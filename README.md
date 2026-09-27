# 单细胞模型盲测基准

服务面向跨物种单细胞模型的隔离盲测，为可复查比较流程提供稳定入口。

## 治理规则

- **冻结**：管理员创建基准版本（数据来源、训练可见范围、物种/实验室分层、任务、指标、容差、结果截止日），冻结时计算清单哈希并存入隐藏测试集；冻结后不存在任何修改入口。
- **隔离**：隐藏测试集、权重本体、揭盲材料只进入受限命名空间，不挂任何 HTTP 路由；公开视图中 hidden-test 数据源只暴露 id 与可见性。执行环境仅回传预测与资源消耗。
- **提交与重试**：参赛团队提交权重摘要（`sha256:<hex>`）与运行配置（代码引用、代码摘要、训练谱系声明）；声明的训练来源超出冻结清单即拒绝。失败重试沿用同一作业身份（jobId 不变、attempt 递增），可修正运行配置并重新校验。
- **泄漏检查**：执行时对照隐藏测试谱系索引检查样本、供体、物种、实验室与隐藏数据源五个维度的重叠，命中即判失败并留痕。
- **评测任务**：未见物种识别（accuracy）、健康/病变区分（AUROC）、缺失基因预测（Pearson）、不确定性校准（ECE）；按清单容差判定通过与否，方向归一化后加权合成综合分。
- **密封与发布**：截止日前结果与榜单仅授权管理员可见；截止日后管理员发布，发布文档公开分项表现、适用范围（物种/实验室）与资源消耗，每版本只发布一次，新版本不改写旧榜单。
- **申诉**：必须引用至少一条可复查的审计日志（按 seq），评审人不能是冻结人、执行人或申诉方；裁决成立即废止对应榜单条目，全程留痕。
- **可追溯**：所有关键动作写入哈希链审计日志，`GET /v1/audit`（管理员）可校验链完整性；发布文档记录清单哈希与审计链头。

## 接口概览

| 方法 | 路径 | 角色 |
| --- | --- | --- |
| GET | `/health` | 公开 |
| POST | `/v1/versions` | admin |
| GET | `/v1/versions`、`/v1/versions/:id` | 公开（脱敏） |
| POST | `/v1/versions/:id/freeze` | admin |
| POST | `/v1/versions/:id/submissions` | team |
| POST | `/v1/jobs/:jobId/retry` | 本团队 |
| POST | `/v1/jobs/:jobId/executions` | executor / admin |
| GET | `/v1/submissions/:id` | admin / 本团队（截止日前结果密封） |
| GET | `/v1/versions/:id/leaderboard` | admin；发布后公开给登录角色 |
| POST | `/v1/versions/:id/release` | admin（截止日后） |
| GET | `/v1/versions/:id/release` | 公开 |
| POST | `/v1/appeals`、`/v1/appeals/:id/decision` | team / reviewer |
| GET | `/v1/audit` | admin |

认证使用 `Authorization: Bearer <token>`，本地联调凭证见 `src/app.js` 的 `defaultTokens()`，生产通过环境变量 `BENCH_TOKENS`(JSON) 注入。

## 运行

`npm run check` 核对配置，`npm test` 验证接口契约与治理规则，`node service.js` 启动服务（默认 `127.0.0.1:8000`，`PORT` 可改）。
