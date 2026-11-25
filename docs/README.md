# 文档索引（统一入口）

维护规则：本索引只指路并标明每份资料的用途与身份，不复制正文（避免多副本口径漂移）。`docs/` 根目录只保留 **3 个主入口**（[README.md](README.md)、[SELF-USE-GUIDE.md](SELF-USE-GUIDE.md)、[V1-CLOSURE-AND-V2-MIGRATION.md](V1-CLOSURE-AND-V2-MIGRATION.md)），过渡交接与缺口盘点档案集中归档于 [v1/](v1/)，Phase 1–5 收口报告与证据路径按评测脚本契约保持在 `phase1/`–`phase5/` 与 `adr/`。审计原稿、冻结报告、原始日志与证据文件字节不变。

## 推荐阅读顺序

1. 根 [README](../README.md)：项目定位、v1 封存基线总览与运行前置条件。
2. [V1-CLOSURE-AND-V2-MIGRATION.md](V1-CLOSURE-AND-V2-MIGRATION.md)：**v1 正式封存裁决、全部剩余项处置结论及 v2 拟复用资产清单**（首读收官结论）。
3. [SELF-USE-GUIDE.md](SELF-USE-GUIDE.md)：v1 本地单命令冷启动与 Web Console `⑤ 设置与接入` 操作指南。
4. 本文：按类别找对历史资料（[v1/](v1/)、[phase1/](phase1/)–[phase5/](phase5/)、[adr/](adr/)）。
5. 历史审计与阶段收口：phase1–5 下各收口报告、证据及 [v1/](v1/) 历史交接档（仅作史实追溯，不作为后续开发任务单）。

## 现行规范（操作依据）

| 资料 | 用途 |
| --- | --- |
| 本机设计包 `D:\AegisPi\aegis-pi-design-pack-v1.4.1` | 唯一规范来源，不随库分发；修订契约读原包 |
| 根 [AGENTS.md](../AGENTS.md) | 仓库级硬约束（版本锁定、Phase 边界、敏感内容、证据格式、不越界） |
| [apps/daemon/config/defaults.json](../apps/daemon/config/defaults.json) | 唯一策略默认（预算 $0.80/$5、失败关闭开关：baseUrl=null、双白名单=[]、allowReal*=false、四项 priceCatalog=null） |
| [apps/daemon/config/schema-source.json](../apps/daemon/config/schema-source.json) | schema.sql 指针与哈希门（漂移即红） |

## 设计决策（现行）

| 资料 | 状态与用途 |
| --- | --- |
| [adr/0001-model-path-pi-host-execution.md](adr/0001-model-path-pi-host-execution.md) | 模型链路最小方案（容器提议、宿主复用 pi-ai 1.5.2 执行）。**单元 4.1 已获授权实施并通过本机离线/容器验收（2026-11-20，见 [phase4/reports/phase4-1-closure.md](phase4/reports/phase4-1-closure.md)）；单元 4.2 真实运行仍未授权** |
| [phase4/reviews/REVIEW-MODEL-ADR-cde9bd3.md](phase4/reviews/REVIEW-MODEL-ADR-cde9bd3.md) | 方案审核原稿（字节冻结，SHA-256 `685192d7…`，判定「需改后通过、4.1 可实施候选、不授权实施」） |
| [phase4/reviews/response-review-model-adr-cde9bd3.md](phase4/reviews/response-review-model-adr-cde9bd3.md) | 对上述审核的逐项回应与追记（四项更正落点 + 两句澄清记录 + 方案确认追记） |

## 阶段计划（现行）

