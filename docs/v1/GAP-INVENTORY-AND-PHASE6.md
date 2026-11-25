# AegisPi v1 历史缺口盘点与最终处置台账

> **归档状态**：**已裁决封存**（2026-11-25，`v1-zero-trust-baseline`）。v1 已正式收官，**以下任何事项均不再在 v1 主线继续施工**；最终架构裁决与 v2 复用清单请以主入口 [../V1-CLOSURE-AND-V2-MIGRATION.md](../V1-CLOSURE-AND-V2-MIGRATION.md) 为准。
> **对照基线**：仓库 `1b847e7`（`report:user-value` `327/327 PASS`，`selfuse` `31/31 PASS`）对照本机设计包 `D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\00`–`06`。

本文集中梳理了 v1 收官时对照设计包 `00`–`06` 核查出的全部剩余条目（分为前五阶段设计差额 `G-A1`–`G-A6`、此前已推迟项 `G-B1`–`G-B2`、以及旧 Phase 6 范围 `C1`–`C6`），并直接标注每项在 `v1-zero-trust-baseline` 下的**最终处置口径**（不保留模糊的“v1 待做/待补齐”指令）。

---

## 一、全量条目与最终处置汇总表

| 编号 | 原分类 | 事项名称 | 规范来源 | v1 代码现状 | 最终处置结论（2026-11-25 裁决） |
| --- | --- | --- | --- | --- | --- |
| G-A1 | 前五阶段设计差额 | 公开写仓库与复合 PR 链路（真实 GitHub 传输） | `03 §2.3`、`04 §2`、`06 §5` | 仅定义 `pr.create_draft` 校验，无真实 GitHub 写适配器与分步组卡 UI | **由 v2 新架构替代（v1 不再补做）**：v2 改用官方 `github-mcp-server` |
| G-A2 | 前五阶段设计差额 | 容器内 Pi 多步工具循环；`router`/`summary`/`classify` 未用模型实测 | `00 §3`、`02 §4`、`05`、`ADR-0001` | 宿主单次 `completeSimple` + scoped 多轮历史；容器无 `AgentSession` 循环；3 个 purpose 未测 | **由 v2 新架构替代（v1 不再补做）**：v2 改用 `pi-durable@1.6.0` 原生内核 |
| G-A3 | 前五阶段设计差额 | 真实供应商账单对账与 `CHARGED_BOUND` 校正流 | `06 §8`、`model-path-and-pi.md §7` | 仅按本地 `priceCatalog` 自算结清；真实外部账单校正未实盘 | **随 v1 封存（抛弃）**：v1 本地硬上限门禁已验证，不再补充重流程 |
| G-A4 | 前五阶段设计差额 | 通用长任务 `feature list` 验证器与语义 `Watchdog` | `03 §6`、`06 §8` | 确定性步数/预算/墙钟/租约已落地；语义 Watchdog 与 `feature list` 未实现 | **吸收精简版进 v2（阶段三）**：仅保留轻量语义 Watchdog，砍掉 `feature list` |
| G-A5 | 前五阶段设计差额 | 标准 OpenTelemetry（`OTel`）Span 写入受 ACL 对象存储 | `06 §2`、`06 §10` | 无 OTel exporter/span 写盘；`/api/tasks/:id/trace` 直接拼 DB 表 | **随 v1 封存（抛弃）**：v1 `/api/tasks/:id/trace` 已满足排障 |
| G-A6 | 前五阶段非阻断残留 | `effect_response` 与 `mail_draft` 空心对象引用 | `phase5-final-closure.md §5` | DB 有 `objects` 行与哈希但未写盘内容（正本仍在 `action_json`/`audit_log`） | **随 v1 封存（不修复）**：正本完整落库，不修改 v1 生产代码 |
| G-B1 | 此前明确推迟项 | 真实 `CalDAV` 日历实盘验收（`CALDAV_*`） | `D-102`、`03 §4` | Permit 1 环回夹具与 ETag 防覆盖已验；实盘标记 `DEFERRED / NOT VERIFIED` | **长期后置（按需再接）**：仅在后续有明确使用需求时接入 |
| G-B2 | 此前明确推迟项 | Telegram 公网 Webhook（路线 2 `setWebhook`） | `phase3-status-and-remaining.md §1 D` | 路由代码在案未暴露，v1 自用固定走路线 1 `getUpdates` 长轮询 | **随 v1 封存（抛弃）**；Telegram 通道整体暂缓 |
| C1 | 旧 Phase 6 | 信号聚类与后台 Curator 候选（`proposed_updates`） | `03 §7.1`、`04 §6`、`06 §2` | `proposed_updates` 仅建表，业务逻辑未实现 | **吸收精简版进 v2（阶段三）**：配合轻量影子重放按需构建 |
| C2 | 旧 Phase 6 | 可复现 Shadow Replay 与隔离 Holdout 盲测 | `03 §7.2–7.3`、`04 §4/§6` | `budget.mjs` 仅预留 `"replay"` 枚举；重放器/holdout 隔离未实现 | **吸收精简版进 v2（阶段三）**：改用 `pi-durable fork()` 实现轻量影子重放 |
| C3 | 旧 Phase 6 | 人工晋升、技能版本回滚与补偿删除候选 | `03 §7.3`、`04 §4/§6` | `skills.mjs` 已有注册/激活/`skill_set_hash` 锁；缺回滚方法及 3 条 HTTP 路由 | **吸收精简版进 v2（阶段三）**：继承技能索引与人工晋升/回滚语义 |
| C4 | 旧 Phase 6 | MCP Pin 安全治理与指纹变更隔离 | `02 §6`、`04 §4/§6` | `POST /api/mcp-pins/:id/decide` 返回 `501`，无 `mcp_pin` 注册/重连核验 | **吸收进 v2 主线（阶段二必做）**：搭配 `pi-mcp@1.6.0` 实现指纹防投毒 |
| C5 | 旧 Phase 6 | 终态控制台四大视图补齐（`Replay Studio`、拓扑图等） | `04 §3`、`04 §6` | 已有原生 DOM 5 页签轻量控制台；Phase 6 路由返回 `501 not_implemented_yet` | **由 v2 新架构替代（v1 不再补做）**：v2 改用 Vite+React+Tailwind 重建四视图 |
| C6 | 旧 Phase 6 | 旧重型 Phase 6 评测矩阵与 `eval:all` | `04 §6` | 无 `evals/phase6/`、`docs/phase6/` 及 `eval:replay`/`test:promotion`/`eval:all` | **随 v1 封存（抛弃）**：v2 改为精简核心安全红线测试 |

