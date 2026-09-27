"use strict";

const http = require("node:http");
const { Store } = require("./store");
const { HttpError } = require("./errors");
const domain = require("./domain");

const SERVICE_ID = "single-cell-blind-comparison";
const SERVICE_NAME = "单细胞模型盲测基准";

function healthPayload() {
  return { status: "ok", service: SERVICE_ID, name: SERVICE_NAME };
}

// 本地联调用默认凭证；生产部署通过 BENCH_TOKENS(JSON) 注入。
function defaultTokens() {
  return {
    "dev-admin": { actorId: "admin-1", roles: ["admin"] },
    "dev-executor": { actorId: "executor-1", roles: ["executor"] },
    "dev-team-a": { actorId: "team-a-1", teamId: "team-a", roles: ["team"] },
    "dev-team-b": { actorId: "team-b-1", teamId: "team-b", roles: ["team"] },
    "dev-reviewer": { actorId: "reviewer-1", roles: ["reviewer"] },
  };
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "body_too_large", "请求体超过大小限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

// 路由表：roles 缺失表示公开接口；受限命名空间（隐藏测试集、权重、揭盲材料）不挂任何路由。
function buildRoutes() {
  return [
    { method: "GET", path: "/health", handler: () => ({ status: 200, body: healthPayload() }) },
    {
      method: "POST",
      path: "/v1/versions",
      roles: ["admin"],
      handler: (ctx) => ({ status: 201, body: domain.publicVersion(domain.createVersion(ctx.store, ctx.actor, ctx.body, ctx.now)) }),
    },
    {
      method: "GET",
      path: "/v1/versions",
      handler: (ctx) => ({ status: 200, body: { versions: ctx.store.list("versions").map(domain.publicVersion) } }),
    },
    {
      method: "GET",
      path: "/v1/versions/:versionId",
      handler: (ctx) => {
        const v = ctx.store.get("versions", ctx.params.versionId);
        if (!v) throw new HttpError(404, "not_found", "基准版本不存在");
        return { status: 200, body: domain.publicVersion(v) };
      },
    },
    {
      method: "POST",
      path: "/v1/versions/:versionId/freeze",
      roles: ["admin"],
      handler: (ctx) => ({ status: 200, body: domain.publicVersion(domain.freezeVersion(ctx.store, ctx.actor, ctx.params.versionId, ctx.body, ctx.now)) }),
    },
    {
      method: "POST",
      path: "/v1/versions/:versionId/submissions",
      roles: ["team"],
      handler: (ctx) => ({ status: 201, body: domain.createSubmission(ctx.store, ctx.actor, ctx.params.versionId, ctx.body, ctx.now) }),
    },
    {
      method: "GET",
      path: "/v1/versions/:versionId/leaderboard",
      roles: ["admin", "team", "reviewer"],
      handler: (ctx) => ({ status: 200, body: domain.leaderboardView(ctx.store, ctx.actor, ctx.params.versionId) }),
    },
    {
      method: "POST",
      path: "/v1/versions/:versionId/release",
      roles: ["admin"],
      handler: (ctx) => ({ status: 201, body: domain.publishRelease(ctx.store, ctx.actor, ctx.params.versionId, ctx.now) }),
    },
    {
      method: "GET",
      path: "/v1/versions/:versionId/release",
      handler: (ctx) => ({ status: 200, body: domain.getRelease(ctx.store, ctx.params.versionId) }),
    },
    {
      method: "POST",
      path: "/v1/jobs/:jobId/retry",
      roles: ["team"],
      handler: (ctx) => ({ status: 200, body: domain.retryJob(ctx.store, ctx.actor, ctx.params.jobId, ctx.body, ctx.now) }),
    },
    {
      method: "POST",
      path: "/v1/jobs/:jobId/executions",
      roles: ["executor", "admin"],
      handler: (ctx) => ({ status: 201, body: domain.recordExecution(ctx.store, ctx.actor, ctx.params.jobId, ctx.body, ctx.now) }),
    },
    {
      method: "GET",
      path: "/v1/submissions/:submissionId",
      roles: ["admin", "team"],
      handler: (ctx) => ({ status: 200, body: domain.getSubmissionView(ctx.store, ctx.actor, ctx.params.submissionId, ctx.now) }),
    },
    {
      method: "POST",
      path: "/v1/appeals",
      roles: ["team"],
      handler: (ctx) => ({ status: 201, body: domain.fileAppeal(ctx.store, ctx.actor, ctx.body, ctx.now) }),
    },
    {
      method: "POST",
      path: "/v1/appeals/:appealId/decision",
      roles: ["reviewer"],
      handler: (ctx) => ({ status: 200, body: domain.decideAppeal(ctx.store, ctx.actor, ctx.params.appealId, ctx.body, ctx.now) }),
    },
    {
      method: "GET",
      path: "/v1/audit",
      roles: ["admin"],
      handler: (ctx) => ({ status: 200, body: { entries: ctx.store.audit, valid: ctx.store.verifyAudit() } }),
    },
  ];
}

function matchRoute(routes, method, segments) {
  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    if (route.method !== method || parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(":")) {
        params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      } else if (parts[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

function authenticate(req, tokens) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  return tokens[match[1]] || null;
}

function createApp(options = {}) {
  const store = options.store || new Store();
  const tokens = options.tokens || defaultTokens();
  const now = options.now || (() => new Date());
  const routes = buildRoutes();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);
      const matched = matchRoute(routes, req.method, segments);
      if (!matched) throw new HttpError(404, "not_found", "路由不存在");
      const { route, params } = matched;

      let actor = null;
      if (route.roles) {
        actor = authenticate(req, tokens);
        if (!actor) throw new HttpError(401, "unauthenticated", "缺少有效凭证");
        if (!route.roles.some((r) => actor.roles.includes(r))) {
          throw new HttpError(403, "forbidden", "权限不足");
        }
      }

      const body = req.method === "GET" ? {} : await readBody(req);
      const result = route.handler({ store, actor, params, body, now: now() });
      send(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        send(res, 500, { error: { code: "internal", message: "内部错误" } });
      }
    }
  });
  server.store = store;
  return server;
}

module.exports = { SERVICE_ID, SERVICE_NAME, healthPayload, defaultTokens, createApp };
