# AegisPi v2 任务书 1 阶段一第 2 周验收报告（第 3 轮冻结候选）

- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **第 2 周第 3 轮冻结代码候选提交（全号）**：`2dffb01fe0711a9b727b9f41006ed55bcac335b7`
- **历史基线与轮次链（分开登记，不混写）**：
  - 第 2 周第 2 轮提审候选（已退回整改，见 [WEEK2-AUDIT-REPORT.md](WEEK2-AUDIT-REPORT.md) §11.3）：`efba0eda53a21cf5f935846377f8ab03ff42eb69`（证据固化于 `evidence/round2/`）
  - 第 2 周第 1 轮提审候选（已退回整改，见 [WEEK2-AUDIT-REPORT.md](WEEK2-AUDIT-REPORT.md) §10）：`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`（原始证据恢复于 `evidence/`）
  - 第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（交接提交 `47a4dd41e663b61b5daf76918dd2b0a48771954d`）
  - v1 零信任历史基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`，历史成绩 `327/327`、`selfuse 31/31`，不与本次 v2 实测混写）
- **实测范围**：阶段一第 2 周全部代码交付（D6–D10）、`S6`、`V01–V06`、第 2 轮审计未关闭及新增全部 7 项（`W2-R2-M1`、`W2-S1`、`W2-S2`、`W2-S3`、`W2-S4`、`W2-S6`、`W2-R2-E1`），以及在同一冻结候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 上用锁定 Node 和全新数据目录复跑的 `tests/week1/run-all.ts`（含 `S1–S5`、25 项矩阵、`W1-A`、`W1-B` 复签）。
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

以下命令均在 `git rev-parse HEAD = 2dffb01fe0711a9b727b9f41006ed55bcac335b7`、工作区干净、全新临时数据与证据目录下执行：

### 2.1 类型检查与第 1 周回归复签（§7）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1 = Join-Path $env:TEMP 'aegis-w2r3-w1-88fcde82'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1 'data') --evidence-dir (Join-Path $w1 'evidence')
```

- 退出码：`0`
- `runId`：`week1_e72893f9`（执行时间 `2026-11-26T04:55:49.413Z`）
- 脱敏汇总：[evidence/round3/week1/week1-summary.json](evidence/round3/week1/week1-summary.json)

