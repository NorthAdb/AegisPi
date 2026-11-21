# 单元 4.1 收口验收报告（ADR-0001 模型提议与 pi-ai 执行链路）

> **日期**：2026-11-20（2026-11-21 `/poteto-mode` 自审计加固并重建纪元 5 收口）  
> **起始基线**：`52354a8b2bfd17c6ba836637df1054e0ef0d7b9b`（`origin/main`，已含 D-77/D-78 修订与两项冲突裁量；`9b1d5fda8cc4` 为首批 4.1 实施与证据提交，本轮在其上完成 19 项加固补丁）  
> **授权口径**：主人 2026-11-20 正式开工授权（**仅限单元 4.1、许可 1 范围**；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-79`、`D-80`）  
> **实施依据**：[phase4-1-implementation-task-spec.md](../phase4-1-implementation-task-spec.md)（含 D-77/D-78 修订）与 [0001-model-path-pi-host-execution.md](../../adr/0001-model-path-pi-host-execution.md)  
> **运行环境**：Windows 11（Docker Desktop `29.9.2` + `127.0.0.1:5000` 本地构建 registry），锁定 Node `v22.23.5`（`D:\AegisPi\tools\node-v22.23.5\node.exe`）

---

## 一、核心结论

单元 4.1 按任务书 §2a → §2b → §2c 连续实施并完成一轮 `/poteto-mode` 三路对抗审计加固，全量离线 + 容器套件在纪元 5 终树上本机验证全绿（全部 12 项工作套件 + Hono 预检均为 `exit 0`，`test:model-proposal` 共 14 项全过）。**真实推理服务零调用、全程未读 `.env`、`defaults.json` 失败关闭开关与 $\$0.80 / \$5 / 1000\,\mu\$$ 上限不变、未触单元 4.2 或任何真实外部写 / Telegram / 公网 webhook / 常开。**

1. **执行核心**：已切换到已锁定生产依赖 `@earendil-works/pi-ai@1.5.2`（`getBuiltinModel("deepseek", "deepseek-flash")` + `completeSimple`，必传 `reasoning: "high"`、`env: {}`、`maxRetries: 0`）；`model.baseUrl` 实行无路径根地址语义（拒绝自带 `/chat/completions` 后缀与任意 path/query/hash，启动配置阶段即 fails closed）。子进程环境白名单剥离宿主 `*_API_KEY`，`bearer` 非空 trim 校验阻断环境密钥旁路。
2. **通道与状态机**：`worker.mjs` 在只读 rootfs + `--network none` 容器内写闭字段 `model_request` 信封至 `proposals/`；宿主经 `ensureModelRequestsTable(db)`（D-78 冲突 1 方案 A，独立幂等扩展建表，不动 canonical schema 与 27 表指纹门）与七态状态机执行「全校验先行 → 单事务+SAVEPOINT 并发防竞态 `RESERVED` + `ledger.reserveInTx` → 独立提交 `EXECUTING` → 单次 `pi-ai` 调用（含 `try/catch` 兜底）→ 同事务租约宽容写回（`SETTLED`/`HELD`/`ORPHAN`，租约过期不再回滚已发生计费）+ `model-result-<requestId>.json` 回传」。
3. **清理与统一核心**：`apps/daemon/src/model-call-child.mjs` 已删除，生产树（`apps docker evals tools package.json package-lock.json`）`git grep model-call-child` 零命中；`adapters.mjs` 的 `model.inference` 与提议链路统一走 `callModelOnce`（`credentials.model` 不再绕过 `credential_slots`）；`test:model:real` 已改接到新核心，**未运行**且按 D-77 保留现状为已知残留。
4. **纪元 5 镜像**：初版完成纪元 3（`52354a8b2bfd`）；自审计 19 项加固完成后复算 `appImageContextHash`，仅 `agent` 上下文漂移，经纪元 4 推进并在最终状态机/轮询修复后选择性重建 `agent` 至**纪元 5**（推送 `127.0.0.1:5000`，`acquisition` 与 `execution` 核验一致后携带原 digest）；终树 `image-gate` 零漂移放行。

---

## 二、§2a–§2c 实施产物一览

| 阶段 | 文件 | 关键改动与职责 |
| --- | --- | --- |
| §2a | [apps/daemon/config/defaults.json](../../../apps/daemon/config/defaults.json) | `model.endpoint` → `model.baseUrl: null`；新增 `allowedPurposes: []`、`allowedModelIds: []`、`cacheReadPerMTokMicrousd: null`、`cacheWritePerMTokMicrousd: null`；全失败关闭值与预算定额不变 |
| §2a | [apps/daemon/src/config.mjs](../../../apps/daemon/src/config.mjs) | 读取 `model.baseUrl` 根地址、双白名单及四项 `priceCatalog`，显式剥离并拒用旧 `endpoint` 键 |
| §2a | [apps/daemon/src/model-call-pi-child.mjs](../../../apps/daemon/src/model-call-pi-child.mjs) | **新增**：从 `stdin` 读请求（避免 128 KiB messages 与 apiKey 经 `argv` 泄露），调用 `getBuiltinModel` + `completeSimple(..., { reasoning: "high", env: {}, maxRetries: 0 })`，抽提四字段 usage 与 `totalFromProvider` 存在标记 |
| §2a | [apps/daemon/src/model-call.mjs](../../../apps/daemon/src/model-call.mjs) | 校验无路径根 `baseUrl`、`parseModelWhitelistKey`（白名单 `<provider>/<modelId>` 与 wire `model.id` 区分）、驱动 `model-call-pi-child.mjs`；硬化 `microusdForUsage`（校验布尔键 `totalFromProvider`、4 个非负整数 token 且和 `> 0`、token `> 0` 类别价格为非负整数、`BigInt` ceil 求和，reasoning 不另计） |
| §2a | [evals/phase3/model-real/run.mjs](../../../evals/phase3/model-real/run.mjs) | 按新核心接至 `baseUrl: "https://api.deepseek.com"`、`allowedPurposes`/`allowedModelIds`、4 价位结构、`ensureModelRequestsTable` 与 `model_requests` 通道；**4.1 不运行、不追加一次性守卫** |
| §2b | `apps/daemon/src/model-call-child.mjs` | **已删除**（彻底消除旧直连 HTTP 客户端双路径） |
| §2b | [apps/daemon/src/db/migrate.mjs](../../../apps/daemon/src/db/migrate.mjs) | **新增导出 `ensureModelRequestsTable(db)`**（D-78 冲突 1 方案 A，`IF NOT EXISTS` + `idx_model_requests_task`）；规范 `schema.sql`、`schema-source.json`（`ede73ecaa...`）与 27 表 `migrate()` / `verifySchema()` 原样不动 |
| §2b | [apps/daemon/src/budget.mjs](../../../apps/daemon/src/budget.mjs) | 导出内部事务方法 `reserveInTx`、`settleInTx`、`releaseInTx`，`reserve`/`settle`/`release` 包装调用保持对外零语义变化 |
| §2b | [apps/daemon/src/recovery.mjs](../../../apps/daemon/src/recovery.mjs) | 第 8 步账本超期校准排除关联 `model_requests.state = 'RESERVED'` 的预留（调用尚未发出，T5 不入 `CHARGED_BOUND`）；`EXECUTING` 超时仍转 `CHARGED_BOUND` |
| §2b | [apps/daemon/src/model-requests.mjs](../../../apps/daemon/src/model-requests.mjs) | **新增**：闭信封校验 + 双白名单 + 主键幂等查询 + `RUNNING` 四元组身份复检（全过才 `INSERT INTO model_requests ... 'RECEIVED'`，6 类校验触发 0 行 0 预留）→ 同事务 `RECEIVED→RESERVED`+`ledger.reserveInTx`（预算拒转 `RECEIVED→FAILED`）→ pre-call `cancelPreCallModelRequest`（`RESERVED→FAILED` + `RELEASED`）→ 独立事务 `RESERVED→EXECUTING` → `callModelOnce`（凭据槽 `"model"`）→ `commitModelCallWriteback`（`SETTLED`/`HELD`/`ORPHAN` 同事务结清/交付与存证）、`settleLateModelUsage`（仅 `request=EXECUTING && ledger=HELD` 纯账本结清一次）、`modelResultFileName`（UUID v4 正则硬门）、三处 crashpoint 注入与 `processPendingModelProposals` |
| §2b | [apps/daemon/src/adapters.mjs](../../../apps/daemon/src/adapters.mjs) | `createAdapterUpstream` 的 `model.inference` 经 `callModelOnce`、双白名单与 `"model"` 凭据槽执行，保持现有 `requiresReservation` 硬门 |
| §2b | [docker/agent/src/worker.mjs](../../../docker/agent/src/worker.mjs) | 新增 `proposeModelRequest`（闭字段信封、小写 UUID v4 校验及非复用防线、128 KiB 校验、`.tmp`+`rename` 原子写），更新 `serveCommands` 消费 `model-result-*.json` 并写回执（兼容 `:ro` 宿主目录跳过 `EROFS` 删除，拒收 `null`/非对象指令），`main()` 支持消费 `context.modelRequest` |
| §2b | [evals/phase3/security-unit/helpers/local-model-service.mjs](../../../evals/phase3/security-unit/helpers/local-model-service.mjs), [evals/phase3/security-unit/run.mjs](../../../evals/phase3/security-unit/run.mjs) | 环回模拟服务升级为 OpenAI SSE `/chat/completions`（含 `priced`、`no-usage`、`timeout`、`http_error`、cache token 夹具模式与请求日志）；`security-unit` 升级为经夹具凭据槽 `"model"` 与 `model_requests` 通道测试（44 项全绿） |
| §2b | [evals/phase3/model-proposal/run.mjs](../../../evals/phase3/model-proposal/run.mjs), [package.json](../../../package.json) | **新增完整 4.1 验收套件 `test:model-proposal`**：覆盖 §2a 根地址/usage 三态、锚点容器端到端、生产 `--agent-image` 启动器 + 父目录/子目录 ACL/三路径绑定隔离、T1–T10 矩阵、超时/超限冻结/`adapters` 统一核心与对抗加固不变量（撤销凭据/禁用 warming/大写 UUID/租约过期 ORPHAN 结清/路径哈希防撞/显式 ACL 清理）共 14 项检查 |
| §2c | [apps/daemon/src/container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) | 新增 `safeTaskDirComponent`、`agentWorkAttemptDir`、`lockHostProposalsDir`（Windows 自动 `icacls /inheritance:r /grant:r "<account>:(OI)(CI)F"` + 自检禁宽泛主体；POSIX `0770`，禁用 `1777`）、`inspectHostProposalsAcl` 与 `createAgentLauncher`（3 目录按 `proposals:rw` / `host-commands:ro` / `context.json:ro` 挂载、`--network none`、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--init`） |
| §2c | [apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs) | 启动后在 `migrate()` 之后按需调用 `ensureModelRequestsTable(db)`；移除旧内联 `config.model.endpoint` 分支，接入 `processPendingModelProposals` 与可选 `--agent-image=<digest>` 启动器并把 `modelConfig` 传入 `createAdapterUpstream` |
| §2c | [tools/build-app-images.mjs](../../../tools/build-app-images.mjs), [docs/phase3/reports/image-digest.md](../../phase3/reports/image-digest.md) | 历史节标题改名「前序纪元」避免纪元误标；选择性重建 `agent`（初版纪元 3 → 加固终版纪元 5）并更新机器可读 `v2` digest 块 |

