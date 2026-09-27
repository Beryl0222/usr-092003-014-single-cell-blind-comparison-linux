"use strict";

const { HttpError } = require("./errors");
const { hashObject, newId, deepFreeze } = require("./util");
const { TASK_DEFS, KNOWN_TASK_IDS, evaluateTasks, checkLeakage } = require("./evaluate");

const WEIGHT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_HASH_RE = /^[0-9a-f]{64}$/;
const RESTRICTED_HIDDEN_TEST = (versionId) => `hidden-test:${versionId}`;

function teamOf(actor) {
  return actor.teamId || actor.actorId;
}

function mustGet(store, collection, id, label) {
  const record = store.get(collection, id);
  if (!record) throw new HttpError(404, "not_found", `${label}不存在`);
  return record;
}

// ---------- 校验 ----------

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new HttpError(422, "invalid_manifest", "清单缺失或不是对象");
  }
  const { dataSources, trainingScope, stratification, tasks } = manifest;

  if (!Array.isArray(dataSources) || dataSources.length === 0) {
    throw new HttpError(422, "invalid_manifest", "dataSources 必须是非空数组");
  }
  const sourceIds = new Set();
  for (const s of dataSources) {
    if (!s || typeof s.id !== "string" || !s.id) {
      throw new HttpError(422, "invalid_manifest", "数据源缺少 id");
    }
    if (sourceIds.has(s.id)) {
      throw new HttpError(422, "invalid_manifest", `数据源 id 重复：${s.id}`);
    }
    sourceIds.add(s.id);
    if (!SOURCE_HASH_RE.test(s.sha256 || "")) {
      throw new HttpError(422, "invalid_manifest", `数据源 ${s.id} 缺少合法 sha256`);
    }
    if (!["train-visible", "hidden-test"].includes(s.visibility)) {
      throw new HttpError(422, "invalid_manifest", `数据源 ${s.id} 的 visibility 非法`);
    }
  }
  if (!dataSources.some((s) => s.visibility === "hidden-test")) {
    throw new HttpError(422, "invalid_manifest", "至少需要一个 hidden-test 数据源");
  }

  if (!trainingScope || !Array.isArray(trainingScope.allowedSourceIds)) {
    throw new HttpError(422, "invalid_manifest", "trainingScope.allowedSourceIds 缺失");
  }
  const byId = new Map(dataSources.map((s) => [s.id, s]));
  for (const id of trainingScope.allowedSourceIds) {
    const src = byId.get(id);
    if (!src || src.visibility !== "train-visible") {
      throw new HttpError(422, "invalid_manifest", `训练可见范围包含非训练可见数据源：${id}`);
    }
  }

  if (
    !stratification ||
    !Array.isArray(stratification.species) ||
    stratification.species.length === 0 ||
    !Array.isArray(stratification.labs) ||
    stratification.labs.length === 0
  ) {
    throw new HttpError(422, "invalid_manifest", "stratification 必须给出非空的物种与实验室分层");
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new HttpError(422, "invalid_manifest", "tasks 必须是非空数组");
  }
  const taskIds = new Set();
  for (const t of tasks) {
    if (!KNOWN_TASK_IDS.includes(t.id)) {
      throw new HttpError(422, "invalid_manifest", `未知任务类型：${t.id}`);
    }
    if (taskIds.has(t.id)) {
      throw new HttpError(422, "invalid_manifest", `任务重复：${t.id}`);
    }
    taskIds.add(t.id);
    if (typeof t.weight !== "number" || !(t.weight > 0)) {
      throw new HttpError(422, "invalid_manifest", `任务 ${t.id} 的 weight 必须为正数`);
    }
    const direction = TASK_DEFS[t.id].direction;
    const tol = t.tolerance || {};
    if (direction === "max" && tol.min !== undefined && typeof tol.min !== "number") {
      throw new HttpError(422, "invalid_manifest", `任务 ${t.id} 的容差 min 必须是数字`);
    }
    if (direction === "min" && tol.max !== undefined && typeof tol.max !== "number") {
      throw new HttpError(422, "invalid_manifest", `任务 ${t.id} 的容差 max 必须是数字`);
    }
  }
}

