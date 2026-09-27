"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createApp } = require("../src/app");
const metrics = require("../src/metrics");

const TOKENS = {
  admin: { actorId: "admin-1", roles: ["admin"] },
  exec: { actorId: "executor-1", roles: ["executor"] },
  teamA: { actorId: "team-a-1", teamId: "team-a", roles: ["team"] },
  teamB: { actorId: "team-b-1", teamId: "team-b", roles: ["team"] },
  reviewer: { actorId: "reviewer-1", roles: ["reviewer"] },
  conflict: { actorId: "admin-1", roles: ["admin", "reviewer"] },
};

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function makeManifest() {
  return {
    dataSources: [
      { id: "atlas-human", uri: "s3://open/atlas-human.h5ad", sha256: "a".repeat(64), visibility: "train-visible", license: "CC-BY" },
      { id: "atlas-mouse", uri: "s3://open/atlas-mouse.h5ad", sha256: "b".repeat(64), visibility: "train-visible", license: "CC-BY" },
      { id: "heldout-macaque", uri: "s3://vault/macaque.h5ad", sha256: "c".repeat(64), visibility: "hidden-test" },
    ],
    trainingScope: { allowedSourceIds: ["atlas-human", "atlas-mouse"] },
    stratification: { species: ["human", "mouse", "macaque"], labs: ["lab-x", "lab-y"] },
    tasks: [
      { id: "unseen_species_id", weight: 1, tolerance: { min: 0.5 } },
      { id: "health_disease", weight: 1, tolerance: { min: 0.7 } },
      { id: "missing_gene", weight: 1, tolerance: { min: 0.3 } },
      { id: "uncertainty_calibration", weight: 1, tolerance: { max: 0.4 } },
    ],
  };
}

function makeHiddenTest() {
  return {
    lineageIndex: {
      sampleIds: ["S-hidden-1", "S-hidden-2"],
      donorIds: ["D-hidden-1"],
      species: ["macaque"],
      labs: ["lab-z"],
    },
    tasks: {
      unseen_species_id: { labels: ["spA", "spB", "spA", "spB"] },
      health_disease: { labels: [0, 0, 1, 1] },
      missing_gene: { values: [1, 2, 3, 4] },
      uncertainty_calibration: { correct: [true, true, false, true] },
    },
  };
}

function goodPredictions() {
  return {
    unseen_species_id: { labels: ["spA", "spB", "spA", "spB"] },
    health_disease: { scores: [0.1, 0.2, 0.8, 0.9] },
    missing_gene: { values: [1, 2, 3, 4.5] },
    uncertainty_calibration: { confidences: [0.9, 0.8, 0.7, 0.6] },
  };
}

function makeRunConfig(overrides = {}) {
  return {
    codeRef: "git://example/repo@abc123",
    codeDigest: "sha256:" + "d".repeat(64),
    trainingProvenance: {
      sourceIds: ["atlas-human"],
      sampleIds: ["S-train-1"],
      donorIds: ["D-train-1"],
      species: ["human"],
      labs: ["lab-x"],
    },
    ...overrides,
  };
}

const RESOURCE_USAGE = { wallClockSec: 120, gpuHours: 0.5, memPeakGb: 8 };

async function withServer(run) {
  const server = createApp({ tokens: TOKENS });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run("http://127.0.0.1:" + server.address().port, server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function frozenVersion(base, deadline = FUTURE) {
  const created = await api(base, "POST", "/v1/versions", {
    token: "admin",
    body: { name: "v1", resultsDeadline: deadline, manifest: makeManifest() },
  });
  assert.equal(created.status, 201);
  const frozen = await api(base, "POST", `/v1/versions/${created.body.id}/freeze`, {
    token: "admin",
    body: { hiddenTest: makeHiddenTest() },
  });
  assert.equal(frozen.status, 200);
  return frozen.body;
}

async function submittedJob(base, versionId, token = "teamA", runConfig = makeRunConfig()) {
  const res = await api(base, "POST", `/v1/versions/${versionId}/submissions`, {
    token,
    body: { weightDigest: "sha256:" + "e".repeat(64), runConfig },
  });
  assert.equal(res.status, 201);
  return res.body;
}

test("版本冻结后清单哈希固定且不可再冻结", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base);
    assert.equal(version.status, "frozen");
    assert.match(version.manifestSha256, /^[0-9a-f]{64}$/);

    const again = await api(base, "POST", `/v1/versions/${version.id}/freeze`, {
      token: "admin",
      body: { hiddenTest: makeHiddenTest() },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "already_frozen");

    // 公开视图不含隐藏测试集内容，hidden-test 数据源只暴露 id 与可见性
    const pub = await api(base, "GET", `/v1/versions/${version.id}`);
    assert.equal(pub.status, 200);
    assert.equal(JSON.stringify(pub.body).includes("S-hidden-1"), false);
    const hidden = pub.body.manifest.dataSources.find((s) => s.id === "heldout-macaque");
    assert.deepEqual(Object.keys(hidden).sort(), ["id", "visibility"]);
  });
});

