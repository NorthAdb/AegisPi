# 文档索引（统一入口）

维护规则：本索引只指路并标明每份资料的用途与身份，不复制正文（避免多副本口径漂移）。审计原稿、冻结报告、原始日志与证据文件字节不变；历史文档不按现行口径改写，其历史结论与现行结论并列时以本索引的标注为准；更正一律走 [phase3/reports/errata-2026-11-20.md](phase3/reports/errata-2026-11-20.md) 与各文档的日期追记节。

## 推荐阅读顺序（新人）

1. 根 [README](../README.md)：项目定位、已实现/未实现边界、运行前置条件。
2. 本文：按类别找对资料，认清「现行」与「历史」身份。
3. [phase3/reports/phase3-status-and-remaining.md](phase3/reports/phase3-status-and-remaining.md)：现行权威状态清单（四项真实验收现状、审计归档、镜像、缺口、待办）。
4. [adr/0001-model-path-pi-host-execution.md](adr/0001-model-path-pi-host-execution.md) + [phase4/phase4-restricted-kickoff-draft.md](phase4/phase4-restricted-kickoff-draft.md)：下一步的设计与计划（方案已确认，未实施、未授权运行）；单元 4.1 的实施细则见 [phase4/phase4-1-implementation-task-spec.md](phase4/phase4-1-implementation-task-spec.md)（已备待授权，不含运行授权）。
5. 按需查各阶段历史：phase1/2/3 收口报告与审计原稿（只作史实，不作操作依据）。

## 现行规范（操作依据）

| 资料 | 用途 |
| --- | --- |
| 本机设计包 `D:\AegisPi\aegis-pi-design-pack-v1.4.1` | 唯一规范来源，不随库分发；修订契约读原包 |
| 根 [AGENTS.md](../AGENTS.md) | 仓库级硬约束（版本锁定、Phase 边界、敏感内容、证据格式、不越界） |
| [apps/daemon/config/defaults.json](../apps/daemon/config/defaults.json) | 唯一策略默认（预算 $0.80/$5、失败关闭开关），git diff 始终 0 行 |
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
| [phase4/phase4-restricted-kickoff-draft.md](phase4/phase4-restricted-kickoff-draft.md) | Phase 4 拆单元 4.1（模型链路实现）/ 4.2（真实仓库 Observe）；两种许可分列；七项首跑检查表。**4.1 已获授权实施并本机验收通过；4.2 首跑仍待逐项书面确认，不构成任何真实运行授权** |
| [phase4/phase4-1-implementation-task-spec.md](phase4/phase4-1-implementation-task-spec.md) | 单元 4.1 实施任务书（基线 `52354a8`，含 D-77/D-78 修订）。**4.1 实施完成，验收依据**：分步目标与产物、端到端锚点用例、最小验收矩阵 T1–T10、环境/镜像/交付与停止条件在焉；4.2 与一切真实运行不在其授权内 |
| [phase3/reports/real-acceptance-plan.md](phase3/reports/real-acceptance-plan.md) | A/B/C/D 真实验收计划。A/B/C 已执行且授权闭合（无剩余额度），D 延期——文中「待主人逐项授权」对 D 与任何重跑仍然有效，对已闭合项不提供剩余额度 |

## 状态说明（现行权威）

| 资料 | 用途 |
| --- | --- |
| [phase4/reports/phase4-1-closure.md](phase4/reports/phase4-1-closure.md) | **单元 4.1 收口验收报告**（2026-11-20）：§2a–§2c 实施产物、T1–T10 矩阵与锚点 E2E 观测对照、纪元 3 镜像证据、全量 12 套件 + Hono 预检通过记录、生产树 `model-call-child` 零出现证明、`defaults.json` 失败关闭核对与三项已知残留 |
| [phase3/reports/phase3-status-and-remaining.md](phase3/reports/phase3-status-and-remaining.md) | **Phase 3–4 状态与待办清单**（2026-11-20）：A/B/C/D 现状、审计归档与判定、原镜像口径、模型路径（4.1 实施完成）与 4.2 待办汇总 |
| [phase3/reports/round-closure-2026-11-20-limited-fixes.md](phase3/reports/round-closure-2026-11-20-limited-fixes.md) | 限定修复收口：daemon 用例崩溃根因（测试层修复、生产零改动）与纪元 2 选择性重建；终树三 docker 套件 14/14、29/29、5/5 |
| [phase3/reports/image-digest.md](phase3/reports/image-digest.md) | **现行镜像纪元表**（纪元 3：重建 `agent`，携带 `acquisition`/`execution`；v2 机器块，image-gate 解析，勿手改）；前序纪元保留为历史节 |
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

**Phase 4（单元 4.1 已收口，4.2 未授权开工）**

- 设计与计划见上文「设计决策」「阶段计划」；收口报告见 [phase4/reports/phase4-1-closure.md](phase4/reports/phase4-1-closure.md)；[phase4/reviews/](phase4/reviews) 为审核往来记录。

## 纪律速记

- 真实入口四类（A 模型 / B 外部写 / C Telegram / D 公网 webhook）：逐项书面授权「仅限本次」，闭合后零剩余额度，重跑即需新授权；D 延期至首次启用 Telegram 公网入站 webhook 前，不作为全部 Phase 4 的前置条件，出站发送另需授权。
- 不常开；`defaults.json` 失败关闭；任务 $0.80 / 日 $5 已定不重开（价格、token 上限与单次预留属首跑检查表核对，非预算重谈）。
- 密钥只进本机 `.env`；审计原稿与证据字节不变；历史缺证不追补；任何阶段结论以「状态说明」类文档为准。
