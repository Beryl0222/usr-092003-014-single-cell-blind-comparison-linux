"use strict";

/**
 * 样本与谱系泄漏检查。冻结清单中固定“训练可见范围”，揭盲前据此对隐藏
 * 测试集做四类检查，任何命中都记录为可复查发现：
 *
 *  1. sample_id     样本标识重叠（换物种标签也逃不掉同一 ID）
 *  2. content_hash  表达图谱内容哈希重叠（同一张图换 ID 重放）
 *  3. donor_lineage 同一供体或同一谱系群体（如近缘克隆/亲本系）
 *  4. fingerprint   表达指纹余弦相似度达到冻结阈值（高度相似图谱）
 *
 * 输入：
 *  trainScope: [{ datasetId, species, lab, sampleIds[], profileHashes[],
 *                 donors[], lineages[] }]
 *  testSamples:[{ sampleId, species, lab, donorId, lineageId, profileHash,
 *                 fingerprint[] }]
 *  thresholds: { fingerprintCosine }
 */

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error("指纹向量维度不一致或为空");
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function checkLeakage(trainScope, testSamples, thresholds = {}) {
  const fpThreshold =
    typeof thresholds.fingerprintCosine === "number"
      ? thresholds.fingerprintCosine
      : 0.98;

  // 建立训练侧索引
  const sampleIds = new Map();
  const profileHashes = new Map();
  const donors = new Map();
  const lineages = new Map();
  const trainEntries = [];

  for (const entry of trainScope) {
    trainEntries.push(entry);
    for (const sid of entry.sampleIds || []) {
      if (!sampleIds.has(sid)) sampleIds.set(sid, []);
      sampleIds.get(sid).push(entry.datasetId);
    }
    for (const h of entry.profileHashes || []) {
      if (!profileHashes.has(h)) profileHashes.set(h, []);
      profileHashes.get(h).push(entry.datasetId);
    }
    for (const d of entry.donors || []) {
      if (!donors.has(d)) donors.set(d, []);
      donors.get(d).push(entry.datasetId);
    }
    for (const lg of entry.lineages || []) {
      if (!lineages.has(lg)) lineages.set(lg, []);
      lineages.get(lg).push(entry.datasetId);
    }
  }

  const findings = [];
  const addFinding = (check, severity, sampleId, detail) => {
    findings.push({ check, severity, sampleId, detail });
  };

  // 测试集内部也不允许重复图谱，否则同一答案被重复计权
  const seenTestHash = new Map();

  for (const sample of testSamples) {
    if (sampleIds.has(sample.sampleId)) {
      addFinding("sample_id", "critical", sample.sampleId, {
        reason: "隐藏样本标识出现在训练可见范围",
        trainDatasets: sampleIds.get(sample.sampleId),
      });
    }
    if (profileHashes.has(sample.profileHash)) {
      addFinding("content_hash", "critical", sample.sampleId, {
        reason: "图谱内容哈希与训练样本完全相同",
        trainDatasets: profileHashes.get(sample.profileHash),
      });
    }
    if (seenTestHash.has(sample.profileHash)) {
      addFinding("content_hash", "warning", sample.sampleId, {
        reason: "隐藏测试集内部存在重复图谱",
        otherSample: seenTestHash.get(sample.profileHash),
      });
    } else {
      seenTestHash.set(sample.profileHash, sample.sampleId);
    }
    if (sample.donorId && donors.has(sample.donorId)) {
      addFinding("donor_lineage", "critical", sample.sampleId, {
        reason: "同一供体同时出现在训练与隐藏测试",
        donorId: sample.donorId,
        trainDatasets: donors.get(sample.donorId),
      });
    }
    if (sample.lineageId && lineages.has(sample.lineageId)) {
      addFinding("donor_lineage", "high", sample.sampleId, {
        reason: "供体谱系群体跨训练/测试共享",
        lineageId: sample.lineageId,
        trainDatasets: lineages.get(sample.lineageId),
      });
    }
  }

  // 指纹相似度：冻结阈值之上的跨集合样本对（昂贵检查，但确定性可复算）
  let pairsChecked = 0;
  for (const sample of testSamples) {
    if (!Array.isArray(sample.fingerprint)) continue;
    let best = { cosine: -1, trainDataset: null, trainSample: null };
    for (const entry of trainEntries) {
      for (const trainSample of entry.fingerprints || []) {
        const sim = cosine(sample.fingerprint, trainSample.vector);
        pairsChecked += 1;
        if (sim > best.cosine) {
          best = { cosine: sim, trainDataset: entry.datasetId, trainSample: trainSample.sampleId };
        }
      }
    }
    if (best.cosine >= fpThreshold) {
      addFinding("fingerprint", "high", sample.sampleId, {
        reason: "表达指纹与训练图谱高度相似，疑似近重复",
        maxCosine: Number(best.cosine.toFixed(6)),
        threshold: fpThreshold,
        trainDataset: best.trainDataset,
        trainSample: best.trainSample,
      });
    }
  }

  const counts = { sample_id: 0, content_hash: 0, donor_lineage: 0, fingerprint: 0 };
  for (const f of findings) counts[f.check] += 1;
  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;

  return {
    verdict: critical > 0 ? "leaked" : high > 0 ? "review" : "clean",
    thresholds: { fingerprintCosine: fpThreshold },
    testSamples: testSamples.length,
    pairsChecked,
    counts,
    findings,
  };
}

module.exports = { checkLeakage, cosine };
