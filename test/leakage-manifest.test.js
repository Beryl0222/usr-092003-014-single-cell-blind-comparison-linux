"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { checkLeakage, cosine } = require("../lib/leakage");
const { freezeManifest, prepareManifest } = require("../lib/manifest");

const trainScope = [
  {
    datasetId: "ds-human-labA",
    species: "human",
    lab: "labA",
    sampleIds: ["s-train-1", "s-train-2"],
    profileHashes: ["h-train-1", "h-train-2"],
    donors: ["donor-1"],
    lineages: ["lineage-X"],
    fingerprints: [
      { sampleId: "s-train-1", vector: [1, 0, 0, 0] },
      { sampleId: "s-train-2", vector: [0, 1, 0, 0] },
    ],
  },
];

test("余弦相似度", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
  assert.throws(() => cosine([1], [1, 0]), /维度/);
});

test("泄漏检查：干净样本通过", () => {
  const result = checkLeakage(
    trainScope,
    [
      {
        sampleId: "s-axolotl-1",
        species: "axolotl",
        lab: "labZ",
        donorId: "donor-new",
        lineageId: "lineage-new",
        profileHash: "h-new-1",
        fingerprint: [0, 0, 1, 0],
      },
    ],
    { fingerprintCosine: 0.98 }
  );
  assert.equal(result.verdict, "clean");
  assert.equal(result.findings.length, 0);
  assert.equal(result.pairsChecked, 2);
});

test("泄漏检查：样本ID/内容哈希/供体重叠被判 critical", () => {
  const result = checkLeakage(trainScope, [
    {
      sampleId: "s-train-1", // ID 重叠
      donorId: "donor-9",
      lineageId: "lg-9",
      profileHash: "h-9",
      fingerprint: [0, 0, 1, 0],
    },
    {
      sampleId: "s-new",
      donorId: "donor-1", // 供体重叠
      lineageId: "lg-9",
      profileHash: "h-train-2", // 内容哈希重叠
      fingerprint: [0, 0, 0, 1],
    },
  ]);
  assert.equal(result.verdict, "leaked");
  assert.equal(result.counts.sample_id, 1);
  assert.equal(result.counts.content_hash, 1);
  assert.equal(result.counts.donor_lineage, 1);
});

test("泄漏检查：谱系共享为 high（review），指纹近重复命中阈值", () => {
  const lineageOnly = checkLeakage(trainScope, [
    {
      sampleId: "s-new",
      donorId: "donor-new",
      lineageId: "lineage-X",
      profileHash: "h-new",
      fingerprint: [0, 0, 1, 0],
    },
  ]);
  assert.equal(lineageOnly.verdict, "review");
  assert.equal(lineageOnly.counts.donor_lineage, 1);

  const nearDup = checkLeakage(trainScope, [
    {
      sampleId: "s-new2",
      donorId: "d2",
      lineageId: "lg2",
      profileHash: "h-new2",
      fingerprint: [0.9999, 0.0001, 0, 0], // 与 s-train-1 近似共线
    },
  ]);
  assert.equal(nearDup.verdict, "review");
  assert.equal(nearDup.counts.fingerprint, 1);
  assert.ok(nearDup.findings[0].detail.maxCosine >= 0.98);
});

function validDraft(overrides = {}) {
  return {
    benchmarkId: "xspecies-cell-v1",
    version: "2026.09",
    dataSources: [
      { datasetId: "ds-h", species: "human", lab: "labA", matrixSha256: "a".repeat(64), rows: 100 },
      { datasetId: "ds-m", species: "mouse", lab: "labB", matrixSha256: "b".repeat(64), rows: 80 },
    ],
    trainScope: [{ datasetId: "ds-h" }],
    stratification: [
      { species: "human", lab: "labA", role: "train" },
      { species: "axolotl", lab: "labZ", role: "held_out" },
    ],
    hiddenTest: {
      matrixRef: "matrix-hidden-1",
      unblindingRef: "truth-1",
      sampleCount: 40,
      leakageThresholds: { fingerprintCosine: 0.97 },
    },
    tasks: [
      {
        taskId: "t-species",
        type: "species_identification",
        metrics: [{ metric: "macroF1", threshold: 0.6, tolerance: 0.01 }, { metric: "accuracy" }],
        scope: { classes: ["axolotl", "opossum"] },
      },
      { taskId: "t-health", type: "health_disease", metrics: [{ metric: "auroc", threshold: 0.7 }] },
      {
        taskId: "t-gene",
        type: "missing_gene",
        metrics: [
          { metric: "pearson", threshold: 0.5 },
          { metric: "rmse", threshold: 1.0, tolerance: 0.05 },
        ],
      },
      { taskId: "t-calib", type: "uncertainty_calibration", metrics: [{ metric: "ece", threshold: 0.1 }] },
    ],
    deadline: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

test("清单冻结：规范化、哈希稳定、指标方向锁定", () => {
  const f1 = freezeManifest(validDraft());
  const f2 = freezeManifest(validDraft());
  assert.equal(f1.manifestHash, f2.manifestHash);
  assert.equal(f1.status, "frozen");
  assert.match(f1.manifestHash, /^[a-f0-9]{64}$/);
  const ece = f1.manifest.tasks.find((t) => t.type === "uncertainty_calibration");
  assert.equal(ece.metrics[0].higherIsBetter, false);
  const gene = f1.manifest.tasks.find((t) => t.type === "missing_gene");
  assert.equal(gene.metrics.find((m) => m.metric === "rmse").higherIsBetter, false);
  assert.equal(f1.manifest.hiddenTest.leakageThresholds.fingerprintCosine, 0.97);
});

test("清单校验：拒绝缺项、重复版本外内容、非法指标方向、无 held_out", () => {
  assert.throws(() => prepareManifest(validDraft({ dataSources: [] })), /dataSources/);
  assert.throws(
    () => prepareManifest(validDraft({ stratification: [{ species: "human", lab: "labA", role: "train" }] })),
    /held_out/
  );
  assert.throws(
    () =>
      prepareManifest(
        validDraft({
          tasks: [
            { taskId: "bad", type: "health_disease", metrics: [{ metric: "macroF1" }] },
          ],
        })
      ),
    /不支持指标/
  );
  assert.throws(() => prepareManifest(validDraft({ deadline: "not-a-date" })), /deadline/);
  assert.throws(
    () =>
      prepareManifest(
        validDraft({
          dataSources: [
            { datasetId: "ds-h", species: "human", lab: "labA", matrixSha256: "short", rows: 1 },
          ],
        })
      ),
    /矩阵哈希/
  );
});