---

## 三、§3 锚点用例、生产启动器与 T1–T10 矩阵实测对照

来源：[model-proposal-log.md](../../phase3/evidence/model-proposal-log.md)（14/14 PASS，exit 0）。

### 3.1 核心前缀与容器端到端基线

| 用例 | 关键实测观测 | 结果 |
| --- | --- | --- |
| §2a 根 `baseUrl` 与 usage 三态 | `callModelOnce` 拒绝 `/chat/completions` 后缀（`ModelCallError`）；`no-usage` 无 `totalFromProvider` 键 → `microusdForUsage=null`；全零有布尔键但和为 0 → `null`；`40/13` → `28 u$` | **PASS** |
| §3 锚点端到端（`docker run` 钉住镜像） | `--network none`、`--read-only`、`--cap-drop ALL`、`PI_OFFLINE=1`、宿主 ACL 锁定 `proposals`；容器写信封 → daemon `--once` → `pi-ai` 子进程请求环回 `/chat/completions`（`model=deepseek-flash`、`thinking.type=enabled`、hits=1）→ 请求 `SETTLED` / 账本 `SETTLED(28 u$)` / 任务 `SUCCEEDED` → 容器消费 `model-result-<uuid>.json` 并回执原文一致（证据 `replyLen=4000`） | **PASS** |
| §2c 生产启动器（`daemon --once --agent-image=...`） | 自动建目+`icacls` 锁定父与子目录（`attemptAcl=true aclOk=true`），任务 `SUCCEEDED`、`SETTLED/28 u$`、`hits=1`、退场后残余容器空；四路径探针实测 `rootfs=RO:EROFS cmds=RO:EROFS ctx=RO:EROFS prop=RW`；`modelResultFileName("../etc/passwd")` 拒绝 | **PASS** |

