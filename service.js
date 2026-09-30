"use strict";

const http = require("node:http");
const { BenchmarkEngine, HttpError } = require("./lib/engine");

const SERVICE_ID = "single-cell-blind-comparison";
const SERVICE_NAME = "单细胞模型盲测基准";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

/**
 * 本地演示令牌表：生产部署应替换为外部身份提供方签发的令牌。
 * team-<teamId> 形式直接映射到参赛团队身份。
 */
function defaultTokens() {
  return {
    "admin-local": { id: "admin-1", role: "admin" },
    "reviewer-local": { id: "reviewer-1", role: "reviewer" },
    "runner-local": { id: "runner-1", role: "runner" },
  };
}

function resolveActor(authorization, tokens) {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (tokens[token]) return tokens[token];
  if (token.startsWith("team-")) {
    const teamId = token.slice("team-".length);
    if (teamId) return { id: "member-" + teamId, role: "team", teamId };
  }
  return null;
}

function createServer(options = {}) {
  const engine =
    options.engine ||
    new BenchmarkEngine({ rootDir: options.rootDir || process.env.BENCH_DIR || ".bench-data" });
  const tokens = options.tokens || defaultTokens();

  const server = http.createServer(async (request, response) => {
    const send = (status, payload, headers = {}) => {
      const body = payload === undefined ? "" : JSON.stringify(payload);
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        ...headers,
      });
      response.end(body);
    };

    if (request.method === "GET" && request.url === "/health") {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }

    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      const actor = resolveActor(request.headers.authorization, tokens);
      const requireActor = () => {
        if (!actor) throw new HttpError(401, "UNAUTHENTICATED", "缺少身份令牌");
        return actor;
      };

      const readBody = () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => resolve(Buffer.concat(chunks)));
          request.on("error", reject);
        });
      const readJson = async () => {
        const raw = (await readBody()).toString("utf8");
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          throw new HttpError(400, "BAD_JSON", "请求体不是合法 JSON");
        }
      };

      const m = (pattern) => {
        const match = pathname.match(pattern);
        return match ? match.slice(1) : null;
      };
      const q = (name) => url.searchParams.get(name);

      // ---- 管理：受限材料入库 ----
      let args;
      if ((args = m(/^\/v1\/admin\/matrices\/([^/]+)$/))) {
        requireActor();
        if (request.method !== "PUT") throw new HttpError(405, "METHOD_NOT_ALLOWED", "仅支持 PUT");
        const bytes = await readBody();
        send(201, engine.ingestRestrictedMatrix(actor, decodeURIComponent(args[0]), bytes));
        return;
      }
      if ((args = m(/^\/v1\/admin\/unblinding\/([^/]+)$/))) {
        requireActor();
        if (request.method !== "PUT") throw new HttpError(405, "METHOD_NOT_ALLOWED", "仅支持 PUT");
        const bytes = await readBody();
        send(201, engine.ingestUnblinding(actor, decodeURIComponent(args[0]), bytes));
        return;
      }

      // ---- 管理：泄漏检查 / 冻结 / 发布 / 自检 ----
      if (request.method === "POST" && pathname === "/v1/admin/leakage-reports") {
        requireActor();
        const body = await readJson();
        send(201, engine.createLeakageReport(actor, body));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/admin/manifests") {
        requireActor();
        const draft = await readJson();
        send(201, engine.freeze(actor, draft));
        return;
      }
      if (request.method === "POST" && (args = m(/^\/v1\/admin\/leaderboards\/([^/]+)\/release$/))) {
        requireActor();
        const body = await readJson();
        send(201, engine.releaseLeaderboard(actor, args[0], body));
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/admin\/leakage-reports\/([^/]+)$/))) {
        requireActor();
        send(200, engine.getLeakageReport(actor, args[0]));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/admin/audit/verify") {
        requireActor();
        send(200, engine.verifyAudit());
        return;
      }

      // ---- 只读目录 ----
      if (request.method === "GET" && pathname === "/v1/manifests") {
        send(200, { manifests: engine.listManifests() });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/leaderboards") {
        send(200, { leaderboards: engine.listLeaderboards() });
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/leaderboards\/([^/]+)$/))) {
        send(200, engine.getLeaderboard(actor, args[0]));
        return;
      }

      // ---- 团队：权重 / 提交 / 重试 / 申诉 ----
      if (request.method === "POST" && pathname === "/v1/teams/weights") {
        requireActor();
        const manifestHash = q("manifestHash");
        if (!manifestHash) throw new HttpError(400, "BAD_REQUEST", "需要 manifestHash 查询参数");
        const bytes = await readBody();
        send(201, engine.uploadWeights(actor, manifestHash, bytes));
        return;
      }
      if (request.method === "POST" && pathname === "/v1/jobs") {
        requireActor();
        const body = await readJson();
        send(201, engine.submit(actor, body));
        return;
      }
      if (request.method === "POST" && (args = m(/^\/v1\/jobs\/([^/]+)\/retry$/))) {
        requireActor();
        send(200, engine.retry(actor, args[0]));
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/jobs\/([^/]+)\/weights$/))) {
        requireActor();
        const bytes = engine.readWeights(actor, args[0]);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bytes.length,
        });
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/jobs\/([^/]+)\/trace$/))) {
        requireActor();
        send(200, engine.trace(actor, args[0]));
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/jobs\/([^/]+)\/audit-citations$/))) {
        requireActor();
        send(200, { citations: engine.getJobAuditCitations(actor, args[0]) });
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/jobs\/([^/]+)$/))) {
        requireActor();
        send(200, engine.getJob(actor, args[0]));
        return;
      }
      if (request.method === "GET" && pathname === "/v1/jobs") {
        requireActor();
        send(200, { jobs: engine.listJobs(actor, { manifestHash: q("manifestHash") }) });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/appeals") {
        requireActor();
        const body = await readJson();
        send(201, engine.fileAppeal(actor, body));
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/appeals\/([^/]+)\/result$/))) {
        requireActor();
        send(200, engine.getResultForAppeal(actor, args[0]));
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/appeals\/([^/]+)$/))) {
        requireActor();
        send(200, engine.getAppeal(actor, args[0]));
        return;
      }
      if (request.method === "POST" && (args = m(/^\/v1\/reviewer\/appeals\/([^/]+)$/))) {
        requireActor();
        const body = await readJson();
        send(200, engine.reviewAppeal(actor, args[0], body));
        return;
      }

      // ---- 隔离执行环境 ----
      if (request.method === "POST" && (args = m(/^\/v1\/runner\/jobs\/([^/]+)\/run$/))) {
        requireActor();
        const body = await readJson().catch(() => ({}));
        const out = await engine.runAttempt(actor, args[0], body || {});
        send(200, out);
        return;
      }
      if (request.method === "GET" && (args = m(/^\/v1\/results\/([^/]+)$/))) {
        // 已发布结果可匿名读取；密封结果由引擎按角色裁决
        send(200, engine.getResult(actor, args[0]));
        return;
      }

      send(404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      if (err instanceof HttpError) {
        send(err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      send(500, { error: { code: "INTERNAL", message: String(err && err.message ? err.message : err) } });
    }
  });

  server.on("close", () => {
    if (!options.engine) engine.close();
  });

  return server;
}

if (require.main === module) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== SERVICE_ID) throw new Error("服务身份不一致");
    // 若存在数据目录，重放审计哈希链做启动自检
    const fs = require("node:fs");
    const rootDir = process.env.BENCH_DIR || ".bench-data";
    if (fs.existsSync(rootDir)) {
      const probe = new BenchmarkEngine({ rootDir });
      const result = probe.verifyAudit();
      probe.close();
      if (!result.ok) throw new Error("审计哈希链校验失败: " + result.reason);
      process.stdout.write(`基础检查通过（审计链 ${result.entries} 条，head ${result.head.slice(0, 12)}…）\n`);
    } else {
      process.stdout.write("基础检查通过\n");
    }
  } else {
    const port = Number(process.env.PORT || 8000);
    createServer().listen(port, "127.0.0.1");
    process.stdout.write(`${SERVICE_NAME}监听 http://127.0.0.1:${port}\n`);
  }
}

module.exports = {
  SERVICE_ID,
  SERVICE_NAME,
  createServer,
  healthPayload,
  defaultTokens,
  resolveActor,
};
