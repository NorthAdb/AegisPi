# Phase 4.2 离线链路实施任务书（许可 1 范围：只读仓库获取与 Observe 离线闭环；不含真实运行授权）

> **生成日期**：2026-11-21（Asia/Hong_Kong）  
> **上游依据**：[phase4-restricted-kickoff-draft.md](phase4-restricted-kickoff-draft.md)（单元 4.2 与许可 1 / 许可 2 分列）、[0001-model-path-pi-host-execution.md](../adr/0001-model-path-pi-host-execution.md)、[AUDIT-PHASE4-UNIT4-1-8943a10.md](audits/AUDIT-PHASE4-UNIT4-1-8943a10.md) 与设计包 `02 §1/§4`、`03 §2`、`04 §6`、`06`。  
> **效力边界**：本任务书涵盖**许可 1** 范围内的离线工程实施与本地容器/环回验收，**零真实外部仓库拉取、零真实模型调用、零读取 `.env`、零外部写与通知外发**。任何真实运行仍严格阻塞于《受限开工草案》许可 2 首跑检查表七项逐项书面确认。

---

## 1. 目标与范围锁定

1. **宿主侧 `acquisition` 容器启动器与 Observe 编排**：
   - 补齐 `apps/daemon/src/container-executor.mjs` 中与 `--execution-image`、`--agent-image` 平行的 `createAcquisitionLauncher`（对应 `--acquisition-image=<digest>`），以及新模块 `apps/daemon/src/repo-observe.mjs`。
   - **修复既有 `docker/acquisition/src/downloader.mjs` 双重 `digest()` 缺陷**：`fetchTo` 在启用 `sha256` 校验时两次调用 `hash.digest("hex")`（第 196 行与第 201 行）会触发 `ERR_CRYPTO_HASH_FINALIZED`，必须改为单次摘要缓存，确保带 SHA-256 钉住的归档下载可用。
   - 宿主严格依据 `config.acquisition`（缺省全部失败关闭：`allowRealRepoFetch: false`、`enableHostGateway: false`、`allowedHosts: []`、`targets: {}`）生成只读 `/plan/plan.json` 并运行 digest 钉住的 `acquisition` 容器；严禁由 `inbox` 自由文本、模型响应或容器拼接 URL / 读取路径。
   - **不整库入库与只读零写**：`acquisition` 下载并按 `target.readPaths` 提取有界、脱敏的摘要片段写入 scope-ACL 对象 `repo_observe_manifest`（仅指针、文件哈希与受限摘要，清理原始临时解包目录），`agent` 容器仅消费宿主注入的有界摘要并在 `--network none` 下经 4.1 提议链路完成分析；`task_result` 通过 `object_edges`（`derived_from`）关联 `repo_observe_manifest`。
   - **HELD 停止语义**：Observe 任务结算若落入 `HELD`（usage 缺失或目录价未核定），`tasks` 行禁止标为 `SUCCEEDED`，按 `FAILED`（`error_code='settlement_held_uncompleted'`）+ `observe_stopped_settlement_held` 审计诚实停机并释放容器（兑现《受限开工草案》4.2 停止条件）。
2. **业务级输入/输出 token 硬上限与真实调用代码门禁**：
   - `defaults.json` 新增失败关闭字段 `model.maxInputBytes: null`、`model.maxOutputTokens: null` 及 `acquisition` 策略块；`config.mjs` 在启动期做整数与合法性校验（违例 `ConfigError`）。
   - `model-requests.mjs` 与 `adapters.mjs` 在设值时于建行前强制拒绝超限 `maxInputBytes`（`input_bytes_exceeded`，0 行 0 预留），透传 `maxOutputTokens` 至 `callModelOnce` / `callModelOnceAsync` → `completeSimple({ maxTokens })`（wire 发送 `max_tokens`）；且对非环回真实端点要求 `maxInputBytes` 与 `maxOutputTokens` 均已显式配置，否则建行前失败关闭（`token_caps_not_configured`）。