### 3.2 最小验收矩阵 T1–T10 实测对照表

| 编号 | 场景 | 预期（请求态 / 账本态 / 费用 / 环回次数） | 实测（请求态 / 账本态 / 费用 / 环回次数） | 其他关键观测 |
| --- | --- | --- | --- | --- |
| **T1** | 正常端到端调用（40 input + 13 output + reasoning:high） | `SETTLED` / `SETTLED` / `28 u$` / `1` | `SETTLED` / `SETTLED` / `28 u$` / `1` | wire 路径 `/chat/completions`、`model=deepseek-flash`、`thinking.type=enabled`；回执正文匹配、证据截断 4000 |
| **T2-1** | 6 类校验拒绝（purpose / modelId / scope / fence / unknown-field / >128 KiB） | 建行前拒绝：**0 行 / 0 预留** / `0 u$` / `0` | **6 触发全 refused，rows=0 / res=0** / `0 u$` / `0` | 触发 `model_request_refused` 审计 6 条 |
| **T2-2** | 合法信封遇账户冻结/超限预留拒绝 | `FAILED` / 无预留 / `0 u$` / `0` | `FAILED` / `res=0` / `0 u$` / `0` | 先插 `RECEIVED` 后因 `AccountFrozen` 转 `FAILED` 并落 `budget_refused` |
| **T3** | 同 `requestId` 重复投递 | 首条 `SETTLED`，次次返回幂等；1 条请求行 / 1 条预留 / `1` | 首条 `settled`，重复 `duplicate(SETTLED)`；`req=1`、`res=1` / `1` | `model_request_duplicate` 审计 1 条 |
| **T4** | `RESERVED` 与 `EXECUTING` 之间调用前取消 | `FAILED` / `RELEASED` / `0 u$` / `0` | `FAILED` / `RELEASED` / `taskHeld=0, dayHeld=0` / `0` | `budget_released` 审计 1 条 |
| **T5** | `RESERVED` 与 `EXECUTING` 之间崩溃（真 SIGKILL + witness marker）→ 超时窗口重启动作 + 放弃 attempt | 重启后 `RESERVED` / `HELD`（禁进 `CHARGED_BOUND`）；放弃后 `FAILED` / `RELEASED` / `0 u$` / `0` | 重启（含 `+20m`）保持 `RESERVED` / `HELD`；放弃后 `FAILED` / `RELEASED` / `spent=0` / `0` | 经 D-77 口径，crashpoint marker 命中，零费用零调用 |
| **T6** | 提交 `EXECUTING` 后崩溃（真 SIGKILL + witness marker）→ 越过 15m 超时恢复 | 初重启 `EXECUTING` / `HELD`；超时后保持 `EXECUTING` / `CHARGED_BOUND(1000 u$)` / 禁再调用 | 初重启 `EXECUTING` / `HELD`；`+20m` 恢复后 `EXECUTING` / `CHARGED_BOUND(1000 u$)` (`taskSpent=500`) | 尝试 pre-call `cancelPreCallModelRequest` 被拒（`releaseBlocked=true`） |
| **T7** | 第一次调用已完成取到 usage、写回前崩溃 → 迟到结清与重放 | 崩溃前调用 `1`；迟到一次转 `SETTLED` / `SETTLED(28 u$)`，重放丢弃，累计 `1` | `hitsAfterCrash=1`, 迟到前 `EXECUTING/HELD` → `SETTLED/SETTLED(28 u$)`，重放 `dropped`，`totalHits=1` | `model_late_usage_settled=1`、`model_late_usage_dropped=1` |
| **T8** | usage 缺失（`no-usage`）与全零（`0/0`） | 两命名空间均 `HELD` / 账本 `HELD`；请求态 `HELD` 再来迟到 usage 丢弃 / `2` | `missing=HELD/HELD`, `zero=HELD/HELD`, `dupLate=dropped` / `calls=2` | `model_usage_not_settled=2`，不按免费 0 结算 |
| **T9** | 合法 0 输出（`10/0`）& `cacheWrite>0` 且价格为 `null` | 子例 1 `SETTLED` / `SETTLED(3 u$)`；子例 2 `HELD` / `HELD` / `2` | `sub1=SETTLED/SETTLED(3u$)`, `sub2=HELD/HELD` / `calls=2` | 逐类定价与非零输出免卡契约双成立 |
| **T10** | 写回前任务已终态（`CANCELLED`）下有效 usage 与无效 usage | 子例 1 `ORPHAN` / `SETTLED(28 u$)`；子例 2 `ORPHAN` / `HELD` → 超时 `CHARGED_BOUND(1000 u$)`；0 投递 | `sub1=ORPHAN/SETTLED(28u$)`, `sub2=ORPHAN/CHARGED_BOUND(1000u$)` / `deliveredFiles=0` | `model_result_orphan=2`；交付终止不免除已发生费用 |
| **边界补充** | 请求超时 / 超上限实扣（`2040 > 1000`）/ `adapters` 统一核心 / 对抗不变量 | 超时进 `EXECUTING`/`CHARGED_BOUND(1000)`；超限仍 `SETTLED` 且冻结账户；adapter 经 `callModelOnce` `/chat/completions` | 超时 `EXECUTING/CHARGED_BOUND(1000)` (`model_call_failed=1`)；超限冻结 (`overchargeFrozen=1/2`)；`adapter=succeeded/deepseek-flash//chat/completions`；加固五不变量 `revoked=call_failed warm=warming_disabled upper=invalid_request_id leaseExp=ORPHAN/SETTLED(28) compsUnique=true explicitAclCleaned=true` | 含未接线 `"model"` 凭据槽于建连前即 fails closed（[security-unit-log.md](../../phase3/evidence/security-unit-log.md) 第 36 项 `http-hits=0`） |

