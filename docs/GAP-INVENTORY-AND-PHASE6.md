# AegisPi 全量缺口盘点与 Phase 6 待实施清单

> **归档说明**：本文盘点的全部 14 项缺口及处置结论已完成最终裁决并封存，请以 [V1-CLOSURE-AND-V2-MIGRATION.md](V1-CLOSURE-AND-V2-MIGRATION.md) 为准（v1 不再继续补做或启动旧 Phase 6，相关项分别按替代 / 封存 / 后置 / 吸收进 v2 主线处置）。
>
> **盘点日期**：2026-11-25（Asia/Hong_Kong）
> **对照基线**：仓库 `main`（`1b847e7`）对照设计包 `D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\00`–`06`
> **前序验证基线**：`evals/phase4/report-user-value/run.mjs` `327/327 PASS`（`defaultsFailClosed=true`、`secretScan=clean`），`evals/phase5/selfuse/run.mjs` `31/31 PASS`。

本文把除已收口能力之外的所有剩余事项集中放在同一份清单里，分为三类以便统一审视决策：

1. **A 类（G-A1 ~ G-A6）**：Phase 1–5 门槛之外、但设计包 `00`–`06` 明确写过且**当前尚未接实或仅半闭环**的事项（不含主人点名推迟项）。
2. **B 类（G-B1 ~ G-B2）**：**主人明确裁定推迟**的事项（仅供全景对照，不算遗漏）。
3. **C 类（C1 ~ C6）**：**Phase 6（受控 RSI、可复现 Replay 与终态控制台）** 全部待交付事项，区分“已预埋底座”与“待开发缺口”。

---

## 一、全景汇总表

| 编号 | 类别 | 事项名称 | 规范来源 | 当前代码状态 | 阻断日常自用？ |
| --- | --- | --- | --- | --- | --- |
| G-A1 | 前五阶段设计缺口 | 公开写仓库与复合 PR 链路（真实 GitHub 传输） | `03 §2.3`、`04 §2`、`06 §5` | 仅定义 `pr.create_draft` 校验，无真实 GitHub 写适配器与分步组卡 UI | 否（只读分诊可用，不能代发真实 PR） |
| G-A2 | 前五阶段设计缺口 | 容器内 Pi 多步工具循环；`router`/`summary`/`classify` 未用模型实测 | `00 §3`、`02 §4`、`05`、`ADR-0001` | 宿主单次 `completeSimple` + 自用多轮历史；容器无 `AgentSession` 循环；3 个 purpose 为未测 | 否（已支持单轮与多轮文本对话，复杂自主排查受限） |
| G-A3 | 前五阶段设计缺口 | 真实供应商账单对账与 `CHARGED_BOUND` 校正流 | `06 §8`、`model-path-and-pi.md §7` | 仅按本地 `priceCatalog` 自算结清；真实外部账单校正未实盘 | 否（本地账本上限硬门禁有效） |
| G-A4 | 前五阶段设计缺口 | 通用长任务 `feature list` 验证器与语义 `Watchdog` | `03 §6`、`06 §8` | 确定性步数/预算/墙钟/租约已落地；语义 Watchdog 与 `feature list` 未实现 | 否 |
| G-A5 | 前五阶段设计缺口 | 标准 OpenTelemetry（`OTel`）Span 写入受 ACL 对象存储 | `06 §2`、`06 §10` | 无 OTel exporter/span 写盘；`/api/tasks/:id/trace` 直接拼 DB 表 | 否 |
| G-A6 | 前五阶段非阻断瑕疵 | `effect_response` 与 `mail_draft` 空心对象引用 | `phase5-final-closure.md §5` | DB 有 `objects` 行与哈希但未写盘内容（正本仍在 `action_json`/`audit_log`） | 否 |
| G-B1 | 主人裁定推迟 | 真实 `CalDAV` 日历实盘（`CALDAV_*`） | `D-102`、`03 §4` | Permit 1 环回夹具与 ETag 防覆盖已验；实盘标记 `DEFERRED / NOT VERIFIED` | 按需求开启 |
| G-B2 | 主人裁定推迟 | Telegram 公网 Webhook（路线 2 `setWebhook`） | `phase3-status-and-remaining.md §1 D` | 路由代码在案未暴露，日常走路线 1 `getUpdates` 长轮询 | 否 |
| C1 | Phase 6 | 信号聚类与后台 Curator 候选（`proposed_updates`） | `03 §7.1`、`04 §6`、`06 §2` | `proposed_updates` 仅建表，业务逻辑为 0 | 否（需先攒真实失败样本） |
| C2 | Phase 6 | 可复现 Shadow Replay 与隔离 Holdout 盲测（`eval:replay`） | `03 §7.2–7.3`、`04 §4/§6` | `budget.mjs` 仅预留 `"replay"` 枚举；重放器/夹具 manifest/holdout 隔离为 0 | 否 |
| C3 | Phase 6 | 人工晋升、技能版本回滚与补偿删除候选（`test:promotion`） | `03 §7.3`、`04 §4/§6` | `skills.mjs` 已有注册/激活/`skill_set_hash` 锁；缺回滚方法及 3 条 HTTP 路由 | 否 |
| C4 | Phase 6 | MCP Pin 安全治理与指纹变更隔离 | `02 §6`、`04 §4/§6` | `POST /api/mcp-pins/:id/decide` 兜底返回 `501`，无 `mcp_pin` 注册/重连核验 | 否 |
| C5 | Phase 6 | 终态控制台四大视图补齐（`Replay Studio`、拓扑图等） | `04 §3`、`04 §6` | 已有原生 DOM 5 页签轻量台；Phase 6 路由返回 `501 not_implemented_yet` | 否 |
| C6 | Phase 6 | Phase 6 验收套件、文档与 `eval:all` 总入口 | `04 §6` | 无 `evals/phase6/`、`docs/phase6/` 及 `eval:replay`/`test:promotion`/`eval:all` | 否 |

