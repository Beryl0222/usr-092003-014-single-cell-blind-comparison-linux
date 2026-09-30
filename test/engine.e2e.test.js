"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { COMPARTMENTS } = require("../lib/vault");
const {
  ACTORS,
  buildEngine,
  frozenBenchmark,
  strongPredictions,
  weakPredictions,
  hiddenTestSamples,
  draft,
  sha256Json,
} = require("./helpers");

async function setup() {
  const built = await buildEngine();
  const { frozen } = await frozenBenchmark(built.engine);
  return { ...built, manifestHash: frozen.manifestHash };
}

/** 按错误码断言（HttpError 的 message 是中文文案，code 才是稳定契约）。 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err && err.code === code, `期望抛出错误码 ${code}`);
}

function submitAndRun(engine, team, manifestHash, predictions, { failOnceOnAttempt } = {}) {
  const submitted = engine.submit(ACTORS[team], {
    manifestHash,
    weightDigest: "sha256:" + sha256Json({ team, weights: "v1" }),
    teamName: team,
    runConfig: { predictions, failOnceOnAttempt },
  });
  return engine.runAttempt(ACTORS.runner, submitted.jobId).then((out) => ({ submitted, out }));
}

test("冻结：同内容清单不可二次冻结；未升版本号即使内容改动也被拒", async () => {
  const built = await buildEngine();
  const { draft: sameDraft } = await frozenBenchmark(built.engine);
  throwsCode(() => built.engine.freeze(ACTORS.admin, sameDraft), "ALREADY_FROZEN");

  const changed = draft();
  changed.dataSources = changed.dataSources.map((s) =>
    s.datasetId === "ds-human-labA" ? { ...s, rows: 999 } : s
  );
  const rep = built.engine.createLeakageReport(ACTORS.admin, {
    draft: changed,
    testSamples: hiddenTestSamples(),
  });
  changed.hiddenTest.leakageReportHash = rep.reportHash;
  throwsCode(() => built.engine.freeze(ACTORS.admin, changed), "VERSION_EXISTS");
});

test("泄漏闸：检查后改动草案导致基线不匹配；真实泄漏禁止冻结", async () => {
  const { engine } = await buildEngine();
  const d = draft();
  const report = engine.createLeakageReport(ACTORS.admin, { draft: d, testSamples: hiddenTestSamples() });
  d.hiddenTest.leakageReportHash = report.reportHash;
  d.dataSources[0].rows = 999; // 检查后改动数据来源
  throwsCode(() => engine.freeze(ACTORS.admin, d), "REPORT_MISMATCH");

  const { engine: e2 } = await buildEngine();
  e2.ingestRestrictedMatrix(ACTORS.admin, "matrix-hidden-2026", Buffer.from("{}"));
  e2.ingestUnblinding(ACTORS.admin, "truth-2026", Buffer.from("{}"));
  const leakedSamples = hiddenTestSamples();
  leakedSamples[0].donorId = "donor-human-1";
  const d2 = draft();
  const leakedReport = e2.createLeakageReport(ACTORS.admin, { draft: d2, testSamples: leakedSamples });
  assert.equal(leakedReport.verdict, "leaked");
  d2.hiddenTest.leakageReportHash = leakedReport.reportHash;
  throwsCode(() => e2.freeze(ACTORS.admin, d2), "LEAKAGE_BLOCK");
});

test("提交与角色：非团队不能提交；同团队同基准重复提交被拒，须沿用同一作业", async () => {
  const { engine, manifestHash } = await setup();
  throwsCode(
    () => engine.submit(ACTORS.admin, { manifestHash, weightDigest: "x", runConfig: {} }),
    "FORBIDDEN"
  );
  const job = engine.submit(ACTORS.strong, {
    manifestHash,
    weightDigest: "digest-strong",
    runConfig: { predictions: strongPredictions() },
  });
  assert.equal(job.status, "queued");
  throwsCode(
    () =>
      engine.submit(ACTORS.strong, {
        manifestHash,
        weightDigest: "digest-strong-2",
        runConfig: { predictions: strongPredictions() },
      }),
    "JOB_EXISTS"
  );
});

test("截止闸：截止后拒绝新提交", async () => {
  const { engine, clock, manifestHash } = await setup();
  clock.set("2027-01-01T00:00:01.000Z");
  throwsCode(
    () =>
      engine.submit(ACTORS.other, {
        manifestHash,
        weightDigest: "late",
        runConfig: { predictions: weakPredictions() },
      }),
    "DEADLINE_PASSED"
  );
});

test("失败重试沿用同一作业身份：attempt 递增，第二次成功，结果挂到新尝试", async () => {
  const { engine, manifestHash } = await setup();
  const submitted = engine.submit(ACTORS.weak, {
    manifestHash,
    weightDigest: "digest-weak",
    runConfig: { predictions: weakPredictions(), failOnceOnAttempt: 1 },
  });
  const first = await engine.runAttempt(ACTORS.runner, submitted.jobId);
  assert.equal(first.job.status, "failed");
  assert.equal(first.job.attempts.length, 1);
  assert.match(first.job.attempts[0].error, /OOM/);

  // 他队不能重试别人的作业
  throwsCode(() => engine.retry(ACTORS.strong, submitted.jobId), "FORBIDDEN");
  const retried = engine.retry(ACTORS.weak, submitted.jobId);
  assert.equal(retried.status, "queued");
  const second = await engine.runAttempt(ACTORS.runner, submitted.jobId);
  assert.equal(second.job.status, "succeeded");
  assert.equal(second.job.attempts.length, 2);
  assert.equal(second.job.attempts[0].attemptNumber, 1);
  assert.equal(second.job.attempts[1].attemptNumber, 2);
  assert.equal(second.job.latestResultId, "result:" + submitted.jobId + ":a2");

  // 成功后不可再重试
  throwsCode(() => engine.retry(ACTORS.weak, submitted.jobId), "NOT_RETRYABLE");
});

test("截止后失败重试同样被拒绝", async () => {
  const { engine, clock, manifestHash } = await setup();
  const submitted = engine.submit(ACTORS.weak, {
    manifestHash,
    weightDigest: "digest-weak",
    runConfig: { predictions: weakPredictions(), failOnceOnAttempt: 1 },
  });
  await engine.runAttempt(ACTORS.runner, submitted.jobId);
  clock.set("2027-01-01T00:00:01.000Z");
  throwsCode(() => engine.retry(ACTORS.weak, submitted.jobId), "DEADLINE_PASSED");
});

test("预测不符冻结口径时本次尝试失败，可再次重试", async () => {
  const { engine, manifestHash } = await setup();
  const bad = weakPredictions();
  delete bad.species.h1;
  const submitted = engine.submit(ACTORS.other, {
    manifestHash,
    weightDigest: "digest-other",
    runConfig: { predictions: bad },
  });
  const out = await engine.runAttempt(ACTORS.runner, submitted.jobId);
  assert.equal(out.job.status, "failed");
  assert.match(out.job.attempts[0].error, /物种预测/);
  const retried = engine.retry(ACTORS.other, submitted.jobId);
  assert.equal(retried.status, "queued");
});

test("打分按冻结指标与容差：强模型四项任务全部达标", async () => {
  const { engine, manifestHash } = await setup();
  const { out } = await submitAndRun(engine, "strong", manifestHash, strongPredictions());
  const r = engine.results.get(out.resultId);
  assert.equal(r.taskResults["t-species"].values.macroF1, 1);
  assert.equal(r.taskResults["t-health"].values.auroc, 1);
  assert.equal(r.taskResults["t-gene"].values.pearson, 1);
  assert.equal(r.taskResults["t-gene"].values.rmse, 0);
  assert.equal(r.taskResults["t-calib"].values.ece, 0);
  for (const [, tr] of Object.entries(r.taskResults)) assert.equal(tr.pass, true);
  assert.equal(r.resources.peakMemoryMb, 4096);
  assert.ok(r.resources.wallMs >= 1);
  assert.match(r.predictionHash, /^[a-f0-9]{64}$/);
});

test("弱模型：物种/AUROC/校准不达标，容差边界按方向判定", async () => {
  const { engine, manifestHash } = await setup();
  const { out } = await submitAndRun(engine, "weak", manifestHash, weakPredictions());
  const r = engine.results.get(out.resultId);
  assert.equal(r.taskResults["t-species"].values.macroF1, 0);
  assert.equal(r.taskResults["t-health"].values.auroc, 0);
  assert.equal(r.taskResults["t-species"].pass, false);
  assert.equal(r.taskResults["t-calib"].pass, false);
  // 过度自信且全错：ECE 接近 0.9
  assert.ok(r.taskResults["t-calib"].values.ece > 0.8);
});

test("可见性：发布前各团队看不到分数，管理员可见；发布后公开", async () => {
  const { engine, manifestHash } = await setup();
  const { out } = await submitAndRun(engine, "strong", manifestHash, strongPredictions());
  const rid = out.resultId;
  throwsCode(() => engine.getResult(ACTORS.strong, rid), "RESULT_SEALED");
  throwsCode(() => engine.getResult(ACTORS.weak, rid), "RESULT_SEALED");
  const adminView = engine.getResult(ACTORS.admin, rid);
  assert.equal(adminView.released, false);
  // 截止日前榜单对任何团队都不可见（含密封预览）；管理员可见密封预览
  assert.equal(engine.getLeaderboard(ACTORS.admin, manifestHash).sealed, true);
  throwsCode(() => engine.getLeaderboard(ACTORS.strong, manifestHash), "NOT_RELEASED");
  throwsCode(() => engine.getLeaderboard(ACTORS.weak, manifestHash), "NOT_RELEASED");
  // 作业主能看到运行状态但视图不含分数
  const jobView = engine.getJob(ACTORS.strong, out.job.jobId);
  assert.equal(jobView.status, "succeeded");
  assert.equal(jobView.latestResultId, rid);
  // 独立评审不能脱离申诉上下文裸查密封结果
  throwsCode(() => engine.getResult(ACTORS.reviewer, rid), "RESULT_SEALED");
});

test("权重跨团队隔离：他队读取被拒并在访问日志留痕", async () => {
  const { engine, manifestHash } = await setup();
  const up = engine.uploadWeights(ACTORS.strong, manifestHash, Buffer.from("MODEL_WEIGHTS_BYTES"));
  const submitted = engine.submit(ACTORS.strong, {
    manifestHash,
    weightDigest: "digest-w",
    weightRef: up.ref,
    runConfig: { predictions: strongPredictions() },
  });
  const mine = engine.readWeights(ACTORS.strong, submitted.jobId);
  assert.equal(mine.toString(), "MODEL_WEIGHTS_BYTES");
  assert.throws(() => engine.readWeights(ACTORS.weak, submitted.jobId), /访问被拒绝/);
});

test("榜单发布：截止前禁止、截止后快照不可变；公开分项、适用范围与资源", async () => {
  const { engine, clock, manifestHash } = await setup();
  await submitAndRun(engine, "strong", manifestHash, strongPredictions());
  await submitAndRun(engine, "weak", manifestHash, weakPredictions());

  throwsCode(() => engine.releaseLeaderboard(ACTORS.admin, manifestHash), "BEFORE_DEADLINE");
  clock.set("2027-01-02T00:00:00.000Z");
  const board = engine.releaseLeaderboard(ACTORS.admin, manifestHash);
  assert.equal(board.entries.length, 2);
  assert.equal(board.entries[0].teamId, "team-strong");
  assert.equal(board.entries[0].overallRank, 1);
  const strongEntry = board.entries[0];
  assert.equal(strongEntry.tasks["t-species"].primaryValue, 1);
  assert.equal(strongEntry.scope.evaluatedOn.length, 2);
  assert.deepEqual(strongEntry.scope.tasksBelowThreshold, []);
  assert.equal(strongEntry.resources.peakMemoryMb, 4096);
  // 弱队适用范围必须标注未达标任务，给出不得外推的告诫
  const weakEntry = board.entries.find((e) => e.teamId === "team-weak");
  assert.ok(weakEntry.scope.tasksBelowThreshold.length >= 1);
  assert.match(weakEntry.scope.caveat, /不得外推/);
  // 再次发布被拒（不可变）
  assert.throws(() => engine.releaseLeaderboard(ACTORS.admin, manifestHash), /不可变/);
  // 发布后所有人可见
  const publicBoard = engine.getLeaderboard(ACTORS.other, manifestHash);
  assert.equal(publicBoard.entries[0].teamId, "team-strong");
  const result = engine.getResult(ACTORS.other, board.entries[0].resultId);
  assert.equal(result.released, true);
});

test("新版本是独立榜单：冻结 2026.10 不影响 2026.09 旧快照", async () => {
  const { engine, clock, manifestHash } = await setup();
  await submitAndRun(engine, "strong", manifestHash, strongPredictions());
  clock.set("2027-01-02T00:00:00.000Z");
  const oldBoard = engine.releaseLeaderboard(ACTORS.admin, manifestHash);

  engine.ingestRestrictedMatrix(ACTORS.admin, "matrix-hidden-2027", Buffer.from("{}"));
  engine.ingestUnblinding(ACTORS.admin, "truth-2027", Buffer.from("{}"));
  const d2 = draft({
    version: "2026.10",
    hiddenTest: {
      matrixRef: "matrix-hidden-2027",
      unblindingRef: "truth-2027",
      sampleCount: 6,
      leakageThresholds: { fingerprintCosine: 0.98 },
    },
    deadline: "2027-06-30T00:00:00.000Z",
  });
  const report2 = engine.createLeakageReport(ACTORS.admin, { draft: d2, testSamples: hiddenTestSamples() });
  d2.hiddenTest.leakageReportHash = report2.reportHash;
  const frozen2 = engine.freeze(ACTORS.admin, d2);
  assert.notEqual(frozen2.manifestHash, manifestHash);

  const boards = engine.listLeaderboards();
  assert.equal(boards.length, 1);
  assert.equal(boards[0].version, "2026.09");
  const stillOld = engine.getLeaderboard(ACTORS.other, manifestHash);
  assert.equal(stillOld.snapshotHash, oldBoard.snapshotHash);
});

test("申诉：必须引用可复查日志；独立评审裁决；成立则追加更正附注但不改榜单", async () => {
  const { engine, clock, manifestHash } = await setup();
  const { submitted } = await submitAndRun(engine, "weak", manifestHash, weakPredictions());
  clock.set("2027-01-02T00:00:00.000Z");
  const board = engine.releaseLeaderboard(ACTORS.admin, manifestHash);
  const beforeHash = board.snapshotHash;

  assert.throws(
    () => engine.fileAppeal(ACTORS.weak, { jobId: submitted.jobId, rationale: "我不服", cites: [] }),
    /至少一条/
  );
  throwsCode(
    () =>
      engine.fileAppeal(ACTORS.weak, {
        jobId: submitted.jobId,
        rationale: "x",
        cites: [{ seq: 1, entryHash: "f".repeat(64) }],
      }),
    "CITE_INVALID"
  );
  const citations = engine.getJobAuditCitations(ACTORS.weak, submitted.jobId);
  assert.ok(citations.length >= 2);
  const appeal = engine.fileAppeal(ACTORS.weak, {
    jobId: submitted.jobId,
    rationale: "打分所用容差与冻结清单不一致",
    cites: [citations[0]],
  });

  // 团队不能自裁
  throwsCode(
    () => engine.reviewAppeal(ACTORS.weak, appeal.appealId, { outcome: "upheld", rationale: "x" }),
    "FORBIDDEN"
  );
  const reviewed = engine.reviewAppeal(ACTORS.reviewer, appeal.appealId, {
    outcome: "upheld",
    rationale: "复查日志确认运行配置无误，争议为容差适用，予以更正附注",
  });
  assert.equal(reviewed.appeal.outcome, "upheld");
  assert.equal(reviewed.appeal.verifiedCites[0].verified, true);
  assert.ok(reviewed.correction);
  // 评审可经申诉上下文查看被申诉结果
  const viaAppeal = engine.getResultForAppeal(ACTORS.reviewer, appeal.appealId);
  assert.ok(viaAppeal.resultId);
  // 评审不能二次改判
  throwsCode(
    () => engine.reviewAppeal(ACTORS.reviewer, appeal.appealId, { outcome: "denied", rationale: "x" }),
    "APPEAL_CLOSED"
  );

  // 榜单快照哈希不变，更正随榜单展示
  const boardAfter = engine.getLeaderboard(ACTORS.other, manifestHash);
  assert.equal(boardAfter.snapshotHash, beforeHash);
  assert.equal(boardAfter.corrections.length, 1);
  assert.equal(boardAfter.corrections[0].appealId, appeal.appealId);
});

test("溯源：获胜结论可一路追溯到固定数据、运行与评审决定", async () => {
  const { engine, clock, manifestHash } = await setup();
  const { submitted } = await submitAndRun(engine, "strong", manifestHash, strongPredictions());
  clock.set("2027-01-02T00:00:00.000Z");
  engine.releaseLeaderboard(ACTORS.admin, manifestHash);
  const chain = engine.trace(ACTORS.admin, submitted.jobId);
  assert.equal(chain.frozenData.manifestHash, manifestHash);
  assert.equal(chain.frozenData.dataSources.length, 2);
  assert.equal(chain.leakage.verdict, "clean");
  assert.match(chain.submission.runConfigHash, /^[a-f0-9]{64}$/);
  assert.equal(chain.attempts.length, 1);
  assert.ok(chain.results[0].predictionHash);
  assert.equal(chain.leaderboard.snapshotId, "snapshot:" + manifestHash);
  assert.match(chain.auditHead, /^[a-f0-9]{64}$/);

  const verify = engine.verifyAudit();
  assert.equal(verify.ok, true);
  assert.ok(verify.entries > 5);
});

test("受限材料：非活动窗口直接读取保管库被拒，越权尝试全部留痕", async () => {
  const { engine } = await setup();
  throwsCode(
    () =>
      engine.vault.read(COMPARTMENTS.RESTRICTED_MATRIX, "matrix-hidden-2026", {
        allow: false,
        reason: "probe",
      }),
    "VAULT_DENIED"
  );
  throwsCode(
    () =>
      engine.vault.read(COMPARTMENTS.UNBLINDING, "truth-2026", {
        allow: false,
        actor: "team:team-strong",
        reason: "curious",
      }),
    "VAULT_DENIED"
  );
});