---

## 四、纪元 5 构建、供应链声明与终树套件证据

### 4.1 纪元 5 镜像与零绑定漂移

初版 4.1 完成后产出的纪元 3（`52354a8b2bfd`）与加固初版产出的纪元 4（`sha256:731cf7...`）均已归入历史；终树先重算 `appImageContextHash`：仅 `agent` 上下文随加固补丁漂移至 `sha256:c4ded878...`，`acquisition`（`sha256:8abae275...`）与 `execution`（`sha256:8183df14...`）自纪元 1 起逐位未变，经本地 `127.0.0.1:5000` registry 核验后携带沿用。

- 执行命令：`D:\AegisPi\tools\node-v22.23.5\node.exe tools/build-app-images.mjs --only=agent --note="Epoch 5 (Phase 4.1 hardening): agent rebuilt with final scanPendingProposals empty-tasksToVisit fix, post-launch container lease heartbeat, and graceful receipt wait window; acquisition/execution verified context-identical and carried over."`（exit 0）
- **agent 现行纪元 5（[image-digest.md](../../phase3/reports/image-digest.md)）**：
  - tag：`127.0.0.1:5000/aegispi/agent:phase3-9b1d5fda8cc4`
  - manifest digest：`sha256:5be3082db79d4d0f20163bce8bf452c37cfc041c621b6a467727fdebe13e8bde`
  - config digest：`sha256:68478dea9ceac793c857b58e8d33c3bac0253bccb368ec16f29f2ceeaf1738fe`
  - context digest：`sha256:c4ded878e5b3a2da407ce799f3745e527e65a56df589b03043a81caf1dde03df`
  - 构建后容器内冒烟：`agent --self-check` → `self-check: green (pi 1.5.2)`（exit 0）