---

## 二、A 类详情：前五阶段设计包已提及但尚未完全闭环的事项

### G-A1：公开写仓库与复合 PR 链路未接真实 GitHub 写入传输
- **规范要求**：`03 §2.3`、`04 §2`、`06 §5` 规定“建分支、推提交、开 PR”不能当作单步黑盒事务，必须在审批前拆分为带各自 `effect`、`business_key` 与 `expected HEAD` 的外部操作；远端 `HEAD` 变更须作废重审，UI 需逐项呈现批准与执行状态。
- **代码现状**：`apps/daemon/src/adapters.mjs`（第 69–81、415–432 行）已为 `pr.create_draft` 注册了参数校验与策略门禁，但无专用 Git/GitHub 写入传输模块，实际只走通用 `baseUpstream`；当前仓库能力仅覆盖只读获取（`repo-observe.mjs`）和双快照对比分诊（`repo-triage.mjs`）。
- **补齐工作**：实现 Git/GitHub PR 子进程适配器（仅读取宿主授权凭据、校验目标 repo/branch 白名单与 `expected HEAD`）、拆步计划生成器，以及控制台复合动作分组审批卡片。

### G-A2：容器内 Pi 多步 Agent 循环未启用；`router`/`summary`/`classify` 仍未用模型实测
- **规范要求**：`00 §3` 与 `02 §4` 描述“Agent 在容器内运行提出模型/读取/job 提议，宿主检查授权与预算后代执行”；`06 §8` 要求全部 8 种 `purpose` 入账。
- **代码现状**：
  - 按 `docs/adr/0001-model-path-pi-host-execution.md` 第 11 行最小方案收口后，容器内 `docker/agent/src/worker.mjs`（第 1–21 行）保持 `PI_OFFLINE=1`，仅发送 `announce` 与轮询 `host-commands`，**未在容器内运行 Pi `AgentSession` 多轮工具调用循环**；宿主通过 `apps/daemon/src/model-call-pi-child.mjs` 调用 `pi-ai` `completeSimple` 执行单次推理（日常 Web/Telegram 多轮对话由 `apps/daemon/src/selfuse-dispatch.mjs` 拼接 scoped 历史实现）。
  - `docs/phase4/reports/user-value-report.md`（第 61–68 行）中只有 `worker` 有实测调用与费用（6 次请求 / `12708` microUSD）；`router`、`summary`、`classify` 均未产生模型实测记录（例如 `apps/daemon/src/dreaming.mjs` 第 261 行仍采用零模型调用的 `dreaming-deterministic-scan`）。
- **补齐工作**：① 如需 Agent 在沙箱内多步读文件/调工具并多次请求宿主模型，需打开 `ADR-0001` 定义的 `model_request` / `model_result` 双向往返并在容器侧接入有限步数循环；② 为 L3 Dreaming（`summary`）、复杂消息分流（`router`/`classify`）接通实测开关并补齐分 purpose 费用统计。