function validateHiddenTest(manifest, hiddenTest) {
  if (!hiddenTest || typeof hiddenTest !== "object") {
    throw new HttpError(422, "invalid_hidden_test", "隐藏测试集缺失或不是对象");
  }
  const lineage = hiddenTest.lineageIndex;
  if (!lineage || typeof lineage !== "object") {
    throw new HttpError(422, "invalid_hidden_test", "隐藏测试集缺少 lineageIndex");
  }
  for (const key of ["sampleIds", "donorIds", "species", "labs"]) {
    if (!Array.isArray(lineage[key])) {
      throw new HttpError(422, "invalid_hidden_test", `lineageIndex.${key} 必须是数组`);
    }
  }
  if (!hiddenTest.tasks || typeof hiddenTest.tasks !== "object") {
    throw new HttpError(422, "invalid_hidden_test", "隐藏测试集缺少任务真值");
  }
  for (const task of manifest.tasks) {
    if (!hiddenTest.tasks[task.id]) {
      throw new HttpError(422, "invalid_hidden_test", `隐藏测试集缺少任务 ${task.id} 的真值`);
    }
  }
}

function validateRunConfig(manifest, runConfig) {
  if (!runConfig || typeof runConfig !== "object") {
    throw new HttpError(422, "invalid_run_config", "runConfig 缺失或不是对象");
  }
  if (typeof runConfig.codeRef !== "string" || !runConfig.codeRef) {
    throw new HttpError(422, "invalid_run_config", "runConfig.codeRef 缺失");
  }
  if (!WEIGHT_DIGEST_RE.test(runConfig.codeDigest || "")) {
    throw new HttpError(422, "invalid_run_config", "runConfig.codeDigest 必须是 sha256:<hex>");
  }
  const provenance = runConfig.trainingProvenance;
  if (!provenance || typeof provenance !== "object") {
    throw new HttpError(422, "invalid_run_config", "runConfig.trainingProvenance 缺失");
  }
  for (const key of ["sourceIds", "sampleIds", "donorIds", "species", "labs"]) {
    if (!Array.isArray(provenance[key])) {
      throw new HttpError(422, "invalid_run_config", `trainingProvenance.${key} 必须是数组`);
    }
  }
  const allowed = new Set(manifest.trainingScope.allowedSourceIds);
  const outOfScope = provenance.sourceIds.filter((id) => !allowed.has(id));
  if (outOfScope.length > 0) {
    throw new HttpError(
      422,
      "training_scope_violation",
      `训练数据来源超出冻结清单的可见范围：${outOfScope.join(", ")}`
    );
  }
}

function validateResourceUsage(resourceUsage) {
  if (!resourceUsage || typeof resourceUsage !== "object") {
    throw new HttpError(422, "invalid_resource_usage", "resourceUsage 缺失");
  }
  for (const key of ["wallClockSec", "gpuHours", "memPeakGb"]) {
    const v = resourceUsage[key];
    if (typeof v !== "number" || !(v >= 0)) {
      throw new HttpError(422, "invalid_resource_usage", `resourceUsage.${key} 必须是非负数字`);
    }
  }
}

// ---------- 版本与冻结 ----------

function createVersion(store, actor, body, now) {
  const { name, resultsDeadline, manifest } = body;
  if (typeof name !== "string" || !name) {
    throw new HttpError(422, "invalid_version", "name 缺失");
  }
  const deadline = Date.parse(resultsDeadline);
  if (Number.isNaN(deadline)) {
    throw new HttpError(422, "invalid_version", "resultsDeadline 缺失或无法解析");
  }
  validateManifest(manifest);
  const version = {
    id: newId("ver"),
    name,
    status: "draft",
    manifest,
    resultsDeadline: new Date(deadline).toISOString(),
    createdBy: actor.actorId,
    createdAt: now.toISOString(),
    manifestSha256: null,
    frozenAt: null,
    frozenBy: null,
    releasedAt: null,
  };
  store.insert("versions", version);
  store.appendAudit({
    actor: actor.actorId,
    action: "version_created",
    refs: { versionId: version.id },
  });
  return version;
}

