# 单元 4.1 收口验收报告（ADR-0001 模型提议与 pi-ai 执行链路）

> **日期**：2026-11-20  
> **起始基线**：`52354a8b2bfd17c6ba836637df1054e0ef0d7b9b`（`origin/main`，已含 D-77/D-78 修订与两项冲突裁量）  
> **授权口径**：主人 2026-11-20 正式开工授权（**仅限单元 4.1、许可 1 范围**；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-79`）  
> **实施依据**：[phase4-1-implementation-task-spec.md](../phase4-1-implementation-task-spec.md)（含 D-77/D-78 修订）与 [0001-model-path-pi-host-execution.md](../../adr/0001-model-path-pi-host-execution.md)  
> **运行环境**：Windows 11（Docker Desktop `29.9.2` + `127.0.0.1:5000` 本地构建 registry），锁定 Node `v22.23.5`（`D:\AegisPi\tools\node-v22.23.5\node.exe`）

---

## 一、核心结论

单元 4.1 按任务书 §2a → §2b → §2c 连续实施完成，全量离线 + 容器套件在本机验证全绿（全部 12 项工作套件 + Hono 预检均为 `exit 0`）。**真实推理服务零调用、全程未读 `.env`、`defaults.json` 失败关闭开关与 $\$0.80 / \$5 / 1000\,\mu\$$ 上限不变、未触单元 4.2 或任何真实外部写 / Telegram / 公网 webhook / 常开。**

1. **执行核心**：已切换到已锁定生产依赖 `@earendil-works/pi-ai@1.5.2`（`getBuiltinModel("deepseek", "deepseek-flash")` + `completeSimple`，必传 `reasoning: "high"`、`env: {}`、`maxRetries: 0`）；`model.baseUrl` 实行无路径根地址语义（拒绝自带 `/chat/completions` 后缀）。
2. **通道与状态机**：`worker.mjs` 在只读 rootfs + `--network none` 容器内写闭字段 `model_request` 信封至 `proposals/`；宿主经 `ensureModelRequestsTable(db)`（D-78 冲突 1 方案 A，独立幂等扩展建表，不动 canonical schema 与 27 表指纹门）与七态状态机执行「全校验先行 → 同事务 `RESERVED` + `ledger.reserveInTx` → 独立提交 `EXECUTING` → 单次 `pi-ai` 调用 → 同事务写回（`SETTLED`/`HELD`/`ORPHAN`）+ `model_result-<requestId>.json` 回传」。
3. **清理与统一核心**：`apps/daemon/src/model-call-child.mjs` 已删除，生产树（`apps docker evals tools package.json package-lock.json`）`git grep model-call-child` 零命中；`adapters.mjs` 的 `model.inference` 与提议链路统一走 `callModelOnce`；`test:model:real` 已改接到新核心，**未运行**且按 D-77 保留现状为已知残留。
4. **纪元 3 镜像**：构建前复算 `appImageContextHash`，仅 `agent` 上下文漂移，按 `--only=agent` 选择性重建并推送至 `127.0.0.1:5000`，`acquisition` 与 `execution` 核验一致后携带原 digest；终树 `image-gate` 零漂移放行。

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
| §2b | [docker/agent/src/worker.mjs](../../../docker/agent/src/worker.mjs) | 新增 `proposeModelRequest`（闭字段信封、UUID v4 校验及非复用防线、128 KiB 校验、`.tmp`+`rename` 原子写），更新 `serveCommands` 消费 `model_result-*.json` 并写回执（兼容 `:ro` 宿主目录跳过 `EROFS` 删除），`main()` 支持消费 `context.modelRequest` |
| §2b | [evals/phase3/security-unit/helpers/local-model-service.mjs](../../../evals/phase3/security-unit/helpers/local-model-service.mjs), [evals/phase3/security-unit/run.mjs](../../../evals/phase3/security-unit/run.mjs) | 环回模拟服务升级为 OpenAI SSE `/chat/completions`（含 `priced`、`no-usage`、`timeout`、`http_error`、cache token 夹具模式与请求日志）；`security-unit` 升级为经夹具凭据槽 `"model"` 与 `model_requests` 通道测试（44 项全绿） |
| §2b | [evals/phase3/model-proposal/run.mjs](../../../evals/phase3/model-proposal/run.mjs), [package.json](../../../package.json) | **新增完整 4.1 验收套件 `test:model-proposal`**：覆盖 §2a 根地址/usage 三态、锚点容器端到端、生产 `--agent-image` 启动器 + ACL/绑定隔离、T1–T10 矩阵及超时/超限冻结/`adapters` 统一核心共 13 项检查 |
| §2c | [apps/daemon/src/container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) | 新增 `safeTaskDirComponent`、`agentWorkAttemptDir`、`lockHostProposalsDir`（Windows 自动 `icacls /inheritance:r /grant:r "<account>:(OI)(CI)F"` + 自检禁宽泛主体；POSIX `0770`，禁用 `1777`）、`inspectHostProposalsAcl` 与 `createAgentLauncher`（3 目录按 `proposals:rw` / `host-commands:ro` / `context.json:ro` 挂载、`--network none`、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--init`） |
| §2c | [apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs) | 启动后在 `migrate()` 之后按需调用 `ensureModelRequestsTable(db)`；移除旧内联 `config.model.endpoint` 分支，接入 `processPendingModelProposals` 与可选 `--agent-image=<digest>` 启动器并把 `modelConfig` 传入 `createAdapterUpstream` |
| §2c | [tools/build-app-images.mjs](../../../tools/build-app-images.mjs), [docs/phase3/reports/image-digest.md](../../phase3/reports/image-digest.md) | 历史节标题改名「前序纪元」避免纪元 3 误标；选择性重建 `agent` 完成纪元 3 并更新机器可读 `v2` digest 块 |

