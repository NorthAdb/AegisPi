# AegisPi v1 正式收官归档与 v2 迁移说明

> **基线标签**：`v1-zero-trust-baseline`（封存自 `main` 基线 `1b847e7`）
> **收官日期**：2026-11-25（Asia/Hong_Kong）
> **架构裁决**：**v1 作为“零信任治理与对抗审计里程碑基线”正式收官封存**；不再在 v1 手搓单轮调度框架上继续叠加功能或按旧设计包推进 Phase 6，后续另起纯 TypeScript 的 **AegisPi v2** 主线。

---

## 一、v1 最终验证基线快照

截至基线提交 `1b847e7`（Phase 1–5 + 个人自用配置闭环）：

| 验证项 | 实测结果 | 关键约束状态 |
| --- | --- | --- |
| 聚合门禁 `report:user-value` | **327/327 PASS** | `defaultsFailClosed=true`、`secretScan=clean` |
| 自用引导与网页设置 `evals/phase5/selfuse/run.mjs` | **31/31 PASS** | `.env` 白名单写盘、422 校验、热重载、回环探针脱敏通过 |
| 离线与容器回归矩阵（19 套） | **全部 exit 0** | `contracts` 15、`durability` 164、`acl` 15、`budget` 20、`cancel-approval` 20、`offline-jobs` 14、`security-unit` 68、`restore` 11、`security-integration` 29、`model-proposal` 15、`repo-observe` 7、`ingress-telegram` 7、`memory-lifecycle` 47、`cross-channel` 25、`scenarios` 89、`quota-calibration` 5、`triage` 7 |
| 核心不变项与隔离守卫 | **全部保持** | `apps/daemon/config/defaults.json` 全失败关闭零改动；6 个 `*-real` 入口缺省 `exit 4`；浏览器 Chrome DevTools 实测 `⑤ 设置与接入` 0 报错 |

---

## 二、为什么收官 v1、启动 v2

- **v1 的核心价值**：已经完整跑通并验证了零信任控制面、单次 `actionHash + nonce` 审批 CAS、microUSD 整数预算账本、宿主凭据代理、L0–L3 分层记忆、13 类注入扫描及无网 Docker 执行沙箱。
- **升级 v2 的缘由**：v1 的通用对话链路受限于早期单轮 `completeSimple` 与手搓 `tick()` 调度 / `/agent-work/` 文件提案脚手架，难以在不背负双调度器包袱的前提下做出流畅的多步推理与工具交互体验。
- **v2 方向**：另起纯 TypeScript 工程，以 `@earendil-works/pi-durable@1.6.0` 为唯一运行内核，搭配 `@earendil-works/pi-mcp@1.6.0`、本地 SQLite 与 Vite + React + Tailwind 四视图 Web 端；仅从 v1 抽离复用经审计验证的安全与能力积木，彻底卸下旧调度脚手架。

---

## 三、v1 遗留缺口与旧 Phase 6 项最终处置结论

全部 14 项源记录见 [GAP-INVENTORY-AND-PHASE6.md](GAP-INVENTORY-AND-PHASE6.md)。本次收官**不修改 v1 生产逻辑代码**，各项统一按以下四类口闭合处置：