// 冻结即定版：清单哈希固定，隐藏测试集进入受限命名空间，之后不存在任何修改入口。
function freezeVersion(store, actor, versionId, body, now) {
  const version = mustGet(store, "versions", versionId, "基准版本");
  if (version.status !== "draft") {
    throw new HttpError(409, "already_frozen", "版本已冻结，清单不可再修改");
  }
  const hiddenTest = body.hiddenTest;
  validateHiddenTest(version.manifest, hiddenTest);
  version.manifestSha256 = hashObject(version.manifest);
  version.status = "frozen";
  version.frozenAt = now.toISOString();
  version.frozenBy = actor.actorId;
  deepFreeze(version.manifest);
  store.insert("restricted", {
    id: RESTRICTED_HIDDEN_TEST(versionId),
    kind: "hidden-test",
    versionId,
    data: deepFreeze(hiddenTest),
    depositedAt: now.toISOString(),
    depositedBy: actor.actorId,
  });
  store.appendAudit({
    actor: actor.actorId,
    action: "version_frozen",
    refs: { versionId, manifestSha256: version.manifestSha256 },
  });
  return version;
}

// 对外视图：hidden-test 数据源只暴露 id 与可见性，uri/哈希不出受限域。
function publicVersion(v) {
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    manifestSha256: v.manifestSha256,
    resultsDeadline: v.resultsDeadline,
    createdAt: v.createdAt,
    frozenAt: v.frozenAt,
    releasedAt: v.releasedAt,
    manifest: {
      tasks: v.manifest.tasks,
      stratification: v.manifest.stratification,
      trainingScope: { allowedSourceIds: v.manifest.trainingScope.allowedSourceIds },
      dataSources: v.manifest.dataSources.map((s) =>
        s.visibility === "hidden-test"
          ? { id: s.id, visibility: s.visibility }
          : { id: s.id, visibility: s.visibility, uri: s.uri || null, sha256: s.sha256, license: s.license || null }
      ),
    },
  };
}

// ---------- 提交与作业 ----------

function createSubmission(store, actor, versionId, body, now) {
  const version = mustGet(store, "versions", versionId, "基准版本");
  if (version.status !== "frozen") {
    throw new HttpError(409, "version_not_frozen", "版本未冻结，暂不接受提交");
  }
  const { weightDigest, runConfig } = body;
  if (!WEIGHT_DIGEST_RE.test(weightDigest || "")) {
    throw new HttpError(422, "invalid_submission", "weightDigest 必须是 sha256:<hex>");
  }
  validateRunConfig(version.manifest, runConfig);
  const submission = {
    id: newId("sub"),
    versionId,
    teamId: teamOf(actor),
    weightDigest,
    runConfig,
    status: "accepted",
    createdAt: now.toISOString(),
  };
  store.insert("submissions", submission);
  const job = {
    id: newId("job"),
    submissionId: submission.id,
    versionId,
    attempt: 1,
    status: "pending",
    lastExecutor: null,
    history: [{ attempt: 1, event: "created", at: now.toISOString() }],
  };
  store.insert("jobs", job);
  store.appendAudit({
    actor: actor.actorId,
    action: "submission_accepted",
    refs: { versionId, submissionId: submission.id, jobId: job.id, teamId: submission.teamId },
  });
  return { submission, job };
}