| 资料 | 状态与用途 |
| --- | --- |
| [phase5/phase5-kickoff-plan.md](phase5/phase5-kickoff-plan.md) | **Phase 5 详细实施与验收规划（`D-90` 定稿，含 `D-95` 范围调整）**：将 Phase 5 拆分为单元 5.1（分层记忆 L0–L2/L3 数据结构、13 类注入扫描、墓碑遗忘清单、技能与 Spill）→ 5.2（Telegram 路线 1 `getUpdates` 轮询入站与跨通道 Canary 隔离）→ 5.3（场景一邮件草稿审批、4h 停车与对账）→ 5.4（场景二晨报、带时区条件 Timer、日历 ETag 审批与**转入的 L3 Dreaming 编排循环**）→ 5.5（控制台 API 补齐与 `127.0.0.1:4310/` 最小 Web 前端）→ 5.6（许可 2 实盘验收与终局对抗审计） |
| [phase4/phase4-restricted-kickoff-draft.md](phase4/phase4-restricted-kickoff-draft.md) | Phase 4 拆单元 4.1（模型链路实现）/ 4.2（真实仓库 Observe）；两种许可分列；七项首跑检查表。**4.1 已通过独立审计冻结；4.2 许可 1 与许可 2 广度真实验收均已完成** |
| [phase4/phase4-1-implementation-task-spec.md](phase4/phase4-1-implementation-task-spec.md) | 单元 4.1 实施任务书（基线 `52354a8`，含 D-77/D-78 修订）。**4.1 实施并审计冻结，验收依据**：分步目标与产物、锚点用例、矩阵 T1–T10 与停止条件 |
| [phase4/phase4-2-offline-task-spec.md](phase4/phase4-2-offline-task-spec.md) | **单元 4.2 许可 1 离线任务书**：只读 Repo Observe 离线编排、业务级 `maxInputBytes`/`maxOutputTokens` 硬上限、`HELD` 停机语义、4.1 延后 P2 项与 `model:real` opt-in 守卫（不含任何真实运行授权） |
| [phase3/reports/real-acceptance-plan.md](phase3/reports/real-acceptance-plan.md) | A/B/C/D 真实验收计划。A/B/C 已执行且授权闭合（无剩余额度），D 延期——文中「待主人逐项授权」对 D 与任何重跑仍然有效，对已闭合项不提供剩余额度 |

## 状态说明（现行权威）

