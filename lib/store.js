"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256Json } = require("./hash");

/**
 * 只追加 JSONL 存储：记录一经写入不可修改、不可删除。
 * 每条记录附带 seq / at / recordHash（含内容与 seq 的规范化哈希）。
 * 同一逻辑实体的“更新”通过追加新记录表达，读取时按 id 归并到最新状态。
 */
class AppendStore {
  constructor(filePath, entityName) {
    this.filePath = filePath;
    this.entityName = entityName || path.basename(filePath);
    this._byId = new Map();
    this._records = [];
    this._fh = null;
  }

  static load(filePath, entityName) {
    const store = new AppendStore(filePath, entityName);
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8");
      let seq = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        seq += 1;
        const envelope = JSON.parse(line);
        if (envelope.seq !== seq) {
          throw new Error(
            `${entityName || filePath} 记录序号断裂: 期望 ${seq}, 实际 ${envelope.seq}`
          );
        }
        const expected = sha256Json({
          id: envelope.record.id,
          type: envelope.record.type,
          data: envelope.record.data,
          seq: envelope.seq,
        });
        if (envelope.recordHash !== expected) {
          throw new Error(
            `${entityName || filePath} 第 ${seq} 条记录哈希校验失败：日志可能被篡改`
          );
        }
        store._records.push(envelope.record);
        store._byId.set(envelope.record.id, envelope.record.data);
      }
    }
    return store;
  }

  open() {
    if (this._fh) return this;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._fh = fs.openSync(this.filePath, "a");
    return this;
  }

  get size() {
    return this._records.length;
  }

  all() {
    return this._records.slice();
  }

  /** 返回每个实体最新一条记录（同一 id 的历史推进仍完整保留在文件中）。 */
  latest() {
    const byId = new Map();
    for (const record of this._records) byId.set(record.id, record);
    return [...byId.values()];
  }

  /** 返回某实体的完整状态推进历史（旧 -> 新）。 */
  history(id) {
    return this._records.filter((record) => record.id === id);
  }

  get(id) {
    return this._byId.get(id);
  }

  has(id) {
    return this._byId.has(id);
  }

  /** 追加一条记录；id 已存在时要求调用方明确允许“状态推进”。 */
  append(id, type, data, { allowUpdate = false } = {}) {
    if (!this._fh) this.open();
    const exists = this._byId.has(id);
    if (exists && !allowUpdate) {
      throw new Error(`${this.entityName} 记录 ${id} 已存在且不可修改`);
    }
    const seq = this._records.length + 1;
    const record = { id, type, data };
    const recordHash = sha256Json({
      id,
      type,
      data,
      seq,
    });
    const envelope = { seq, at: new Date().toISOString(), record, recordHash };
    fs.writeSync(this._fh, JSON.stringify(envelope) + "\n");
    try {
      fs.fsyncSync(this._fh);
    } catch {
      // 某些平台/文件系统不支持 fsync，忽略；哈希链仍可在读取时校验。
    }
    this._records.push(record);
    this._byId.set(id, data);
    return envelope;
  }

  close() {
    if (this._fh) {
      fs.closeSync(this._fh);
      this._fh = null;
    }
  }
}

module.exports = { AppendStore };
