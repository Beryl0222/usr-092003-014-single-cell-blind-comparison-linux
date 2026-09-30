"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { stableStringify, sha256Json, randomId } = require("../lib/hash");
const { AppendStore } = require("../lib/store");
const { AuditLog } = require("../lib/audit");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-unit-"));
}

test("规范化哈希不受键顺序影响", () => {
  const a = { z: 1, a: { y: 2, x: [1, 2, { b: 1, a: 2 }] } };
  const b = { a: { x: [1, 2, { a: 2, b: 1 }], y: 2 }, z: 1 };
  assert.equal(sha256Json(a), sha256Json(b));
  assert.equal(stableStringify([3, 1, 2]), "[3,1,2]");
  assert.notEqual(sha256Json([3, 1, 2]), sha256Json([1, 2, 3]));
});

test("随机标识带前缀且不碰撞", () => {
  const ids = new Set(Array.from({ length: 100 }, () => randomId("job")));
  assert.equal(ids.size, 100);
  assert.ok([...ids][0].startsWith("job_"));
});

test("只追加存储：不可改写、允许显式推进、重放校验", () => {
  const dir = tempDir();
  const file = path.join(dir, "x.jsonl");
  const store = AppendStore.load(file, "x").open();
  store.append("k1", "t", { v: 1 });
  assert.throws(() => store.append("k1", "t", { v: 2 }), /不可修改/);
  store.append("k1", "t", { v: 2 }, { allowUpdate: true });
  assert.equal(store.get("k1").v, 2);
  assert.deepEqual(
    store.history("k1").map((r) => r.data.v),
    [1, 2]
  );
  store.close();

  const reloaded = AppendStore.load(file, "x");
  assert.equal(reloaded.get("k1").v, 2);
  assert.equal(reloaded.size, 2);

  // 篡改任意一条记录 → 重新加载必须抛出
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  lines[0] = lines[0].replace('"v":1', '"v":9');
  fs.writeFileSync(file, lines.join("\n") + "\n");
  assert.throws(() => AppendStore.load(file, "x"), /哈希校验失败/);
});

test("审计哈希链：追加、引用复查、篡改可发现", () => {
  const dir = tempDir();
  const file = path.join(dir, "audit.log");
  const log = AuditLog.load(file).open();
  const e1 = log.append("admin:1", "manifest.freeze", { jobId: "j" });
  log.append("team:a", "job.submit", { jobId: "j" });
  assert.deepEqual(log.verify(), {
    ok: true,
    entries: 2,
    head: log.head,
  });
  assert.equal(log.cite(e1.seq, e1.entryHash).action, "manifest.freeze");
  assert.equal(log.cite(e1.seq, "x".repeat(64)), null);
  log.close();

  // 改写中间动作字段 → 链在加载时即校验失败
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const obj = JSON.parse(lines[0]);
  obj.action = "manifest.rewrite";
  lines[0] = JSON.stringify(obj);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  assert.throws(() => AuditLog.load(file), /内容哈希校验失败/);

  // 恢复内容但破坏前驱链接 → 报哈希链断裂
  const fresh = AuditLog.load(path.join(dir, "audit2.log")).open();
  const a = fresh.append("a", "one", {});
  const b = fresh.append("b", "two", {});
  fresh.close();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "audit2.log"), "utf8").trimEnd().split("\n")[1]);
  raw.prevHash = "f".repeat(64);
  const rawLines = fs.readFileSync(path.join(dir, "audit2.log"), "utf8").trimEnd().split("\n");
  rawLines[1] = JSON.stringify(raw);
  fs.writeFileSync(path.join(dir, "audit2.log"), rawLines.join("\n") + "\n");
  assert.throws(() => AuditLog.load(path.join(dir, "audit2.log")), /前驱哈希不匹配/);
});
