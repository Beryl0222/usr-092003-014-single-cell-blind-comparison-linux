"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BenchmarkEngine } = require("../lib/engine");
const { sha256Json } = require("../lib/hash");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-e2e-"));
}

/** 可控时钟：测试可随时拨快时间以验证截止闸。 */
function fakeClock(startIso) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceMs: (ms) => {
      current += ms;
    },
    set: (iso) => {
      current = new Date(iso).getTime();
    },
  };
}

const ACTORS = Object.freeze({
  admin: { id: "admin-1", role: "admin" },
  reviewer: { id: "reviewer-1", role: "reviewer" },
  runner: { id: "runner-1", role: "runner" },
  strong: { id: "member-strong", role: "team", teamId: "team-strong" },
  weak: { id: "member-weak", role: "team", teamId: "team-weak" },
  other: { id: "member-other", role: "team", teamId: "team-other" },
});

const MATRIX_REF = "matrix-hidden-2026";
const TRUTH_REF = "truth-2026";

/** 隐藏测试集：6 个样本，2 个未见物种，健康/病变各半。 */
function hiddenMatrix() {
  return {
    matrixRef: MATRIX_REF,
    generatedAt: "2026-09-01T00:00:00.000Z",
    samples: [
      { sampleId: "h1", species: null, covariates: [0.1, 0.2, 0.3] },
      { sampleId: "h2", species: null, covariates: [0.2, 0.1, 0.4] },
      { sampleId: "h3", species: null, covariates: [0.3, 0.4, 0.1] },
      { sampleId: "h4", species: null, covariates: [0.4, 0.3, 0.2] },
      { sampleId: "h5", species: null, covariates: [0.2, 0.2, 0.2] },
      { sampleId: "h6", species: null, covariates: [0.3, 0.1, 0.3] },
    ],
  };
}

/** 揭盲材料（真值）：运行器永远拿不到，仅打分进程内部读取。 */
function truth() {
  const species = {
    h1: "axolotl",
    h2: "axolotl",
    h3: "opossum",
    h4: "opossum",
    h5: "axolotl",
    h6: "opossum",
  };
  const health = {
    h1: "healthy",
    h2: "disease",
    h3: "healthy",
    h4: "disease",
    h5: "healthy",
    h6: "disease",
  };
  const genes = {
    h1: [0.1, 0.5, 0.9, 0.2],
    h2: [0.8, 0.3, 0.4, 0.6],
    h3: [0.2, 0.7, 0.1, 0.9],
    h4: [0.6, 0.6, 0.5, 0.3],
    h5: [0.3, 0.4, 0.8, 0.1],
    h6: [0.7, 0.2, 0.6, 0.4],
  };
  return { sampleOrder: ["h1", "h2", "h3", "h4", "h5", "h6"], labels: { species, health }, heldOutGenes: genes };
}

/** 强模型预测：物种全对、病变完美分离、基因贴真值、校准自信且正确。 */
function strongPredictions() {
  const t = truth();
  const species = {};
  const healthScores = {};
  const calib = {};
  const genes = {};
  for (const id of t.sampleOrder) {
    species[id] = t.labels.species[id];
    healthScores[id] = t.labels.health[id] === "disease" ? 0.95 : 0.05;
    calib[id] = t.labels.health[id] === "disease" ? [0, 1] : [1, 0];
    genes[id] = t.heldOutGenes[id].map((v) => v);
  }
  return { species, health: healthScores, calibration: calib, missingGene: genes };
}

/** 弱模型预测：物种全错、病变反向、基因噪声、过度自信且错误。 */
function weakPredictions() {
  const t = truth();
  const species = {};
  const healthScores = {};
  const calib = {};
  const genes = {};
  for (const id of t.sampleOrder) {
    species[id] = t.labels.species[id] === "axolotl" ? "opossum" : "axolotl";
    healthScores[id] = t.labels.health[id] === "disease" ? 0.05 : 0.95;
    calib[id] = t.labels.health[id] === "disease" ? [0.95, 0.05] : [0.05, 0.95];
    // 确定性偏移，相关但偏差大
    genes[id] = t.heldOutGenes[id].map((v, i) => 0.5 + ((i % 2) * 0.4 - v * 0.1));
  }
  return { species, health: healthScores, calibration: calib, missingGene: genes };
}

function trainScope() {
  return [
    {
      datasetId: "ds-human-labA",
      species: "human",
      lab: "labA",
      sampleIds: ["train-1", "train-2"],
      profileHashes: ["hash-train-1", "hash-train-2"],
      donors: ["donor-human-1"],
      lineages: ["lineage-human-A"],
      fingerprints: [
        { sampleId: "train-1", vector: [1, 0, 0, 0] },
        { sampleId: "train-2", vector: [0, 1, 0, 0] },
      ],
    },
  ];
}

