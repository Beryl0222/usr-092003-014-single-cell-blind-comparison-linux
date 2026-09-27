"use strict";

const { sha256 } = require("./util");

const GENESIS_HASH = "0".repeat(64);

// 内存存储 + 哈希链审计日志。集合语义：
// - versions / submissions / jobs / results / appeals / releases：常规记录
// - leaderboard：按 (versionId, submissionId) 插入一次，之后只允许经审计的废止标记
// - restricted：受限命名空间（隐藏测试集、揭盲材料），任何 HTTP 路由都不得读取后返回
class Store {
  constructor() {
    this.collections = new Map();
    this.audit = [];
  }

  _coll(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  insert(name, record) {
    const coll = this._coll(name);
    if (coll.has(record.id)) {
      throw new Error(`集合 ${name} 中已存在 id ${record.id}`);
    }
    coll.set(record.id, record);
    return record;
  }

  get(name, id) {
    return this._coll(name).get(id) || null;
  }

  list(name) {
    return [...this._coll(name).values()];
  }

  filter(name, fn) {
    return this.list(name).filter(fn);
  }

  appendAudit(entry) {
    const prevHash = this.audit.length ? this.audit[this.audit.length - 1].hash : GENESIS_HASH;
    const body = { seq: this.audit.length + 1, prevHash, ...entry };
    const hash = sha256(JSON.stringify(body));
    const record = { ...body, hash };
    this.audit.push(record);
    return record;
  }

  auditGet(seq) {
    return this.audit.find((e) => e.seq === seq) || null;
  }

  verifyAudit() {
    let prev = GENESIS_HASH;
    for (const entry of this.audit) {
      const { hash, ...body } = entry;
      if (body.prevHash !== prev) return false;
      if (sha256(JSON.stringify(body)) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}

module.exports = { Store, GENESIS_HASH };