### G-A3：真实供应商账单核对与 `CHARGED_BOUND` 校正流未实盘闭环
- **规范要求**：`06 §8`（第 150–154 行）要求对 `UNKNOWN`/中断请求先转 `CHARGED_BOUND` 保守记账，并支持后续凭供应商真实账单进行事后校正；不可靠目录价估算替代真实账单核对。
- **代码现状**：`docs/phase3/reports/model-path-and-pi.md` §7（第 60 行）明确记为“半闭环”——已有的 DeepSeek 调用按本地 `priceCatalog` × token 自算 `SETTLED`，**从未拿真实外部供应商对账单驱动 `CHARGED_BOUND` 校正流程**。
- **补齐工作**：在日常积累多次真实调用后，拉取供应商账单与本地 `budget_reservations`（含潜在 `CHARGED_BOUND` 记录）执行一次真实对账演练并固化对账检查脚本。

### G-A4：通用长任务 `feature list` 验收器与语义 `Watchdog`
- **规范要求**：`03 §6`（第 87–91 行）规定长任务需有宿主维护的版本化 `feature list`（由宿主验证器写 `passes`），并在硬门禁之后加入低预算的语义 `Watchdog`（`06 §8` `purpose: "watchdog"`），读取脱敏工具序列识别重复失败或目标偏移。
- **代码现状**：`daemon.mjs` 与 `scheduler.mjs` 已落实步数、预算、墙钟和租约硬检查；版本化 `feature list` 与语义 `Watchdog` 尚未开发。
- **补齐工作**：定义长任务 `feature_list` 对象格式及宿主校验回写流程；在多步工具循环落地后，加入独立预算的语义 `Watchdog` 建议模块。

### G-A5：标准 OpenTelemetry（`OTel`）Span 落盘
- **规范要求**：`06 §2`（第 47 行）与 `06 §10`（第 179 行）要求将 OTel span 数据存入受 ACL 保护的 `objects`，非关键性能 span 有界丢弃并计数，写盘失败不影响安全动作记录。
- **代码现状**：全库目前没有 OTel SDK/exporter 或 span 文件生成；控制台 `GET /api/tasks/:id/trace`（`apps/daemon/src/console/api.mjs` 第 1277 行）是从 `tasks`、`effects`、`audit_log`、`model_requests` 实时聚合时间线。
- **补齐工作**：按需补充轻量脱敏 span 写入受 ACL `objects` 的模块与有界保留清理，并与 `/api/tasks/:id/trace` 合并展示。

### G-A6：两处非阻断“空心对象引用”残留
- **已登记出处**：`docs/phase5/reports/phase5-final-closure.md` §5（第 90–92 行）。
- **代码现状**：`apps/daemon/src/effects.mjs`（第 514 行 `effect_response`）与 `apps/daemon/src/mail-triage.mjs`（第 314 行 `mail_draft`）在写入 `objects` 行时绑定了内容哈希，但未先调用 `putObjectContent` 落盘文件（`storage_ref` 为 `NULL`）。回执/草稿原文仍在 `effects.action_json` 与 `audit_log` 中，因此审批发送与对账正常，只是通过 `GET /api/objects/:id` 分页读取这两类对象时会返回 `null`。
- **补齐工作**：在两处 `insertObjectRow` 前补齐 `putObjectContent(stateDir, ...)` 并补一条对象读取回归断言。

*(注：早前在 `docs/HANDOFF-PHASE5-TO-SELFUSE.md` §3.2 记过的首次自用配置脚手架、网页多轮历史、Web Console 设置页、`briefing-followup.mjs` `content_hash` 与 `enqueuePlain` 残留、以及配置边界收件人大小写不一致，均已在后续自用改造提交中清理/完成。)*

---

## 三、B 类详情：主人明确推迟的事项（台账对照）

### G-B1：真实 `CalDAV` 日历实盘验收
- **现状**：`evals/phase5/scenarios/run.mjs`（89/89）已在环回 TLS 夹具上验证 CalDAV 拉取与 `calendar.write`（`If-Match` ETag 防静默覆盖）。因暂未配置真实 `CALDAV_*`，按 `D-102` 裁定标记为 `DEFERRED / NOT VERIFIED`；Web Console `⑤ 设置与接入` 也将 `calendar.quietHours` 暂保留为只读展示。
- **重启条件**：填入本机 `.env` 的 `CALDAV_*` 凭据并放开只读试拉；如需在网页端直接编辑静默时间，可在 `api.mjs` 放开白名单字段并接入设置页。

