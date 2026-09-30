"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../service");
const { BenchmarkEngine } = require("../lib/engine");
const {
  ACTORS,
  hiddenMatrix,
  truth,
  strongPredictions,
  weakPredictions,
  hiddenTestSamples,
  draft,
  scriptedRunner,
} = require("./helpers");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-api-"));
}

const TOKENS = {
  "admin-token": { id: "admin-1", role: "admin" },
  "reviewer-token": { id: "reviewer-1", role: "reviewer" },
  "runner-token": { id: "runner-1", role: "runner" },
};
const TEAM = (id) => "team-" + id;

async function withServer(run) {
  const rootDir = tempDir();
  const engine = new BenchmarkEngine({ rootDir, runner: scriptedRunner() });
  const server = createServer({ rootDir, tokens: TOKENS, engine });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    engine.close();
  }
}

async function req(base, method, urlPath, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = "Bearer " + token;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(base + urlPath, { method, headers, body: payload });
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("application/json")) return { status: response.status, json: await response.json() };
  return { status: response.status, buf: await response.arrayBuffer() };
}

async function freezeFresh(base) {
  await req(base, "PUT", "/v1/admin/matrices/matrix-hidden-2026", {
    token: "admin-token",
    raw: JSON.stringify(hiddenMatrix()),
  });
  await req(base, "PUT", "/v1/admin/unblinding/truth-2026", {
    token: "admin-token",
    raw: JSON.stringify(truth()),
  });
  const d = draft();
  const report = await req(base, "POST", "/v1/admin/leakage-reports", {
    token: "admin-token",
    body: { draft: d, testSamples: hiddenTestSamples() },
  });
  d.hiddenTest.leakageReportHash = report.json.reportHash;
  const frozen = await req(base, "POST", "/v1/admin/manifests", { token: "admin-token", body: d });
  return frozen.json.manifestHash;
}

test("HTTP：未认证被拒；健康检查公开", async () => {
  await withServer(async (base) => {
    const health = await fetch(base + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "single-cell-blind-comparison");
    const noAuth = await req(base, "GET", "/v1/jobs");
    assert.equal(noAuth.status, 401);
    const badToken = await req(base, "GET", "/v1/jobs", { token: "nope" });
    assert.equal(badToken.status, 401);
    // 普通团队不能调管理接口
    const forbidden = await req(base, "POST", "/v1/admin/manifests", {
      token: TEAM("x"),
      body: {},
    });
    assert.equal(forbidden.status, 403);
  });
});