---

## 三、§3 锚点用例、生产启动器与 T1–T10 矩阵实测对照

来源：[model-proposal-log.md](../../phase3/evidence/model-proposal-log.md)（13/13 PASS，exit 0）。

### 3.1 核心前缀与容器端到端基线

| 用例 | 关键实测观测 | 结果 |
| --- | --- | --- |
| §2a 根 `baseUrl` 与 usage 三态 | `callModelOnce` 拒绝 `/chat/completions` 后缀（`ModelCallError`）；`no-usage` 无 `totalFromProvider` 键 → `microusdForUsage=null`；全零有布尔键但和为 0 → `null`；`40/13` → `28 u$` | **PASS** |
| §3 锚点端到端（`docker run` 钉住镜像） | `--network none`、`--read-only`、`--cap-drop ALL`、`PI_OFFLINE=1`、宿主 ACL 锁定 `proposals`；容器写信封 → daemon `--once` → `pi-ai` 子进程请求环回 `/chat/completions`（`model=deepseek-flash`、`thinking.type=enabled`、hits=1）→ 请求 `SETTLED` / 账本 `SETTLED(28 u$)` / 任务 `SUCCEEDED` → 容器消费 `model-result-<uuid>.json` 并回执原文一致（证据 `replyLen=4000`） | **PASS** |
| §2c 生产启动器（`daemon --once --agent-image=...`） | 自动建目+`icacls` 锁定（`acl.ok=true`），任务 `SUCCEEDED`、`SETTLED/28 u$`、`hits=1`、退场后残余容器空；三目录只读/读写探针实测 `rootfs=RO:EROFS cmds=RO:EROFS prop=RW`；`modelResultFileName("../etc/passwd")` 拒绝 | **PASS** |

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
| **边界补充** | 请求超时 / 超上限实扣（`2040 > 1000`）/ `adapters` 统一核心 | 超时进 `EXECUTING`/`CHARGED_BOUND(1000)`；超限仍 `SETTLED` 且冻结账户；adapter 经 `callModelOnce` `/chat/completions` | 超时 `EXECUTING/CHARGED_BOUND(1000)` (`model_call_failed=1`)；超限冻结 (`overchargeFrozen=1/2`)；`adapter=succeeded/deepseek-flash//chat/completions` | 含未接线 `"model"` 凭据槽于建连前即 fails closed（`security-unit` 第 35 项 `http-hits=0`） |