3. **单元 4.1 路线 A 延后加固项合并落地**：
   - `model-requests.mjs` `processModelRequestAsync`：启动子进程前即时刷新 `heartbeat` 并按 `config.leases.heartbeatMs`（10s，且不超过 `Math.floor(leaseMs / 3)`）周期续租。
   - `daemon.mjs` `reclaimFinishedAgentContainers`（`[P2-1]`）：校验 `info.deadlineAt`，任务超墙钟后停止续租并强制回收容器。
   - `container-executor.mjs` `inspectHostProposalsAcl`（`[P2-2]`）：非 `win32` 平台补齐 `statSync` 检查，拒收 other 可写（`mode & 0o007 !== 0`）目录。
   - `docker/agent/src/worker.mjs`（`[P2-3]`）：`proposeModelRequest` 先校验 `messages` 再写入 `usedRequestIds`，并检查目标文件不存在以防同 attempt 覆写；清理 `model-call.mjs` 空 `if` 注释块（`[P2-4]`）。
   - `evals/phase3/model-real/run.mjs`：在读取 `.env` 之前增加一次性显式环境变量守卫 `AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1`（缺失即 `exit 4`，零 `.env` 读取），并对齐 `maxInputBytes` / `maxOutputTokens` 配置字段。
4. **保持不变的红线**：
   - Canonical `schema.sql`、`schema-source.json`（`ede73ecaa...`）及全部 27 用户表断言不变（Observe 清单与血缘全部复用既有 `objects` + `object_edges`）；
   - `defaults.json` 预算定额（`$0.80` / `$5` / `1000` / `leaseSeconds=45`）与全部失败关闭开关不变；
   - 不新增 Telegram 出站发送（首跑检查表第 2、7 项默认先落本地证据/控制台诊断，待主人书面确认另行决定是否发通知）；D 项继续延期。

---

## 2. 离线可证伪验收标准（`test:repo-observe` + 全量回归 + 纪元 6）

新增 `evals/phase3/repo-observe/run.mjs`（npm 脚本 `test:repo-observe`），驱动真实 digest 钉住的 `acquisition` + `agent` 容器、真实 `daemon.mjs --once`、本地一次性 HTTP 仓库归档源与本地 OpenAI SSE 环回服务，覆盖：

1. **端到端离线 Observe 闭环**：含 `sha256` 钉住的 `.tar.gz` 拉取、仅提取白名单 `readPaths` 入 `repo_observe_manifest`、清理原始解包树（不整库入库）、`object_edges` 溯源、`max_tokens` 透传到 wire、`SETTLED(28 µ$)` → `SUCCEEDED`、`repo_writes=0` 与容器/volume 零残留。
2. **失败关闭门禁（零容器启动、零字节外发）**：未登记 `targetId` 拒绝、`allowRealRepoFetch=false` 拒绝外网源、`allowedHosts` 外主机拒绝、非环回模型端缺失 `maxInputBytes`/`maxOutputTokens` 拒绝（0 行 0 预留）。
3. **`maxInputBytes` 建行前拦截**：小于 128 KiB 但超 `model.maxInputBytes` 的提议在建行前拒绝（`input_bytes_exceeded`，0 行 0 预留 0 调用）。
4. **下载器安全边界与脱敏**：越界软链 / `sha256` 不匹配归档在 `acquisition` 容器内拒绝并使任务落 `FAILED(infra_error)`（`agent` 零启动、模型零调用）；摘要文本中的凭据样式字符串（`sk-...`）被宿主脱敏。
5. **HELD 停止条件**：`priceCatalog` 为 `null`（或 `no-usage`）时，request/账本保持 `HELD`，Observe 任务**不判 `SUCCEEDED`**（落 `FAILED` + `observe_stopped_settlement_held`）。
6. **`heartbeat` 对齐、T6 1 次调用崩溃补强与 `model:real` 护栏**：`processModelRequestAsync` 子进程前刷租并按配置周期续租；`model-proposal/run.mjs` T6 补足 `after-call-before-writeback` 超时转 `CHARGED_BOUND(1000)` + 重放抑制断言及 `proposeModelRequest` 防覆写断言；`model:real` 无 opt-in 变量直接 `exit 4` 且零 `.env` 读取。
7. **镜像纪元 6 与全量套件**：重建 `agent` 与 `acquisition`（`execution` 复算零漂移携带），`image-gate` 放行，`git grep model-call-child` 生产树零命中，全部 13 条离线/容器套件 + Hono 预检全绿 `exit 0`。
