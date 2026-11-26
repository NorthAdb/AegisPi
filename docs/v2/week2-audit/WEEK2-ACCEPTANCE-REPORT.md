# AegisPi v2 任务书 1 阶段一第 2 周验收报告

- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **第 2 周冻结代码候选提交（全号）**：`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`
- **前置基线（与本次 v2 实测分开登记）**：
  - 第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（交接提交 `47a4dd41e663b61b5daf76918dd2b0a48771954d`）
  - v1 零信任历史基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`，历史成绩 `327/327`、`selfuse 31/31`，不与本次 v2 实测混写）
- **实测范围**：阶段一第 2 周全部代码交付（D6–D10）、`S6`、`V01–V06`，以及在冻结候选提交 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb` 上用锁定 Node 和全新数据目录复跑的 `tests/week1/run-all.ts`（含 `S1–S5`、25 项矩阵、`W1-A`、`W1-B` 复签）。
- **边界声明**：本报告所有 JSON 证据文件已脱敏（无真实凭据、无 `.env` 样本、无本机用户绝对路径）。阶段一零真实模型计费、零真实邮件外发、零真实 GitHub 写入。本地替身结果与真实只读待验证项分别列示。

---

## 1. 锁定环境与依赖

| 项目 | 实测值 |
|---|---|
| 操作系统与架构 | Windows (`win32 10.0.26300`, `x64`, 6 CPUs) |
| 锁定 Node 与内置 SQLite | `D:\AegisPi\tools\node-v22.23.5\node.exe` (`v22.23.5`) / `node:sqlite` (`3.54.1`) |
| npm | `10.9.9` |
| 锁定 Pi SDK（无 `^` / `~`） | `@earendil-works/pi-durable@1.6.0`, `@earendil-works/pi-mcp@1.6.0`, `@earendil-works/pi-ai@1.6.0` |
| 本地 Docker 与镜像 | Docker Client `29.9.2` / Server `29.9.2`；`node:22.23.5-bookworm-slim` (`sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`) |
| 本地浏览器 | `msedge.exe`（Headless CDP，Node 22 原生 WebSocket） |
| 时区与计费日 | `Asia/Hong_Kong` / `2026-11-26` |

---

## 2. 冻结候选提交上的全量实测命令

以下命令均在 `git rev-parse HEAD = ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`、工作区干净、全新临时数据与证据目录下执行：

### 2.1 第 1 周回归与 W1-A / W1-B 复签（§7）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1 = Join-Path $env:TEMP "aegis-w2-w1-$([guid]::NewGuid().ToString())"
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1 'data') --evidence-dir (Join-Path $w1 'evidence')
```

- 退出码：`0`
- `runId`：`week1_0c6fd47a`（执行时间 `2026-11-26T02:34:06.170Z`）
- 脱敏汇总：[evidence/week1/week1-summary.json](evidence/week1/week1-summary.json)

### 2.2 第 2 周全量验收（类型检查、分层守卫、S6、V01–V06）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w2 = Join-Path $env:TEMP "aegis-w2-w2-$([guid]::NewGuid().ToString())"
& $node tests/week2/run-all.ts --data-dir (Join-Path $w2 'data') --evidence-dir (Join-Path $w2 'evidence')
```

- 退出码：`0`
- `runId`：`week2_203150f4`（执行时间 `2026-11-26T02:36:34.805Z`）
- 脱敏汇总：[evidence/week2/week2-summary.json](evidence/week2/week2-summary.json)

---

