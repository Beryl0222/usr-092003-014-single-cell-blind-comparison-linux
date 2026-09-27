"use strict";

const crypto = require("node:crypto");

// 键序稳定的序列化，保证同一对象永远得到同一哈希。
function canonicalize(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hashObject(obj) {
  return sha256(canonicalize(obj));
}

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

module.exports = { canonicalize, sha256, hashObject, newId, round6, deepFreeze };
