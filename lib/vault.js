"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256Bytes, sha256Json } = require("./hash");

/**
 * 分级隔离保管库。三类受限材料各自独立分区，访问由调用方（服务层）按
 * 作业状态与调用者角色裁决；保管库本身只在显式授权通过后才吐出字节，
 * 并记录“谁在何时因何引用读取了什么”的访问痕迹。
 *
 * 分区：
 *  - restricted-matrix   受限表达矩阵（隐藏测试集），仅活动作业执行期可读
 *  - team-weights        各参赛团队提交的权重摘要/权重包，跨团队互不可见
 *  - unblinding          揭盲材料（物种/供体/病变真值映射），截止并发布前不可读
 */
const COMPARTMENTS = Object.freeze({
  RESTRICTED_MATRIX: "restricted-matrix",
  TEAM_WEIGHTS: "team-weights",
  UNBLINDING: "unblinding",
});

class Vault {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.accessLogPath = path.join(rootDir, "access.log");
    for (const key of Object.keys(COMPARTMENTS)) {
      fs.mkdirSync(path.join(rootDir, COMPARTMENTS[key]), { recursive: true });
    }
  }

  _blobPath(compartment, ref) {
    if (!/^[A-Za-z0-9_.-]+$/.test(ref)) {
      throw new Error("非法的保管库引用");
    }
    if (!Object.values(COMPARTMENTS).includes(compartment)) {
      throw new Error("未知保管分区");
    }
    return path.join(this.rootDir, compartment, ref + ".blob");
  }

  /** 存放字节材料，返回内容哈希与大小；引用由调用方给定并需合法。 */
  put(compartment, ref, buffer, meta = {}) {
    const filePath = this._blobPath(compartment, ref);
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    const record = {
      compartment,
      ref,
      sha256: sha256Bytes(bytes),
      size: bytes.length,
      meta,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(filePath + ".meta", JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
    return record;
  }

  has(compartment, ref) {
    return fs.existsSync(this._blobPath(compartment, ref));
  }

  meta(compartment, ref) {
    const metaPath = this._blobPath(compartment, ref) + ".meta";
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  }

  /**
   * 读取受限材料。authorize 为服务层传入的裁决结果对象：
   * { allow: true, reason, actor } —— allow 非真一律拒绝并记录拒绝事件。
   * 任何读取（含拒绝）都落访问日志，保证越界尝试可审计。
   */
  read(compartment, ref, authorization) {
    const decision = authorization || { allow: false, reason: "未授权" };
    this._trace(compartment, ref, decision, decision.allow === true);
    if (decision.allow !== true) {
      const err = new Error(
        `访问被拒绝：分区 ${compartment} 引用 ${ref}（${decision.reason || "无授权理由"}）`
      );
      err.code = "VAULT_DENIED";
      throw err;
    }
    const filePath = this._blobPath(compartment, ref);
    if (!fs.existsSync(filePath)) {
      const err = new Error(`保管材料不存在: ${compartment}/${ref}`);
      err.code = "VAULT_MISSING";
      throw err;
    }
    return fs.readFileSync(filePath);
  }

  _trace(compartment, ref, decision, allowed) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        actor: decision.actor || "unknown",
        compartment,
        ref,
        allowed: allowed === true,
        reason: decision.reason || null,
      }) + "\n";
    fs.appendFileSync(this.accessLogPath, line, { mode: 0o600 });
  }

  list(compartment) {
    const dir = path.join(this.rootDir, compartment);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".meta"))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
      );
  }
}

module.exports = { Vault, COMPARTMENTS };