## 3. 第 2 周逐项验收结果（本地替身 + 实机 Docker + 实机 Edge 浏览器）

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|---|
| 类型与分层守卫 | `week2_203150f4` | `0` | `tsc --noEmit` 通过；仅 `src/runtime/` 导入 `@earendil-works/pi-*`，单向分层零违规 | `typecheck = PASS (0)`；`layerBoundary.violations = []` | PASS | [week2-summary.json](evidence/week2/week2-summary.json) |
| **S6** | `s6_317c0d82` | `0` | 扫描器阳性对照 2/2 检出；覆盖 6 个采样点；5 个独立槽位凭据标记在双库/快照/SSE/日志/prompt/子进程非授权环境/Docker 容器环境中命中均为 0 | 阳性对照 `2/2`；覆盖 `router_generation`、`worker_generation`、`compaction`、`imap_and_mcp_connectors`、`docker_sandbox`、`post_restart`；5 槽位（`slot:model-router`、`slot:model-worker`、`slot:imap-readonly`、`slot:github-mcp-pat`、`slot:web-console`）`totalForbiddenHits = 0`；Docker 环境仅 `["PATH","NODE_VERSION","YARN_VERSION"]`；MCP `inheritEnv: false` | PASS | [s6-evidence.json](evidence/week2/s6-evidence.json) |
| **V01** | `v01v06_667b26b0` | `0` | 从本机视图①发演示句，端到端调记忆/IMAP/GitHub MCP/Worker/Docker 写入 `reports/weekly.md`；断线刷新后仍可核对来源、步骤、文件字节与待核对效果；墓碑与注入笔记不进界面，XSS 纯文本显示 | 浏览器 `msedge.exe` 跑通演示句（`conversationId = 8`）；`firstToolProgressMs = 168`，`completionMs = 12557`；刷新后来源 `["memory","memory","imap","github_mcp","workspace_file"]`、预算步骤 `["router","router","worker","worker","worker","worker","router"]` 均可见；`reports/weekly.md` `expectedSha256 = actualSha256 = 2ffb1928c26898842201a80b8f45f56fc1dbfa9a25ea31874ecd2365feb8286d`；`tombstonedAndInjectedExcludedFromUi = true`；`xssPlainTextVerified = true` | PASS（替身；`firstTokenMs` 见第 5 节） | [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |
| **V02（替身）** | `v02_e07a4c6e` | `0` | 记忆跨主体隔离/墓碑拦截/注入隔离；IMAP 直连与 CONNECT 隧道内层验真且 `EXAMINE + BODY.PEEK` 不改已读；GitHub MCP 校验二进制与工具钉扎且零写调用；读取与向模型披露分离，撤销披露后受限内容发送为 0 | 记忆：`otherPrincipalPrivateHits = 0`，`tombstonedRefHits = 0`，`injectedNoteQuarantined = true`。IMAP：`uid = 102`，`flagsBefore = flagsAfterDirect = flagsAfterConnect = []`，`totalSelectCommands = 0`，`totalExamineCommands = 2`，`totalBodyPeekFetches = 2`，`totalNonPeekFetches = 0`，错证书登录前拦截（`wrongCertServerLogins = 0`），撤销授权拒绝。GitHub MCP：`pinnedArtifactSha256 = 280b8fd47db464961cb7e76bf6d1c372e8e8d4ff286535d97e47f05cd20fa490`，`inheritEnvFalseVerified = true`，`totalToolCallsOnServer = 1`，`totalWriteCallsOnServer = 0`，越权 ref/path、写工具、篡改定义与撤销工具均在 RPC 前拦截。披露门控：授权前发送 `0`，阳性对照假模型命中 `1`，撤销后窗口物理发送增量 `0`、标记命中增量 `0` | PASS（本地替身；真实只读见第 5 节） | [v02-evidence.json](evidence/week2/v02-evidence.json) |
| **V03** | `v03_6ecb96be` | `0` | 无网零凭据容器 + 私有卷，全部写者退出后只读导出；正常导入字节一致；冲突保留两版；各类恶意/越权拒绝时目标不变；安装后回执丢失恢复不二次写盘 | 实机 Docker `29.9.2`：`networkMode = none`，`allWritersExited = true`；正常导入 `reports/weekly.md` `expectedSha256 = actualSha256 = d694d6741eeeec7e3edb0728a42fd7fa2783bd8c4742ae4d261c29e476979466`（`installCount = 1`）；编辑冲突与新建冲突均 `CONFLICT_SAVED` 并保留用户版本（`reports/weekly.conflict-da1cd1ed50.md`、`reports/new-note.conflict-92ff32fa4d.md`）；活跃写者/符号链接/硬链接/超额/ADS/路径穿越/Windows 设备名/撤销写授权全部拒绝且目标不变；回执丢失恢复 `reconciled_after_receipt_loss`，`installCount = 1`，`diskRewrittenOnRetry = false` | PASS | [v03-evidence.json](evidence/week2/v03-evidence.json) |
| **V04** | `v04v05_43885a5b` | `0` | 治理登记 -> 稳定 Pi `requestId` 受理 -> 补宿主回执；窗 2 强杀后重试仅一个逻辑提交；同键异文与错代际返 409；并发双击单提交；无法证明受理时显“受理待核对” | 窗 1 与核对读失败：`PENDING_RECONCILE / 受理待核对`，额外发送 `0`；窗 2 Pi 受理后强杀恢复：`piRequestId = chatreq:1434dc2c39336407a70fdcebeb4c0b0a`，`submissionId = 15`，`conflict409Verified = true`，`wrongEpoch409Verified = true`，`concurrentDoubleClickSingleSubmission = true`；窗 3 丢 HTTP 响应重放仍复用 `submissionId = 15` | PASS | [v04-v05-evidence.json](evidence/week2/v04-v05-evidence.json) |
| **V05** | `v04v05_43885a5b` + `v01v06_667b26b0` | `0` | 快照与 SSE 游标绑定 `(principalId, runtimeEpoch, conversationId)`；快照后/订阅前批准不漏事件；历史淘汰/慢客户端/同代际重启触发 `resync`；注销后无业务帧且返 401；浏览器去重、断号重取、切会话清旧卡 | 协议面：快照游标 `str_2cec90be-896:1`，空窗批准后首条重放 `str_2cec90be-896:2`；`cursor_history_evicted`、`slow_client_queue_overflow`、`stream_instance_changed` 均触发 `resync`；`postLogoutBusinessFrames = 0`；跨主体 `403`。浏览器面：`duplicateFramesIgnored = 1`，`gapTriggeredResyncCount = 1`，`stalePartialOverwrittenBySnapshot = true`，`oldSessionCardsAfterSwitch = 0`，`logoutClosedStreamAndReturned401 = true` | PASS | [v04-v05-evidence.json](evidence/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |
| **V06** | `v01v06_667b26b0` | `0` | 浏览器中改草稿未保存禁批准、保存升修订版、旧标签页旧修订返 409；过期卡禁批准且旧标签返 410、SMTP 发送增量 0；`UNKNOWN` 刷新后持续显“结果待核对”；恶意/缺 Origin 返 403、未登录返 401 | `unsavedEditDisabledApprove = true`；`savedNewRevision = 2`；`staleRevisionOldTabStatus = 409`；`expiredCardDisabledApprove = true`；`expiredOldTabStatus = 410`；`expiredSmtpSentDelta = 0`；`unknownPersistedAfterReloadLabel = "结果待核对"`；`badOriginStatus = 403`；`missingOriginStatus = 403`；`unauthStatus = 401` | PASS | [v01-v06-browser-evidence.json](evidence/week2/v01-v06-browser-evidence.json) |

---

## 4. 第 1 周回归与 W1-A / W1-B 复签结果（同一冻结提交 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`）

### 4.1 汇总表

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|---|
| **W1-A** | `w1a_50aba5c5` | `0` | 3 个足额对照（Router / Worker / Compaction）各物理发送 1 次；6 个差 1 microUSD 额度不足用例各物理发送 0 次且账本/预留不变、视图①见拒绝记录 | 3 个对照全部 `serverCountDelta = 1`；6 个负例全部 `serverCountDelta = 0`、`reservationsCreated = []`、视图①见明确拒绝原因（明细见 4.2） | PASS | [w1-a-evidence.json](evidence/week1/w1-a-evidence.json) |
| **W1-B** | `w1b_9d37a198` | `0` | 批准发信后假 SMTP 扣应答，实机 `Stop-Process -Force` 强杀并两次重启与重复 SDK 唤醒；独立假 SMTP 累计收件 1 封、成功领取 1 次、审批 1 次；原会话刷新后仍显“结果待核对” | `effectId = efx_a188d34a18874f61bc76ba52cd3817b3`；实机强杀 PID `26340`，重启 PID `9180` 与 `48764`；假 SMTP `totalReceived = 1`；`claimCount = 1`；`approvalCount = 1`；`finalEffectState = UNKNOWN`；原会话刷新后 `uiStatusLabel = "结果待核对"`；`secretLeaksCount = 0` | PASS | [w1-b-evidence.json](evidence/week1/w1-b-evidence.json) |
| **S1–S5** | `week1_0c6fd47a` | `0` | Pi SDK 1.6.0 启动冻结、工具身份对齐、Signal 五态、并发预算归属、双库事务与锁释放契约全部通过 | `S1–S5` 5/5 全部 PASS | PASS | [s1-s5-evidence.json](evidence/week1/s1-s5-evidence.json) |
| **第 1 周矩阵** | `week1_0c6fd47a` | `0` | `GUARD-BOUNDARY`、`G1–G3`、`R1`、`R3`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10` 共 25 项全部通过 | `25/25` 全部 PASS | PASS | [matrix-evidence.json](evidence/week1/matrix-evidence.json) |

### 4.2 W1-A 九个用例逐项核对（`runId = w1a_50aba5c5`）

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
| 实机 Docker 无网零凭据沙箱与受管文件导入（`V03`、`S6`、`V01`） | 实机容器 | PASS | Docker `29.9.2` + `node:22.23.5-bookworm-slim` 实测通过 |
| 实机 Edge 浏览器视图①全流程（`V01`、`V05`、`V06`） | 实机浏览器 | PASS | `msedge.exe` CDP 实测通过；本机执行时 `127.0.0.1:4310` 已被其他进程占用，套件按设计优先尝试 `4310` 后回落至本机回环端口 `http://127.0.0.1:60802` |
| 真实 Gmail 只读 IMAP（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 缺少本次人工授权范围与只读验收账号确认；严格遵守零未授权外部接触原则，未读取或使用 `.env` 中任何凭据 |
| 真实 GitHub MCP 只读（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 本机缺少授权的 `GITHUB_PAT` 与 `github-mcp-server.exe` 可执行文件 |
| 真实邮件发送与真实 GitHub 写入 | 阶段一禁区 | 保持关闭 | 阶段一硬边界，代码层与测试层均阻断 |
| V01 `firstTokenMs` 细粒度首 token 指标 | 流式指标子项 | **待验证** | 本地假模型替身按整段 SSE 块返回，未细分逐 token 输出；`firstToolProgressMs = 168ms` 与 `completionMs = 12557ms` 已实测记录 |
