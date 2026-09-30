"use strict";

const { sha256Json } = require("./hash");

/**
 * 基准冻结清单（manifest）。揭盲前由平台管理员冻结，锁定：
 *  - dataSources   数据来源（数据集、物种、实验室、矩阵内容哈希、行数）
 *  - trainScope    训练可见范围（各来源允许模型见到的样本/供体/谱系集合）
 *  - stratification物种 × 实验室分层（保证未见物种识别等任务的分组定义明确）
 *  - hiddenTest    隐藏测试集描述（矩阵 vault 引用、样本数、揭盲材料引用）
 *  - tasks         任务定义与指标口径、阈值、容差
 *  - deadline      提交截止时间
 * 冻结后内容不可变：manifestHash 进入所有作业、结果、榜单与申诉记录。
 */

const TASK_TYPES = Object.freeze({
  SPECIES: "species_identification",
  HEALTH: "health_disease",
  MISSING_GENE: "missing_gene",
  CALIBRATION: "uncertainty_calibration",
});

const TASK_SCHEMA = Object.freeze({
  [TASK_TYPES.SPECIES]: {
    label: "未见物种识别",
    metrics: ["macroF1", "accuracy"],
    primary: "macroF1",
    higherIsBetter: true,
  },
  [TASK_TYPES.HEALTH]: {
    label: "健康与病变区分",
    primary: "auroc",
    metrics: ["auroc"],
    higherIsBetter: true,
  },
  [TASK_TYPES.MISSING_GENE]: {
    label: "缺失基因预测",
    primary: "pearson",
    metrics: ["pearson", "rmse"],
    // pearson 越高越好；rmse 越低越好，作为辅助指标单独记录方向
    higherIsBetter: true,
  },
  [TASK_TYPES.CALIBRATION]: {
    label: "不确定性校准",
    primary: "ece",
    metrics: ["ece", "brier"],
    higherIsBetter: false,
  },
});

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.code = "MANIFEST_INVALID";
    throw err;
  }
}