- **终树绑定校验**：`requireAppImageDigests()` 核对三镜像 `context` / `config` / `registry manifest` 全部匹配，`IMAGE_GATE_OK`（exit 0）。
- **构建供应链网络面声明（与真实推理调用分列）**：`docker/agent/Dockerfile` 的 `deps` 阶段执行了 `npm ci --omit=dev --ignore-scripts`，通过公网 npm registry 下载 `package-lock.json` 锁定依赖（与纪元 1/2 同一构建通道），基础镜像 `node:22.23.5-bookworm-slim` 按 index digest 固定、构建后推送仅至本地 `127.0.0.1:5000`。**该构建行为不涉及模型 API 或 `.env` 凭据，真实推理服务调用严格为 0。**

### 4.2 全量离线 + 容器验收汇总（2026-11-21 纪元 5 终树复跑，锁定 Node v22.23.5）

回归选择依据：Unit 4.1 改动触及 `defaults.json`、`config.mjs`、`db/migrate.mjs`、`budget.mjs`、`recovery.mjs`、`adapters.mjs`、`container-executor.mjs`、`daemon.mjs` 与 `agent` 容器镜像，涵盖配置加载、账本状态、恢复扫描、适配器与容器执行全链路。因此本轮**在终树上全量运行了仓库全部 12 条离线/本地及容器测试脚本与 1 项 Hono 预检**，不做任何跳过，**仅故意不运行三条 `real` 入口**。

