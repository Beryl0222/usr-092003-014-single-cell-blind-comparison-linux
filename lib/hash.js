"use strict";

const crypto = require("node:crypto");

/**
 * 规范化 JSON：对象键递归排序，无空白，确保跨进程哈希一致。
 * 不接受 undefined / function / 符号，避免歧义编码。
 */
function stableStringify(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number" || type === "boolean") return JSON.stringify(value);
  if (type === "undefined") {
    // 与 JSON.stringify 在数组中的行为保持一致（元素记为 null）
    return "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (type === "object") {
    if (value instanceof Uint8Array) {
      return JSON.stringify({ __bin__: Buffer.from(value).toString("base64") });
    }
    // 与 JSON.stringify 一致：值为 undefined 的对象键被跳过
    const keys = Object.keys(value).filter((key) => typeof value[key] !== "undefined");
    keys.sort();
    return (
      "{" +
      keys
        .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
        .join(",") +
      "}"
    );
  }
  throw new TypeError("不支持的编码类型: " + type);
}

/** 对任意可规范化 JSON 值取 SHA-256（十六进制）。 */
function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex");
}

/** 对字节块取 SHA-256（十六进制）。 */
function sha256Bytes(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function randomId(prefix) {
  const suffix = crypto.randomBytes(9).toString("base64url");
  return prefix + "_" + suffix;
}

/** 由字符串种子确定性派生的 32 位状态，供模拟运行器使用。 */
function seededPrng(seedText) {
  const digest = crypto.createHash("sha256").update(String(seedText)).digest();
  let state = digest.readUInt32LE(0) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  stableStringify,
  sha256Json,
  sha256Bytes,
  randomId,
  seededPrng,
};
