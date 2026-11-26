# AegisPi v2 任务书 1 阶段一第 2 周验收报告（第 2 轮冻结候选）

- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **第 2 周第 2 轮冻结代码候选提交（全号）**：`efba0eda53a21cf5f935846377f8ab03ff42eb69`
- **历史基线与轮次链（分开登记，不混写）**：
  - 第 2 周第 1 轮提审候选（已退回整改，见 [WEEK2-AUDIT-REPORT.md](WEEK2-AUDIT-REPORT.md) §10）：`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`
  - 第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（交接提交 `47a4dd41e663b61b5daf76918dd2b0a48771954d`）
  - v1 零信任历史基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`，历史成绩 `327/327`、`selfuse 31/31`，不与本次 v2 实测混写）
- **实测范围**：阶段一第 2 周全部代码交付（D6–D10）、`S6`、`V01–V06`、第 1 轮独立审计 9 项缺陷（`W2-G1`、`W2-G2`、`W2-S1`–`W2-S7`）与 §10.4 工程项整改，以及在同一冻结候选 `efba0eda53a21cf5f935846377f8ab03ff42eb69` 上用锁定 Node 和全新数据目录复跑的 `tests/week1/run-all.ts`（含 `S1–S5`、25 项矩阵、`W1-A`、`W1-B` 复签）。
- **边界声明**：本报告所有 JSON 证据文件已脱敏（无真实凭据、无 `.env` 样本、无本机用户绝对路径）。阶段一零真实模型计费、零真实邮件外发、零真实 GitHub 写入。本地替身结果与真实只读待验证项分别列示。完整多轮审计传递记录见 [WEEK2-AUDIT-REPORT.md](WEEK2-AUDIT-REPORT.md)。

---

## 1. 锁定环境与依赖

| 项目 | 实测值 |
|---|---|
| 操作系统与架构 | Windows (`win32 10.0.26300`, `x64`, 6 CPUs) |
| 锁定 Node 与内置 SQLite | `D:\AegisPi\tools\node-v22.23.5\node.exe` (`v22.23.5`) / `node:sqlite` (`3.54.1`) |
| npm | `10.9.9` |
| 锁定 Pi SDK（无 `^` / `~`） | `@earendil-works/pi-durable@1.6.0`, `@earendil-works/pi-mcp@1.6.0`, `@earendil-works/pi-ai@1.6.0` |
| `package-lock.json` SHA-256 | `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`（与第 1 周完全一致） |
| 本地 Docker 与不可变镜像 ID | Docker Client `29.9.2` / Server `29.9.2`；`node:22.23.5-bookworm-slim` (`sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`) |
| 本地浏览器 | `msedge.exe`（Headless CDP，Node 22 原生 WebSocket） |
| 时区与计费日 | `Asia/Hong_Kong` / `2026-11-26` |

---

## 2. 冻结候选提交上的全量实测命令

以下命令均在 `git rev-parse HEAD = efba0eda53a21cf5f935846377f8ab03ff42eb69`、工作区干净、全新临时数据与证据目录下执行：

### 2.1 类型检查与第 1 周回归复签（§7）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1 = Join-Path $env:TEMP 'aegis-w2r2-w1-733c4571'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1 'data') --evidence-dir (Join-Path $w1 'evidence')
```

- 退出码：`0`
- `runId`：`week1_61255801`（执行时间 `2026-11-26T03:43:40.515Z`）
- 脱敏汇总：[evidence/week1/week1-summary.json](evidence/week1/week1-summary.json)