---

## 四、纪元 3 构建、供应链声明与终树套件证据

### 4.1 纪元 3 镜像与零绑定漂移

构建前先重算 `appImageContextHash`：仅 `agent` 上下文从纪元 2（`sha256:72ed2cae...`）漂移至本树（`sha256:59518d1a...`），`acquisition`（`sha256:8abae275...`）与 `execution`（`sha256:8183df14...`）逐位未变，经本地 `127.0.0.1:5000` registry 核验后携带沿用。

- 执行命令：`D:\AegisPi\tools\node-v22.23.5\node.exe tools/build-app-images.mjs --only=agent --note="Epoch 3 (Phase 4.1): agent rebuilt for ADR-0001 pi-ai core, model_requests, worker model_request/model_result channel, and production agent launcher; acquisition/execution verified context-identical and carried over."`（exit 0）
- **agent 现行纪元 3（[image-digest.md](../../phase3/reports/image-digest.md)）**：
  - tag：`127.0.0.1:5000/aegispi/agent:phase3-52354a8b2bfd`
  - manifest digest：`sha256:100b9d8084aa74203d814ef032907c444334d8885bced731e6e55160f17a04c2`
  - config digest：`sha256:c79ad7b7c6f113b7722cbc3196f7369bcf6d3d04392bdf6e0f7834822242dffd`
  - context digest：`sha256:59518d1a52a5691be7318c7c4ee77972c537aa8d2748b2bd43a2f29b2a224ad9`
  - 构建后容器内冒烟：`agent --self-check` → `self-check: green (pi 1.5.2)`（exit 0）
- **终树绑定校验**：`requireAppImageDigests()` 核对三镜像 `context` / `config` / `registry manifest` 全部匹配，`IMAGE_GATE_OK`（exit 0）。
- **构建供应链网络面声明（与真实推理调用分列）**：`docker/agent/Dockerfile` 的 `deps` 阶段执行了 `npm ci --omit=dev --ignore-scripts`，通过公网 npm registry 下载 `package-lock.json` 锁定依赖（与纪元 1/2 同一构建通道），基础镜像 `node:22.23.5-bookworm-slim` 按 index digest 固定、构建后推送仅至本地 `127.0.0.1:5000`。**该构建行为不涉及模型 API 或 `.env` 凭据，真实推理服务调用严格为 0。**

### 4.2 全量离线 + 容器验收汇总（锁定 Node v22.23.5）

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
| `test:model-proposal` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/model-proposal/run.mjs` | 13 pass, 0 fail, 13 judged（§2a/锚点 E2E/生产启动器/T1–T10/边界/adapter） | `0` |
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
   - 宿主由 [container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) 内的 `lockHostProposalsDir` 程序化自动执行 `icacls <dir> /inheritance:r /grant:r "<account>:(OI)(CI)F"`，剥夺继承 ACL（清除 Windows 默认继承中包含的 `Authenticated Users` 修改权），并通过 `inspectHostProposalsAcl` 对**宿主 ACL** 逐项验明无宽泛主体后才放行容器挂载。
   - **平台约束**：Windows NTFS 不存在 Linux `uid 999` 主体，Docker Desktop 通过当前运行 Windows 账号代理容器写宿主目录，且容器 Linux VFS 内核侧一律呈现 `777 root:root`。因此本平台**无法将「daemon 进程」与「容器作业身份 `uid 999`」在 NTFS ACL 上区分开**，只能保证有效写集合收紧为「运行 daemon 与 Docker Desktop 代理的同一 Windows 账号」，且绝不能以容器内 `stat` 做权限断言；「有效写集合仅限 daemon 与容器 `uid 999` 两个身份」的完整隔离语义在 Linux 成立。**若将来部署常开宿主机且切换平台或提权模型，本条需重开裁量。**
4. **未触授权与阻塞边界**：单元 4.2（真实仓库 Observe）**未开工**，仍受 4.1 验收与首跑检查表七项逐项书面确认阻塞；真实模型调用、外部写、Telegram 入站/出站、D 项公网 webhook（继续延期至首次启用前）与常开宣告均零触碰。