test("训练可见范围越界的提交被拒绝", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base);
    const bad = makeRunConfig();
    bad.trainingProvenance.sourceIds = ["atlas-human", "heldout-macaque"];
    const res = await api(base, "POST", `/v1/versions/${version.id}/submissions`, {
      token: "teamA",
      body: { weightDigest: "sha256:" + "e".repeat(64), runConfig: bad },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "training_scope_violation");
  });
});

test("谱系泄漏判失败，重试沿用同一作业身份并成功", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base);
    const leaky = makeRunConfig();
    leaky.trainingProvenance.donorIds = ["D-train-1", "D-hidden-1"];
    const { job } = await submittedJob(base, version.id, "teamA", leaky);

    const exec1 = await api(base, "POST", `/v1/jobs/${job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });
    assert.equal(exec1.status, 201);
    assert.equal(exec1.body.result.status, "failed_leakage");
    assert.deepEqual(exec1.body.result.leakage.overlaps.donorIds, ["D-hidden-1"]);
    assert.equal(exec1.body.job.status, "failed");

    // 重试：同一 jobId，attempt 递增，修正后的配置重新过训练范围校验
    const retry = await api(base, "POST", `/v1/jobs/${job.id}/retry`, {
      token: "teamA",
      body: { runConfig: makeRunConfig() },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, job.id);
    assert.equal(retry.body.attempt, 2);
    assert.equal(retry.body.status, "pending");

    const exec2 = await api(base, "POST", `/v1/jobs/${job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });
    assert.equal(exec2.status, 201);
    assert.equal(exec2.body.result.status, "succeeded");
    assert.equal(exec2.body.result.tasks.unseen_species_id.value, 1);
    assert.equal(exec2.body.result.tasks.health_disease.value, 1);
    const expectedPearson = metrics.pearson([1, 2, 3, 4], [1, 2, 3, 4.5]);
    assert.equal(exec2.body.result.tasks.missing_gene.value, Math.round(expectedPearson * 1e6) / 1e6);
    const expectedEce = metrics.ece([true, true, false, true], [0.9, 0.8, 0.7, 0.6]);
    assert.equal(exec2.body.result.tasks.uncertainty_calibration.value, Math.round(expectedEce * 1e6) / 1e6);
    for (const t of Object.values(exec2.body.result.tasks)) assert.equal(t.pass, true);

    // 非失败作业不能再重试
    const retry2 = await api(base, "POST", `/v1/jobs/${job.id}/retry`, { token: "teamA", body: {} });
    assert.equal(retry2.status, 409);
  });
});

test("截止日前结果对团队密封、对管理员可见", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base, FUTURE);
    const { submission, job } = await submittedJob(base, version.id);
    await api(base, "POST", `/v1/jobs/${job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });

    const teamView = await api(base, "GET", `/v1/submissions/${submission.id}`, { token: "teamA" });
    assert.equal(teamView.status, 200);
    assert.equal(teamView.body.resultSealed, true);
    assert.equal(teamView.body.result, undefined);

    const adminView = await api(base, "GET", `/v1/submissions/${submission.id}`, { token: "admin" });
    assert.equal(adminView.status, 200);
    assert.equal(adminView.body.result.status, "succeeded");

    const otherTeam = await api(base, "GET", `/v1/submissions/${submission.id}`, { token: "teamB" });
    assert.equal(otherTeam.status, 403);

    const board = await api(base, "GET", `/v1/versions/${version.id}/leaderboard`, { token: "teamA" });
    assert.equal(board.status, 403);
    assert.equal(board.body.error.code, "leaderboard_sealed");
  });
});

test("发布需过截止日，发布后公开分项表现、适用范围与资源消耗", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base, PAST);
    const { job } = await submittedJob(base, version.id);
    await api(base, "POST", `/v1/jobs/${job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });

    const release = await api(base, "POST", `/v1/versions/${version.id}/release`, { token: "admin" });
    assert.equal(release.status, 201);
    assert.deepEqual(release.body.applicabilityScope, { species: ["human", "mouse", "macaque"], labs: ["lab-x", "lab-y"] });
    assert.equal(release.body.entries.length, 1);
    const entry = release.body.entries[0];
    assert.equal(entry.rank, 1);
    assert.equal(entry.teamId, "team-a");
    assert.equal(entry.weightDigest, "sha256:" + "e".repeat(64));
    assert.deepEqual(entry.resourceUsage, RESOURCE_USAGE);
    assert.equal(typeof entry.tasks.unseen_species_id.value, "number");
    // 发布文档不携带隐藏测试集与预测明细
    const text = JSON.stringify(release.body);
    assert.equal(text.includes("S-hidden-1"), false);
    assert.equal(text.includes("predictions"), false);

    // 公开发布文档无需凭证；重复发布被拒绝
    const pub = await api(base, "GET", `/v1/versions/${version.id}/release`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.manifestSha256, version.manifestSha256);
    const again = await api(base, "POST", `/v1/versions/${version.id}/release`, { token: "admin" });
    assert.equal(again.status, 409);

    const board = await api(base, "GET", `/v1/versions/${version.id}/leaderboard`, { token: "teamB" });
    assert.equal(board.status, 200);
    assert.equal(board.body.entries.length, 1);
  });
});

