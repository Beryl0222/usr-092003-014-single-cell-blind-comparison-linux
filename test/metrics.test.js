"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  macroF1,
  auroc,
  pearsonRmse,
  calibration,
  judgeMetric,
} = require("../lib/metrics");

const approx = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol, `期望 ${expected}, 实际 ${actual}`);

test("macro-F1：完美、全错与单类别边界", () => {
  const classes = ["human", "mouse", "axolotl"];
  const perfect = macroF1(
    ["human", "mouse", "axolotl", "human"],
    ["human", "mouse", "axolotl", "human"],
    classes
  );
  approx(perfect.macroF1, 1);
  approx(perfect.accuracy, 1);

  const allWrong = macroF1(
    ["human", "mouse", "axolotl"],
    ["mouse", "axolotl", "human"],
    classes
  );
  approx(allWrong.macroF1, 0);
  // 宏平均不因 axolotl 样本少而忽略它
  const rare = macroF1(
    ["human", "human", "human", "axolotl"],
    ["human", "human", "human", "axolotl"],
    classes
  );
  const axolotl = rare.perClass.find((c) => c.class === "axolotl");
  approx(axolotl.f1, 1);
  assert.equal(axolotl.support, 1);
});

test("AUROC：完美分离为 1，反转为 0，并列评分取平均秩", () => {
  approx(auroc(["d", "d", "h", "h"], [0.9, 0.8, 0.3, 0.2], "d"), 1);
  approx(auroc(["d", "d", "h", "h"], [0.1, 0.2, 0.8, 0.9], "d"), 0);
  // 全部并列 => 0.5
  approx(auroc(["d", "d", "h", "h"], [0.5, 0.5, 0.5, 0.5], "d"), 0.5);
  // 一对正确一对并列
  approx(auroc(["d", "h", "h"], [0.7, 0.7, 0.1], "d"), (1 + 0.5) / 2);
  assert.throws(() => auroc(["d"], [0.5], "d"), /正负两类/);
});

test("Pearson 与 RMSE", () => {
  const r = pearsonRmse([1, 2, 3, 4], [2, 4, 6, 8]);
  approx(r.pearson, 1);
  approx(r.rmse, Math.sqrt((1 + 4 + 9 + 16) / 4));
  const neg = pearsonRmse([1, 2], [2, 1]);
  approx(neg.pearson, -1);
  assert.throws(() => pearsonRmse([1], [1, 2]), /等长/);
});

test("校准：ECE、Brier，完美概率与概率校验", () => {
  const classes = ["healthy", "disease"];
  // 高置信且全对 => ECE 0；完美 0/1 概率 => Brier 0
  const labels = ["healthy", "disease"];
  const probs = [
    [1, 0],
    [0, 1],
  ];
  const perfect = calibration(labels, probs, classes, 2);
  approx(perfect.ece, 0);
  approx(perfect.brier, 0);

  // 置信度 0.9 但准确率 0 => |conf-acc| = 0.9
  const bad = calibration(["healthy", "healthy"], [[0.1, 0.9], [0.1, 0.9]], classes, 10);
  approx(bad.ece, 0.9);
  approx(bad.brier, ((0.1 - 1) ** 2 + 0.9 ** 2) ); // 两个样本之和/2 = 0.81
  assert.throws(
    () => calibration(["healthy"], [[0.5, 0.6]], classes),
    /不归一/
  );
  assert.throws(() => calibration(["healthy"], [[1.2, -0.2]], classes), /越界/);
});

test("judgeMetric：容差按指标方向判定达标", () => {
  const high = judgeMetric({ metric: "macroF1", threshold: 0.8, tolerance: 0.01 }, { macroF1: 0.795 });
  assert.equal(high.pass, true);
  const highMiss = judgeMetric({ metric: "macroF1", threshold: 0.8, tolerance: 0.01 }, { macroF1: 0.78 });
  assert.equal(highMiss.pass, false);
  const low = judgeMetric({ metric: "ece", threshold: 0.05, tolerance: 0.005, higherIsBetter: false }, { ece: 0.054 });
  assert.equal(low.pass, true);
  const lowMiss = judgeMetric({ metric: "ece", threshold: 0.05, tolerance: 0.005, higherIsBetter: false }, { ece: 0.06 });
  assert.equal(lowMiss.pass, false);
});