| 资料 | 用途 |
| --- | --- |
| [V1-CLOSURE-AND-V2-MIGRATION.md](V1-CLOSURE-AND-V2-MIGRATION.md) | **v1 正式收官封存与 v2 迁移说明（2026-11-25，`v1-zero-trust-baseline`）**：记录 `327/327` / `selfuse 31/31` 封存基线、14 项历史缺口与旧 Phase 6 项的最终处置表，以及后续 v2 拟抽离复用的 5 块 v1 核心安全资产 |
| [SELF-USE-GUIDE.md](SELF-USE-GUIDE.md) | **v1 个人自用指南**：单命令冷启动（`scripts/selfuse.mjs start`）、Web Console `⑤ 设置与接入` 填写配置与热重载说明 |
| [v1/GAP-INVENTORY-AND-PHASE6.md](v1/GAP-INVENTORY-AND-PHASE6.md) | **v1 历史缺口盘点与最终处置台账（已归档）**：集中核查 `G-A1..G-A6`、`G-B1..G-B2`、`C1..C6` 并标注最终处置结论 |
| [v1/HANDOFF-PHASE5-TO-SELFUSE.md](v1/HANDOFF-PHASE5-TO-SELFUSE.md) | **Phase 5 至自用过渡历史交接档（已归档）**：记录当时自用差距评估及后续已完成/已封存映射 |
| [phase5/HANDOFF-BATCH1-AUDIT.md](phase5/HANDOFF-BATCH1-AUDIT.md) | **Phase 5 第 1 批交接与验收结论（2026-11-22，`D-95`/`D-96`）**：记录 `45b7c03..52e223a` 初版对抗审计（`HOLD`）、`D-94` 主人豁免归档、L3 Dreaming 转入第 2 批，以及 **`D-96` 返工修复后全量验收 `PASS`（放行第 2 批）** |
| [phase5/reports/phase5-batch1-closure.md](phase5/reports/phase5-batch1-closure.md) | **Phase 5 第 1 批收口报告（单元 5.1 + 5.2，2026-11-22）**：含初版自测、`D-94` 声明、§七初版审计（`HOLD`）与 **§八返工修复与最终验收收口（`D-96 PASS`，纪元 13，`47/47` + `23/23`）** |
| [phase5/reports/phase5-batch2-closure.md](phase5/reports/phase5-batch2-closure.md) | **Phase 5 第 2 批收口报告（单元 5.3 邮件 + 5.4 日历/L3 Dreaming + 5.5 Web 控制台，2026-11-22，`D-97`）**：`eval:scenarios` `78/78`（环回 TLS SMTP/IMAP/CalDAV 夹具全矩阵）、security-unit `63/63`（+15 个 5.5 用例）、cancel-approval `20/20`（+4）、纪元 14、17 套全量回归 + real×5 exit 4 + `report:user-value` `149/149`，浏览器 E2E 四页签实测截图归档 `phase5/evidence/browser-e2e/` |
| [phase5/reports/phase5-final-closure.md](phase5/reports/phase5-final-closure.md) | **Phase 5 终局收口报告（单元 5.6 许可 2 实盘 + `report:user-value` 升级，2026-11-23，`D-102`）**：`eval:scenarios:real`（缺省 `exit 4`）实盘验收真实 `getUpdates` 私聊/测试群 Canary 隔离 + 真实邮箱 IMAP→DeepSeek 草稿→`127.0.0.1:4310` 审批→SMTP 恰 1 封回信；**真实 CalDAV 按主人裁定登记 `DEFERRED / NOT VERIFIED`（不阻塞 Phase 5）**；`report:user-value` 升级 12 套必检 + 分场景/分 purpose 归因；D-101 两项非阻断瑕疵修复；第 4 次实盘 23/23 后收尾崩溃的 finalize 证据链如实登记 |
| [phase4/reports/phase4-5-closure.md](phase4/reports/phase4-5-closure.md) | **单元 4.5 与 Phase 4 终局收口报告**（2026-11-21 纪元 11.4/11.5）：`eval:triage:real` 6/6 实盘验收（GitHub + DeepSeek + 无网 TS 执行 + `@aegispibot` TLS/CONNECT 私聊）、4 路对抗审计加固、SSRF IP 字面量保护、全量 16 项回归与 `report:user-value` 134/134 通过 |
| [phase4/HANDOFF-UNIT4-5.md](phase4/HANDOFF-UNIT4-5.md) | **单元 4.5 会话交接存档**（历史基线，2026-11-21 纪元 10）：已由单元 4.5 实盘与终局收口完成承接 |
| [phase4/reports/phase4-4-closure.md](phase4/reports/phase4-4-closure.md) | **单元 4.4 收口报告**（2026-11-21 纪元 9 终版）：Scenario 4 `repo_triage` 双快照采集与四分类神谕裁定、`eval:triage` 7/7、`report:user-value` 125/125 与全量 17 项通过 |
| [phase4/reports/user-value-report.md](phase4/reports/user-value-report.md) | **Phase 4 证据聚合报告**：汇总 `triage`、`repo-observe`、`model-proposal`、`security-unit`、`offline-jobs`、`security-integration`、`repo-observe-real` 与 `triage-real`（**134/134 PASS**，defaults 失败关闭确认） |
| [phase4/reports/phase4-3-closure.md](phase4/reports/phase4-3-closure.md) | **单元 4.3 收口报告**（2026-11-21 纪元 7 终版）：空回复防误判 `SUCCEEDED`、KV 前缀稳态与前置截停、`telegram-send` fail-closed 出站适配器及全量 13 套件 + Hono 预检通过 |
| [phase4/reports/phase4-2-real-acceptance.md](phase4/reports/phase4-2-real-acceptance.md) | **单元 4.2 许可 2 广度真实 Repo Observe 验收报告**（2026-11-21）：6 个锁定 commit 公开 GitHub 仓库 + 真实 `api.deepseek.com` 8/8 PASS（含 `cacheRead` 命中结算、截断、`file` 模式、`302->codeload` 拦阻、`182 MB` tar 截停与欠价 `HELD` 停机）及 `4096` 输出耗尽实证记录 |
| [phase4/reports/phase4-2-offline-closure.md](phase4/reports/phase4-2-offline-closure.md) | **单元 4.2 许可 1 离线收口报告**（2026-11-21 纪元 6 终版）：只读 Repo Observe 离线闭环、`downloader.mjs` 双摘要修复、4.1 路线 A 延后加固闭合、`model-real` exit 4 护栏、纪元 6 镜像与全量 13 套件 + Hono 预检通过记录及待签许可 2 检查表 |
| [phase4/reports/phase4-1-closure.md](phase4/reports/phase4-1-closure.md) | **单元 4.1 收口验收报告**（2026-11-21 纪元 5 终版）：§2a–§2c 实施产物、T1–T10 矩阵与锚点 E2E 观测对照、纪元 5 镜像证据与自审计 19 项加固整改汇总 |
| [phase3/reports/phase3-status-and-remaining.md](phase3/reports/phase3-status-and-remaining.md) | **Phase 3–4 状态与待办清单**：A/B/C/D 现状、审计归档与判定、原镜像口径、模型路径（4.1 审计冻结、4.2 许可 1 离线就绪）与 4.2 首跑待办汇总 |
| [phase3/reports/round-closure-2026-11-20-limited-fixes.md](phase3/reports/round-closure-2026-11-20-limited-fixes.md) | 限定修复收口：daemon 用例崩溃根因（测试层修复、生产零改动）与纪元 2 选择性重建；终树三 docker 套件 14/14、29/29、5/5 |
| [phase3/reports/image-digest.md](phase3/reports/image-digest.md) | **现行镜像摘要表**（`agent:phase3-357d3a70e2ea`，manifest `sha256:a3d84892…`，携带 `acquisition` 与 `execution`；v2 机器块，image-gate 解析，勿手改）；前序纪元保留为历史节 |
| [phase3/reports/quota-calibration.md](phase3/reports/quota-calibration.md) | 容器配额占位值的实测依据（CPU/内存/pids/可写盘） |

