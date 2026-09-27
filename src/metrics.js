"use strict";

function assertPairs(a, b, label) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    throw new Error(`${label}：真值与预测必须是等长非空数组`);
  }
}

function accuracy(labels, preds) {
  assertPairs(labels, preds, "accuracy");
  let hit = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === preds[i]) hit += 1;
  }
  return hit / labels.length;
}

// 秩次法 AUROC，平局取平均秩。
function auroc(labels, scores) {
  assertPairs(labels, scores, "auroc");
  const nPos = labels.filter((y) => y === 1).length;
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) throw new Error("auroc：真值必须同时包含正负样本");
  const order = labels
    .map((y, i) => ({ y, s: scores[i] }))
    .sort((a, b) => a.s - b.s);
  const ranks = new Array(order.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].s === order[i].s) j += 1;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  order.forEach((p, idx) => {
    if (p.y === 1) sumPos += ranks[idx];
  });
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// 期望校准误差：置信度分箱后 |准确率 - 平均置信度| 的加权平均。
function ece(correct, confidences, bins = 10) {
  assertPairs(correct, confidences, "ece");
  const n = correct.length;
  const buckets = Array.from({ length: bins }, () => ({ count: 0, acc: 0, conf: 0 }));
  for (let i = 0; i < n; i += 1) {
    const c = confidences[i];
    if (typeof c !== "number" || c < 0 || c > 1) throw new Error("ece：置信度必须位于 [0,1]");
    const idx = Math.min(bins - 1, Math.floor(c * bins));
    buckets[idx].count += 1;
    buckets[idx].acc += correct[i] ? 1 : 0;
    buckets[idx].conf += c;
  }
  let total = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    total += (b.count / n) * Math.abs(b.acc / b.count - b.conf / b.count);
  }
  return total;
}

function pearson(a, b) {
  assertPairs(a, b, "pearson");
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0; // 常数序列无相关性定义，按 0 处理
  return cov / Math.sqrt(varA * varB);
}

module.exports = { accuracy, auroc, ece, pearson };