### 2.2 第 2 周全量验收（类型检查、分层守卫、S6、V01–V06）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w2 = Join-Path $env:TEMP 'aegis-w2r3-w2-88fcde82'
& $node tests/week2/run-all.ts --data-dir (Join-Path $w2 'data') --evidence-dir (Join-Path $w2 'evidence')
```

- 退出码：`0`
- `runId`：`week2_c948a676`（执行时间 `2026-11-26T05:00:38.475Z`）
- 脱敏汇总：[evidence/round3/week2/week2-summary.json](evidence/round3/week2/week2-summary.json)

---

## 3. 第 2 周逐项验收结果（本地替身 + 实机 Docker + 实机 Edge 浏览器）

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据（Round 3 固定路径） |
|---|---|---|---|---|---|---|
| 类型与分层守卫 | `week2_c948a676` | `0` | `tsc --noEmit` 通过；仅 `src/runtime/` 导入 `@earendil-works/pi-*`，单向分层零违规 | `typecheck = PASS (0)`；`layerBoundary.violations = []` | PASS | [week2-summary.json](evidence/round3/week2/week2-summary.json) |
| **S6** | `s6_e2791b1a` | `0` | 正式入口 `src/index.ts` 启动并擦除启动环境密钥；Docker CLI 仅得最小白名单非密环境；阳性对照 2/2；运行期活跃 WAL/DB/快照/SSE/URL/日志/子进程全覆且 5 槽位命中均为 0 | `formalEntrypointUsed = true`、`hostStartupSecretEnvScrubbed = true`、阳性对照 `2/2`；活跃 WAL（`aegis-gov.sqlite-wal` 416152/461472 B、`pi-durable.sqlite-wal` 1940552/2117712 B）、`dockerCliMinimalEnvKeys`（14 个非密系统键）、`uncollectedSamples = []`、5 槽位 `totalForbiddenHits = 0` | PASS | [s6-evidence.json](evidence/round3/week2/s6-evidence.json) |
| **V01** | `v01v06_555dbbe5` | `0` | 正式入口 `src/index.ts` 完成未配置 fail-closed、带挂起工作重启 `beforeResume` 准备就绪后再放行、以及视图① 端到端演示句与刷新核对 | `formalEntrypointUsed = true`、`unconfiguredHostFailClosedVerified = true`、`formalStartupPendingResumeReadyVerified = true`（`reports/resumed.md` SHA-256 `883ccc83...`）；Edge 演示句（`http://127.0.0.1:54595`，`selectedEmailUid = 102`、`repoCommitSha = a1b2c3d4...`、`firstToolProgressMs = 185`、`completionMs = 15231`、`reports/weekly.md` SHA-256 匹配 `31d1598f...`）刷新后来源与 7 步预算可见 | PASS（替身；`firstTokenMs` 见第 5 节） | [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **V02（替身）** | `v02_209e8629` | `0` | 凭据目标绑定；旧 MCP 库 0 预算拒绝两次开库迁移通过；真实 `run_worker` 委派子会话及全路径单撤读取后发送增量 0；IMAP 无命中不读无关正文且不改已读；GitHub MCP 零写调用 | 错配登录/启动增量 `0`；旧 MCP 库迁移补齐 `["command","args_json"]` 且 `foreignKeyViolations = 0`；真实委派 Worker（`id = "31"`）与 Router/Compaction/durable 重试单撤读取后发送增量 `0`；IMAP 无命中 `no_matching_message`（`filterMissBodyFetchDelta = 0`、`totalSelectCommands = 0`、`totalNonPeekFetches = 0`）；MCP `totalWriteCallsOnServer = 0` | PASS（本地替身；真实只读见第 5 节） | [v02-evidence.json](evidence/round3/week2/v02-evidence.json) |
| **V03** | `v03_c4621b31` | `0` | 不可变镜像 digest 启动；同路径重叠任务独立冻结输入与基准；异步导出后安装前复核授权；同摘要无写盘收口与 `PREPARED` 保守恢复；正式宿主回执前强杀 Step 5c 唯一恢复 | 不可变镜像 `sha256:e9f565d3...`；重叠两任务触发 `CONFLICT_SAVED` 保住 A 版；导出窗口内撤来源/撤写授权拒返且目标与冲突候选 0 增量；同摘要 `noop_unchanged (installCount=0)` 与同摘要 `PREPARED` 启动转 `pending_reconcile`；正式宿主强杀 PID `29672` -> `26240` Step 5c 唯一恢复 `installCount = 1` 且忽略模型伪造基准 | PASS | [v03-evidence.json](evidence/round3/week2/v03-evidence.json) |
| **V04** | `v04v05_a29b8d30` + `v01v06_555dbbe5` | `0` | 治理登记 -> 稳定 Pi `requestId` 受理 -> 补宿主回执；窗 2 强杀唯一提交；跨刷新保留原提交键；跨会话迟到回执不覆盖新会话输入 | 窗 2 `piRequestId = chatreq:36b9942f9589e150e6c94ef8507082f6`、`submissionId = 15`；跨刷新原键重试（`ui-chat-1795669198665-62548f30`）通过；跨会话迟到回执 `lateReceiptCrossSessionPreservedNewInput = true`、`lateReceiptClearedOriginalPendingKeyOnly = true`、`lateReceiptSingleLogicalSubmission = true` | PASS | [v04-v05-evidence.json](evidence/round3/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **V05** | `v04v05_a29b8d30` + `v01v06_555dbbe5` | `0` | 快照/SSE 游标绑定；撤权后旧流 0 业务帧且携旧游标重连不重放历史帧；审批草稿与派生 Worker `role=user` 输入脱敏；新建切换瞬时清旧卡；首帧/partial 缺号与断线重连 | 协议面：`sourceRevokeOldStreamBusinessFrames = 0`、`sourceRevokeResubscribePreRevokeCursorBusinessFrames = 0`、`sourceRevokeApprovalDraftRedacted = true`、`sourceRevokeDelegatedWorkerUserInputRedacted = true`、`projectionConcurrentStaleReadSerialized = true`。浏览器面：`oldSessionCardsAfterSwitch = 0`、首帧/partial 缺号与重连全过 | PASS | [v04-v05-evidence.json](evidence/round3/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **V06** | `v01v06_555dbbe5` | `0` | 未保存草稿防 SSE 覆盖；打开卡片跨期无刷新自动禁批（旧标签 410、SMTP 增量 0）；直连真实 W1-B 强杀恢复库刷新显“结果待核对”；跨 Origin 403、未登录 401 | `unsavedDraftPreservedAcrossUnrelatedSse = true`、`openCardAutoExpiredWithoutReload = true`、`expiredOldTabStatus = 410`、`expiredSmtpSentDelta = 0`；直连真实 `runW1B`（`w1b_55794765`，强杀 PID `50708`，`effectId = efx_ddffdbd441984790bee814ebda146ab1`，审批 1 / 领取 1 / SMTP 1）刷新后显 `"结果待核对"` | PASS | [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |

---

## 4. 第 1 周回归与 W1-A / W1-B 复签结果（同一冻结提交 `2dffb01fe0711a9b727b9f41006ed55bcac335b7`）

### 4.1 汇总表

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|---|
| **W1-A** | `w1a_20c05e1d` | `0` | 3 个足额对照（Router / Worker / Compaction）各物理发送 1 次；6 个差 1 microUSD 额度不足用例各物理发送 0 次且账本/预留不变、视图①见拒绝记录 | 3 个对照全部 `serverCountDelta = 1`；6 个负例全部 `serverCountDelta = 0`、`reservationsCreated = []`、视图①见明确拒绝原因（明细见 4.2） | PASS | [w1-a-evidence.json](evidence/round3/week1/w1-a-evidence.json) |
| **W1-B** | `w1b_7248ceb7` | `0` | 批准发信后假 SMTP 扣应答，实机 `Stop-Process -Force` 强杀并两次重启与重复 SDK 唤醒；独立假 SMTP 累计收件 1 封、成功领取 1 次、审批 1 次；原会话刷新后仍显“结果待核对” | `effectId = efx_2eb8e2f2b0294671bd80cc98eff88e4c`；实机强杀 PID `37916`，重启 PID `50260` 与 `51032`；假 SMTP `totalReceived = 1`；`claimCount = 1`；`approvalCount = 1`；`finalEffectState = UNKNOWN`；原会话刷新后 `uiStatusLabel = "结果待核对"`；`secretLeaksCount = 0` | PASS | [w1-b-evidence.json](evidence/round3/week1/w1-b-evidence.json) |
| **S1–S5** | `week1_e72893f9` | `0` | Pi SDK 1.6.0 启动冻结、工具身份对齐、Signal 五态、并发预算归属、双库事务与锁释放契约全部通过 | `S1–S5` 5/5 全部 PASS | PASS | [s1-s5-evidence.json](evidence/round3/week1/s1-s5-evidence.json) |
| **第 1 周矩阵** | `week1_e72893f9` | `0` | `GUARD-BOUNDARY`、`G1–G3`、`R1`、`R3`、`R3-LEGACY-UPGRADE`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10` 共 25 项全部通过 | `25/25` 全部 PASS | PASS | [matrix-evidence.json](evidence/round3/week1/matrix-evidence.json) |

### 4.2 W1-A 九个用例逐项核对（`runId = w1a_20c05e1d`）

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
| 实机 Edge 浏览器视图①全流程（`V01`、`V05`、`V06`） | 实机浏览器 | PASS | `msedge.exe` CDP 通过正式 `src/index.ts`（`http://127.0.0.1:54595`）实测通过 |
| 真实 Gmail 只读 IMAP（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 缺少本次人工授权范围与只读验收账号确认；严格遵守零未授权外部接触原则，未读取或使用 `.env` 中任何凭据 |
| 真实 GitHub MCP 只读（`V02` 真实只读子项） | 真实只读连接器 | **待验证** | 本机缺少授权的 `GITHUB_PAT` 与 `github-mcp-server.exe` 可执行文件 |
| 真实邮件发送与真实 GitHub 写入 | 阶段一禁区 | 保持关闭 | 阶段一硬边界，代码层与测试层均阻断 |
| V01 `firstTokenMs` 细粒度首 token 指标 | 流式指标子项 | **待验证** | 本地假模型替身按整段 SSE 块返回，未细分逐 token 输出；`firstToolProgressMs = 185ms` 与 `completionMs = 15231ms` 已实测记录 |