| 编号 | 原事项 | 最终处置 | 归档说明 / v2 落点 |
| --- | --- | --- | --- |
| G-A1 | 公开写仓库与复合 PR 链路（真实 GitHub 传输） | **由 v2 新架构替代（v1 不再补做）** | v2 改用官方 `github-mcp-server` 承载仓库写操作，保留审批前确定性门禁 |
| G-A2 | 容器内 Pi 多步工具循环 & `router`/`summary`/`classify` 未测 | **由 v2 新架构替代（v1 不再补做）** | v2 改用 `pi-durable@1.6.0` 原生多轮工具运行内核，不再维护手搓循环 |
| C5 | 终态控制台四大视图补齐（`Replay Studio`、拓扑等） | **由 v2 新架构替代（v1 不再补做）** | v2 改用 Vite + React + Tailwind 重建四视图前端 |
| G-A6 | `effect_response` 与 `mail_draft` 空心对象引用 | **随 v1 封存（不修复）** | 正本保留在 `action_json` 与 `audit_log` 中，v1 不阻塞 |
| G-A3 | 真实供应商账单核对与 `CHARGED_BOUND` 校正流 | **随 v1 封存（抛弃重做流程）** | v1 本地硬预算门禁已验证；v2 按需精简结算对账 |
| G-A5 | 标准 `OTel` Span 写入受 ACL 对象存储 | **随 v1 封存（抛弃）** | v1 `/api/tasks/:id/trace` 已足够排查；v2 轻量重构可观测性 |
| G-B2 | Telegram 公网 Webhook（路线 2） | **随 v1 封存（抛弃）** | v1 个人试用固定使用 `getUpdates` 长轮询 |
| C6 | 旧重型 Phase 6 评测矩阵与 `eval:all` | **随 v1 封存（抛弃）** | v2 改为围绕核心安全红线与关键路径的精简必检集 |
| G-B1 | 真实 `CalDAV` 日历实盘验收（及 Telegram 通道后续） | **长期后置（按需再接）** | 仅在后续明确接入日历或 Telegram 通道需求时再启用 |
| C4 | MCP Pin 指纹防投毒与断线重连变更隔离 | **吸收进 v2 主线（阶段二必做）** | 搭配 `@earendil-works/pi-mcp@1.6.0` 实现工具描述/Schema 指纹固定与隔离 |
| G-A4 | 长任务 `feature list` 与语义 `Watchdog` | **吸收精简版进 v2 主线（阶段三）** | 仅保留轻量语义 Watchdog 防死循环/偏移，砍掉重型 `feature list` 验收器 |
| C1 | 信号聚类与后台 Curator 候选（`proposed_updates`） | **吸收精简版进 v2 主线（阶段三）** | 与轻量化影子重放联动，仅处理真实脱敏失败轨迹 |
| C2 | 可复现 Shadow Replay 与隔离 Holdout 盲测 | **吸收精简版进 v2 主线（阶段三）** | 改用 `pi-durable fork()` 实现轻量影子重放，保持零真实外部副作用 |
| C3 | 人工晋升、技能版本回滚与补偿删除候选 | **吸收精简版进 v2 主线（阶段三）** | 继承 v1 技能只读索引与人工晋升/回滚语义，接入 v2 运行时 |

---

## 四、后续 v2 拟抽离复用的 5 块 v1 核心资产

1. **审批 CAS 与动作哈希防篡改核心**（`apps/daemon/src/effects.mjs`、`approvals.mjs`、`adapters.mjs`）
   - RFC 8785 canonical JSON 规范化 `action_hash`、`actionHash + nonce` 单次消费 CAS、编辑/HEAD 变更作废重审、CP4 目标/白名单校验及 `UNKNOWN` 人工对账语义。
2. **微美元两阶段预算账本与防回滚安全机制**（`apps/daemon/src/budget.mjs`、`keys.mjs`、`deletion-manifest.mjs`）
   - 整数 microUSD `HELD -> SETTLED / CHARGED_BOUND / RELEASED` 预留结算、任务/日硬限额与墓碑删除清单恢复校验。
3. **宿主凭据代理与零泄漏配置管理**（`apps/daemon/src/credentials.mjs`、`selfuse-bootstrap.mjs`、`connectivity-test.mjs`）
   - 凭据只存本机 `.env` 并在宿主内存注入、密钥白名单原子写入、错误响应自动脱敏、永远不入库也不进容器。
4. **通道适配器与 L0–L3 分层记忆 / Skills 安全组件**（`apps/daemon/src/mail-adapter.mjs`、`mail-triage.mjs`、`memory.mjs`、`memory-scanner.mjs`、`recall.mjs`、`skills.mjs`）
   - 分域记忆隔离（L0–L3）、13 类注入扫描、双 FTS 先授权召回、IMAP/SMTP 安全读取草稿发送，以及三层技能披露与版本锁定语义。
5. **无网 Docker 执行沙箱与宿主校验器**（`docker/execution/`、`docker/acquisition/`、`apps/daemon/src/container-executor.mjs`、`job-oracle.mjs`）
   - `--network none` 隔离、tmpfs/cgroup 资源硬限、只读下载供应链检查与由宿主依据 oracle 独立裁决的离线执行边界。

---

## 五、归档资料索引

- [GAP-INVENTORY-AND-PHASE6.md](GAP-INVENTORY-AND-PHASE6.md)：v1 全量缺口原始盘点台账（已由本文完成处置归档）
- [HANDOFF-PHASE5-TO-SELFUSE.md](HANDOFF-PHASE5-TO-SELFUSE.md)：Phase 5 收官基线与自用过渡交接记录
- [SELF-USE-GUIDE.md](SELF-USE-GUIDE.md)：v1 个人本地单命令启动与 Web Console 设置指南
- [phase5/reports/phase5-final-closure.md](phase5/reports/phase5-final-closure.md)：Phase 5 终局收口报告（`D-102` / `D-103`）