/** 校验清单草案并返回规范化清单（补默认值），随后可冻结。 */
function prepareManifest(draft) {
  assert(draft && typeof draft === "object", "清单必须是对象");
  assert(draft.benchmarkId, "缺少 benchmarkId");
  assert(draft.version, "缺少版本号 version");
  assert(Array.isArray(draft.dataSources) && draft.dataSources.length > 0, "dataSources 为空");
  assert(Array.isArray(draft.trainScope), "trainScope 必须是数组");
  assert(draft.hiddenTest && typeof draft.hiddenTest === "object", "缺少 hiddenTest");
  assert(Array.isArray(draft.tasks) && draft.tasks.length > 0, "tasks 为空");
  assert(Number.isFinite(Date.parse(draft.deadline)), "deadline 必须是可解析时间");

  const dataSourceIds = new Set();
  for (const source of draft.dataSources) {
    assert(source.datasetId, "数据来源缺少 datasetId");
    assert(!dataSourceIds.has(source.datasetId), `数据来源重复: ${source.datasetId}`);
    dataSourceIds.add(source.datasetId);
    assert(source.species, `${source.datasetId} 缺少 species`);
    assert(source.lab, `${source.datasetId} 缺少 lab`);
    assert(/^[a-f0-9]{64}$/.test(source.matrixSha256 || ""), `${source.datasetId} 缺少 64 位矩阵哈希`);
    assert(Number.isInteger(source.rows) && source.rows > 0, `${source.datasetId} 缺少有效行数`);
  }

  // 训练可见范围只能引用已声明来源；未见物种必须在分层中显式标出
  for (const scope of draft.trainScope) {
    assert(
      dataSourceIds.has(scope.datasetId),
      `trainScope 引用了未声明来源: ${scope.datasetId}`
    );
  }

  assert(
    Array.isArray(draft.stratification) && draft.stratification.length > 0,
    "stratification 为空"
  );
  const stratumKeys = new Set();
  for (const stratum of draft.stratification) {
    assert(stratum.species && stratum.lab, "分层需要 species 与 lab");
    assert(
      ["train", "held_out", "excluded"].includes(stratum.role),
      `分层角色非法: ${stratum.role}`
    );
    const key = stratum.species + "|" + stratum.lab;
    assert(!stratumKeys.has(key), `分层重复: ${key}`);
    stratumKeys.add(key);
  }
  assert(
    draft.stratification.some((s) => s.role === "held_out"),
    "至少需要一个 held_out（未见物种/实验室）分层"
  );

  assert(draft.hiddenTest.matrixRef, "hiddenTest 缺少 matrixRef（保管库引用）");
  assert(draft.hiddenTest.unblindingRef, "hiddenTest 缺少 unblindingRef（揭盲材料引用）");
  assert(
    Number.isInteger(draft.hiddenTest.sampleCount) && draft.hiddenTest.sampleCount > 0,
    "hiddenTest 缺少有效 sampleCount"
  );
  if (
    draft.hiddenTest.leakageThresholds &&
    typeof draft.hiddenTest.leakageThresholds.fingerprintCosine === "number"
  ) {
    const t = draft.hiddenTest.leakageThresholds.fingerprintCosine;
    assert(t > 0 && t <= 1, "fingerprintCosine 阈值必须在 (0,1] 内");
  }

  const taskIds = new Set();
  const tasks = draft.tasks.map((task) => {
    assert(TASK_SCHEMA[task.type], `未知任务类型: ${task.type}`);
    assert(task.taskId, "任务缺少 taskId");
    assert(!taskIds.has(task.taskId), `任务标识重复: ${task.taskId}`);
    taskIds.add(task.taskId);
    const schema = TASK_SCHEMA[task.type];
    for (const metricSpec of task.metrics || []) {
      assert(schema.metrics.includes(metricSpec.metric),
        `${task.type} 不支持指标 ${metricSpec.metric}，口径已冻结为 ${schema.metrics.join("/")}`);
      if (metricSpec.threshold !== undefined) {
        assert(typeof metricSpec.threshold === "number", "threshold 必须为数值");
      }
      if (metricSpec.tolerance !== undefined) {
        assert(
          typeof metricSpec.tolerance === "number" && metricSpec.tolerance >= 0,
          "tolerance 必须为非负数值"
        );
      }
      // 方向由指标口径固定，不允许清单自行翻转，避免事后挑有利方向
      metricSpec.higherIsBetter =
        metricSpec.metric === "rmse" || metricSpec.metric === "ece" || metricSpec.metric === "brier"
          ? false
          : true;
    }
    return {
      taskId: task.taskId,
      type: task.type,
      label: schema.label,
      primary: schema.primary,
      metrics: task.metrics || [],
      scope: task.scope || null,
    };
  });

  return {
    benchmarkId: draft.benchmarkId,
    version: draft.version,
    dataSources: draft.dataSources,
    trainScope: draft.trainScope,
    stratification: draft.stratification,
    hiddenTest: {
      matrixRef: draft.hiddenTest.matrixRef,
      unblindingRef: draft.hiddenTest.unblindingRef,
      sampleCount: draft.hiddenTest.sampleCount,
      leakageReportHash: draft.hiddenTest.leakageReportHash || null,
      leakageThresholds: draft.hiddenTest.leakageThresholds || { fingerprintCosine: 0.98 },
    },
    tasks,
    deadline: draft.deadline,
    notes: draft.notes || null,
  };
}

/** 生成冻结记录（含哈希与冻结时间）。同一草案永远得到同一哈希。 */
function freezeManifest(draft, frozenAt = new Date().toISOString()) {
  const manifest = prepareManifest(draft);
  return {
    manifest,
    manifestHash: sha256Json(manifest),
    frozenAt,
    status: "frozen",
  };
}

module.exports = {
  TASK_TYPES,
  TASK_SCHEMA,
  prepareManifest,
  freezeManifest,
};