// 失败重试沿用同一作业身份：jobId 不变，attempt 递增；允许修正运行配置（重新校验训练范围）。
function retryJob(store, actor, jobId, body, now) {
  const job = mustGet(store, "jobs", jobId, "作业");
  const submission = mustGet(store, "submissions", job.submissionId, "提交");
  if (submission.teamId !== teamOf(actor)) {
    throw new HttpError(403, "forbidden", "只能重试本团队的作业");
  }
  if (job.status !== "failed") {
    throw new HttpError(409, "job_not_failed", "只有失败的作业可以重试");
  }
  const version = mustGet(store, "versions", job.versionId, "基准版本");
  if (body.runConfig !== undefined) {
    validateRunConfig(version.manifest, body.runConfig);
    submission.runConfig = body.runConfig;
  }
  job.attempt += 1;
  job.status = "pending";
  job.history.push({ attempt: job.attempt, event: "retry", at: now.toISOString() });
  store.appendAudit({
    actor: actor.actorId,
    action: "job_retried",
    refs: { jobId: job.id, submissionId: submission.id, attempt: job.attempt },
  });
  return job;
}

// ---------- 隔离执行与评测 ----------

// 隔离执行环境回传预测与资源消耗；服务侧只做泄漏检查与指标计算，不接触权重本体。
function recordExecution(store, actor, jobId, body, now) {
  const job = mustGet(store, "jobs", jobId, "作业");
  if (job.status !== "pending") {
    throw new HttpError(409, "job_not_runnable", "作业当前不在待执行状态");
  }
  const submission = mustGet(store, "submissions", job.submissionId, "提交");
  const version = mustGet(store, "versions", job.versionId, "基准版本");
  const restricted = store.get("restricted", RESTRICTED_HIDDEN_TEST(version.id));
  if (!restricted) {
    throw new HttpError(409, "hidden_test_missing", "隐藏测试集尚未存入隔离环境");
  }
  validateResourceUsage(body.resourceUsage);
  job.lastExecutor = actor.actorId;

  const leakage = checkLeakage(version.manifest, restricted.data, submission.runConfig.trainingProvenance);
  if (leakage.leaked) {
    job.status = "failed";
    job.history.push({ attempt: job.attempt, event: "leakage_detected", at: now.toISOString() });
    const result = {
      id: newId("res"),
      jobId: job.id,
      attempt: job.attempt,
      submissionId: submission.id,
      versionId: version.id,
      status: "failed_leakage",
      leakage,
      createdAt: now.toISOString(),
    };
    store.insert("results", result);
    store.appendAudit({
      actor: actor.actorId,
      action: "leakage_detected",
      refs: {
        jobId: job.id,
        submissionId: submission.id,
        attempt: job.attempt,
        overlapCounts: Object.fromEntries(
          Object.entries(leakage.overlaps).map(([k, v]) => [k, v.length])
        ),
      },
    });
    return { job, result };
  }

  let evaluation;
  try {
    evaluation = evaluateTasks(version.manifest, restricted.data, body.predictions);
  } catch (err) {
    job.status = "failed";
    job.history.push({ attempt: job.attempt, event: "evaluation_error", at: now.toISOString() });
    store.appendAudit({
      actor: actor.actorId,
      action: "execution_failed",
      refs: { jobId: job.id, attempt: job.attempt, reason: err.message },
    });
    throw new HttpError(422, "evaluation_failed", `评测失败：${err.message}`);
  }

  const result = {
    id: newId("res"),
    jobId: job.id,
    attempt: job.attempt,
    submissionId: submission.id,
    versionId: version.id,
    status: "succeeded",
    tasks: evaluation.tasks,
    composite: evaluation.composite,
    resourceUsage: body.resourceUsage,
    executorLogRef: body.executorLogRef || null,
    leakage,
    annulled: false,
    createdAt: now.toISOString(),
  };
  store.insert("results", result);
  job.status = "succeeded";
  job.history.push({ attempt: job.attempt, event: "succeeded", at: now.toISOString() });

  // 榜单条目按 (版本, 提交) 只插入一次；后续版本更新不会触碰本版本榜单。
  store.insert("leaderboard", {
    id: `${version.id}:${submission.id}`,
    versionId: version.id,
    submissionId: submission.id,
    teamId: submission.teamId,
    jobId: job.id,
    attempt: job.attempt,
    composite: evaluation.composite,
    tasks: evaluation.tasks,
    resourceUsage: body.resourceUsage,
    weightDigest: submission.weightDigest,
    codeDigest: submission.runConfig.codeDigest,
    annulled: false,
    recordedAt: now.toISOString(),
  });
  store.appendAudit({
    actor: actor.actorId,
    action: "execution_recorded",
    refs: {
      jobId: job.id,
      submissionId: submission.id,
      attempt: job.attempt,
      composite: evaluation.composite,
    },
  });
  return { job, result };
}