function hiddenTestSamples() {
  return ["h1", "h2", "h3", "h4", "h5", "h6"].map((id, i) => ({
    sampleId: id,
    species: i % 2 === 0 ? "axolotl" : "opossum",
    lab: "labZ",
    donorId: "donor-" + id,
    lineageId: "lineage-" + id,
    profileHash: "hash-" + id,
    fingerprint: [0, 0, Math.cos(i), Math.sin(i)],
  }));
}

function draft(overrides = {}) {
  return {
    benchmarkId: "xspecies-cell",
    version: "2026.09",
    dataSources: [
      { datasetId: "ds-human-labA", species: "human", lab: "labA", matrixSha256: "a".repeat(64), rows: 200 },
      { datasetId: "ds-mouse-labB", species: "mouse", lab: "labB", matrixSha256: "b".repeat(64), rows: 160 },
    ],
    trainScope: trainScope(),
    stratification: [
      { species: "human", lab: "labA", role: "train" },
      { species: "mouse", lab: "labB", role: "train" },
      { species: "axolotl", lab: "labZ", role: "held_out" },
      { species: "opossum", lab: "labZ", role: "held_out" },
    ],
    hiddenTest: {
      matrixRef: MATRIX_REF,
      unblindingRef: TRUTH_REF,
      sampleCount: 6,
      leakageThresholds: { fingerprintCosine: 0.98 },
    },
    tasks: [
      {
        taskId: "t-species",
        type: "species_identification",
        metrics: [{ metric: "macroF1", threshold: 0.6, tolerance: 0.01 }, { metric: "accuracy" }],
        scope: { classes: ["axolotl", "opossum"] },
      },
      {
        taskId: "t-health",
        type: "health_disease",
        metrics: [{ metric: "auroc", threshold: 0.7, tolerance: 0.0 }],
        scope: { positiveLabel: "disease" },
      },
      {
        taskId: "t-gene",
        type: "missing_gene",
        metrics: [
          { metric: "pearson", threshold: 0.5 },
          { metric: "rmse", threshold: 0.6, tolerance: 0.05 },
        ],
      },
      {
        taskId: "t-calib",
        type: "uncertainty_calibration",
        metrics: [
          { metric: "ece", threshold: 0.1, tolerance: 0.01 },
          { metric: "brier" },
        ],
        scope: { classes: ["healthy", "disease"], binCount: 5 },
      },
    ],
    deadline: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 脚本运行器（测试替身）：只使用矩阵与团队提交的运行配置；
 * failOnceOnAttempt 可模拟首次尝试瞬时崩溃、重试成功。
 */
function scriptedRunner() {
  return async ({ runConfig, attempt }) => {
    if (runConfig.failOnceOnAttempt === attempt.attemptNumber) {
      throw new Error("隔离环境瞬时故障：容器 OOM");
    }
    return {
      predictions: runConfig.predictions,
      resources: runConfig.resources || {
        runtimeMs: 12000,
        peakMemoryMb: 4096,
        cpuMillis: 30500,
      },
    };
  };
}

async function buildEngine() {
  const dir = tempDir();
  const clock = fakeClock("2026-09-30T08:00:00.000Z");
  const engine = new BenchmarkEngine({ rootDir: dir, runner: scriptedRunner(), clock: clock.now });
  return { dir, clock, engine };
}

/** 一键冻结：入库 → 泄漏检查 → 冻结，返回冻结体。 */
async function frozenBenchmark(engine, draftOverrides = {}) {
  engine.ingestRestrictedMatrix(ACTORS.admin, MATRIX_REF, Buffer.from(JSON.stringify(hiddenMatrix())));
  engine.ingestUnblinding(ACTORS.admin, TRUTH_REF, Buffer.from(JSON.stringify(truth())));
  const d = draft(draftOverrides);
  const report = engine.createLeakageReport(ACTORS.admin, {
    draft: d,
    testSamples: hiddenTestSamples(),
  });
  d.hiddenTest.leakageReportHash = report.reportHash;
  const frozen = engine.freeze(ACTORS.admin, d);
  return { frozen, report, draft: d };
}

module.exports = {
  tempDir,
  fakeClock,
  ACTORS,
  MATRIX_REF,
  TRUTH_REF,
  hiddenMatrix,
  truth,
  strongPredictions,
  weakPredictions,
  trainScope,
  hiddenTestSamples,
  draft,
  scriptedRunner,
  buildEngine,
  frozenBenchmark,
  sha256Json,
};