test("HTTP：完整生命周期——冻结/提交/运行/密封/发布/公开/申诉/溯源", async () => {
  await withServer(async (base) => {
    const manifestHash = await freezeFresh(base);

    // 两队提交
    async function submit(teamId, predictions) {
      const res = await req(base, "POST", "/v1/jobs", {
        token: TEAM(teamId),
        body: {
          manifestHash,
          weightDigest: "digest-" + teamId,
          teamName: teamId,
          runConfig: { predictions },
        },
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json.jobId;
    }
    const jobStrong = await submit("strong", strongPredictions());
    const jobWeak = await submit("weak", weakPredictions());

    async function run(jobId) {
      const res = await req(base, "POST", `/v1/runner/jobs/${jobId}/run`, {
        token: "runner-token",
        body: {},
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      return res.json;
    }
    const runStrong = await run(jobStrong);
    const runWeak = await run(jobWeak);
    assert.equal(runStrong.job.status, "succeeded");

    // 截止前：团队拿结果 → 403
    const sealedTeam = await req(base, "GET", `/v1/results/${runStrong.resultId}`, {
      token: TEAM("strong"),
    });
    assert.equal(sealedTeam.status, 403);
    assert.equal(sealedTeam.json.error.code, "RESULT_SEALED");
    // 管理员可见
    const adminResult = await req(base, "GET", `/v1/results/${runStrong.resultId}`, {
      token: "admin-token",
    });
    assert.equal(adminResult.status, 200);
    assert.equal(adminResult.json.released, false);

    // 运行器无权发起管理操作
    const runnerNotAdmin = await req(base, "POST", `/v1/admin/leaderboards/${manifestHash}/release`, {
      token: "runner-token",
      body: {},
    });
    assert.equal(runnerNotAdmin.status, 403);

    // 截止前禁止发布
    const early = await req(base, "POST", `/v1/admin/leaderboards/${manifestHash}/release`, {
      token: "admin-token",
      body: {},
    });
    assert.equal(early.status, 403);
    assert.equal(early.json.error.code, "BEFORE_DEADLINE");
    // 管理员强制发布（截止闸由 force 显式绕过，留审计痕迹）
    const released = await req(base, "POST", `/v1/admin/leaderboards/${manifestHash}/release`, {
      token: "admin-token",
      body: { force: true },
    });
    assert.equal(released.status, 201);
    assert.equal(released.json.entries[0].teamId, "strong");
    assert.equal(released.json.entries[0].overallRank, 1);
    assert.ok(released.json.taskDefs.length === 4);

    // 公开榜单与结果（无令牌也可读取发布内容）
    const publicBoard = await fetch(base + `/v1/leaderboards/${manifestHash}`);
    assert.equal(publicBoard.status, 200);
    const publicResult = await fetch(base + `/v1/results/${runStrong.resultId}`);
    assert.equal(publicResult.status, 200);
    assert.equal((await publicResult.json()).released, true);

    // 弱队申诉：先取可引用日志，再引用提交
    const cites = await req(base, "GET", `/v1/jobs/${jobWeak}/audit-citations`, {
      token: TEAM("weak"),
    });
    assert.equal(cites.status, 200);
    assert.ok(cites.json.citations.length >= 2);
    const appeal = await req(base, "POST", "/v1/appeals", {
      token: TEAM("weak"),
      body: {
        jobId: jobWeak,
        rationale: "对容差适用有异议",
        cites: [cites.json.citations[0]],
      },
    });
    assert.equal(appeal.status, 201);
    const appealId = appeal.json.appealId;

    const reviewed = await req(base, "POST", `/v1/reviewer/appeals/${appealId}`, {
      token: "reviewer-token",
      body: { outcome: "upheld", rationale: "日志复查成立，附注更正但不改榜" },
    });
    assert.equal(reviewed.status, 200);
    assert.ok(reviewed.json.correction);

    // 更正附注出现在公开榜单上
    const boardAfter = await fetch(base + `/v1/leaderboards/${manifestHash}`);
    const boardJson = await boardAfter.json();
    assert.equal(boardJson.corrections.length, 1);

    // 溯源链
    const trace = await req(base, "GET", `/v1/jobs/${jobStrong}/trace`, { token: "admin-token" });
    assert.equal(trace.status, 200);
    assert.equal(trace.json.frozenData.manifestHash, manifestHash);
    assert.equal(trace.json.leaderboard.snapshotId, "snapshot:" + manifestHash);
    assert.equal(trace.json.corrections.length, 0);

    // 审计哈希链自检
    const verify = await req(base, "GET", "/v1/admin/audit/verify", { token: "admin-token" });
    assert.equal(verify.json.ok, true);
    assert.ok(verify.json.entries > 10);

    // 权重隔离：他队下载被 403
    const weightsUp = await req(base, "POST", `/v1/teams/weights?manifestHash=${manifestHash}`, {
      token: TEAM("strong"),
      raw: "WEIGHTS",
    });
    assert.equal(weightsUp.status, 201);
    // 已存在作业不允许再次提交
    const dupSubmit = await req(base, "POST", "/v1/jobs", {
      token: TEAM("strong"),
      body: { manifestHash, weightDigest: "d2", runConfig: {} },
    });
    assert.equal(dupSubmit.status, 409);
    assert.equal(dupSubmit.json.error.code, "JOB_EXISTS");
  });
});

test("HTTP：失败重试沿用同一作业身份", async () => {
  await withServer(async (base) => {
    const manifestHash = await freezeFresh(base);
    const weak = weakPredictions();
    const submitted = await req(base, "POST", "/v1/jobs", {
      token: TEAM("weak"),
      body: {
        manifestHash,
        weightDigest: "d",
        runConfig: { predictions: weak, failOnceOnAttempt: 1 },
      },
    });
    const jobId = submitted.json.jobId;
    const first = await req(base, "POST", `/v1/runner/jobs/${jobId}/run`, {
      token: "runner-token",
      body: {},
    });
    assert.equal(first.json.job.status, "failed");
    const retry = await req(base, "POST", `/v1/jobs/${jobId}/retry`, { token: TEAM("weak") });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.status, "queued");
    const second = await req(base, "POST", `/v1/runner/jobs/${jobId}/run`, {
      token: "runner-token",
      body: {},
    });
    assert.equal(second.json.job.status, "succeeded");
    assert.equal(second.json.job.attempts.length, 2);
    assert.equal(second.json.resultId, `result:${jobId}:a2`);
  });
});