// ---------- 结果可见性 ----------

function latestResult(store, submissionId) {
  const results = store
    .filter("results", (r) => r.submissionId === submissionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results[0] || null;
}

function getSubmissionView(store, actor, submissionId, now) {
  const submission = mustGet(store, "submissions", submissionId, "提交");
  const isAdmin = actor.roles.includes("admin");
  if (!isAdmin && submission.teamId !== teamOf(actor)) {
    throw new HttpError(403, "forbidden", "无权查看其他团队的提交");
  }
  const version = mustGet(store, "versions", submission.versionId, "基准版本");
  const jobs = store.filter("jobs", (j) => j.submissionId === submissionId);
  const view = {
    id: submission.id,
    versionId: submission.versionId,
    teamId: submission.teamId,
    weightDigest: submission.weightDigest,
    status: submission.status,
    createdAt: submission.createdAt,
    jobs: jobs.map((j) => ({ id: j.id, attempt: j.attempt, status: j.status, history: j.history })),
  };
  const result = latestResult(store, submissionId);
  if (result) {
    const sealed = now < Date.parse(version.resultsDeadline);
    if (isAdmin || !sealed) {
      view.result = result;
    } else {
      view.resultSealed = true; // 截止日前仅授权管理员可见
    }
  }
  return view;
}

// ---------- 榜单与发布 ----------

function leaderboardView(store, actor, versionId) {
  const version = mustGet(store, "versions", versionId, "基准版本");
  const isAdmin = actor.roles.includes("admin");
  if (!version.releasedAt && !isAdmin) {
    throw new HttpError(403, "leaderboard_sealed", "榜单在发布前仅授权管理员可见");
  }
  const entries = store.filter("leaderboard", (e) => e.versionId === versionId);
  const active = entries
    .filter((e) => !e.annulled)
    .sort((a, b) => b.composite - a.composite)
    .map((e, idx) => ({ rank: idx + 1, ...e }));
  return {
    versionId,
    manifestSha256: version.manifestSha256,
    released: Boolean(version.releasedAt),
    entries: active,
    annulledCount: entries.length - active.length,
  };
}

// 发布是单向的：每版本一次，发布后公开；旧版本榜单与发布文档永不被新版本改写。
function publishRelease(store, actor, versionId, now) {
  const version = mustGet(store, "versions", versionId, "基准版本");
  if (version.status !== "frozen") {
    throw new HttpError(409, "version_not_frozen", "版本未冻结，不能发布");
  }
  if (version.releasedAt) {
    throw new HttpError(409, "already_released", "该版本已发布，发布文档不可改写");
  }
  if (now.getTime() < Date.parse(version.resultsDeadline)) {
    throw new HttpError(409, "release_before_deadline", "截止日前不能发布结果");
  }
  const entries = store
    .filter("leaderboard", (e) => e.versionId === versionId && !e.annulled)
    .sort((a, b) => b.composite - a.composite)
    .map((e, idx) => ({
      rank: idx + 1,
      teamId: e.teamId,
      composite: e.composite,
      tasks: e.tasks,
      resourceUsage: e.resourceUsage,
      weightDigest: e.weightDigest,
      codeDigest: e.codeDigest,
    }));
  const release = {
    id: versionId,
    versionId,
    name: version.name,
    manifestSha256: version.manifestSha256,
    resultsDeadline: version.resultsDeadline,
    publishedAt: now.toISOString(),
    applicabilityScope: {
      species: version.manifest.stratification.species,
      labs: version.manifest.stratification.labs,
    },
    tasks: version.manifest.tasks.map((t) => ({ id: t.id, weight: t.weight, tolerance: t.tolerance })),
    entries,
    auditHead: store.audit.length ? store.audit[store.audit.length - 1].hash : null,
  };
  store.insert("releases", release);
  version.releasedAt = now.toISOString();
  store.appendAudit({
    actor: actor.actorId,
    action: "release_published",
    refs: { versionId, manifestSha256: version.manifestSha256, entries: entries.length },
  });
  return release;
}

function getRelease(store, versionId) {
  const release = store.get("releases", versionId);
  if (!release) throw new HttpError(404, "not_found", "该版本尚未发布");
  return release;
}

// ---------- 申诉 ----------

function fileAppeal(store, actor, body, now) {
  const { jobId, statement, logRefs } = body;
  const job = mustGet(store, "jobs", jobId, "作业");
  const submission = mustGet(store, "submissions", job.submissionId, "提交");
  if (submission.teamId !== teamOf(actor)) {
    throw new HttpError(403, "forbidden", "只能就本团队的作业申诉");
  }
  if (typeof statement !== "string" || !statement) {
    throw new HttpError(422, "invalid_appeal", "申诉陈述缺失");
  }
  if (!Array.isArray(logRefs) || logRefs.length === 0) {
    throw new HttpError(422, "appeal_logs_required", "申诉必须引用至少一条可复查的审计日志");
  }
  for (const seq of logRefs) {
    if (!store.auditGet(seq)) {
      throw new HttpError(422, "unknown_log_ref", `审计日志不存在：seq=${seq}`);
    }
  }
  const appeal = {
    id: newId("app"),
    jobId: job.id,
    submissionId: submission.id,
    versionId: job.versionId,
    filedBy: submission.teamId,
    statement,
    logRefs,
    status: "open",
    decision: null,
    createdAt: now.toISOString(),
  };
  store.insert("appeals", appeal);
  store.appendAudit({
    actor: actor.actorId,
    action: "appeal_filed",
    refs: { appealId: appeal.id, jobId: job.id, logRefs },
  });
  return appeal;
}

// 独立评审：评审人不能是该版本的冻结人、该作业的执行人或申诉方成员。
function decideAppeal(store, actor, appealId, body, now) {
  const appeal = mustGet(store, "appeals", appealId, "申诉");
  if (appeal.status !== "open") {
    throw new HttpError(409, "appeal_closed", "申诉已有结论");
  }
  const version = mustGet(store, "versions", appeal.versionId, "基准版本");
  const job = mustGet(store, "jobs", appeal.jobId, "作业");
  const submission = mustGet(store, "submissions", appeal.submissionId, "提交");
  if (
    actor.actorId === version.frozenBy ||
    actor.actorId === job.lastExecutor ||
    teamOf(actor) === submission.teamId
  ) {
    throw new HttpError(403, "reviewer_not_independent", "评审人与被申诉事项存在关联，须回避");
  }
  const { verdict, rationale } = body;
  if (!["upheld", "rejected"].includes(verdict)) {
    throw new HttpError(422, "invalid_decision", "verdict 必须是 upheld 或 rejected");
  }
  if (typeof rationale !== "string" || !rationale) {
    throw new HttpError(422, "invalid_decision", "评审结论必须给出理由");
  }
  appeal.status = "decided";
  appeal.decision = {
    verdict,
    rationale,
    reviewer: actor.actorId,
    decidedAt: now.toISOString(),
  };
  if (verdict === "upheld") {
    const entry = store.get("leaderboard", `${appeal.versionId}:${appeal.submissionId}`);
    if (entry) {
      entry.annulled = true;
      entry.annulledByAppeal = appeal.id;
    }
    const result = latestResult(store, appeal.submissionId);
    if (result) result.annulled = true;
  }
  store.appendAudit({
    actor: actor.actorId,
    action: "appeal_decided",
    refs: { appealId: appeal.id, verdict, jobId: appeal.jobId },
  });
  return appeal;
}

module.exports = {
  createVersion,
  freezeVersion,
  publicVersion,
  createSubmission,
  retryJob,
  recordExecution,
  getSubmissionView,
  leaderboardView,
  publishRelease,
  getRelease,
  fileAppeal,
  decideAppeal,
};
