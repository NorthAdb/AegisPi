# 单元 4.2 许可 1 离线收口报告（Repo Observe 离线闭环与 4.1 延后加固）

> **日期**：2026-11-21（Asia/Hong_Kong）  
> **起始基线**：`7cc85d9de4a2`（`main`，已包含单元 4.1 交付 `8943a10` 与独立对抗审计归档 [AUDIT-PHASE4-UNIT4-1-8943a10.md](../audits/AUDIT-PHASE4-UNIT4-1-8943a10.md)）  
> **授权口径**：仅限《受限开工草案》**许可 1 范围**（本地工程实施、夹具测试与镜像纪元构建；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-81`、`D-82`）  
> **实施依据**：[phase4-2-offline-task-spec.md](../phase4-2-offline-task-spec.md)、[phase4-restricted-kickoff-draft.md](../phase4-restricted-kickoff-draft.md) 与 [0001-model-path-pi-host-execution.md](../../adr/0001-model-path-pi-host-execution.md)  
> **运行环境**：Windows 11（Docker Desktop `29.9.2` + `127.0.0.1:5000` 本地构建 registry），锁定 Node `v22.23.5`（`D:\AegisPi\tools\node-v22.23.5\node.exe`）

---

## 一、核心结论

单元 4.2 许可 1 离线链路实施完成，同时并入执行主人裁定「路线 A」下从单元 4.1 延后的全部非阻断 P2 加固项、`heartbeat` 续租对齐、`test:model:real` 显式 opt-in 守卫与 `downloader.mjs` 既有 `sha256` 双重摘要缺陷修复。在**镜像纪元 6** 终树上，仓库全部 **13 项离线/容器套件与 1 项 Hono 预检**全部 `exit 0`（含新增 `test:repo-observe` 6/6 全过与 `test:model-proposal` 14/14 全过）。

**零越界声明**：本轮实施与全部验收**零真实外部仓库拉取、零真实模型调用、全程未读取 `.env`、未触外部写/Telegram/公网 webhook/常开宣告**。单元 4.2 的任何**真实运行**仍严格阻塞于《受限开工草案》**许可 2 首跑检查表七项逐项书面确认**（见第七节）。

1. **只读 Repo Observe 离线闭环**：宿主经 [repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs) 与 `createAcquisitionLauncher`（`--acquisition-image=<digest>`）在 `bridge`（无 `--add-host` 除非 `enableHostGateway=true`）、`--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges` 容器内运行 [downloader.mjs](../../../docker/acquisition/src/downloader.mjs) 下载受白名单管控与可选 `sha256` 钉住的归档；宿主机逐级 `lstatSync` 拒绝任何软链逃逸或非普通文件读取，按 `readPaths` 提取有界且脱敏的只读摘要写入 `objects`（`kind='repo_observe_manifest'`，`readOnly=true`、`repoWrites=0`、`fullRepoPersisted=false`），立即清理原始解包目录；再将精确拟合 `model.maxInputBytes` 的提示词注入 `--network none` 的 `agent` 容器经 4.1 提议链路调用 `pi-ai@1.5.2`，同事务以 `object_edges(relation='derived_from')` 关联 `task_result` 并结清预算。
2. **修复 `downloader.mjs` 既有双重 `digest()` 缺陷**：[docker/acquisition/src/downloader.mjs](../../../docker/acquisition/src/downloader.mjs) 的 `fetchTo` 原先在传入期望 `sha256` 时两次调用 `hash.digest("hex")`（先比对再返回）导致 `ERR_CRYPTO_HASH_FINALIZED`，已改为单次计算复用，确保带 `sha256` 钉住的真实容器下载可用（已进入纪元 6 `acquisition` 镜像并由 `test:repo-observe` 实测验证）。
3. **`HELD` 停止条件落地**：当 `repo_observe` 任务结算落入 `HELD`（如 `priceCatalog` 为 `null` 或 `no-usage`），[model-requests.mjs](../../../apps/daemon/src/model-requests.mjs) 识别该 attempt 绑定的 `repo_observe_manifest`，拒绝将 `tasks` 标为 `SUCCEEDED`，按 `FAILED`（`error_code='settlement_held_uncompleted'`）+ `observe_stopped_settlement_held` 审计停机。
4. **业务级 token 上限与 `model:real` 显式护栏**：`defaults.json` 新增 `model.maxInputBytes: null`、`model.maxOutputTokens: null` 与 `acquisition` 策略块；非环回模型端点未配置上下限时在建行前即拒（`token_caps_not_configured`）；超 `maxInputBytes` 在建行前即拒（`input_bytes_exceeded`，0 行 0 预留）；`maxOutputTokens` 透传至 `completeSimple({ maxTokens })` 并由环回 wire 验证 `max_tokens`。`evals/phase3/model-real/run.mjs` 在读取 `.env` 之前增加显式 `AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1` 守卫（缺省 `exit 4`，零 `.env` 读取）。
5. **单元 4.1 路线 A 延后项全部关闭**：补齐 `[P2-1]` 连续模式超 `deadlineAt` 停止续租并回收容器、`[P2-2]` POSIX `inspectHostProposalsAcl` 校验 `(mode & 0o1777 & 0o007) === 0`、`[P2-3]` `worker.mjs` 先校验 `messages` 与目标文件不存在再记录 `usedRequestIds`、`[P2-4]` 清理 `model-call.mjs` 空 `if` 块、`processModelRequestAsync` 启动即刷新与周期 `heartbeat` 对齐、`model-proposal/run.mjs` T6 `after-call-before-writeback`（1 次调用转 `CHARGED_BOUND(1000)` + 抑制重放）与 `no-comments` 审查清理。

---

## 二、单元 2 产物一览

| 类别 | 文件 | 关键改动与职责 |
| --- | --- | --- |
| 策略默认与配置校验 | [apps/daemon/config/defaults.json](../../../apps/daemon/config/defaults.json)、[apps/daemon/src/config.mjs](../../../apps/daemon/src/config.mjs) | 新增失败关闭键 `model.maxInputBytes: null`、`model.maxOutputTokens: null` 与 `acquisition` 策略块（`allowRealRepoFetch: false`、`enableHostGateway: false`、`allowedHosts: []`、`targets: {}`、`maxDownloadBytes: 8388608`、`maxExcerptBytes: 32768`、`maxFiles: 32`、`timeoutMs: 30000`）；`config.mjs` 复用到共享 URL/相对路径校验并严格校验每目标 `maxDownloadBytes` 与整型边界 |
| Repo Observe 宿主编排 | [apps/daemon/src/repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs) | **新增**：`parseRepoObservePayload`、`authorizeAcquisitionTarget`、跨文件共享校验（`isHttpUrlWithoutCredentials` / `isSafeRelativeReadPath`）、`buildSafeRepoExcerpt`（逐段 `lstatSync` 拒软链/非普通文件 + 凭据脱敏 + 字节限制）、`executeRepoObserveAcquisition`（入库 `repo_observe_manifest`、清理原始 `run.workDir`、精确二分裁剪提示词适配 `maxInputBytes`） |
| 捕获镜像与启动器 | [docker/acquisition/src/downloader.mjs](../../../docker/acquisition/src/downloader.mjs)、[apps/daemon/src/container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) | 修复 `fetchTo` 双重 `hash.digest("hex")` 缺陷；新增 `createAcquisitionLauncher`（`@sha256:` 硬门、`enableHostGateway` 默认禁网关心、`/plan:ro` + named `/downloads` volume、启动失败清理 `workDir`、`onProgress` 心跳回调、启动 `reapOrphanContainers`）；POSIX `inspectHostProposalsAcl` 补全 `other` 可写检查 |
| 执行核心与状态机 | [apps/daemon/src/model-call.mjs](../../../apps/daemon/src/model-call.mjs)、[apps/daemon/src/adapters.mjs](../../../apps/daemon/src/adapters.mjs)、[apps/daemon/src/model-requests.mjs](../../../apps/daemon/src/model-requests.mjs) | 新增 `validateModelTokenCaps` 并经既有 `model-call-pi-child.mjs` 透传 `maxTokens`；`model-requests.mjs` 建行前强制执行 `maxInputBytes` / 非环回上下限门禁，写回复用 `observeManifestObjectIdForAttempt` 关联 `object_edges(relation='derived_from')` 并落实 Observe `HELD` 停止条件，补齐 `processModelRequestAsync` 即时 + 周期 `heartbeat`，提取共享 `recordScannedProposalOutcome`；删除 `model-call.mjs` 空 `if` 注释块 |
| 容器与 Daemon 接线 | [docker/agent/src/worker.mjs](../../../docker/agent/src/worker.mjs)、[apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs) | `worker.mjs` 先校 `messages` 再写 `usedRequestIds` 且拒同 attempt 覆写；`daemon.mjs` 提取 `parseImageLauncher` 接入 `--acquisition-image=<digest>`，拉取阶段传入心跳回调，连续回收校验 `deadlineAt`，转发 `heartbeatMs` 至 `processPendingModelProposalsAsync` |
| 验收套件与门禁脚本 | [evals/phase3/repo-observe/run.mjs](../../../evals/phase3/repo-observe/run.mjs)、[evals/phase3/model-proposal/run.mjs](../../../evals/phase3/model-proposal/run.mjs)、[evals/phase3/model-real/run.mjs](../../../evals/phase3/model-real/run.mjs)、[evals/phase3/security-unit/helpers/local-model-service.mjs](../../../evals/phase3/security-unit/helpers/local-model-service.mjs)、[package.json](../../../package.json) | **新增 `test:repo-observe`（6 项全绿）**；补强 `model-proposal` T6 post-call replay 与 worker 覆写护栏；`model-real/run.mjs` 增读前 `exit 4` opt-in 守卫与输入输出 caps；环回服务记录 `max_tokens` 并支持延迟响应 |

---

## 三、`test:repo-observe` 实测矩阵（6/6 PASS）

来源：[repo-observe-log.md](../../phase3/evidence/repo-observe-log.md)（`6 pass, 0 fail, 6 judged`，`exit 0`）。

| 用例 | 关键实测观测 | 结果 |
| --- | --- | --- |
| `repo-observe-e2e-acquisition-to-settled-28` | 真实 `daemon --once`（`--agent-image` + `--acquisition-image`）从 HTTP 拉取含 `sha256` 钉住的 `.tar.gz`（`/good.tar.gz`）→ 脱敏 `sk-...` 为 `[REDACTED_KEY]` 入 `repo_observe_manifest`（`readOnly=true`、`repoWrites=0`、`fullRepoPersisted=false`）→ `agent` 提议经 `pi-ai` 调环回（`max_tokens=128`、`thinking.type=enabled`）→ `SETTLED(28 µ$)` → `tasks=SUCCEEDED`，`object_edges.relation='derived_from'`，原始 `acquisitions` 目录/容器/volume 零残留 | **PASS** |
| `fail-closed-targets-hosts-and-nonloopback-token-caps` | 未登记 `targetId`（`acquisition_target_not_allowed`）、`allowRealRepoFetch=false`（`acquisition_real_fetch_disabled`）、主机外域名（`acquisition_host_not_allowed`）、非环回端点缺 caps（`token_caps_not_configured`）均建行前失败关闭；`daemon --once` 未登记目标使任务落 `FAILED`，`model_requests=0`、0 次容器启动、0 次 HTTP 请求 | **PASS** |
| `model-max-input-bytes-pre-row-refusal` | 消息超 `maxInputBytes=64` 在建行前被 `input_bytes_exceeded` 拒绝，`rowCreated=false`、`model_requests=0`、`budget_reservations=0`、0 次模型调用 | **PASS** |
| `acquisition-rejects-bad-sha256-and-symlink-archive-before-agent` | 错误 `sha256` 钉住与包含逃逸 symlink 的 `.tar.gz` 均在 `acquisition` 阶段失败并使任务落 `FAILED(acquisition_failed)`，`agent` 零启动、`model_requests=0`、模型零命中；`buildSafeRepoExcerpt` 脱敏 `ghp_...`/`Bearer ...` 并拒绝非文件目录读取 | **PASS** |
| `observe-held-settlement-never-completes-succeeded` | `priceCatalog` 为 `null` 时 request/账本停 `HELD`，`tasks` 落 `FAILED(settlement_held_uncompleted)` 并记 `observe_stopped_settlement_held` 审计 1 条，绝不误判 `SUCCEEDED` | **PASS** |
| `async-heartbeat-extends-lease-and-model-real-optin-exit-4` | `processModelRequestAsync` 跨越超初始租约（`1500ms`）的 `2000ms` 延迟调用，凭即时 + 周期 `heartbeat`（`300ms`）续租 `leaseDelta=2820ms` 并 `SETTLED`（`orphan=false`）；未设 `AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1` 执行 `model-real/run.mjs` 在读取 `.env` 前直接 `exit 4` | **PASS** |

---

## 四、镜像纪元 6 与全量终树验收（13 套件 + Hono 预检）

### 4.1 纪元 6 选择性构建与供应链声明

按 `image-digest.md` 纪元机制重建变更的 `agent` 与 `acquisition`（`execution` 经核验 context `sha256:8183df14...` 未漂移且于 `127.0.0.1:5000` 复解析一致后携带沿用），并经 `no-comments` / 结构清理后重验 `requireAppImageDigests()` 返回 `IMAGE_GATE_OK`：

- `agent`（[image-digest.md](../../phase3/reports/image-digest.md)）：tag `127.0.0.1:5000/aegispi/agent:phase3-7cc85d9de4a2`，manifest `sha256:20d51fb34e3a28f2d76aefe179649fced81c7f0d8c29d602bb4a8865bfa3f904`，config `sha256:57b87b449b1a6cc830e2a2c9ae23f66a766fcac78b934593eee9b9cf16cf6061`，context `sha256:764ca000404b0998c1156eb73b53a6dee1449c95781cfd893056533aa7745498`；构建后冒烟 `agent --self-check` → `self-check: green (pi 1.5.2)`（exit 0）。
- `acquisition`：tag `127.0.0.1:5000/aegispi/acquisition:phase3-7cc85d9de4a2`，manifest `sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c`，config `sha256:6d94e022acf79ffb529ca1943d15b73918f8ee00f2301b8e469ef0edef48b02b`，context `sha256:36b473094d9b70befe2d5f14935d4fbd0b0bb82effb1e85c530d4e6836c87b3e`；构建后冒烟 `downloader: 0/1 entries ok; report at /downloads/report.json`。
- `execution`：carried over manifest `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050`。
- **供应链网络声明**：`docker/agent/Dockerfile` `deps` 阶段通过 `npm ci --omit=dev --ignore-scripts` 经公网 npm registry 下载 lockfile 锁定依赖；基础镜像按 index digest 固定、构建产物仅推至本机 `127.0.0.1:5000`。**构建全程不接触 `.env` 或任何模型/外部仓库端点。**

### 4.2 全量 13 套件 + Hono 预检汇总（2026-11-21 纪元 6 终树，Node v22.23.5）

| 套件 | 执行命令 | 实测计数 / 状态 | 退出码 |
| --- | --- | --- | --- |
| `test:repo-observe` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/repo-observe/run.mjs` | `6 pass, 0 fail, 6 judged` | `0` |
| `test:model-proposal` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/model-proposal/run.mjs` | `14 pass, 0 fail, 14 judged` | `0` |
| `test:security:integration` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/security-integration/run.mjs` | `29 pass, 0 fail, 29 judged` | `0` |
| `test:offline-jobs` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/offline-jobs/run.mjs` | `14 pass, 0 fail, 14 judged` | `0` |
| `test:quota-calibration` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/quota-calibration/run.mjs` | `5 pass, 0 fail, 5 judged` | `0` |
| `test:contracts` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/contracts/run-contracts.mjs` | `15 probe(s): all PASS` | `0` |
| Hono 预检配对 | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 baseline / 4.12.24 target / 未安装快照全通过 | `0` |
| `test:durability` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/durability/run.mjs` | `164 pass, 0 fail, 164 judged` | `0` |
| `test:acl` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/acl/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:budget` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase2/budget/run.mjs` | `20 pass, 0 fail, 20 judged` | `0` |
| `test:cancel-approval` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/cancel-approval/run.mjs` | `16 pass, 0 fail, 16 judged` | `0` |
| `test:security:unit` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/security-unit/run.mjs` | `44 pass, 0 fail, 44 judged` | `0` |
| `test:restore` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/restore/run.mjs` | `11 pass, 0 fail, 11 judged` | `0` |
| `test:ingress-telegram` | `D:\AegisPi\tools\node-v22.23.5\node.exe evals/phase3/ingress-telegram/run.mjs` | `7 pass, 0 fail, 7 judged (+ 1 NOTE)` | `0` |

- `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：0 命中（退出码 `1`）。
- 严格禁跑 `test:external-write:real`、`test:ingress-telegram:real` 与带真实凭据运行 `test:model:real`（仅验证未设置 `AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1` 时立即 `exit 4`）。

