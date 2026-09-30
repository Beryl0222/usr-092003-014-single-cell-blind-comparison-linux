"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { stableStringify, sha256Json } = require("./hash");

/**
 * 哈希链审计日志：每条记录包含前一条记录的哈希（prevHash），
 * 形成只可追加、顺序可验证的证据链。任何删除、改写、调序都会在 verify 时暴露。
 */
class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this._fh = null;
  }

  static GENESIS = "0".repeat(64);

  static load(filePath) {
    const log = new AuditLog(filePath);
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8");
      let prev = AuditLog.GENESIS;
      let seq = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        seq += 1;
        const entry = JSON.parse(line);
        if (entry.seq !== seq) {
          throw new Error(`审计日志序号断裂: 期望 ${seq}, 实际 ${entry.seq}`);
        }
        if (entry.prevHash !== prev) {
          throw new Error(`审计日志第 ${seq} 条前驱哈希不匹配：哈希链断裂`);
        }
        const expected = AuditLog.digestEntry(entry);
        if (entry.entryHash !== expected) {
          throw new Error(`审计日志第 ${seq} 条内容哈希校验失败`);
        }
        log.entries.push(entry);
        prev = entry.entryHash;
      }
    }
    return log;
  }

  static digestEntry(entry) {
    return sha256Json({
      seq: entry.seq,
      at: entry.at,
      actor: entry.actor,
      action: entry.action,
      details: entry.details,
      prevHash: entry.prevHash,
    });
  }

  open() {
    if (this._fh) return this;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this._fh = fs.openSync(this.filePath, "a");
    return this;
  }

  get head() {
    return this.entries.length === 0
      ? AuditLog.GENESIS
      : this.entries[this.entries.length - 1].entryHash;
  }

  /** 追加一条审计记录，返回含 entryHash 的完整条目（可作为复查引用）。 */
  append(actor, action, details = {}) {
    if (!this._fh) this.open();
    const entry = {
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
      actor: actor || "anonymous",
      action,
      details,
      prevHash: this.head,
    };
    entry.entryHash = AuditLog.digestEntry(entry);
    fs.writeSync(this._fh, stableStringify(entry) + "\n");
    try {
      fs.fsyncSync(this._fh);
    } catch {
      // 忽略不支持 fsync 的环境
    }
    this.entries.push(entry);
    return entry;
  }

  /** 独立重放整条链，供申诉复查与启动自检使用。 */
  verify() {
    let prev = AuditLog.GENESIS;
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry.seq !== i + 1) {
        return { ok: false, reason: `序号断裂于第 ${i + 1} 条` };
      }
      if (entry.prevHash !== prev) {
        return { ok: false, reason: `前驱哈希断裂于第 ${entry.seq} 条` };
      }
      if (AuditLog.digestEntry(entry) !== entry.entryHash) {
        return { ok: false, reason: `内容哈希失配于第 ${entry.seq} 条` };
      }
      prev = entry.entryHash;
    }
    return { ok: true, entries: this.entries.length, head: prev };
  }

  /** 按引用（seq + entryHash）取出可复查日志条目。 */
  cite(seq, entryHash) {
    const entry = this.entries.find((e) => e.seq === seq);
    if (!entry || entry.entryHash !== entryHash) return null;
    return entry;
  }

  close() {
    if (this._fh) {
      fs.closeSync(this._fh);
      this._fh = null;
    }
  }
}

module.exports = { AuditLog };