### 2.2 第 2 周全量验收（类型检查、分层守卫、S6、V01–V06）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w2 = Join-Path $env:TEMP 'aegis-w2r2-w2-733c4571'
& $node tests/week2/run-all.ts --data-dir (Join-Path $w2 'data') --evidence-dir (Join-Path $w2 'evidence')
```

- 退出码：`0`
- `runId`：`week2_57fd5f62`（执行时间 `2026-11-26T03:46:51.176Z`）
- 脱敏汇总：[evidence/week2/week2-summary.json](evidence/week2/week2-summary.json)

---

## 3. 第 2 周逐项验收结果（本地替身 + 实机 Docker + 实机 Edge 浏览器）

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|---|
| 类型与分层守卫 | `week2_57fd5f62` | `0` | `tsc --noEmit` 通过；仅 `src/runtime/` 导入 `@earendil-works/pi-*`，单向分层零违规 | `typecheck = PASS (0)`；`layerBoundary.violations = []` | PASS | [week2-summary.json](evidence/week2/week2-summary.json) |
| **S6** | `s6_c5a55850` | `0` | 扫描器阳性对照 2/2 检出；运行期分时点实采双库与实时 WAL、URL、宿主日志、快照、SSE、无关子进程与 Docker 容器环境；5 槽位命中均为 0 | 阳性对照 `2/2`；5 个活跃/重启采样点全覆（运行期 `aegis-gov.sqlite-wal` 832272/877592 B、`pi-durable.sqlite-wal` 1017672/1194832 B、`capturedUrlsCount = 9`、`unrelatedChildEnvKeysCount = 83`、`uncollectedSamples = []`）；5 槽位 `totalForbiddenHits = 0`；Docker 仅 `["PATH","NODE_VERSION","YARN_VERSION"]` 且记录双镜像 digest | PASS | [s6-evidence.json](evidence/week2/s6-evidence.json) |
| **V01** | `v01v06_4fc0ba05` | `0` | 由正式入口 `src/index.ts` 启动独立宿主进程完成演示句，未配置时拒绝；端到端核对所选邮件 UID、仓库提交 SHA、两处时间差异、Router/Worker 账本、授权文件字节与刷新后界面 | `formalEntrypoint = "src/index.ts"`、`formalEntrypointUsed = true`、`unconfiguredHostFailClosedVerified = true`；Edge 跑通演示句（`http://127.0.0.1:60796`，`conversationId = 8`），`selectedEmailUid = 102`、`repoCommitSha = a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`、`firstToolProgressMs = 197`、`completionMs = 13821`；`reports/weekly.md` SHA-256 匹配 `31d1598f4b8470cfa54994d6a8e52b0b31f39762dad5b63608bda58837108c1c`；刷新后来源与 7 步预算可见，墓碑与注入排除，XSS 纯文本显示 | PASS（替身；`firstTokenMs` 见第 5 节） | [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |
| **V02（替身）** | `v02_2eb0985a` | `0` | 凭据与目标/参数强绑定；记忆逐节点域授权与墓碑/注入隔离；IMAP 无命中不扩大读取且 `EXAMINE + BODY.PEEK` 不改已读；GitHub MCP 工件+参数钉扎且零写调用；单独撤销读取后全路径模型发送增量 0 | 凭据错配 `imapMismatchLoginsDelta = 0`、`mcpMismatchSpawnsDelta = 0`；记忆 `unauthorizedDomainRefHits = 0`、`otherPrincipalPrivateHits = 0`、`tombstonedRefHits = 0`；IMAP 有命中 `uid = 102` 且不读无关 UID `103`，无命中返 `no_matching_message`（`filterMissBodyFetchDelta = 0`），`totalSelectCommands = 0`、`totalNonPeekFetches = 0`、`wrongCertServerLogins = 0`；MCP `pinnedCommandAndArgsVerified = true`、`totalToolCallsOnServer = 1`、`totalWriteCallsOnServer = 0`；保留披露单独撤销读取后 `durableRetryExtraSendsAfterRevoke = 0`、`routerWorkerCompactionSendsDelta = 0`、`l0AndTaintedMarkerHitsDelta = 0`；撤销披露后发送增量 `0` | PASS（本地替身；真实只读见第 5 节） | [v02-evidence.json](evidence/week2/v02-evidence.json) |
| **V03** | `v03_00298889` | `0` | 执行器与导出器均以不可变镜像 digest 启动；宿主权威基线不接受模型覆盖；父来源撤权拒绝；正常导入字节一致、冲突保留两版；安装后回执前强杀正式宿主由 Step 5c 恢复且累计安装 1 次 | 实机 Docker `29.9.2`：`approvedImageId = executorImageId = exporterImageId = sha256:e9f565d3...`，缺/错摘要启动前拒；正常导入 `reports/weekly.md` SHA-256 匹配 `289419b8...`（`installCount = 1`）；撤销父来源拒返 `source_read_revoked`（`conflictFilesCreatedDelta = 0`）；正式宿主回执前强杀 PID `39896` -> 重启 PID `31736` 由 Step 5c 恢复，`reconciledOutcome = "reconciled_installed"`、`installCount = 1`、`diskRewrittenOnRestart = false`、`workspaceFileSourceReconciledInSnapshot = true`；模型伪造 `baseSha256` 被忽略并保留两版（`reports/spoof-check.conflict-4dc6b87cee.md`） | PASS | [v03-evidence.json](evidence/week2/v03-evidence.json) |
| **V04** | `v04v05_c965b9dc` + `v01v06_4fc0ba05` | `0` | 治理登记 -> 稳定 Pi `requestId` 受理 -> 补宿主回执；窗 2 强杀后重试仅一个逻辑提交；同键异文与错代际返 409；浏览器跨刷新保留原提交键重试 | 窗 1 与核对读失败：`PENDING_RECONCILE / 受理待核对`，额外发送 `0`；窗 2 强杀恢复：`piRequestId = chatreq:4610d37be4cc20f7111d6d2ce95d7588`，`submissionId = 15`，`conflict409Verified = true`，`wrongEpoch409Verified = true`，`concurrentDoubleClickSingleSubmission = true`；浏览器跨刷新保留原键 `ui-chat-1795664791640-017144a9` 并成功复用受理 | PASS | [v04-v05-evidence.json](evidence/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |
| **V05** | `v04v05_c965b9dc` + `v01v06_4fc0ba05` | `0` | 快照与 SSE 游标绑定 `(principalId, runtimeEpoch, conversationId)`；快照后/订阅前批准不漏事件；来源撤权收束旧流且重取快照脱敏；并发旧读串行化；浏览器首帧/partial 缺号与真实断线重连 | 协议面：`snapshotCursor = str_b305be46-42a:1`、空窗批准后首条 `str_b305be46-42a:2`；来源撤权 `source_read_revoked`（旧流 0 业务帧、重取快照脱敏）；`projectionConcurrentStaleReadSerialized = true`；`postLogoutBusinessFrames = 0`；跨主体 `403`。浏览器面：`duplicateDeltaIgnored = 1`、`duplicatePartialIgnored = 1`、`partialGapTriggeredResync = true`、`firstFrameGapTriggeredResync = true`、`realDisconnectReconnectCursorMatched = true`、`oldSessionCardsAfterSwitch = 0`、`logoutClosedStreamAndReturned401 = true` | PASS | [v04-v05-evidence.json](evidence/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |
| **V06** | `v01v06_4fc0ba05` | `0` | 改草稿未保存禁批且无关 SSE 不覆盖本地草稿；打开卡片跨期无需刷新自动禁批、旧标签返 410、SMTP 增量 0；直连真实 W1-B 强杀恢复库刷新仍显“结果待核对”；跨 Origin 403、未登录 401 | `unsavedEditDisabledApprove = true`、`unsavedDraftPreservedAcrossUnrelatedSse = true`、`savedNewRevision = 2`、`staleRevisionOldTabStatus = 409`、`openCardAutoExpiredWithoutReload = true`、`expiredOldTabStatus = 410`、`expiredSmtpSentDelta = 0`；直连真实 `runW1B`（`w1b_a7a10f7b`，强杀 PID `39960`，`effectId = efx_671c924828da4812aa4210f55570079a`，`approvalCount = 1`、`claimCount = 1`、`smtpTotalReceived = 1`）刷新后显 `"结果待核对"`；`badOriginStatus = 403`、`missingOriginStatus = 403`、`unauthStatus = 401` | PASS | [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |

---

## 4. 第 1 周回归与 W1-A / W1-B 复签结果（同一冻结提交 `efba0eda53a21cf5f935846377f8ab03ff42eb69`）

### 4.1 汇总表

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|---|
| **W1-A** | `w1a_b7bbd9e1` | `0` | 3 个足额对照（Router / Worker / Compaction）各物理发送 1 次；6 个差 1 microUSD 额度不足用例各物理发送 0 次且账本/预留不变、视图①见拒绝记录 | 3 个对照全部 `serverCountDelta = 1`；6 个负例全部 `serverCountDelta = 0`、`reservationsCreated = []`、视图①见明确拒绝原因（明细见 4.2） | PASS | [w1-a-evidence.json](evidence/week1/w1-a-evidence.json) |
| **W1-B** | `w1b_f807b927` | `0` | 批准发信后假 SMTP 扣应答，实机 `Stop-Process -Force` 强杀并两次重启与重复 SDK 唤醒；独立假 SMTP 累计收件 1 封、成功领取 1 次、审批 1 次；原会话刷新后仍显“结果待核对” | `effectId = efx_17db48eb65b746bbb311e3036cddb151`；实机强杀 PID `33088`，重启 PID `42368` 与 `27520`；假 SMTP `totalReceived = 1`；`claimCount = 1`；`approvalCount = 1`；`finalEffectState = UNKNOWN`；原会话刷新后 `uiStatusLabel = "结果待核对"`；`secretLeaksCount = 0` | PASS | [w1-b-evidence.json](evidence/week1/w1-b-evidence.json) |
| **S1–S5** | `week1_61255801` | `0` | Pi SDK 1.6.0 启动冻结、工具身份对齐、Signal 五态、并发预算归属、双库事务与锁释放契约全部通过 | `S1–S5` 5/5 全部 PASS | PASS | [s1-s5-evidence.json](evidence/week1/s1-s5-evidence.json) |
| **第 1 周矩阵** | `week1_61255801` | `0` | `GUARD-BOUNDARY`、`G1–G3`、`R1`、`R3`、`R3-LEGACY-UPGRADE`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10` 共 25 项全部通过 | `25/25` 全部 PASS | PASS | [matrix-evidence.json](evidence/week1/matrix-evidence.json) |

### 4.2 W1-A 九个用例逐项核对（`runId = w1a_b7bbd9e1`）

| 用例编号 | 入口 | 类型 | 期望物理发送增量 | 实得 `serverCountDelta` | 账本与拒绝核对 | 结果 |
|---|---|---|---|---|---|---|
| `W1A-CTRL-ROUTER` | `router` | 足额对照 | `1` | `1` | `SETTLED`，`actual_mu = 60` | PASS |
| `W1A-CTRL-WORKER` | `worker` | 足额对照 | `1` | `1` | `SETTLED`，`actual_mu = 60` | PASS |
| `W1A-CTRL-COMPACTION` | `compaction` | 足额对照 | `1` | `1` | `SETTLED`，`actual_mu = 60` | PASS |
| `W1A-NEG-1-ROUTER-TASK` | `router` | 任务额度差 1mu | `0` | `0` | `task_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |
| `W1A-NEG-2-ROUTER-DAY` | `router` | 日额度差 1mu | `0` | `0` | `day_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |
| `W1A-NEG-3-WORKER-TASK` | `worker` | 任务额度差 1mu | `0` | `0` | `task_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |
| `W1A-NEG-4-WORKER-DAY` | `worker` | 日额度差 1mu | `0` | `0` | `day_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |
| `W1A-NEG-5-COMPACTION-TASK` | `compaction` | 任务额度差 1mu | `0` | `0` | `task_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |
| `W1A-NEG-6-COMPACTION-DAY` | `compaction` | 日额度差 1mu | `0` | `0` | `day_budget_exceeded`，`held_mu = 0`，`charged_mu` 不变 | PASS |

---

## 5. 替身结果与真实只读 / 环境相关项分列登记

| 项目 | 类别 | 当前状态 | 说明 |
|---|---|---|---|
| 本地假模型 / 假 IMAP（含直连 TLS 与 HTTP CONNECT 隧道）/ 假 GitHub MCP / 假 SMTP | 本地替身 | PASS（全量通过） | 覆盖 `S6`、`V01–V06`、`W1-A`、`W1-B`、`S1–S5` 与 25 项矩阵 |
| 实机 Docker 无网零凭据沙箱与受管文件导入（`V03`、`S6`、`V01`） | 实机容器 | PASS | Docker `29.9.2` + 不可变镜像 `sha256:e9f565d3...` 实测通过 |
| 实机 Edge 浏览器视图①全流程（`V01`、`V05`、`V06`） | 实机浏览器 | PASS | `msedge.exe` CDP 通过正式 `src/index.ts`（`http://127.0.0.1:60796`）实测通过 |
| 真实 Gmail 只读 IMAP（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 缺少本次人工授权范围与只读验收账号确认；严格遵守零未授权外部接触原则，未读取或使用 `.env` 中任何凭据 |
| 真实 GitHub MCP 只读（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 本机缺少授权的 `GITHUB_PAT` 与 `github-mcp-server.exe` 可执行文件 |
| 真实邮件发送与真实 GitHub 写入 | 阶段一禁区 | 保持关闭 | 阶段一硬边界，代码层与测试层均阻断 |
| V01 `firstTokenMs` 细粒度首 token 指标 | 流式指标子项 | **待验证** | 本地假模型替身按整段 SSE 块返回，未细分逐 token 输出；`firstToolProgressMs = 197ms` 与 `completionMs = 13821ms` 已实测记录 |