| 套件 | 执行命令 | 结果摘要 | 退出码 |
| --- | --- | --- | --- |
| `test:contracts` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/contracts/run-contracts.mjs` | 15 probe(s): all PASS（Pi 01–13、framing、SQLite 27 用户表） | `0` |
| Hono 预检配对 | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 baseline 与 4.12.24 target 及未安装快照对照全通过 | `0` |
| `test:durability` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/durability/run.mjs` | 164 pass, 0 fail, 164 judged | `0` |
| `test:budget` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/budget/run.mjs` | 20 pass, 0 fail, 20 judged | `0` |
| `test:acl` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/acl/run.mjs` | 15 pass, 0 fail, 15 judged | `0` |
| `test:cancel-approval` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/cancel-approval/run.mjs` | 16 pass, 0 fail, 16 judged | `0` |
| `test:restore` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/restore/run.mjs` | 11 pass, 0 fail, 11 judged | `0` |
| `test:security:unit` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/security-unit/run.mjs` | 44 pass, 0 fail, 44 judged（含新核心、凭据槽缺位前阻断、白名单拒绝） | `0` |
| `test:ingress-telegram` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/ingress-telegram/run.mjs` | 7 pass, 0 fail, 7 judged (+ 1 NOTE 本地无网确认) | `0` |
| `test:model-proposal` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/model-proposal/run.mjs` | 14 pass, 0 fail, 14 judged（§2a/锚点 E2E/生产启动器/T1–T10/边界/adapter/对抗加固不变量） | `0` |
| `test:offline-jobs` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/offline-jobs/run.mjs` | 14 pass, 0 fail, 14 judged | `0` |
| `test:security:integration` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/security-integration/run.mjs` | 29 pass, 0 fail, 29 judged | `0` |
| `test:quota-calibration` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/quota-calibration/run.mjs` | 5 pass, 0 fail, 5 judged | `0` |

**严守禁跑的三条真实验收脚本**：`test:model:real`、`test:external-write:real`、`test:ingress-telegram:real`（含模拟/缺 key 模式）在本轮零执行。

---

## 五、清理证明与失败关闭字段核对

### 5.1 生产树 `model-call-child` 零出现证明

```text
$ git grep model-call-child -- apps docker evals tools package.json package-lock.json
(无任何匹配输出，退出码 1)
```

`docs/` 与 `.audit/` 中的历史文件提及均保持字节原样，未作历史擦除。

### 5.2 [defaults.json](../../../apps/daemon/config/defaults.json) 失败关闭字段逐项核对（对照 ADR-0001 §9）

| 配置键路径 | 现值 | 核对结论 |
| --- | --- | --- |
| `model.baseUrl` | `null` | 符合（旧 `endpoint` 键已移除，未配置路径拒绝执行） |
| `model.allowedPurposes` | `[]` | 符合（空数组全拒） |
| `model.allowedModelIds` | `[]` | 符合（空数组全拒） |
| `model.allowRealModelCalls` | `false` | 符合（非环回端点禁止真实调用） |
| `model.priceCatalog.inputPerMTokMicrousd` | `null` | 符合（token>0 即保持 HELD） |
| `model.priceCatalog.outputPerMTokMicrousd` | `null` | 符合 |
| `model.priceCatalog.cacheReadPerMTokMicrousd` | `null` | 符合 |
| `model.priceCatalog.cacheWritePerMTokMicrousd` | `null` | 符合 |
| `model.callUpperMicrousd` | `1000` | 符合（定额未变） |
| `budget.taskMicroUsd` / `dayMicroUsd` / `cacheWarming` | `800000` / `5000000` / `"off"` | 符合（$\$0.80 / \$5$ 与关闭缓存保温不变） |
| `policy.allowRealExternalWrites` | `false` | 符合（外部写失败关闭） |
| `upstream.submitUrl` | `null` | 符合（未接上游提交器） |
| `credentials.{mail,repo,im}` | `null` / `null` / `null` | 符合（未接明文槽位） |

---

## 六、已知残留与平台约束登记

1. **`test:model:real` 无一次性代码守卫（按 D-77 登记现状）**
   - [evals/phase3/model-real/run.mjs](../../../evals/phase3/model-real/run.mjs) 已改为使用新核心（`baseUrl: "https://api.deepseek.com"`、`allowedPurposes: ["worker"]`、`allowedModelIds: ["deepseek/deepseek-flash"]`、`ensureModelRequestsTable`、`model_requests` 通道），按任务书在 4.1 期间**未运行**且**未追加一次性守卫**。若本机 `.env` 配有 `DEEPSEEK_API_KEY` 且人工直接执行该脚本，仍可再次发起真实推理调用；闭合仍依赖文书口径与执行纪律。