---

## 二、各类别说明（基线事实备忘）

### 1. A 类（前五阶段设计差额 `G-A1`–`G-A6`）
- **`G-A1`**：`apps/daemon/src/adapters.mjs`（第 69–81、415–432 行）虽已登记 `pr.create_draft` 校验规范，但未接真实 Git/GitHub 写入传输器，v1 止步于公开仓库只读分诊（`repo-observe.mjs` / `repo-triage.mjs`）；真实写仓库由 v2 接 `github-mcp-server` 承担。
- **`G-A2`**：`docker/agent/src/worker.mjs`（第 1–21 行）保持 `PI_OFFLINE=1` 与单轮提案架构，宿主经 `model-call-pi-child.mjs` 调用 `completeSimple`，并通过 `selfuse-dispatch.mjs` 提供 scoped 多轮文本历史；`router` / `summary` / `classify` 三个 purpose 未接入模型调用（`dreaming.mjs` 第 261 行使用确定性扫描）；多步工具运行由 v2 `pi-durable` 原生接管。
- **`G-A3`**：v1 实盘通过配置 `priceCatalog` 自算费用并落地 `HELD`/`CHARGED_BOUND` 状态机；不再额外开发真实供应商外部对账单自动校正流程。
- **`G-A4`**：v1 已落实步数、预算、墙钟、租约硬门禁；砍掉重型 `feature list`，仅将轻量语义 `Watchdog` 思路吸收进 v2 阶段三。
- **`G-A5` & `G-A6`**：v1 控制台 `/api/tasks/:id/trace` 与 `effects.action_json` / `audit_log` 已具备排障与正本留存能力；标准 OTel 落盘与两处 `putObjectContent` 空心引用均随 v1 封存，不再改生产代码。

### 2. B 类（`G-B1`–`G-B2`）
- **`G-B1`**：`evals/phase5/scenarios/run.mjs`（89/89）已完成环回 TLS 夹具与 `If-Match` ETag 防覆盖验证，真实 `CALDAV_*` 实盘作为长期后置项（`DEFERRED / NOT VERIFIED`）；Web Console `⑤ 设置与接入` 对 `calendar.quietHours` 保持只读展示。
- **`G-B2`**：Telegram 公网 Webhook 仅保留离线验签逻辑且公网监听禁用，v1 自用路径为路线 1 `getUpdates` 长轮询；公网 Webhook 随 v1 抛弃，Telegram 通道整体暂缓。

### 3. C 类（旧 Phase 6 范围 `C1`–`C6`）
- **v1 已预埋底座**：`schema.sql` 含 `proposed_updates` 表、`budget.mjs` 含 `"rsi"` / `"replay"` 用途枚举、`apps/daemon/src/skills.mjs` 已实现技能注册、人工激活与 `tasks.skill_set_hash` 任务级冻结、控制台保留 `501 not_implemented_yet` 诚实兜底。
- **v1 不再继续开发 C1–C6**：上述底座与设计经验仅作为参考输入，对应能力按上表分别转为 **v2 吸收项（`C4`、`C1/C2/C3` 精简版）**、**v2 替代项（`C5`）** 或 **抛弃项（`C6`）**。

*(此前曾在 `HANDOFF-PHASE5-TO-SELFUSE.md` §3.2 记过的自用配置脚手架、多轮对话历史、Web 设置页与热重载、`briefing-followup.mjs` `content_hash`/死辅助修复、以及 `allowedRecipients` 大小写统一均已在此前自用改造提交 `289bd42`–`1b847e7` 中完成，不列入缺口。)*

---

## 三、关联入口

- 最终封存裁决与 v2 拟复用 5 块核心资产详情：[../V1-CLOSURE-AND-V2-MIGRATION.md](../V1-CLOSURE-AND-V2-MIGRATION.md)
- Phase 5 收官交接历史记录：[HANDOFF-PHASE5-TO-SELFUSE.md](HANDOFF-PHASE5-TO-SELFUSE.md)
- 文档总索引：[../README.md](../README.md)
