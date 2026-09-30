# 单细胞模型盲测基准后端

面向跨物种单细胞模型的**隔离盲测基准**。目标是让评审能公平区分“真正的跨物种/跨实验室泛化”与“训练数据已见过测试物种、同一供体或高度相似图谱”的记忆行为。

服务为零依赖 Node.js（需 Node ≥ 18），所有状态落盘为**只追加记录 + 哈希链审计日志 + 分级保管库**，可在任意时点独立重放复查。

## 设计原则：冻结、隔离、可追溯

| 关注点 | 机制 |
| --- | --- |
| 揭盲前冻结 | 冻结清单锁定数据来源、训练可见范围、物种×实验室分层、任务定义、指标口径、阈值与容差、截止时间；冻结体取规范化 SHA-256（`manifestHash`），贯穿作业、结果、榜单、申诉 |
| 样本/谱系泄漏 | 冻结前强制检查：样本标识重叠、图谱内容哈希重叠、同一供体/谱系共享、表达指纹余弦近重复；`leaked` 结论阻止冻结与发布 |
| 隔离执行 | 隐藏矩阵仅在“活动作业的当前尝试”窗口对运行器可读；真值（揭盲材料）只在系统打分进程内部读取，运行器永不接触 |
| 作业身份 | 团队 × 冻结基准唯一作业；失败重试沿用同一 `jobId`，`attemptNumber` 递增；截止闸对提交、重试、运行一致生效 |
| 结果密封 | 截止发布前结果仅授权管理员可见；独立评审只能经申诉上下文查看被申诉结果 |
| 不可变榜单 | 榜单是带哈希的发布快照，一经发布不可改；基准版本更新生成**新快照**，绝不改写旧榜单 |
| 独立评审 | 申诉必须引用哈希链中可复查的日志条目（`seq`+`entryHash`）；评审与团队、管理员角色分离；申诉成立只追加**更正附注**，不改写结果 |
| 受限材料隔离 | 受限表达矩阵 / 各团队权重 / 揭盲材料分三个保管分区，跨团队权重互不可见，每次读取（含拒绝）写访问日志 |
| 可解释公开 | 发布物只含分项表现、适用范围（在哪些 held-out 物种/实验室成立）、资源消耗；不含矩阵、权重与揭盲材料 |
| 端到端溯源 | 获胜结论可追溯到固定数据 → 权重摘要/运行配置 → 每次尝试与预测哈希 → 打分 → 榜单快照 → 申诉评审/更正 |

## 四类盲测任务与冻结指标

| 任务 | 主指标 | 辅助指标 | 方向 |
| --- | --- | --- | --- |
| 未见物种识别 `species_identification` | macro-F1（未见物种不被频次稀释） | accuracy | 越高越好 |
| 健康与病变区分 `health_disease` | AUROC（Mann–Whitney，含并列平均秩） | — | 越高越好 |
| 缺失基因预测 `missing_gene` | Pearson 相关 | RMSE | Pearson 越高越好，RMSE 越低越好 |
| 不确定性校准 `uncertainty_calibration` | ECE（置信度分箱） | 多分类 Brier | 越低越好 |

指标方向由冻结口径固定，清单无法事后翻转；阈值判定带显式容差（高优指标 `value+tol ≥ 阈值`，低优指标 `value-tol ≤ 阈值`）。

## 目录结构

```
lib/hash.js       规范化 JSON 与 SHA-256（键排序，跨进程一致）
lib/store.js      只追加 JSONL 存储（记录哈希，加载时重放校验）
lib/audit.js      哈希链审计日志（prevHash 链接，篡改/调序可发现）
lib/vault.js      三分区隔离保管库（授权裁决 + 访问留痕）
lib/manifest.js   冻结清单校验与规范化
lib/leakage.js    样本与谱系泄漏检查
lib/metrics.js    四任务指标与容差判定
lib/engine.js     编排引擎（角色、作业、执行、打分、榜单、申诉、溯源）
service.js        HTTP API（Bearer 令牌 → 角色）
test/             单元测试 + 引擎端到端 + HTTP 生命周期测试
```

运行数据默认在 `.bench-data/`（已加入 `.gitignore`）：

```
.bench-data/
  records/*.jsonl     只追加业务记录
  audit.log           哈希链审计日志
  vault/
    restricted-matrix/  受限表达矩阵
    team-weights/       各团队权重包（0600）
    unblinding/         揭盲真值材料（0600）
    access.log          保管库访问（含拒绝）留痕
```

## 角色