2. **`model_requests` 位于 `schema_migrations` 记录之外（按 D-78 冲突 1 方案 A 登记）**
   - 因规范源 `schema.sql` 位于仓库外资料包且受 `schema-source.json`（`ede73ecaa...`）及 `durability`/`restore`/`sqlite-node` 等全部 27 用户表断言锁定，本轮采纳与 `credential_slots` 同款的**按需幂等扩展建表函数** `ensureModelRequestsTable(db)`（位于 [apps/daemon/src/db/migrate.mjs](../../../apps/daemon/src/db/migrate.mjs)），仅由 `daemon.mjs` 与需要 `model_requests` 的套件在 `migrate()` 之后调用，不写入 `schema_migrations` 记录；`durability` 等不相关工作区数据库保持 27 用户表与 0 迁移漂移。
3. **Windows 宿主 `proposals` 目录账号级 ACL 约束（按 D-78 冲突 2 方案 A 登记）**
   - 宿主由 [container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) 内的 `lockHostProposalsDir` 程序化自动执行：先清理继承 ACL 与已存在的非当前 daemon 显式主体后再赋当前账号独占完全控制权（先 `icacls <dir> /inheritance:r` 获取旧主体列表并逐一 `/remove`，再 `/grant:r "<account>:(OI)(CI)F"`），同时在创建 `host-commands`、`context.json` 与 `proposals` 前先锁定父 `attemptDir`；并由 `inspectHostProposalsAcl` 按严格白名单解析每一条 ACE，拒收一切继承、拒绝（`(N)`/`DENY`）及非本账号主体后才放行容器挂载。
   - **平台约束**：Windows NTFS 不存在 Linux `uid 999` 主体，Docker Desktop 通过当前运行 Windows 账号代理容器写宿主目录，且容器 Linux VFS 内核侧一律呈现 `777 root:root`。因此本平台**无法将「daemon 进程」与「容器作业身份 `uid 999`」在 NTFS ACL 上区分开**，只能保证有效写集合收紧为「运行 daemon 与 Docker Desktop 代理的同一 Windows 账号」，且绝不能以容器内 `stat` 做权限断言；「有效写集合仅限 daemon 与容器 `uid 999` 两个身份」的完整隔离语义在 Linux 成立。**若将来部署常开宿主机且切换平台或提权模型，本条需重开裁量。**
4. **未触授权与阻塞边界**：单元 4.2（真实仓库 Observe）**未开工**，仍受 4.1 验收与首跑检查表七项逐项书面确认阻塞；真实模型调用、外部写、Telegram 入站/出站、D 项公网 webhook（继续延期至首次启用前）与常开宣告均零触碰。

---

## 七、自审计整改汇总（`/poteto-mode` 闭环加固与纪元 5）

在 `9b1d5fda8cc4` 提交之后，依据 `/poteto-mode` 执行三路并行 `interrogate` + `blast-radius` 对抗审计与 Phase F 源码/运行复核，确认 19 项有效 P0/P1/P2 问题后按三个可独立验证单元连续修补，并经 `no-comments` 与复杂度治理整理后重建至纪元 5，全部 12 条工作套件、Hono 预检与专案边界复现全部在终树复跑验证通过：

1. **单元 1（凭据隔离、配置失败关闭与核心统一）**：
   - [model-call.mjs](../../../apps/daemon/src/model-call.mjs) / [model-call-pi-child.mjs](../../../apps/daemon/src/model-call-pi-child.mjs)：构造最小安全子进程环境 `buildSafeChildEnv` 剥离宿主所有 `*_API_KEY`/密钥变量，在 `spawn`/`spawnSync` 前后强制校验 `bearer` 为非空非全空白字符串（否则立即返回 `kind: "local"` 失败，彻底消除 `process.env.DEEPSEEK_API_KEY` 旁路）；补齐 `[::1]` 环回识别、`timeoutMs` 正整数上界（`<= 2_147_000_000` 防止 `setTimeout` 溢出瞬断）、共享 `assertValidModelBaseUrl`/`validateModelMessages`/`callModelOnceAsync`。
   - [config.mjs](../../../apps/daemon/src/config.mjs)：非空 `model.baseUrl` 启动即按 `assertValidModelBaseUrl` 校验，`callUpperMicrousd`（非负安全整数）与 `callTimeoutMs`（正整数上界）在启动期抛出 `ConfigError`。
   - [adapters.mjs](../../../apps/daemon/src/adapters.mjs)：修复 `transportKind !== "fake"` 判断与 `credentials.model` 绕过缺陷，统一仅从 `credential_slots("model")` 解析凭据；同步校验 `baseUrl`、`validateModelMessages` 并捕获 `ModelCallError` 映射为 `failed_local`。