### G-B2：Telegram 公网 Webhook（路线 2）
- **现状**：`POST /ingress/telegram/webhook` 的头验签逻辑已在 `apps/daemon/src/console/api.mjs` 第 1418 行及 `ingress-verify.mjs` 实现，但 `CONSOLE_BIND` 严格仅监听 `127.0.0.1` 且公网注册长期禁用；个人使用稳定走路线 1 `getUpdates` 长轮询。
- **重启条件**：具备公网 HTTPS 域名/反向代理且按 `real-acceptance-plan.md §D` 同窗口执行 `setWebhook/deleteWebhook` 验收。

---

## 四、C 类详情：Phase 6 全部待实施内容

> **准入条件**（`04-Frontend-Console-UX-and-6-Phase-Taskbook.md` 第 131 行）：已有跨任务真实失败及可靠来源，环境产物可保留并满足隐私规则。

### C1：信号采集与后台 Curator 候选（`proposed_updates`）
- **已有底座**：`schema.sql` 已建 `proposed_updates` 表及 6 种状态（`PROPOSED / REJECTED / EVALUATED / APPROVED / PROMOTED / ROLLED_BACK`）；`budget.mjs` 已含 `"rsi"` 用途；`memory.mjs`/`audit.mjs`/`approvals.mjs` 已记录拒绝、编辑、错误审计。
- **待做缺口**：
  - 采集并聚合信号（用户纠正、重复工具错误、审批拒绝、草稿编辑幅度、回归/误报），落实“至少跨 2 个独立任务的同类信号才聚类进入候选”去噪规则，防止单源投毒；
  - 后台 Curator 仅读取授权范围的脱敏失败轨迹，生成受限 `ProposedUpdate`（修订命题、影响 scope、候选 skill/脚本 hash、风险说明、回滚目标）；
  - 硬边界拦截：禁止候选补丁修改宿主权限、预算、代理、审计日志、验证器、holdout 或发布规则。

### C2：可复现 Shadow Replay 与隔离 Holdout 评测（`eval:replay`）
- **已有底座**：`budget.mjs` 已预留 `"replay"` 用途；`repo-triage.mjs` 已有离线环境 `environment-manifest` 与容器双跑基线/目标模式。
- **待做缺口**：
  - 实现完整的 `Replay manifest` 归档与校验（环境依赖、录制的工具与网络输入夹具、文件与 spill 对象、可控时钟/随机种子、模型/provider 配置、`skill_set_hash`、policy 与 oracle）；实现“删除原工作目录后按 manifest 重建”及缺产物时诚实标注“不可重放”；
  - 实现 Baseline vs Candidate 双沙箱隔离执行：独立临时工作卷、禁用全部生产写/生产 Timer/IM/邮箱/PR 凭据（网络与服务端双重阻断）、真实计费但零真实外部副作用；
  - 建设与 Curator/候选完全物理及接口隔离的 **不可见 Holdout 集**（限频限细节反馈、定期轮换防过拟合），运行多次配对盲测并输出波动区间、成本变化与退化界限。

### C3：人工晋升、技能回滚与模型升级补偿删除（`test:promotion`）
- **已有底座**：`apps/daemon/src/skills.mjs` 已实现 `registerSkillVersion`（13 类注入扫描 -> `CANDIDATE`）、`activateSkillVersion`（人工激活 -> 退休旧 `ACTIVE` 并清除脚本待审标记）及任务创建时冻结 `tasks.skill_set_hash`（运行中不热替换）。
- **待做缺口**：
  - 在 `skills.mjs` 中补齐**明确前驱版本回滚**与审计逻辑，区分“仅影响新 Task 的常规升级/回滚”与“中止旧 run 后重授的紧急撤回”；
  - 实现 3 条 Phase 6 晋升/重放后端 API（替换 `api.mjs` 第 1773 行 `501` 兜底）：
    - `POST /api/replay/jobs`（权限与预算校验后异步返回 `202 replayJobId`）
    - `POST /api/updates/:id/promote`（`expectedRevision` + `candidateHash` + `evalReportRef` 校验，严格管理员人工晋升）
    - `POST /api/skills/:name/rollback`（`scopeRef`、`targetVersion`、`expectedRevision` 校验，仅影响新 run）
  - 实现模型升级后的 `compensations` 清单管理：每条补偿绑定历史 case，连续通过初筛后须经独立 holdout + 跨场景 + 成本复测，并由人工批准进入“删除候选”（且保留恢复路径）。