---

## 五、[defaults.json](../../../apps/daemon/config/defaults.json) 失败关闭字段核对

| 配置路径 | 现值 | 核对结论 |
| --- | --- | --- |
| `budget.taskMicroUsd` / `dayMicroUsd` / `cacheWarming` | `800000` / `5000000` / `"off"` | 符合（$\$0.80 / \$5$ 与关闭缓存保温不变） |
| `leases.heartbeatSeconds` / `leaseSeconds` | `10` / `45` | 符合（异步调用与拉取均已通过定期 `heartbeat` 覆盖默认 `callTimeoutMs=60000`） |
| `model.baseUrl` / `allowedPurposes` / `allowedModelIds` / `allowRealModelCalls` | `null` / `[]` / `[]` / `false` | 符合（失败关闭不变） |
| `model.callUpperMicrousd` / `maxInputBytes` / `maxOutputTokens` | `1000` / `null` / `null` | 符合（非环回调用缺上下限即拒） |
| `model.priceCatalog.*`（四项） | 全部 `null` | 符合（价格未核定即停机于 `HELD`） |
| `acquisition.allowRealRepoFetch` / `enableHostGateway` / `allowedHosts` / `targets` | `false` / `false` / `[]` / `{}` | 符合（未登记目标与非环回源零启动零外发） |
| `policy.allowRealExternalWrites` / `upstream.submitUrl` / `credentials.*` | `false` / `null` / `null` | 符合（外部写与凭据槽保持失败关闭） |