2. **单元 2（预算 `InTx` 门禁、状态机竞态与租约/并发硬化）**：
   - [budget.mjs](../../../apps/daemon/src/budget.mjs)：将 `WarmingDisabled`、`PURPOSES`、整数边界、非空 `accounts` 与 `MissingUsage` 检查下沉至 `reserveInTx` / `settleInTx` 内部（封闭 `InTx` 旁路），并以 SQLite `SAVEPOINT` 包裹三项 `InTx` 事务，使中途异常可原子回滚。
   - [recovery.mjs](../../../apps/daemon/src/recovery.mjs) / [model-requests.mjs](../../../apps/daemon/src/model-requests.mjs)：启动恢复将历史遗留卡死在 `RECEIVED` 的请求行清理为 `FAILED`（`stranded_received_recovered`）；用单事务 + `SAVEPOINT reserve_sp`（`admitAndReserveModelRequestTx`）合并插入 `RECEIVED` 与 `reserveInTx`，并发重复投递由 `UNIQUE` 冲突合并复用；拆出 `validateAndAuthorizeModelProposal` 与 `commitExecutingTransition`；预置 `assertValidModelBaseUrl`、`parseModelWhitelistKey` 与 `warmingEnabled=false` 建行前拒绝；步骤 8 调用前门禁扩大为完整 `checkRunningClaimIdentity`（覆盖 `DEAD`/`LOST`/租约过期并释额为 `FAILED`/`RELEASED`，0 次调用 0 费用）；为 `callModelOnce`/`callModelOnceAsync` 加 `try/catch`；写回阶段支持安全解析已终态/超时任务（`isClaimExpiredOrTerminal` + 空任务防解引用），使租约在调用期间到期时照常按 `SETTLED`+`ORPHAN` 落账不再抛出 `StaleWorker` 回滚费用；写回时钟保持单调不倒流；拒信写入先查库与磁盘防覆写既有 `model-result-*`；新增 `MAX_PROPOSAL_FILE_BYTES` 读前大小门禁；小写限定 `UUID_V4_RE`；补全空 `scanPendingProposals` 返回 `{ ..., tasksToVisit: [] }` 与 `processPendingModelProposalsAsync` 周期 `heartbeat`。
   - [docker/agent/src/worker.mjs](../../../docker/agent/src/worker.mjs)：小写 `UUID_V4_RE` 对齐，并在 `serveCommands` 中拒绝 `null`/数组/基本类型 JSON 指令以防容器 worker 未捕获异常退出。
3. **单元 3（容器生命周期、Windows 宿主 ACL 与 daemon 副作用隔离）**：
   - [container-executor.mjs](../../../apps/daemon/src/container-executor.mjs)：`safeTaskDirComponent` 改为定长截断+12 位 SHA-256 防冲突（`<=41` 字符防 Win32 `MAX_PATH`）；`agentWorkAttemptDir` 校检绝对/相对穿越与正整数 `attemptNo`；`lockHostProposalsDir` 先剥离继承及预存显式他者 ACE 并保护父 `attemptDir`；`inspectHostProposalsAcl` 拒收 deny ACE（`(N)`/`DENY`）与未知主体；容器加注 `aegispi.role=agent` / `aegispi.state_dir` 标签，审计落盘失败时回滚清理容器，并提供 `reapOrphanContainers`。
   - [daemon.mjs](../../../apps/daemon/src/daemon.mjs)：将 `ensureModelRequestsTable(db)` 后移至 `--check` 与 `!openMode` 检查之后（`exit 3` 干跑不再向只读/未初始化库写入）；启动即清孤儿容器；启动后立即续租 `heartbeat`；在未配置 `upstream.submitUrl` 时于 `adapterUpstream` 只路由 `model.inference`，防止其它 `READY` effect 被副作用派发；连续模式经 `reclaimFinishedAgentContainers`（含活体容器 `heartbeat` 与受拒提案任务收口、1500ms 回执等待窗）避免立即孤儿化；`--once` 以 `try/finally` 收口并清停本次拉起容器。
   - 清理与门禁：对新增 diff 执行 `no-comments` 审查与函数拆分（去除 23 行冗余注释并将超长协调函数拆小）；[evals/phase3/model-proposal/run.mjs](../../../evals/phase3/model-proposal/run.mjs) 新增第 14 项 `adversarial-hardening-invariants` 并把容器探针升级为四路径只读/读写检验。纪元 5 终树 12 套件 + Hono 预检 + 全组边界复现全部实测零失败通过。
