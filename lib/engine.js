"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { AppendStore } = require("./store");
const { AuditLog } = require("./audit");
const { Vault, COMPARTMENTS } = require("./vault");
const { sha256Json, randomId } = require("./hash");
const { freezeManifest, prepareManifest } = require("./manifest");
const { checkLeakage } = require("./leakage");
const { macroF1, auroc, pearsonRmse, calibration, judgeMetric } = require("./metrics");

/**
 * 盲测基准编排引擎。所有状态写入只追加存储与哈希链审计日志；
 * 三类受限材料始终留在分级保管库中，由本层按作业状态/角色裁决访问。
 */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ROLES = Object.freeze({
  ADMIN: "admin",
  REVIEWER: "reviewer",
  TEAM: "team",
  RUNNER: "runner",
});

function defaultRunner() {
  // 缺省模拟运行器：只依据受限矩阵特征与提交摘要产出预测，绝不接触真值。
  return async ({ matrix, weightDigest, runConfig }) => {
    const samples = matrix.samples || [];
    let h = 0;
    for (const ch of weightDigest) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rand = () => {
      h = (h + 0x6d2b79f5) >>> 0;
      let t = Math.imul(h ^ (h >>> 15), h | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const speciesCandidates = runConfig.speciesCandidates || ["unknown"];
    const calibClasses = runConfig.calibrationClasses || ["healthy", "disease"];
    const predictions = {
      species: {},
      health: {},
      missingGene: {},
      calibration: {},
    };
    const geneCount = runConfig.heldOutGenes || 4;
    for (const sample of samples) {
      predictions.species[sample.sampleId] =
        speciesCandidates[Math.floor(rand() * speciesCandidates.length)];
      predictions.health[sample.sampleId] = rand();
      predictions.calibration[sample.sampleId] = calibClasses.map((_, i) =>
        i === 0 ? rand() : 0
      );
      const probs = predictions.calibration[sample.sampleId];
      const rest = 1 - probs[0];
      for (let i = 1; i < calibClasses.length; i += 1) {
        probs[i] = rest / (calibClasses.length - 1);
      }
      predictions.missingGene[sample.sampleId] = Array.from({ length: geneCount }, () => rand());
    }
    return {
      predictions,
      resources: { runtimeMs: 1, peakMemoryMb: 64, cpuMillis: 1 },
    };
  };
}

class BenchmarkEngine {
  constructor({ rootDir, runner, clock } = {}) {
    if (!rootDir) throw new Error("需要 rootDir");
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
    const dataDir = path.join(rootDir, "records");
    this.manifests = AppendStore.load(path.join(dataDir, "manifests.jsonl"), "manifest");
    this.reports = AppendStore.load(path.join(dataDir, "leakage.jsonl"), "leakage_report");
    this.jobs = AppendStore.load(path.join(dataDir, "jobs.jsonl"), "job");
    this.results = AppendStore.load(path.join(dataDir, "results.jsonl"), "result");
    this.snapshots = AppendStore.load(path.join(dataDir, "snapshots.jsonl"), "leaderboard_snapshot");
    this.corrections = AppendStore.load(path.join(dataDir, "corrections.jsonl"), "correction");
    this.appeals = AppendStore.load(path.join(dataDir, "appeals.jsonl"), "appeal");
    for (const store of [
      this.manifests,
      this.reports,
      this.jobs,
      this.results,
      this.snapshots,
      this.corrections,
      this.appeals,
    ]) {
      store.open();
    }
    this.audit = AuditLog.load(path.join(rootDir, "audit.log"));
    this.audit.open();
    this.vault = new Vault(path.join(rootDir, "vault"));
    this.runner = runner || defaultRunner();
    this.clock = clock || (() => new Date());
  }

  now() {
    return this.clock();
  }

  pastDeadline(deadlineIso) {
    return Date.parse(this.now().toISOString()) > Date.parse(deadlineIso);
  }

  close() {
    for (const store of [
      this.manifests,
      this.reports,
      this.jobs,
      this.results,
      this.snapshots,
      this.corrections,
      this.appeals,
    ]) {
      store.close();
    }
    this.audit.close();
  }

  // ---------- 角色校验 ----------

  _require(actor, role) {
    if (!actor || actor.role !== role) {
      throw new HttpError(403, "FORBIDDEN", `该操作需要 ${role} 角色`);
    }
  }

  _requireAdmin(actor) {
    this._require(actor, ROLES.ADMIN);
  }

  _audit(actor, action, details) {
    return this.audit.append(actor ? `${actor.role}:${actor.id}` : "anonymous", action, details);
  }

  // ---------- 数据入库（受限材料） ----------

  ingestRestrictedMatrix(actor, ref, buffer, meta = {}) {
    this._requireAdmin(actor);
    if (this.vault.has(COMPARTMENTS.RESTRICTED_MATRIX, ref)) {
      throw new HttpError(409, "ALREADY_EXISTS", "该矩阵引用已存在，受限材料引用不可覆盖");
    }
    const record = this.vault.put(COMPARTMENTS.RESTRICTED_MATRIX, ref, buffer, meta);
    this._audit(actor, "matrix.ingest", { ref, sha256: record.sha256, size: record.size });
    return { ref, sha256: record.sha256, size: record.size };
  }

  ingestUnblinding(actor, ref, buffer, meta = {}) {
    this._requireAdmin(actor);
    if (this.vault.has(COMPARTMENTS.UNBLINDING, ref)) {
      throw new HttpError(409, "ALREADY_EXISTS", "揭盲材料引用已存在，不可覆盖");
    }
    const record = this.vault.put(COMPARTMENTS.UNBLINDING, ref, buffer, meta);
    this._audit(actor, "unblinding.ingest", { ref, sha256: record.sha256, size: record.size });
    return { ref, sha256: record.sha256, size: record.size };
  }

  // ---------- 泄漏检查与冻结 ----------

  /**
   * 泄漏检查发生在冻结之前：输入清单草案，锚定“剔除报告指针后的
   * 清单基线哈希”。冻结时再校验报告与最终清单一致，避免循环依赖。
   */
  createLeakageReport(actor, { draft, trainScope, testSamples }) {
    this._requireAdmin(actor);
    if (!draft) throw new HttpError(400, "BAD_REQUEST", "需要清单草案 draft 以锚定基线");
    const baseline = prepareManifest(draft);
    const baselineHash = sha256Json(baseline);
    const report = checkLeakage(
      trainScope || baseline.trainScope,
      testSamples,
      baseline.hiddenTest.leakageThresholds
    );
    const reportHash = sha256Json({ baselineHash, report });
    if (this.reports.has(reportHash)) {
      return this.reports.get(reportHash);
    }
    this.reports.append(reportHash, "leakage_report", {
      reportHash,
      baselineHash,
      createdAt: this.now().toISOString(),
      ...report,
    });
    this._audit(actor, "leakage.report", {
      baselineHash,
      reportHash,
      verdict: report.verdict,
      counts: report.counts,
    });
    return this.reports.get(reportHash);
  }

  /**
   * 冻结基准。可在草案中携带 leakageReportHash（事先生成的泄漏检查报告）。
   * 冻结后记录不可变，manifestHash 贯穿后续所有产物。
   */
  freeze(actor, draft) {
    this._requireAdmin(actor);
    const frozen = freezeManifest(draft, this.now().toISOString());
    if (this.manifests.has(frozen.manifestHash)) {
      throw new HttpError(409, "ALREADY_FROZEN", "该内容的清单已冻结（哈希重复）");
    }
    const duplicateVersion = this.manifests
      .latest()
      .some(
        (record) =>
          record.data.manifest.benchmarkId === frozen.manifest.benchmarkId &&
          record.data.manifest.version === frozen.manifest.version
      );
    if (duplicateVersion) {
      throw new HttpError(409, "VERSION_EXISTS", "同一 benchmarkId+version 已冻结，版本更新须升版本号");
    }
    if (frozen.manifest.hiddenTest.leakageReportHash) {
      const report = this.reports.get(frozen.manifest.hiddenTest.leakageReportHash);
      if (!report) throw new HttpError(400, "REPORT_MISSING", "引用的泄漏检查报告不存在");
      // 冻结体除报告指针外必须与报告锚定的基线完全一致（指针规范化为 null 后比较）
      const baselineDraft = {
        ...draft,
        hiddenTest: { ...draft.hiddenTest, leakageReportHash: undefined },
      };
      const baselineHash = sha256Json(prepareManifest(baselineDraft));
      if (report.baselineHash !== baselineHash) {
        throw new HttpError(400, "REPORT_MISMATCH", "泄漏报告与清单基线不匹配：草案在检查后被改动");
      }
      if (report.verdict === "leaked") {
        throw new HttpError(400, "LEAKAGE_BLOCK", "样本/谱系泄漏未排除前不得冻结基准");
      }
    }
    this.manifests.append(frozen.manifestHash, "manifest", frozen);
    this._audit(actor, "manifest.freeze", {
      manifestHash: frozen.manifestHash,
      benchmarkId: frozen.manifest.benchmarkId,
      version: frozen.manifest.version,
      tasks: frozen.manifest.tasks.map((t) => t.taskId),
      deadline: frozen.manifest.deadline,
    });
    return frozen;
  }

  _getManifest(manifestHash) {
    const frozen = this.manifests.get(manifestHash);
    if (!frozen) throw new HttpError(404, "MANIFEST_NOT_FOUND", "冻结清单不存在");
    return frozen;
  }

  listManifests() {
    return this.manifests.latest().map((record) => ({
      manifestHash: record.data.manifestHash,
      benchmarkId: record.data.manifest.benchmarkId,
      version: record.data.manifest.version,
      frozenAt: record.data.frozenAt,
      deadline: record.data.manifest.deadline,
      tasks: record.data.manifest.tasks.map((t) => ({
        taskId: t.taskId,
        type: t.type,
        label: t.label,
      })),
    }));
  }

  // ---------- 权重提交与作业 ----------

  uploadWeights(actor, manifestHash, buffer) {
    if (!actor || actor.role !== ROLES.TEAM) {
      throw new HttpError(403, "FORBIDDEN", "仅参赛团队可上传权重");
    }
    this._getManifest(manifestHash);
    const ref = `weights-${actor.teamId}-${manifestHash.slice(0, 12)}`;
    if (this.vault.has(COMPARTMENTS.TEAM_WEIGHTS, ref)) {
      throw new HttpError(409, "ALREADY_EXISTS", "该作业的权重已提交，不可覆盖；请对失败作业发起重试");
    }
    const record = this.vault.put(COMPARTMENTS.TEAM_WEIGHTS, ref, buffer, {
      teamId: actor.teamId,
      manifestHash,
    });
    this._audit(actor, "weights.upload", {
      manifestHash,
      ref,
      sha256: record.sha256,
      size: record.size,
    });
    return { ref, sha256: record.sha256, size: record.size };
  }

  submit(actor, { manifestHash, weightDigest, weightRef, runConfig, teamName }) {
    if (!actor || actor.role !== ROLES.TEAM) {
      throw new HttpError(403, "FORBIDDEN", "仅参赛团队可提交作业");
    }
    const frozen = this._getManifest(manifestHash);
    if (this.pastDeadline(frozen.manifest.deadline)) {
      throw new HttpError(403, "DEADLINE_PASSED", "提交截止时间已过，系统拒绝新提交");
    }
    if (!weightDigest || typeof weightDigest !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "必须提交权重摘要 weightDigest");
    }
    if (!runConfig || typeof runConfig !== "object") {
      throw new HttpError(400, "BAD_REQUEST", "必须提交运行配置 runConfig");
    }
    if (weightRef) {
      const meta = this.vault.meta(COMPARTMENTS.TEAM_WEIGHTS, weightRef);
      if (!meta || meta.meta.teamId !== actor.teamId || meta.meta.manifestHash !== manifestHash) {
        throw new HttpError(404, "WEIGHTS_NOT_FOUND", "权重包不存在或不属于本团队本基准");
      }
    }
    // 同一团队 × 同一冻结基准：沿用同一作业身份，不另建作业
    const existing = this.jobs
      .latest()
      .find(
        (record) =>
          record.data.manifestHash === manifestHash && record.data.teamId === actor.teamId
      );
    if (existing) {
      throw new HttpError(
        409,
        "JOB_EXISTS",
        `作业 ${existing.data.jobId} 已存在；失败后请使用该作业身份重试，不可重复提交`
      );
    }
    const jobId = "job_" + randomId("").slice(4);
    const job = {
      jobId,
      manifestHash,
      benchmarkId: frozen.manifest.benchmarkId,
      version: frozen.manifest.version,
      teamId: actor.teamId,
      teamName: teamName || actor.teamId,
      weightDigest,
      weightRef: weightRef || null,
      weightSha256: weightRef
        ? this.vault.meta(COMPARTMENTS.TEAM_WEIGHTS, weightRef).sha256
        : null,
      runConfig,
      status: "queued",
      attempts: [],
      latestResultId: null,
      createdAt: this.now().toISOString(),
      deadline: frozen.manifest.deadline,
    };
    this.jobs.append(jobId, "job", job);
    this._audit(actor, "job.submit", {
      jobId,
      manifestHash,
      weightDigest,
      weightRef: weightRef || null,
      runConfigHash: sha256Json(runConfig),
    });
    return this._jobView(job, actor);
  }

  /** 失败重试：同一作业身份，attempt 编号递增，截止时间闸同样生效。 */
  retry(actor, jobId) {
    const job = this._getJob(jobId);
    if (!actor || actor.role !== ROLES.TEAM || actor.teamId !== job.teamId) {
      throw new HttpError(403, "FORBIDDEN", "仅作业所属团队可重试该作业");
    }
    if (!["failed", "crashed"].includes(job.status)) {
      throw new HttpError(409, "NOT_RETRYABLE", `作业状态为 ${job.status}，仅失败作业可重试`);
    }
    if (this.pastDeadline(job.deadline)) {
      throw new HttpError(403, "DEADLINE_PASSED", "已超过截止时间，失败重试被拒绝");
    }
    const updated = { ...job, status: "queued" };
    this.jobs.append(jobId, "job", updated, { allowUpdate: true });
    this._audit(actor, "job.retry", {
      jobId,
      nextAttempt: job.attempts.length + 1,
      totalAttemptsSoFar: job.attempts.length,
    });
    return this._jobView(updated, actor);
  }

  _getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new HttpError(404, "JOB_NOT_FOUND", "作业不存在");
    return job;
  }

  // ---------- 隔离执行与打分 ----------

  /**
   * 执行一次作业尝试。由隔离运行环境（runner 角色）触发：
   * 仅在作业处于 queued 且尝试进行中的窗口，运行器可读受限矩阵；
   * 真值（揭盲材料）只在打分步骤由系统内部读取，永不离开本进程。
   */
  async runAttempt(actor, jobId, { force = false } = {}) {
    this._require(actor, ROLES.RUNNER);
    const job = this._getJob(jobId);
    if (job.status !== "queued") {
      throw new HttpError(409, "NOT_QUEUED", `作业状态为 ${job.status}，无法启动尝试`);
    }
    if (!force && this.pastDeadline(job.deadline)) {
      throw new HttpError(403, "DEADLINE_PASSED", "截止时间后不得启动新的运行尝试");
    }
    const frozen = this._getManifest(job.manifestHash);
    const attemptNumber = job.attempts.length + 1;
    const attemptId = `${jobId}:a${attemptNumber}`;

    const running = {
      ...job,
      status: "running",
      attempts: [
        ...job.attempts,
        { attemptNumber, attemptId, status: "running", startedAt: this.now().toISOString() },
      ],
    };
    this.jobs.append(jobId, "job", running, { allowUpdate: true });
    this._audit(actor, "job.attempt_start", {
      jobId,
      attemptId,
      attemptNumber,
      forced: force === true,
    });

    const matrixRef = frozen.manifest.hiddenTest.matrixRef;
    const unblindingRef = frozen.manifest.hiddenTest.unblindingRef;
    const startedAt = this.now();

    let runOutput;
    try {
      // 关键隔离点：仅“活动作业的当前尝试”可读取受限矩阵
      const matrixBytes = this.vault.read(
        COMPARTMENTS.RESTRICTED_MATRIX,
        matrixRef,
        force
          ? { allow: true, actor: `runner:${jobId}:a${attemptNumber}`, reason: "admin-forced run" }
          : {
              allow: true,
              actor: `runner:${jobId}:a${attemptNumber}`,
              reason: `active-job ${jobId} attempt ${attemptNumber} in progress`,
            }
      );
      const matrix = JSON.parse(matrixBytes.toString("utf8"));
      runOutput = await this.runner({
        matrix,
        weightDigest: job.weightDigest,
        weightRef: job.weightRef,
        runConfig: job.runConfig,
        manifest: frozen.manifest,
        attempt: { jobId, attemptNumber, attemptId },
      });
      if (!runOutput || !runOutput.predictions) {
        throw new Error("运行器未返回预测结果");
      }
    } catch (err) {
      const crashed = {
        ...running,
        status: "failed",
        attempts: running.attempts.map((a) =>
          a.attemptId === attemptId
            ? {
                ...a,
                status: "failed",
                finishedAt: this.now().toISOString(),
                error: String(err && err.message ? err.message : err),
              }
            : a
        ),
      };
      this.jobs.append(jobId, "job", crashed, { allowUpdate: true });
      this._audit(actor, "job.attempt_failed", {
        jobId,
        attemptId,
        error: String(err && err.message ? err.message : err),
      });
      return {
        job: this._jobView(crashed, { role: "runner", id: actor.id, teamId: null }),
        resultId: null,
      };
    }

    // 打分：系统内部读取揭盲材料，授权理由绑定本次尝试，打分结束即释放
    const truthBytes = this.vault.read(
      COMPARTMENTS.UNBLINDING,
      unblindingRef,
      {
        allow: true,
        actor: `scorer:${jobId}:a${attemptNumber}`,
        reason: `scoring ${attemptId} against frozen manifest ${job.manifestHash.slice(0, 12)}`,
      }
    );
    const truth = JSON.parse(truthBytes.toString("utf8"));
    const finishedAt = this.now();
    const wallMs = Math.max(1, finishedAt.getTime() - startedAt.getTime());

    let scored;
    try {
      scored = this._score(frozen.manifest, truth, runOutput.predictions);
    } catch (err) {
      const failed = {
        ...running,
        status: "failed",
        attempts: running.attempts.map((a) =>
          a.attemptId === attemptId
            ? {
                ...a,
                status: "failed",
                finishedAt: this.now().toISOString(),
                error: `预测无法按冻结口径打分: ${err.message}`,
              }
            : a
        ),
      };
      this.jobs.append(jobId, "job", failed, { allowUpdate: true });
      this._audit(actor, "job.attempt_failed", { jobId, attemptId, error: err.message });
      return {
        job: this._jobView(failed, { role: "runner", id: actor.id, teamId: null }),
        resultId: null,
      };
    }

    const resources = {
      wallMs,
      runtimeMs: runOutput.resources && runOutput.resources.runtimeMs ? runOutput.resources.runtimeMs : wallMs,
      peakMemoryMb: runOutput.resources && runOutput.resources.peakMemoryMb ? runOutput.resources.peakMemoryMb : null,
      cpuMillis: runOutput.resources && runOutput.resources.cpuMillis ? runOutput.resources.cpuMillis : null,
    };
    const resultId = `result:${attemptId}`;
    const result = {
      resultId,
      jobId,
      attemptId,
      attemptNumber,
      manifestHash: job.manifestHash,
      benchmarkId: job.benchmarkId,
      version: job.version,
      teamId: job.teamId,
      teamName: job.teamName,
      scoredAt: this.now().toISOString(),
      taskResults: scored.taskResults,
      resources,
      predictionHash: sha256Json(runOutput.predictions),
    };
    this.results.append(resultId, "result", result);

    const succeeded = {
      ...running,
      status: "succeeded",
      latestResultId: resultId,
      attempts: running.attempts.map((a) =>
        a.attemptId === attemptId
          ? { ...a, status: "succeeded", finishedAt: this.now().toISOString(), resultId }
          : a
      ),
    };
    this.jobs.append(jobId, "job", succeeded, { allowUpdate: true });
    this._audit(actor, "job.attempt_done", {
      jobId,
      attemptId,
      resultId,
      predictionHash: result.predictionHash,
      resources,
    });
    return { job: this._jobView(succeeded, { role: "runner", id: actor.id, teamId: null }), resultId };
  }

  _score(manifest, truth, predictions) {
    const sampleOrder = truth.sampleOrder;
    const taskResults = {};
    for (const task of manifest.tasks) {
      const scope = task.scope || {};
      if (task.type === "species_identification") {
        const classes = scope.classes;
        const labels = sampleOrder.map((id) => truth.labels.species[id]);
        const preds = sampleOrder.map((id) => (predictions.species || {})[id]);
        if (preds.some((p) => p === undefined)) {
          throw new Error(`${task.taskId}: 缺少部分样本的物种预测`);
        }
        const values = macroF1(labels, preds, classes);
        taskResults[task.taskId] = this._finalizeTask(task, {
          macroF1: values.macroF1,
          accuracy: values.accuracy,
        });
      } else if (task.type === "health_disease") {
        const positive = scope.positiveLabel || "disease";
        const labels = sampleOrder.map((id) => truth.labels.health[id]);
        const scores = sampleOrder.map((id) => (predictions.health || {})[id]);
        if (scores.some((s) => typeof s !== "number")) {
          throw new Error(`${task.taskId}: 缺少部分样本的病变风险评分`);
        }
        const values = { auroc: auroc(labels, scores, positive) };
        taskResults[task.taskId] = this._finalizeTask(task, values);
      } else if (task.type === "missing_gene") {
        const tVec = [];
        const pVec = [];
        for (const id of sampleOrder) {
          const tv = truth.heldOutGenes[id];
          const pv = (predictions.missingGene || {})[id];
          if (!Array.isArray(tv) || !Array.isArray(pv) || tv.length !== pv.length) {
            throw new Error(`${task.taskId}: 样本 ${id} 的缺失基因预测缺失或维度不符`);
          }
          tVec.push(...tv);
          pVec.push(...pv);
        }
        const values = pearsonRmse(tVec, pVec);
        taskResults[task.taskId] = this._finalizeTask(task, {
          pearson: values.pearson,
          rmse: values.rmse,
        });
      } else if (task.type === "uncertainty_calibration") {
        const classes = scope.classes || ["healthy", "disease"];
        const labels = sampleOrder.map((id) => truth.labels.health[id]);
        const probs = sampleOrder.map((id) => (predictions.calibration || {})[id]);
        if (probs.some((p) => !Array.isArray(p))) {
          throw new Error(`${task.taskId}: 缺少部分样本的类别概率`);
        }
        const values = calibration(labels, probs, classes, scope.binCount || 10);
        taskResults[task.taskId] = this._finalizeTask(task, {
          ece: values.ece,
          brier: values.brier,
        });
      } else {
        throw new Error(`不支持的任务类型: ${task.type}`);
      }
    }
    return { taskResults };
  }

  _finalizeTask(task, values) {
    const judges = task.metrics.map((spec) => judgeMetric(spec, values));
    const thresholdJudges = judges.filter((j) => j.pass !== null);
    const pass =
      thresholdJudges.length === 0
        ? null
        : thresholdJudges.every((j) => j.pass === true);
    const primary = judges.find((j) => j.metric === task.primary) || judges[0];
    return {
      type: task.type,
      label: task.label,
      primaryMetric: task.primary,
      values,
      judges,
      pass,
      primaryValue: primary ? primary.value : null,
      primaryHigherIsBetter: primary ? primary.higherIsBetter : true,
    };
  }

  // ---------- 可见性：作业与结果 ----------

  _jobView(job, actor) {
    const base = {
      jobId: job.jobId,
      manifestHash: job.manifestHash,
      benchmarkId: job.benchmarkId,
      version: job.version,
      teamId: job.teamId,
      teamName: job.teamName,
      status: job.status,
      attempts: job.attempts.map((a) => ({
        attemptNumber: a.attemptNumber,
        attemptId: a.attemptId,
        status: a.status,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt || null,
        resultId: a.resultId || null,
        error: a.error || null,
      })),
      latestResultId: job.latestResultId,
      createdAt: job.createdAt,
      deadline: job.deadline,
    };
    const isOwner = actor && actor.role === ROLES.TEAM && actor.teamId === job.teamId;
    const isPrivileged = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    if (isPrivileged) {
      return { ...base, weightDigest: job.weightDigest, weightRef: job.weightRef, runConfig: job.runConfig };
    }
    if (isOwner) {
      // 队伍可见自己的运行配置与执行状态，但截止发布前看不到分数
      return { ...base, weightDigest: job.weightDigest, runConfig: job.runConfig };
    }
    return base;
  }

  getJob(actor, jobId) {
    const job = this._getJob(jobId);
    const isOwner = actor && actor.role === ROLES.TEAM && actor.teamId === job.teamId;
    const isPrivileged = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    const isRunner = actor && actor.role === ROLES.RUNNER;
    if (!isOwner && !isPrivileged && !isRunner) {
      throw new HttpError(403, "FORBIDDEN", "无权查看该作业");
    }
    return this._jobView(job, actor);
  }

  listJobs(actor, { manifestHash } = {}) {
    const isPrivileged = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    const isRunner = actor && actor.role === ROLES.RUNNER;
    if (!isPrivileged && !isRunner && (!actor || actor.role !== ROLES.TEAM)) {
      throw new HttpError(403, "FORBIDDEN", "无权列举作业");
    }
    return this.jobs
      .latest()
      .map((record) => record.data)
      .filter((job) => !manifestHash || job.manifestHash === manifestHash)
      .filter((job) => {
        if (isPrivileged || isRunner) return true;
        return actor.role === ROLES.TEAM && job.teamId === actor.teamId;
      })
      .map((job) => this._jobView(job, actor));
  }

  /**
   * 结果可见性：截止发布前仅授权管理员（及处理申诉的独立评审）可见；
   * 团队成员在发布前拿不到分数，发布后可见全部公开结果。
   */
  getResult(actor, resultId) {
    const result = this.results.get(resultId);
    if (!result) throw new HttpError(404, "RESULT_NOT_FOUND", "结果不存在");
    const released = Boolean(this._snapshotFor(result.manifestHash));
    // 密封期仅授权管理员可经此入口查看；独立评审须走申诉上下文 getResultForAppeal
    if (!released && (!actor || actor.role !== ROLES.ADMIN)) {
      throw new HttpError(403, "RESULT_SEALED", "结果尚未发布：截止日前仅授权管理员可见");
    }
    return this._resultView(result, { released });
  }

  getResultForAppeal(actor, appealId) {
    this._require(actor, ROLES.REVIEWER);
    const appeal = this.appeals.get(appealId);
    if (!appeal) throw new HttpError(404, "APPEAL_NOT_FOUND", "申诉不存在");
    const result = this.results.get(appeal.resultId);
    if (!result) throw new HttpError(404, "RESULT_NOT_FOUND", "被申诉结果不存在");
    this._audit(actor, "appeal.result_view", { appealId, resultId: result.resultId });
    return this._resultView(result, { released: Boolean(this._snapshotFor(result.manifestHash)) });
  }

  _resultView(result, { released }) {
    return {
      resultId: result.resultId,
      jobId: result.jobId,
      attemptId: result.attemptId,
      attemptNumber: result.attemptNumber,
      manifestHash: result.manifestHash,
      benchmarkId: result.benchmarkId,
      version: result.version,
      teamId: result.teamId,
      teamName: result.teamName,
      scoredAt: result.scoredAt,
      released: released === true,
      taskResults: result.taskResults,
      resources: result.resources,
      predictionHash: result.predictionHash,
    };
  }

  // ---------- 权重隔离验证 ----------

  /** 跨团队权重互不可见；仅属主团队与管理员可读取（管理员读取也留痕）。 */
  readWeights(actor, jobId) {
    const job = this._getJob(jobId);
    if (!job.weightRef) throw new HttpError(404, "NO_WEIGHTS", "该作业未提交权重包");
    const owner = actor && actor.role === ROLES.TEAM && actor.teamId === job.teamId;
    const admin = actor && actor.role === ROLES.ADMIN;
    const bytes = this.vault.read(
      COMPARTMENTS.TEAM_WEIGHTS,
      job.weightRef,
      owner || admin
        ? {
            allow: true,
            actor: `${actor.role}:${actor.id}`,
            reason: owner ? `owner team of job ${jobId}` : `admin inspection of job ${jobId}`,
          }
        : {
            allow: false,
            actor: actor ? `${actor.role}:${actor.id}` : "anonymous",
            reason: `not owner of job ${jobId} (owner team ${job.teamId})`,
          }
    );
    this._audit(actor, "weights.read", { jobId, ref: job.weightRef, allowed: owner || admin });
    return bytes;
  }

  // ---------- 榜单发布（不可变快照） ----------

  _snapshotFor(manifestHash) {
    return this.snapshots.get("snapshot:" + manifestHash) || null;
  }

  releaseLeaderboard(actor, manifestHash, { force = false } = {}) {
    this._requireAdmin(actor);
    const frozen = this._getManifest(manifestHash);
    if (this._snapshotFor(manifestHash)) {
      throw new HttpError(409, "SNAPSHIFT_EXISTS", "榜单快照已发布且不可变；版本更新不会改写旧榜单");
    }
    if (!force && this.now().toISOString() < frozen.manifest.deadline) {
      throw new HttpError(403, "BEFORE_DEADLINE", "截止时间未到，不得发布榜单");
    }
    const report = this.reports.get(frozen.manifest.hiddenTest.leakageReportHash);
    if (report && report.verdict === "leaked") {
      throw new HttpError(409, "LEAKAGE_BLOCK", "泄漏检查结论为 leaked，禁止发布获胜结论");
    }
    // 每个团队只取其最新成功结果（同一作业身份的最新尝试）
    const latestByTeam = new Map();
    for (const record of this.results.latest()) {
      const result = record.data;
      if (result.manifestHash !== manifestHash) continue;
      const prev = latestByTeam.get(result.teamId);
      if (!prev || result.attemptNumber > prev.attemptNumber) latestByTeam.set(result.teamId, result);
    }
    const entries = [...latestByTeam.values()].map((result) => this._entry(result));
    const taskIds = frozen.manifest.tasks.map((t) => t.taskId);
    for (const task of frozen.manifest.tasks) {
      const ranked = entries
        .slice()
        .sort((a, b) => {
          const av = a.tasks[task.taskId].primaryValue;
          const bv = b.tasks[task.taskId].primaryValue;
          return task.type === "uncertainty_calibration" ? av - bv : bv - av;
        });
      ranked.forEach((entry, i) => {
        entry.tasks[task.taskId].rank = i + 1;
      });
    }
    // 综合分：各任务百分位排名的均值（第 1 名得 1，越大越好统一为 1 - (rank-1)/n）
    for (const entry of entries) {
      const percentileSum = taskIds.reduce((sum, taskId) => {
        const rank = entry.tasks[taskId].rank;
        return sum + (1 - (rank - 1) / Math.max(1, entries.length));
      }, 0);
      entry.overallScore = Number((percentileSum / taskIds.length).toFixed(6));
    }
    entries.sort((a, b) => b.overallScore - a.overallScore);
    entries.forEach((entry, i) => {
      entry.overallRank = i + 1;
    });

    const snapshot = {
      snapshotId: "snapshot:" + manifestHash,
      manifestHash,
      benchmarkId: frozen.manifest.benchmarkId,
      version: frozen.manifest.version,
      releasedAt: this.now().toISOString(),
      deadline: frozen.manifest.deadline,
      leakage: report
        ? { reportHash: report.reportHash, verdict: report.verdict, counts: report.counts }
        : null,
      taskDefs: frozen.manifest.tasks.map((t) => ({
        taskId: t.taskId,
        type: t.type,
        label: t.label,
        primaryMetric: t.primary,
        metrics: t.metrics,
      })),
      entries,
    };
    snapshot.snapshotHash = sha256Json(snapshot);
    this.snapshots.append(snapshot.snapshotId, "leaderboard_snapshot", snapshot);
    this._audit(actor, "leaderboard.release", {
      manifestHash,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      teams: entries.length,
    });
    return this._snapshotView(snapshot);
  }

  _entry(result) {
    const tasks = {};
    for (const [taskId, tr] of Object.entries(result.taskResults)) {
      tasks[taskId] = {
        label: tr.label,
        primaryMetric: tr.primaryMetric,
        primaryValue: tr.primaryValue,
        pass: tr.pass,
        judges: tr.judges,
        values: tr.values,
      };
    }
    return {
      teamId: result.teamId,
      teamName: result.teamName,
      jobId: result.jobId,
      resultId: result.resultId,
      attemptNumber: result.attemptNumber,
      tasks,
      resources: result.resources,
      scope: null, // 发布时由榜单补充适用范围
    };
  }

  /** 公开发布物：分项表现 + 适用范围 + 资源消耗（矩阵/权重/揭盲材料不在其中）。 */
  _snapshotView(snapshot) {
    const corrections = this.corrections
      .latest()
      .map((record) => record.data)
      .filter((c) => c.manifestHash === snapshot.manifestHash);
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({
        ...entry,
        scope: this._applicability(entry, snapshot),
      })),
      corrections,
    };
  }

  _applicability(entry, snapshot) {
    // 适用范围由冻结分层与任务达标情况推导，声明模型结论在哪些物种/实验室成立
    const heldOut = [];
    // 清单版本中的 held_out 分层对所有条目相同：从 manifest 记录取
    const frozen = this.manifests.get(snapshot.manifestHash);
    for (const stratum of frozen.manifest.stratification) {
      if (stratum.role === "held_out") heldOut.push({ species: stratum.species, lab: stratum.lab });
    }
    const passedTaskIds = Object.entries(entry.tasks)
      .filter(([, t]) => t.pass === true)
      .map(([taskId]) => taskId);
    const failedTaskIds = Object.entries(entry.tasks)
      .filter(([, t]) => t.pass === false)
      .map(([taskId]) => taskId);
    return {
      evaluatedOn: heldOut,
      tasksPassed: passedTaskIds,
      tasksBelowThreshold: failedTaskIds,
      caveat:
        failedTaskIds.length > 0
          ? "泛化结论仅在达标任务范围内成立，未达标任务不得外推"
          : null,
    };
  }

  getLeaderboard(actor, manifestHash) {
    const snapshot = this._snapshotFor(manifestHash);
    if (!snapshot) {
      const isAdmin = actor && actor.role === ROLES.ADMIN;
      if (!isAdmin) {
        throw new HttpError(404, "NOT_RELEASED", "榜单尚未发布，截止日前结果仅授权管理员可见");
      }
      // 管理员可查看未发布预览，但显式标注 sealed，且不产生快照
      return { sealed: true, manifestHash, note: "未发布预览：截止日前仅授权管理员可见" };
    }
    return this._snapshotView(snapshot);
  }

  listLeaderboards() {
    return this.snapshots.latest().map((record) => {
      const snapshot = record.data;
      return {
        snapshotId: snapshot.snapshotId,
        manifestHash: snapshot.manifestHash,
        benchmarkId: snapshot.benchmarkId,
        version: snapshot.version,
        releasedAt: snapshot.releasedAt,
        snapshotHash: snapshot.snapshotHash,
        teams: snapshot.entries.length,
      };
    });
  }

  // ---------- 申诉与独立评审 ----------

  fileAppeal(actor, { jobId, rationale, cites }) {
    const job = this._getJob(jobId);
    if (!actor || actor.role !== ROLES.TEAM || actor.teamId !== job.teamId) {
      throw new HttpError(403, "FORBIDDEN", "仅作业所属团队可对该作业申诉");
    }
    if (!rationale || typeof rationale !== "string") {
      throw new HttpError(400, "BAD_REQUEST", "申诉需要说明理由");
    }
    if (!Array.isArray(cites) || cites.length === 0) {
      throw new HttpError(400, "BAD_REQUEST", "申诉必须引用至少一条可复查日志（seq + entryHash）");
    }
    // 每条引用必须能在哈希链中复查到，杜绝“空口申诉”
    for (const cite of cites) {
      const entry = this.audit.cite(cite.seq, cite.entryHash);
      if (!entry) {
        throw new HttpError(400, "CITE_INVALID", `日志引用不存在或哈希不符: seq=${cite.seq}`);
      }
    }
    if (!job.latestResultId) {
      throw new HttpError(409, "NO_RESULT", "作业尚无打分结果，无可申诉对象");
    }
    const appealId = "appeal_" + randomId("").slice(4);
    const appeal = {
      appealId,
      jobId,
      resultId: job.latestResultId,
      manifestHash: job.manifestHash,
      teamId: job.teamId,
      rationale,
      cites: cites.map((c) => ({ seq: c.seq, entryHash: c.entryHash })),
      status: "open",
      outcome: null,
      reviewer: null,
      events: [
        { at: this.now().toISOString(), type: "filed", by: actor.id, rationale },
      ],
      createdAt: this.now().toISOString(),
    };
    this.appeals.append(appealId, "appeal", appeal);
    this._audit(actor, "appeal.file", {
      appealId,
      jobId,
      resultId: appeal.resultId,
      cites: cites.map((c) => c.seq),
    });
    return appeal;
  }

  reviewAppeal(actor, appealId, { outcome, rationale }) {
    this._require(actor, ROLES.REVIEWER);
    const appeal = this.appeals.get(appealId);
    if (!appeal) throw new HttpError(404, "APPEAL_NOT_FOUND", "申诉不存在");
    if (appeal.status !== "open") {
      throw new HttpError(409, "APPEAL_CLOSED", "申诉已有评审结论，不可更改");
    }
    if (!["upheld", "denied"].includes(outcome)) {
      throw new HttpError(400, "BAD_REQUEST", "outcome 必须为 upheld 或 denied");
    }
    if (!rationale) throw new HttpError(400, "BAD_REQUEST", "评审结论需要理由");
    // 独立评审复查引用日志链
    const verifiedCites = appeal.cites.map((cite) => {
      const entry = this.audit.cite(cite.seq, cite.entryHash);
      return { ...cite, verified: Boolean(entry), action: entry ? entry.action : null };
    });
    const updated = {
      ...appeal,
      status: "closed",
      outcome,
      reviewer: actor.id,
      reviewedAt: this.now().toISOString(),
      reviewRationale: rationale,
      verifiedCites,
      events: [
        ...appeal.events,
        { at: this.now().toISOString(), type: "reviewed", by: actor.id, outcome, rationale },
      ],
    };
    this.appeals.append(appealId, "appeal", updated, { allowUpdate: true });
    this._audit(actor, "appeal.review", {
      appealId,
      outcome,
      jobId: appeal.jobId,
      citesVerified: verifiedCites.filter((c) => c.verified).length,
    });

    // 申诉成立也不改写已发布结果/榜单；以独立更正附注形式追加，随榜单公开展示
    let correction = null;
    if (outcome === "upheld") {
      const result = this.results.get(appeal.resultId);
      const snapshot = this._snapshotFor(appeal.manifestHash);
      const correctionId = "correction_" + randomId("").slice(4);
      correction = {
        correctionId,
        snapshotId: snapshot ? snapshot.snapshotId : null,
        manifestHash: appeal.manifestHash,
        appealId,
        jobId: appeal.jobId,
        resultId: appeal.resultId,
        teamId: appeal.teamId,
        note: rationale,
        reviewer: actor.id,
        at: this.now().toISOString(),
        originalResultHash: sha256Json(result),
      };
      this.corrections.append(correctionId, "correction", correction);
      this._audit(actor, "correction.add", {
        correctionId,
        appealId,
        snapshotId: correction.snapshotId,
      });
    }
    return { appeal: updated, correction };
  }

  getAppeal(actor, appealId) {
    const appeal = this.appeals.get(appealId);
    if (!appeal) throw new HttpError(404, "APPEAL_NOT_FOUND", "申诉不存在");
    const owner = actor && actor.role === ROLES.TEAM && actor.teamId === appeal.teamId;
    const priv = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    if (!owner && !priv) throw new HttpError(403, "FORBIDDEN", "无权查看该申诉");
    return appeal;
  }

  /**
   * 供申诉引用的可复查日志：团队成员可拿到本作业相关审计条目的 seq/entryHash
   * 与动作/时间（不含其他团队信息），申诉时必须引用其中条目。
   */
  getJobAuditCitations(actor, jobId) {
    const job = this._getJob(jobId);
    const owner = actor && actor.role === ROLES.TEAM && actor.teamId === job.teamId;
    const priv = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    if (!owner && !priv) throw new HttpError(403, "FORBIDDEN", "无权引用该作业的日志");
    return this.audit.entries
      .filter((entry) => entry.details && entry.details.jobId === jobId)
      .map((entry) => ({
        seq: entry.seq,
        entryHash: entry.entryHash,
        at: entry.at,
        action: entry.action,
      }));
  }

  // ---------- 溯源 ----------

  /**
   * 获胜结论可追溯链：固定数据（清单/泄漏报告）→ 提交（权重摘要/配置）
   * → 运行（受限读取留痕/尝试/预测哈希）→ 打分 → 榜单快照 → 申诉评审/更正。
   */
  trace(actor, jobId) {
    const priv = actor && (actor.role === ROLES.ADMIN || actor.role === ROLES.REVIEWER);
    const job = this._getJob(jobId);
    const owner = actor && actor.role === ROLES.TEAM && actor.teamId === job.teamId;
    if (!priv && !owner) throw new HttpError(403, "FORBIDDEN", "无权追溯该作业");
    const frozen = this._getManifest(job.manifestHash);
    const snapshot = this._snapshotFor(job.manifestHash);
    const resultRecords = this.results
      .latest()
      .map((record) => record.data)
      .filter((result) => result.jobId === jobId);
    const appeals = this.appeals
      .latest()
      .map((record) => record.data)
      .filter((appeal) => appeal.jobId === jobId);
    const corrections = this.corrections
      .latest()
      .map((record) => record.data)
      .filter((correction) => correction.jobId === jobId);

    const chain = {
      jobId,
      frozenData: {
        manifestHash: frozen.manifestHash,
        benchmarkId: frozen.manifest.benchmarkId,
        version: frozen.manifest.version,
        frozenAt: frozen.frozenAt,
        dataSources: frozen.manifest.dataSources,
        stratification: frozen.manifest.stratification,
        tasks: frozen.manifest.tasks,
        deadline: frozen.manifest.deadline,
      },
      leakage: frozen.manifest.hiddenTest.leakageReportHash
        ? (() => {
            const report = this.reports.get(frozen.manifest.hiddenTest.leakageReportHash);
            return {
              reportHash: report.reportHash,
              verdict: report.verdict,
              counts: report.counts,
              findings: priv ? report.findings : undefined,
            };
          })()
        : null,
      submission: {
        weightDigest: job.weightDigest,
        weightRef: job.weightRef,
        weightSha256: job.weightSha256,
        runConfigHash: sha256Json(job.runConfig),
        runConfig: priv || owner ? job.runConfig : undefined,
        createdAt: job.createdAt,
      },
      attempts: job.attempts,
      results: resultRecords.map((result) => ({
        resultId: result.resultId,
        attemptId: result.attemptId,
        predictionHash: result.predictionHash,
        scoredAt: result.scoredAt,
        resources: result.resources,
        sealed: !snapshot && !priv,
        taskResults: snapshot || priv ? result.taskResults : undefined,
      })),
      leaderboard: snapshot
        ? {
            snapshotId: snapshot.snapshotId,
            snapshotHash: snapshot.snapshotHash,
            releasedAt: snapshot.releasedAt,
          }
        : null,
      appeals: appeals.map((appeal) => ({
        appealId: appeal.appealId,
        status: appeal.status,
        outcome: appeal.outcome,
        reviewer: appeal.reviewer,
        cites: appeal.verifiedCites || appeal.cites,
      })),
      corrections: corrections.map((correction) => ({
        correctionId: correction.correctionId,
        appealId: correction.appealId,
        note: correction.note,
        reviewer: correction.reviewer,
      })),
      auditHead: this.audit.head,
    };
    return chain;
  }

  /** 启动/运维自检：重放审计哈希链。 */
  verifyAudit() {
    const result = this.audit.verify();
    result.vaultAccessLog = path.join(this.vault.rootDir, "access.log");
    return result;
  }

  /** 泄漏报告明细：发布前仅管理员；发布后随公开结论开放汇总（不含受限样本标识映射）。 */
  getLeakageReport(actor, manifestHash) {
    const frozen = this._getManifest(manifestHash);
    const report = this.reports.get(frozen.manifest.hiddenTest.leakageReportHash);
    if (!report) throw new HttpError(404, "REPORT_NOT_FOUND", "该清单未附泄漏检查报告");
    const snapshot = this._snapshotFor(manifestHash);
    const priv = actor && actor.role === ROLES.ADMIN;
    if (!priv && !snapshot) {
      throw new HttpError(403, "REPORT_SEALED", "泄漏报告明细在发布前仅管理员可见");
    }
    if (priv) return report;
    return {
      reportHash: report.reportHash,
      manifestHash,
      baselineHash: report.baselineHash,
      verdict: report.verdict,
      counts: report.counts,
      thresholds: report.thresholds,
      testSamples: report.testSamples,
      pairsChecked: report.pairsChecked,
    };
  }
}

module.exports = { BenchmarkEngine, HttpError, ROLES };