## 历史收口与审计（史实身份，不作现行操作依据）

共同纪律：各阶段 `audits/` 下审计原稿字节冻结不改；`evidence/` 执行证据字节冻结（套件重跑会再生 report/log，以各收口报告标注的轮次为准）；回应与勘误另写不改原稿。

**Phase 1（底座契约，已收口 2026-11-19）**

- [phase1/AUDIT-HANDOFF.md](phase1/AUDIT-HANDOFF.md)：审计移交入口（收口后状态快照）。
- [phase1/reports/phase1-closure.md](phase1/reports/phase1-closure.md)：收口声明（四轮审计史见 [audit-history.md](phase1/reports/audit-history.md)）。
- [phase1/reports/phase1-open-items.md](phase1/reports/phase1-open-items.md)：收口时未决项（后续阶段安排，多已在 Phase 2/3 落地）。
- [model-binding.md](phase1/reports/model-binding.md)、[sqlite-driver.md](phase1/reports/sqlite-driver.md)、[image-digest.md](phase1/reports/image-digest.md)（基础镜像 digest）：Phase 1 结论性报告。
- [phase1/audits/](phase1/audits)（三份原稿）与 [phase1/evidence/](phase1/evidence)（含 07 真实连接最小推理记录）。

**Phase 2（持久化只读链路与恢复，已收口 2026-11-19）**

- [phase2/reports/phase2-closure.md](phase2/reports/phase2-closure.md)：收口报告（独立复审 `461c58f` 判定 MET WITH RESIDUAL RISKS，整改已落地）。
- [audit-response-461c58f.md](phase2/reports/audit-response-461c58f.md)、[phase2/audits/](phase2/audits)、[phase2/evidence/](phase2/evidence)。

**Phase 3（安全边界与首次常开门槛，出口 MET WITH RESIDUAL RISKS）**