test("截止日前不能发布", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base, FUTURE);
    const res = await api(base, "POST", `/v1/versions/${version.id}/release`, { token: "admin" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "release_before_deadline");
  });
});

test("新版本不改写旧榜单", async () => {
  await withServer(async (base) => {
    const v1 = await frozenVersion(base, PAST);
    const s1 = await submittedJob(base, v1.id, "teamA");
    await api(base, "POST", `/v1/jobs/${s1.job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });
    await api(base, "POST", `/v1/versions/${v1.id}/release`, { token: "admin" });
    const before = await api(base, "GET", `/v1/versions/${v1.id}/leaderboard`, { token: "admin" });

    // 新版本走完整流程
    const v2 = await frozenVersion(base, PAST);
    const s2 = await submittedJob(base, v2.id, "teamB");
    await api(base, "POST", `/v1/jobs/${s2.job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });
    await api(base, "POST", `/v1/versions/${v2.id}/release`, { token: "admin" });

    const after = await api(base, "GET", `/v1/versions/${v1.id}/leaderboard`, { token: "admin" });
    assert.deepEqual(after.body, before.body);
    const v2board = await api(base, "GET", `/v1/versions/${v2.id}/leaderboard`, { token: "admin" });
    assert.equal(v2board.body.entries.length, 1);
    assert.equal(v2board.body.entries[0].teamId, "team-b");
  });
});

test("申诉须引用可复查日志，独立评审裁决并废止榜单条目", async () => {
  await withServer(async (base) => {
    const version = await frozenVersion(base, PAST);
    const { submission, job } = await submittedJob(base, version.id);
    await api(base, "POST", `/v1/jobs/${job.id}/executions`, {
      token: "exec",
      body: { predictions: goodPredictions(), resourceUsage: RESOURCE_USAGE },
    });

    // 缺日志引用 / 引用不存在
    const noLogs = await api(base, "POST", "/v1/appeals", {
      token: "teamA",
      body: { jobId: job.id, statement: "评测环境异常", logRefs: [] },
    });
    assert.equal(noLogs.status, 422);
    const badRef = await api(base, "POST", "/v1/appeals", {
      token: "teamA",
      body: { jobId: job.id, statement: "评测环境异常", logRefs: [9999] },
    });
    assert.equal(badRef.status, 422);

    const audit = await api(base, "GET", "/v1/audit", { token: "admin" });
    assert.equal(audit.body.valid, true);
    const execLog = audit.body.entries.find((e) => e.action === "execution_recorded");

    const filed = await api(base, "POST", "/v1/appeals", {
      token: "teamA",
      body: { jobId: job.id, statement: "评测环境异常，见执行日志", logRefs: [execLog.seq] },
    });
    assert.equal(filed.status, 201);
    assert.equal(filed.body.status, "open");

    // 冻结人须回避：reviewer-conflict 的 actorId 与冻结人同为 admin-1
    const conflict = await api(base, "POST", `/v1/appeals/${filed.body.id}/decision`, {
      token: "conflict",
      body: { verdict: "upheld", rationale: "不应被接受" },
    });
    assert.equal(conflict.status, 403);
    assert.equal(conflict.body.error.code, "reviewer_not_independent");

    // 独立评审裁决成立 → 榜单条目废止
    const decided = await api(base, "POST", `/v1/appeals/${filed.body.id}/decision`, {
      token: "reviewer",
      body: { verdict: "upheld", rationale: "执行日志显示环境故障，成绩作废" },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.decision.verdict, "upheld");

    const board = await api(base, "GET", `/v1/versions/${version.id}/leaderboard`, { token: "admin" });
    assert.equal(board.body.entries.length, 0);
    assert.equal(board.body.annulledCount, 1);

    const auditAfter = await api(base, "GET", "/v1/audit", { token: "admin" });
    assert.equal(auditAfter.body.valid, true);
    assert.ok(auditAfter.body.entries.some((e) => e.action === "appeal_decided"));
  });
});

test("指标函数：accuracy / auroc / ece / pearson", () => {
  assert.equal(metrics.accuracy([1, 0, 1], [1, 1, 1]), 2 / 3);
  assert.equal(metrics.auroc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  assert.equal(metrics.auroc([0, 1], [0.9, 0.1]), 0);
  // 平局取平均秩：分数全相同 → 0.5
  assert.equal(metrics.auroc([0, 0, 1, 1], [0.5, 0.5, 0.5, 0.5]), 0.5);
  assert.equal(metrics.ece([true], [1]), 0);
  assert.equal(metrics.ece([false], [1]), 1);
  assert.equal(metrics.pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(metrics.pearson([1, 1, 1], [1, 2, 3]), 0);
  assert.throws(() => metrics.auroc([1, 1], [0.1, 0.2]), /正负样本/);
});