---

## 六、结构性已知约束（沿用 D-78 登记）

1. **`model_requests` 位于 `schema_migrations` 记录之外**：canonical `schema.sql`、`schema-source.json`（`ede73ecaa...`）及全部 27 用户表门禁原样未改；`repo_observe_manifest` 与 `derived_from` 血缘直接复用 canonical `objects` 与 `object_edges`。
2. **Windows 宿主 `proposals` 目录账号级 ACL 约束**：POSIX 分支已补全 `(mode & 0o1777 & 0o007) === 0` 拒绝 other 可写（`[P2-2]`）；Windows 宿主机继续受 NTFS 与 Docker Desktop 文件共享模型约束（单账号独占完全控制，切换常开 Linux 宿主机时另按 Linux uid 999 复核）。

---

## 七、单元 4.2 真实运行前置阻塞：许可 2 首跑检查表（待主人逐项书面确认）

以上全部产物与绿灯验证均严格处于**许可 1 范围**，**不构成**任何真实仓库拉取或真实模型调用授权。进入单元 4.2 真实首次运行前，仍须由主人逐项书面确认以下全部七项：

1. **具体仓库与读取范围**：目标仓库名与 URL、pinned ref / 分支 / commit SHA（或可选归档 `sha256`）、精确 `readPaths` 白名单与 `mode`（只读获取、零写入）。
2. **结果查看与通知目标**：结果仅写入本地 SQLite 证据（`objects` / `audit_log`）与控制台只读诊断，或是否需要发送通知及通知目标通道（默认本地证据/只读诊断；若发通知需另项授权，Telegram 入站 webhook 非前置）。
3. **官方当日现价**：经官方价目页核定的 `priceCatalog` 四价位（`inputPerMTokMicrousd`、`outputPerMTokMicrousd`、`cacheReadPerMTokMicrousd`、`cacheWritePerMTokMicrousd`）。未核定或任一命中正数类别为 `null` 时，调用保持 `HELD` 且 Observe 任务必然拒判成功。
4. **输入 / 输出 token 约束**：`model.maxInputBytes`（信封 `128 KiB` 硬上限之内的业务输入字节上限）与 `model.maxOutputTokens`（输出硬上限）的明确数值。
5. **单次预留上限**：`model.callUpperMicrousd` 数值核定（现默认值占位 `1000` = $\$0.001$）。
6. **模型端点授权**：无路径根地址 `model.baseUrl`（如 `https://api.deepseek.com`）、`model.allowRealModelCalls=true`、白名单与宿主机本机 `.env` 对应凭据槽接线（仍严格仅限单次首跑，闭合后回写失败关闭）。
7. **（若含通知）发送授权**：明确目标、`adapters` 白名单、仅限本次口径、内容模板与发送频率（缺席则仅落本地持久化证据）。
