"use strict";

/**
 * 四类盲测任务的指标实现。所有函数只依赖数组输入，确定性、无外部依赖，
 * 便于在冻结清单中固定口径并在评审时复算。
 *
 * 任务与指标（冻结时固定）：
 *  - species_identification 未见物种识别：macro-F1（附 accuracy）
 *  - health_disease          健康与病变区分：AUROC（二分类风险评分）
 *  - missing_gene            缺失基因预测：Pearson 相关 + RMSE
 *  - calibration             不确定性校准：ECE + 多分类 Brier
 */

function confusion(labels, predictions, classes) {
  const index = new Map(classes.map((c, i) => [c, i]));
  const k = classes.length;
  const tp = new Array(k).fill(0);
  const fp = new Array(k).fill(0);
  const fn = new Array(k).fill(0);
  let correct = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const t = index.get(labels[i]);
    const p = index.get(predictions[i]);
    if (t === undefined || p === undefined) {
      throw new Error(`出现类别空间之外的标签: 真值=${labels[i]} 预测=${predictions[i]}`);
    }
    if (t === p) {
      tp[t] += 1;
      correct += 1;
    } else {
      fp[p] += 1;
      fn[t] += 1;
    }
  }
  return { tp, fp, fn, correct, n: labels.length, k };
}

/** 宏平均 F1：每个类别 F1 后等权平均，未见物种不因频次被稀释。 */
function macroF1(labels, predictions, classes) {
  const { tp, fp, fn, correct, n, k } = confusion(labels, predictions, classes);
  const perClass = classes.map((c, i) => {
    const denom = 2 * tp[i] + fp[i] + fn[i];
    return { class: c, f1: denom === 0 ? 0 : (2 * tp[i]) / denom, support: tp[i] + fn[i] };
  });
  const f1 = perClass.reduce((sum, row) => sum + row.f1, 0) / k;
  return { macroF1: f1, accuracy: n === 0 ? 0 : correct / n, perClass };
}

/**
 * 二分类 AUROC：正类风险评分越高越倾向病变。
 * 采用 Mann–Whitney U 统计量（含并列平分），O(n log n)。
 */
function auroc(labels, scores, positiveLabel) {
  const pos = [];
  const neg = [];
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === positiveLabel) pos.push(scores[i]);
    else neg.push(scores[i]);
  }
  if (pos.length === 0 || neg.length === 0) {
    throw new Error("AUROC 需要正负两类同时存在");
  }
  const ranked = [...pos.map((s) => ({ s, y: 1 })), ...neg.map((s) => ({ s, y: 0 }))].sort(
    (a, b) => a.s - b.s
  );
  // 平均秩（1 起），并列取平均秩
  let rankSumPos = 0;
  let i = 0;
  let rank = 1;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].s === ranked[i].s) j += 1;
    const avgRank = rank + (j - i - 1) / 2;
    for (let m = i; m < j; m += 1) {
      if (ranked[m].y === 1) rankSumPos += avgRank;
    }
    rank += j - i;
    i = j;
  }
  const u = rankSumPos - (pos.length * (pos.length + 1)) / 2;
  return u / (pos.length * neg.length);
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 缺失基因预测：真值/预测表达向量的 Pearson 相关与 RMSE。 */
function pearsonRmse(truth, prediction) {
  if (truth.length !== prediction.length || truth.length === 0) {
    throw new Error("Pearson/RMSE 要求等长且非空的真值与预测序列");
  }
  const mt = mean(truth);
  const mp = mean(prediction);
  let cov = 0;
  let vt = 0;
  let vp = 0;
  let se = 0;
  for (let i = 0; i < truth.length; i += 1) {
    const dt = truth[i] - mt;
    const dp = prediction[i] - mp;
    cov += dt * dp;
    vt += dt * dt;
    vp += dp * dp;
    const d = truth[i] - prediction[i];
    se += d * d;
  }
  const denom = Math.sqrt(vt * vp);
  return {
    pearson: denom === 0 ? 0 : cov / denom,
    rmse: Math.sqrt(se / truth.length),
    n: truth.length,
  };
}

/**
 * 不确定性校准。
 * ECE：按预测置信度（最大类概率）分箱，比较置信度与准确率的差距加权平均。
 * Brier：多分类均方概率误差 1/N * Σ_i Σ_c (p_ic - 1[y_i=c])^2。
 */
function calibration(labels, probabilities, classes, binCount = 10) {
  if (labels.length !== probabilities.length || labels.length === 0) {
    throw new Error("校准计算要求等长且非空的标签与概率序列");
  }
  const index = new Map(classes.map((c, i) => [c, i]));
  let brier = 0;
  let nll = 0;
  const bins = Array.from({ length: binCount }, () => ({ count: 0, conf: 0, correct: 0 }));
  for (let i = 0; i < labels.length; i += 1) {
    const probs = probabilities[i];
    if (!Array.isArray(probs) || probs.length !== classes.length) {
      throw new Error(`第 ${i} 条预测概率维度与类别数 ${classes.length} 不一致`);
    }
    let top = 0;
    let sum = 0;
    for (let c = 0; c < probs.length; c += 1) {
      const p = probs[c];
      if (!(p >= 0 && p <= 1)) throw new Error(`第 ${i} 条概率越界: ${p}`);
      sum += p;
      if (p > probs[top]) top = c;
      const t = index.get(labels[i]);
      brier += (p - (c === t ? 1 : 0)) ** 2;
      if (c === t) nll -= Math.log(Math.max(p, 1e-12));
    }
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`第 ${i} 条概率不归一: 和=${sum}`);
    const confidence = probs[top];
    const bin = Math.min(binCount - 1, Math.floor(confidence * binCount));
    bins[bin].count += 1;
    bins[bin].conf += confidence;
    if (classes[top] === labels[i]) bins[bin].correct += 1;
  }
  const n = labels.length;
  let ece = 0;
  const binDetail = bins
    .filter((b) => b.count > 0)
    .map((b) => {
      const avgConf = b.conf / b.count;
      const acc = b.correct / b.count;
      ece += (b.count / n) * Math.abs(avgConf - acc);
      return { count: b.count, avgConfidence: avgConf, accuracy: acc };
    });
  return { ece, brier: brier / n, nll: nll / n, bins: binDetail };
}

/**
 * 按冻结的指标口径对单个任务结果打分。
 * spec: { metric: "macroF1"|"auroc"|"pearson"|"rmse"|"ece"|"brier",
 *         threshold?: number, tolerance?: number, higherIsBetter?: boolean }
 * 容差用于边界判定：高优指标 value + tolerance >= threshold 视为达标，
 * 低优指标 value - tolerance <= threshold 视为达标。
 */
function judgeMetric(spec, values) {
  const value = values[spec.metric];
  if (typeof value !== "number") {
    throw new Error(`结果中缺少冻结指标 ${spec.metric}`);
  }
  const higherIsBetter = spec.higherIsBetter !== false;
  let pass = null;
  if (typeof spec.threshold === "number") {
    const tol = spec.tolerance || 0;
    pass = higherIsBetter ? value + tol >= spec.threshold : value - tol <= spec.threshold;
  }
  return {
    metric: spec.metric,
    value,
    higherIsBetter,
    threshold: spec.threshold ?? null,
    tolerance: spec.tolerance ?? 0,
    pass,
  };
}

module.exports = {
  macroF1,
  auroc,
  pearsonRmse,
  calibration,
  judgeMetric,
};