- `admin` 平台授权管理员：入库受限材料、发起泄漏检查、冻结、发布、查看密封结果。
- `team` 参赛团队（令牌 `team-<teamId>`）：上传本队权重、提交/重试本队作业、对本队结果申诉；发布前看不到任何分数。
- `runner` 隔离执行环境：仅可对 `queued` 作业启动尝试。
- `reviewer` 独立评审：仅在申诉上下文复查日志、查看被申诉结果、作出 upheld/denied 裁决。

内置演示令牌（生产必须替换为外部身份提供方）：`admin-local`、`runner-local`、`reviewer-local`、`team-<teamId>`。

## 基准生命周期

1. **入库**：管理员将受限矩阵与揭盲材料放入保管分区（PUT 字节，系统记录内容哈希）。
2. **泄漏检查**：提交清单草案 + 隐藏样本元数据，系统按训练可见范围做四类检查，报告锚定清单基线哈希。
3. **冻结**：清单引用泄漏报告；检查后任何草案改动都会使基线不匹配而被拒。冻结返回 `manifestHash`。
4. **提交**：团队提交权重摘要（可选权重包引用）与运行配置；同团队同基准只建一个作业。
5. **隔离运行**：runner 对作业启动尝试，仅在尝试窗口读取矩阵；失败回到 `failed`，团队以同一作业身份重试。
6. **打分**：系统内部读取真值，按冻结指标与容差打分，记录预测哈希与资源消耗（wall/runtime/峰值内存/CPU）。
7. **发布**：截止后管理员发布榜单快照；`leaked` 结论阻止发布。
8. **申诉**：引用哈希链日志 → 独立评审裁决 → 成立则追加更正附注，快照哈希不变。
9. **溯源**：`/v1/jobs/:id/trace` 返回固定数据→提交→尝试→结果→快照→评审的完整链条。

## HTTP 接口（节选）

```
PUT  /v1/admin/matrices/:ref        入库受限矩阵（admin）
PUT  /v1/admin/unblinding/:ref      入库揭盲材料（admin）
POST /v1/admin/leakage-reports      泄漏检查（admin）
POST /v1/admin/manifests            冻结清单（admin）
POST /v1/admin/leaderboards/:hash/release   发布榜单快照（admin）
GET  /v1/admin/audit/verify         重放审计哈希链自检（admin）

POST /v1/teams/weights?manifestHash=…      上传权重包（team）
POST /v1/jobs                       提交作业（team）
POST /v1/jobs/:id/retry            失败重试，同一作业身份（owner team）
GET  /v1/jobs/:id                  作业状态（owner / admin / reviewer / runner）
GET  /v1/jobs/:id/audit-citations  本作业可引用的审计日志条目（owner）
GET  /v1/jobs/:id/trace            端到端溯源链
POST /v1/runner/jobs/:id/run       启动一次尝试（runner）
GET  /v1/results/:id               结果（发布前仅 admin）

GET  /v1/leaderboards/:hash        榜单（发布后公开；未发布仅 admin 预览）
POST /v1/appeals                   提交申诉，须带可复查 cites（owner team）
POST /v1/reviewer/appeals/:id      独立评审裁决（reviewer）
GET  /v1/appeals/:id/result        经申诉上下文查看被申诉结果（reviewer）
GET  /health                       公开健康检查
```

## 运行与验证

```bash
npm run check     # 服务身份检查；若数据目录存在则重放审计哈希链
npm test          # 36 个测试：指标/泄漏/冻结单测 + 引擎端到端 + HTTP 生命周期
PORT=8000 node service.js
```

测试覆盖的关键性质：冻结不可变与版本独立、四类泄漏检出与冻结闸、失败重试同身份与 attempt 递增、截止闸（提交/重试/发布）、预测不符冻结口径即失败、结果与榜单的密封可见性、跨团队权重拒绝且留痕、发布快照不可变且新版本不改旧榜、申诉必须引用可复查日志且评审独立、申诉成立只追加更正附注、受限材料越权读取被拒、审计哈希链篡改可发现。

## 安全边界说明

- 演示令牌表仅用于本地联调；部署时应在反向代理或身份层替换为短期、可审计的凭证。
- “隔离执行环境”在本仓库中体现为**访问裁决与材料边界**（运行器只拿到矩阵字节，真值不出打分进程）；若需进程/容器级强隔离，应将 `runner` 实现替换为在沙箱中拉起参赛镜像的适配器，引擎契约不变。
- 保管库文件权限设为 `0600`，但静态加密、密钥管理与备份策略属于部署环境职责。