### C4：MCP Pin 安全治理
- **已有底座**：`02 §6`（第 67 行）与 `04 §4`（第 55 行）已定好契约：`mcp_pin` 作为受 ACL 约束的 `objects`（`kind = "mcp_pin"`）存储，不额外新增与 canonical schema 冲突的表。
- **待做缺口**：
  - 首次 MCP Server 注册时做工具名冲突与 schema 校验，对 `name / description / inputSchema` 规范化后计算指纹 hash；
  - 断线重连后比对服务端暴露的工具指纹，只要 hash 改变立即自动隔离并阻塞使用，等待人工重新批准；
  - 实现 `POST /api/mcp-pins/:id/decide`（校验 `fingerprint`、`decision`、`expectedRevision`，替换当前的 `501` 响应）。

### C5：终态控制台四大视图补齐
- **已有底座**：`apps/daemon/src/console/ui.mjs` 已基于零依赖原生 DOM 交付对话、待办审批、任务与诊断、记忆与成本治理、设置与接入 5 页签；`GET /api/snapshot`、`GET /api/events/stream`（`<generation>:<seq>` 游标与重置语义）、分 `purpose` 预算与 `Trace` 已落地。
- **待做缺口**（对照 `04 §3` 第 27–33 行与 `04 §6` 第 133 行）：
  - **Replay Studio**：会话分支与环境 manifest 分开展示、缺产物显式告警、Baseline/Candidate 命令/oracle/结果/成本与 holdout 报告对比、管理员晋升/回滚操作台；
  - **Mission Control 完整拓扑**：按 scope 区分 Agent 节点与离线执行 Job 节点的关系展示（`04 §3` 允许终态按已锁依赖选型 React 19 / Tailwind v4 / Zustand / `@xyflow/react`）；
  - **Governance 终态补齐**：接入 **MCP Pin 指纹变化审核** 与 **补偿删除候选审批** 面板，去掉“后续阶段暂不可用”残留，同时继续守住 `未测 / 待结算` 诚实标注与零伪造数字原则。

### C6：Phase 6 独立评测矩阵与总门禁脚本
- **已有底座**：Phase 1–5 拥有 19 套本地/容器测试及 `report:user-value` 聚合检查。
- **待做缺口**：新建 `evals/phase6/` 与 `docs/phase6/`，在 `package.json` 补齐 `eval:replay`、`test:promotion`、`eval:all`，覆盖以下命题验证：
  - 删除原目录后按 `Replay manifest` 重建并复现，缺产物时拒绝对外宣称可重放；
  - 影子运行期间真实外部副作用（IM/Mail/PR/生产 Timer）严格为 0；
  - 旧审批卡不能批准新候选，运行中 Task 不因外部晋升或回滚被热替换 `skill_set_hash`；
  - 不可见 holdout 防泄露边界测试与盲测波动/成本报告；
  - 终态能力追踪表（`04 §7` 第 139–150 行）逐项对账关闭。

---

## 五、建议推进顺序

1. **先跑真实自用（当前已就绪）**：通过 `scripts/selfuse.mjs start` 启动并在 Web Console `⑤ 设置与接入` 配好参数，自然沉淀 `workspace-state` 中的真实任务轨迹、编辑/拒绝记录与费用账本（满足 Phase 6 入口条件）。
2. **按实际痛点决定先补哪块 A/B 类缺口**：
   - 若需要 Agent 在复杂排障时自主多轮读文件、调工具再答复 → 补 **G-A2** + **G-A4**；
   - 若需要直接对 GitHub 仓库发起修改与开 PR 审批 → 补 **G-A1**；
   - 顺手可优先收掉 **G-A6**（仅两处 `putObjectContent` 调用）和按需验证 **G-B1**（`CalDAV`）。
3. **进入 Phase 6 实施时的推荐拆分顺序**：
   - **Unit 6.1**：`skills.mjs` 回滚 + `proposed_updates` 仓储 + `C3`（`/api/updates/:id/promote`、`/api/skills/:name/rollback`）与 `C4`（MCP Pin）；
   - **Unit 6.2**：`Replay manifest` 归档重建 + Shadow Replay 双沙箱运行器 + 隔离 Holdout 评测（`C2` + `eval:replay`）；
   - **Unit 6.3**：Curator 信号聚类与受限候选生成 + 补偿删除流程（`C1` + `test:promotion`）；
   - **Unit 6.4**：终态控制台 `Replay Studio` / 拓扑 / MCP Pin / 补偿 UI 扩展（`C5`），叠加 `G-A3`/`G-A5` 收口与 `eval:all` 全量验收（`C6`）。