- [phase3/reports/phase3-closure.md](phase3/reports/phase3-closure.md)：2026-11-19 收口报告快照。**历史身份**：其后 2026-11-20 的复核、勘误、限定修复与原镜像「本机验证即闭项」等决定不在其内，现行状态一律以 [phase3-status-and-remaining.md](phase3/reports/phase3-status-and-remaining.md) 为准。
- [errata-2026-11-20.md](phase3/reports/errata-2026-11-20.md)：勘误通道（A 授权上限 ≤2、C 账本计数口径等）。
- [model-path-and-pi.md](phase3/reports/model-path-and-pi.md)：模型路径与缺口 A/B/C 史。**历史身份**：其 §7.2「归属待复核」已被 ADR-0001 的方案确认承接，归属现状以 ADR 状态行为准。
- [real-acceptance-run-a-c.md](phase3/reports/real-acceptance-run-a-c.md) 与 [real-acceptance-run-b.md](phase3/reports/real-acceptance-run-b.md)：A/B/C 与 B 的执行记录（授权已闭合）。
- [image-delivery.md](phase3/reports/image-delivery.md)、[image-transfer-manifest.md](phase3/reports/image-transfer-manifest.md)、[local-original-image-verification.md](phase3/reports/local-original-image-verification.md)：原镜像交付准备与本机验证（主人 2026-11-20 决定：本机验证通过即闭项，不要求移交第三方）。
- [telegram-call-ledger-retrospective.md](phase3/reports/telegram-call-ledger-retrospective.md)：Telegram 历史调用账本追溯（缺证如实记录，不追补）。
- [phase3/audits/](phase3/audits)（六份原稿字节冻结，含 `AUDIT-PHASE3-REREVIEW-33d6361` 与 `AUDIT-PHASE3-LIMITED-FIXES-44b3514`）与 [phase3/evidence/](phase3/evidence)。

**Phase 4（全量收口，2026-11-21；单元 4.1 审计冻结于 8943a10；单元 4.2–4.4 分步落地；单元 4.5 `eval:triage:real` 6/6 实盘 + 终局 4 路对抗审计加固 + 纪元 11.5 134/134 全绿收口，见 [phase4-5-closure.md](phase4/reports/phase4-5-closure.md)）**

- 设计与计划见上文「设计决策」「阶段计划」；**单元 4.5 与 Phase 4 终局收口报告**见 [phase4/reports/phase4-5-closure.md](phase4/reports/phase4-5-closure.md)、[phase4/reports/user-value-report.md](phase4/reports/user-value-report.md) 与实盘证据 [triage-real-report.json](phase3/evidence/triage-real-report.json)；前序报告与交接见 [phase4/HANDOFF-UNIT4-5.md](phase4/HANDOFF-UNIT4-5.md)、[phase4/reports/phase4-4-closure.md](phase4/reports/phase4-4-closure.md)、[phase4/reports/phase4-3-closure.md](phase4/reports/phase4-3-closure.md)、[phase4/reports/phase4-2-real-acceptance.md](phase4/reports/phase4-2-real-acceptance.md)、[phase4/reports/phase4-2-offline-closure.md](phase4/reports/phase4-2-offline-closure.md) 与 [phase4/reports/phase4-1-closure.md](phase4/reports/phase4-1-closure.md)；独立对抗审计原稿见 [phase4/audits/AUDIT-PHASE4-UNIT4-1-8943a10.md](phase4/audits/AUDIT-PHASE4-UNIT4-1-8943a10.md)（`PASS WITH RESIDUALS`，路线 A 冻结）；[phase4/reviews/](phase4/reviews) 为方案审核往来记录。

## 纪律速记

- 真实入口四类（A 模型 / B 外部写 / C Telegram / D 公网 webhook）：逐项书面授权「仅限本次」，闭合后零剩余额度，重跑即需新授权；D 延期至首次启用 Telegram 公网入站 webhook 前（2026-11-22 确认：在备齐公网 HTTPS 域名/端口材料前先走路线 1 `getUpdates` 主动长轮询入站，D 项继续推迟且不阻挡 Phase 5 及后续进度），出站发送与实盘轮询另需授权。
- 单元 5.6 许可 2 实盘（`eval:scenarios:real`，`AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE=1`，缺省 `exit 4`）：`D-102` 裁定范围已执行一批（Telegram Pull 隔离 + 真实邮箱恰 1 封回信；授权闭合，重跑即需新授权）；**真实 CalDAV 实盘延后：`CALDAV_*` 未配置，登记为 `DEFERRED / NOT VERIFIED`，不阻塞 Phase 5**（场景二闭环由 Permit 1 环回夹具 `eval:scenarios` 89/89 验收在案）。
- 不常开；`defaults.json` 失败关闭；任务 $0.80 / 日 $5 已定不重开（价格、token 上限与单次预留属首跑检查表核对，非预算重谈）。
- 密钥只进本机 `.env`；审计原稿与证据字节不变；历史缺证不追补；任何阶段结论以「状态说明」类文档为准。
