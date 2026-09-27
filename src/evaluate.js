"use strict";

const metrics = require("./metrics");
const { round6 } = require("./util");

// 四类评测任务：指标与方向由任务类型固定，清单只能声明权重与容差。
const TASK_DEFS = {
  unseen_species_id: {
    metric: "accuracy",
    direction: "max",
    run: (gt, pred) => metrics.accuracy(gt.labels, pred.labels),
  },
  health_disease: {
    metric: "auroc",
    direction: "max",
    run: (gt, pred) => metrics.auroc(gt.labels, pred.scores),
  },
  missing_gene: {
    metric: "pearson",
    direction: "max",
    run: (gt, pred) => metrics.pearson(gt.values, pred.values),
  },
  uncertainty_calibration: {
    metric: "ece",
    direction: "min",
    run: (gt, pred) => metrics.ece(gt.correct, pred.confidences),
  },
};

const KNOWN_TASK_IDS = Object.keys(TASK_DEFS);

// 对照冻结清单逐任务评分。任一任务缺真值或缺预测都视为执行失败。
function evaluateTasks(manifest, hiddenTest, predictions) {
  if (!predictions || typeof predictions !== "object") {
    throw new Error("预测结果缺失或不是对象");
  }
  const tasks = {};
  let weightedSum = 0;
  let weightTotal = 0;
  for (const task of manifest.tasks) {
    const def = TASK_DEFS[task.id];
    const gt = hiddenTest.tasks && hiddenTest.tasks[task.id];
    const pred = predictions[task.id];
    if (!gt) throw new Error(`隐藏测试缺少任务 ${task.id} 的真值`);
    if (!pred) throw new Error(`预测结果缺少任务 ${task.id}`);
    const value = def.run(gt, pred);
    if (!Number.isFinite(value)) throw new Error(`任务 ${task.id} 的指标结果不是有限值`);
    const pass =
      def.direction === "max"
        ? task.tolerance.min === undefined || value >= task.tolerance.min
        : task.tolerance.max === undefined || value <= task.tolerance.max;
    // 方向归一化到“越大越好”，min 类指标映射到 (0,1]。
    const oriented = def.direction === "max" ? value : 1 / (1 + value);
    tasks[task.id] = { metric: def.metric, value: round6(value), pass, tolerance: task.tolerance };
    weightedSum += oriented * task.weight;
    weightTotal += task.weight;
  }
  return { tasks, composite: round6(weightedSum / weightTotal) };
}

// 谱系泄漏检查：声明的训练来源与隐藏测试的样本/供体/物种/实验室/隐藏数据源重叠即判泄漏。
function checkLeakage(manifest, hiddenTest, provenance) {
  const lineage = hiddenTest.lineageIndex || {};
  const overlaps = {};
  for (const key of ["sampleIds", "donorIds", "species", "labs"]) {
    const declared = new Set((provenance && provenance[key]) || []);
    overlaps[key] = (lineage[key] || []).filter((v) => declared.has(v));
  }
  const hiddenSources = new Set(
    manifest.dataSources.filter((s) => s.visibility === "hidden-test").map((s) => s.id)
  );
  overlaps.sourceIds = ((provenance && provenance.sourceIds) || []).filter((id) =>
    hiddenSources.has(id)
  );
  const leaked = Object.values(overlaps).some((list) => list.length > 0);
  return { leaked, overlaps };
}

module.exports = { TASK_DEFS, KNOWN_TASK_IDS, evaluateTasks, checkLeakage };
