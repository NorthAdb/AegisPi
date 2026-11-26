# AegisPi v2 任务书 1 第 1 周交付审计报告

- **文档版本**：Week 1 审计交接第 4 轮提审（2026-11-26，香港时间；已按第 3 轮审计意见 §12.2 唯一剩余阻断 `R3/G1` 完成闭环）
- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **基线提交（v1 零信任基线）**：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`）
- **当前实施与证据候选 SHA（第 4 轮）**：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（前三轮候选分别为 `66f7ee1`、`681113c`、`1c6fe81`；本报告更新随后续文档提交入库，不改动任何实现或 JSON 证据文件）
- **最新全量实测运行标识**：`runId = week1_ef8d218c`（执行时间 `2026-11-26T01:05:37.650Z`，退出码 `0`）
- **审计范围**：阶段一第 1 周（宿主持久治理、预算双账户预留/结算、不可变审批与唯一提交器、双库崩溃恢复、最小视图①、独立假服务与契约 S1–S5 / W1-A / W1-B / F01–F03 / B01–B07 / E01–E10 / G1–G3 / R1–R5）。第 2 周只读连接器（S6）与完整 Web 纵切（V01–V06）不在本次签收范围内。

---

## 1. 基线、提交记录与变更清单

### 1.1 分支与提交链（均保留于本地 `v2`，未推送远端）

| 顺序 | 提交 SHA | 提交说明 | 作用 |
|---|---|---|---|
| 基线 | `3a88b6895991d328e8e27fd1072a29846e7a9adf` | `docs(v1): organize docs/v1 archive and reconcile baseline status` | `v1-zero-trust-baseline` 分叉起点 |
| 1 | `b452a23c8ae93bf12776e9934ed55c4d69e65b69` | `chore(v2): land ADR-0002 migration rules, locked Pi 1.6.0 deps, and TS config` | 落地 ADR-0002、v2 工程约束、锁定依赖与 TS 配置 |
| 2 | `f7b65893d3ffe9b40936e8c24b859e04dcf80af0` | `feat(v2): implement Week 1 governance kernel, Pi runtime layer, and minimal View 1` | 落地 L1–L4 核心实现与 ADR-0003 |
| 3 | `66f7ee19f5c25c95c757ced4d85497f36fbf770d` | `test(v2): add standalone fakes, S1-S5 probes, W1-A/W1-B, and Week 1 audit pack` | 第 1 轮候选：独立假服务、验证夹具与脱敏 JSON 证据包 |
| 4 | `67a0d96` | `docs(v2): add standalone Week 1 audit handoff report` | 第 1 轮交接审计报告 |
| 5 | `681113ced86a45fee5c7b67b8c932ea32e6d98cd` | `fix(v2): remediate Week 1 audit findings G1-G3, R1-R5, and price bound` | 第 2 轮候选：完成 §10 全部整改、修订 ADR-0003 并重跑全量脱敏证据 |
| 6 | `0a1d82e` | `docs(v2): update Week 1 audit report with Round 1 remediation and Round 2 sign-off` | 第 2 轮审计报告更新 |
| 7 | `1c6fe81a95f0d61814a241e11d953162cd551221` | `fix(v2): close Round 2 audit blockers (Web budget binding, redirect fetch guard, epoch-scoped ACL)` | 第 3 轮候选：关闭 §11.2 全部 3 项阻断、更新 ADR-0003 并重跑 24/24 全量证据 |
| 8 | `a592a27` | `docs(v2): update Week 1 audit report with Round 2 remediation and Round 3 sign-off` | 第 3 轮审计报告更新 |
| 9 | `69ce7b9ac818d5f80551a8cfcc18add84a1607f8` | `fix(v2): close Round 3 blocker (idempotent legacy DB upgrade and strict denial epoch filter)` | **第 4 轮候选**：关闭 §12.2 旧治理库升级与无代际拒绝记录过滤阻断，新增 `R3-LEGACY-UPGRADE` 并重跑 25/25 全量证据 |

### 1.2 迁移与架构决策文档

- [docs/adr/0002-v2-pi-durable-migration.md](../../adr/0002-v2-pi-durable-migration.md)：v1 到 v2 迁移决议、工具链与 exact `1.6.0` 版本锁定、四层单向依赖与单点导入铁律。
- [docs/adr/0003-week1-budget-attribution-and-paired-recovery.md](../../adr/0003-week1-budget-attribution-and-paired-recovery.md)：预算任务归属（含 `budget_task_bindings` 持久化与硬上界拒绝）、全分页同代际轨迹回退识别、换代联动与审批挑战传播规范（已按 §10 修订）。
- [docs/v2/dependency-integrity.json](../dependency-integrity.json)：锁定工具链信息、`package-lock.json` SHA-256 及全部直接依赖完整性摘要。

### 1.3 相对基线 `3a88b68` 的变更文件清单（共 38 项代码/配置/证据文件，不含本报告）

| 分层 / 类别 | 状态 | 文件路径 |
|---|---|---|
| 工程约束与配置 | M / A | `AGENTS.md`, `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json` |
| L1 治理内核（`src/governance/`） | A | `canonical.ts`, `db.ts`, `lock.ts`, `credentials.ts`, `budget.ts`, `approvals.ts`, `effects.ts`, `signal-outbox.ts`, `recovery.ts` |
| L2 能力连接器（`src/capabilities/`） | A | `mail/smtp-client.ts` |
| L3 Pi 运行时层（`src/runtime/`，全仓唯一 `@earendil-works/*` 导入边界） | A | `telemetry.ts`, `models.ts`, `submitter.ts`, `extensions/aegis-policy.ts`, `harness.ts` |
| L4 最小视图①与宿主入口（`src/web/`, `src/`） | A | `src/web/auth.ts`, `src/web/server.ts`, `src/web/view1.ts`, `src/index.ts` |
| 独立假服务进程（`tests/fakes/`） | A | `fake-model-server.ts`, `fake-smtp-server.ts`, `client.ts` |
| 第 1 周验证套件（`tests/week1/`） | A | `run-sdk-contracts.ts`, `run-w1-a.ts`, `run-w1-b.ts`, `run-matrix.ts`, `audit-regressions.ts`, `run-all.ts` |
| ADR 与脱敏证据包（`docs/`） | A | `docs/adr/0002-v2-pi-durable-migration.md`, `docs/adr/0003-week1-budget-attribution-and-paired-recovery.md`, `docs/v2/dependency-integrity.json`, `docs/v2/week1-audit/{week1-summary,s1-s5-evidence,w1-a-evidence,w1-b-evidence,matrix-evidence}.json` |

---

## 2. 锁定运行环境与依赖完整性

### 2.1 实测环境版本

| 项目 | 实测值 |
|---|---|
| 操作系统与架构 | Windows (`win32 x64`) |
| Node 可执行文件与版本 | `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`） |
| Node 内置 SQLite | `3.54.1`（`node:sqlite`） |
| npm 版本 | `10.9.9` |
| 时区与计费日 | `Asia/Hong_Kong` / `2026-11-26` |
| `package-lock.json` SHA-256 | `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`（锁定包总数 `175`） |

### 2.2 直接依赖精确版本与 SHA-512 完整性（无 `^` / `~`）

| 包名 | 锁定版本 | 类型 | Integrity（SHA-512） |
|---|---|---|---|
| `@earendil-works/pi-durable` | `1.6.0` | dependencies | `sha512-nyPjInj/7ZjLEUCDMS7oNGRj1ynftOCVqXilWRBhIuT/xoRHrPy5yFNle/64hvs3F1rukMZ7Ar/4reA7auvUWQ==` |
| `@earendil-works/pi-mcp` | `1.6.0` | dependencies | `sha512-dhqAR6MP8Fp3b8LEcBFOyxMZpGSozUAdzF0Dbl7OvojsjZrQsDV3ZKn85WRbwjHb4WjQUCVBsIZXwoyQxXeunw==` |
| `@earendil-works/pi-ai` | `1.6.0` | dependencies | `sha512-9hL+eygFDEiFp//cydeUfmFsKmEqpmvsNPb10Y1W8+m5K9O+sx1hMStfu6nukrBD5sl6mP4RykCYBBNEgsVLfw==` |
| `hono` | `4.13.22` | dependencies | `sha512-wncKd5/40Pj8grx0RZ2fgNIicFEmVFwIHT5UFLTnphR8I6AQWFf9c2JoM6ZJ9g8y4pMzg3sNlCVNe0m2Yclg0Q==` |
| `@hono/node-server` | `2.1.11` | dependencies | `sha512-KzKz9vl4vvr1vgLHamj+g5uonbrj5NwAdO3yzOS6cd2HjALVeOgTgeZOyAzNxejbkfOOPIcvuf/Tg8l1pEFLog==` |
| `@types/node` | `22.20.7` | dependencies | `sha512-F/Mcc4pD3YwXQCG50hb8BjB5RmrOere6hge7n2XHf0V8tpkZOVEjwYv9Ql7n0MpMn8Bv7+q12P9w6UHsBm0Sfw==` |
| `typescript` | `5.9.3` | devDependencies | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` |
| `vitest` | `5.1.2` | devDependencies | `sha512-VIa2wXV208WraXUbzH+dQUrGcFpPuaiRA8HlhXS8R6/sy9cynw6OMqGj8fmAlH1hot7huTCtWUE14+FdXU3eLw==` |

---

## 3. 审计人独立复跑命令（PowerShell）

以下所有命令均在仓库根目录 `D:\AegisPi\aegis-pi` 下执行，使用锁定 Node 二进制与全新临时数据目录，不依赖任何本地隐藏状态，也不接触真实模型或邮件服务。

### 3.1 一键复跑完整第 1 周验收（推荐）

执行 `tsc --noEmit`、`S1–S5`、`W1-A`（含 `B01`）、`W1-B`（含 `E06` 与重复 SDK 唤醒）与全量矩阵（`GUARD-BOUNDARY`、`G1-AUTH`、`G2-EGRESS`、`G3-NONCE-SSE`、`R1-ATTRIBUTION`、`R3-EPOCH-ACL`、`R3-LEGACY-UPGRADE`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10`，共 25 项），并将新的脱敏证据输出至独立临时目录：

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$dataDir = Join-Path $env:TEMP "aegispi-v2-audit-data-$ts"
$evDir = Join-Path $env:TEMP "aegispi-v2-audit-evidence-$ts"
& $node ./node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -eq 0) {
  & $node tests/week1/run-all.ts --data-dir $dataDir --evidence-dir $evDir
}
```

### 3.2 独立复跑 W1-A（双账户预算零逃逸 + 3 个入口对照组与 6 个负例）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
& $node tests/week1/run-w1-a.ts --data-dir (Join-Path $env:TEMP "aegispi-w1a-$ts") --evidence-dir (Join-Path $env:TEMP "aegispi-w1a-ev-$ts")
```

### 3.3 独立复跑 W1-B（最小视图①批准 + 假 SMTP 扣应答 + `Stop-Process -Force` 强杀 + 重启与重复 SDK 唤醒核对）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
& $node tests/week1/run-w1-b.ts --data-dir (Join-Path $env:TEMP "aegispi-w1b-$ts") --evidence-dir (Join-Path $env:TEMP "aegispi-w1b-ev-$ts")
```

### 3.4 单独复跑 S1–S5 契约探针或全量失败矩阵

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
& $node tests/week1/run-sdk-contracts.ts
& $node tests/week1/run-matrix.ts
```

### 3.5 第 4 轮实测执行记录（候选 SHA `69ce7b9`）

- **执行命令**：
  ```powershell
  $node='D:\AegisPi\tools\node-v22.23.5\node.exe'; & $node ./node_modules/typescript/bin/tsc --noEmit; if ($LASTEXITCODE -eq 0) { & $node tests/week1/run-all.ts --data-dir "$env:TEMP\aegispi-v2-week1-r4-$(Get-Date -Format 'yyyyMMdd-HHmmss')" --evidence-dir "docs/v2/week1-audit" }
  ```
- **运行标识与退出码**：`runId = week1_ef8d218c`，退出码 `0`（`tsc --noEmit` 退出码 `0`；`run-all.ts` 退出码 `0`）
- **脱敏证据目录**：`docs/v2/week1-audit/`
  - [week1-summary.json](./week1-summary.json)
  - [s1-s5-evidence.json](./s1-s5-evidence.json)
  - [w1-a-evidence.json](./w1-a-evidence.json)
  - [w1-b-evidence.json](./w1-b-evidence.json)
  - [matrix-evidence.json](./matrix-evidence.json)

---

## 4. 第 1 周全量验收矩阵（第 4 轮候选 `69ce7b9` 逐项结果）

### 4.1 工程护栏与 SDK 契约（S1–S5 / S6 / G1–G3）

| 用例 ID | 验收项 | 结果 | 关键实测证据 | 证据文件 |
|---|---|---|---|---|
| `TSC` | Node 22 原生可擦除 TS 静态类型检查 | **通过** | `tsc --noEmit` 退出码 `0` | [week1-summary.json](./week1-summary.json) |
| `GUARD-BOUNDARY` | 单点导入与单向分层护栏 | **通过** | `violations = []`；仅 `src/runtime/` 导入 `@earendil-works/*`，`src/governance/` 零上行依赖 | [matrix-evidence.json](./matrix-evidence.json) |
| `G1-AUTH` | 主体宿主绑定、无口令拒启与跨主体治理越权阻断 | **通过** | 缺口令退出码 `1`；伪造 `principalId="bob"` 仍绑定 `alice`；`bob` 调 challenge/decide/reconcile/revoke 全返 `403`，目标治理行零变更 | [matrix-evidence.json](./matrix-evidence.json) |
| `G2-EGRESS` | 阶段一本地回环出站硬边界（含防 HTTP 重定向跳出） | **通过** | 非回环模型/SMTP 在启动（exit `1`）、Vault 与传输层全拒；`redirect: "manual"` 受控 `fetch` 阻断假服务 307 跳向 `api.openai.com`，`redirectLoopbackHops = 1`、`disallowedRedirectFetchCalls = 0`、`smtpConnectCalls = 0` | [matrix-evidence.json](./matrix-evidence.json) |
| `G3-NONCE-SSE` | 审批挑战零暴露于 SSE/快照/日志与专用受权获取入口 | **通过** | 捕获 SSE 帧（1182 B）命中 `0`、快照命中 `0`、审计表命中 `0`；`POST /api/approvals/:id/challenge` 仅授权主体返 `200`（`Cache-Control: no-store`），越权返 `403` | [matrix-evidence.json](./matrix-evidence.json) |
| `S1` | 启动调度闸门（遗留任务不提前调度） | **通过** | `Harness.open` 后 `scheduling = "paused"`，`phaseCallbacksBeforeFence = 0`，`transportCallsBeforeFence = 0`；`signal()` 与 `waitForIdle()` 均切为 `running` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S2` | 工具调用身份与草稿重写/分叉隔离 | **通过** | `beforeTool` 与 `execute` 在顶层（`call_s2_model`）与嵌套调用（`call_s2_model/child1`）上三元组 `(conversationId, taskId, callId)` 完全一致；`{ arguments }` 改写生效；fork 分配独立 `conversationId = 18` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S3` | Signal 全部返回值与观察句柄关闭 | **通过** | 完整命中 `not_found`、`invalid`、`delivered`、`duplicate`、`closed` 5 种 `SignalResult`；`watch` / `watchTaskGraph` 正常关闭，`Harness.close` 优雅退出 | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S4` | 同会话并行压缩与生成通过产品账本精确分账及 `maxRetries = 0` | **通过** | 经真实 `AegisHostRuntime` 在同一 `conversationId = 8` 并行执行 `pi.compaction`（`taskId = 23`）与 `pi.generation`（`taskId = 26`），在途同时在 `acct:task:budget-task-compaction-A` 与 `acct:task:budget-task-gen-B` 各冻结 `100μ`，完成后各自结清 `60μ`；`503` 物理请求 = `1` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S5` | 双库 PRAGMA、Windows 强杀锁释放与轨迹回退检测 | **通过** | 治理库 `WAL + synchronous=2 (FULL) + foreign_keys=1`，Pi 库 `WAL`；`Stop-Process -Id 27736 -Force` 后命名管道独占锁立即释放；缺失已观测 `conversationId = 7` 检出回退 | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S6` | MCP 只读连接器超时、降级与工具面约束 | **待验证** | 属第 2 周交付范围，本轮未实施 | 第 2 周 |

### 4.2 核心签收单与失败矩阵（F01–F03 / B01–B07 / R1 / E01–E10 / V01–V06）

| 用例 ID | 类别 | 验收项摘要 | 结果 | 关键实测指标 | 证据文件 |
|---|---|---|---|---|---|
| `W1-A` / `B01` | 预算 | 足额对照 + 三入口 × 双账户少 1 microUSD 零逃逸 | **通过** | `runId = w1a_6e2e1d19`：3 组对照各 `+1` 且 `SETTLED`；6 组负例（含不含 `budgetTaskId` 的普通 Web 压缩）新增物理请求全为 `0`、冻结残留 `0`、原会话视图①返回准确 `code` 与 `purpose` | [w1-a-evidence.json](./w1-a-evidence.json) |
| `W1-B` / `E06` | 外部效果 | 视图①批准 + 假 SMTP 扣应答 + `Stop-Process -Force` 强杀 + 重启与重复 SDK 唤醒核对 | **通过** | `runId = w1b_ba1e83d4`、`effectId = efx_775b79ec...`：批准 `1` 次、领取 `1` 次、SMTP 累计 `1` 封、强杀（PID `43916`）恢复后 `UNKNOWN`、显式重复 SDK 唤醒返 `closed`、重启与刷新后持续显示「结果待核对」、密钥扫描 `0` 泄漏 | [w1-b-evidence.json](./w1-b-evidence.json) |
| `R1-ATTRIBUTION` | 预算 | 真实 `run_worker` 委派、重启续跑、无绑定失败关闭与 Web 路由禁止请求选账 | **通过** | 委派继承父任务；重启读持久绑定拒发（`0`）；无绑定报 `unknown_budget_owner`（`0`）；Web create/chat/compact 夹带伪造 `budgetTaskId` 均被忽略，固定绑定 `host-task:...`，压缩与聊天拒发各 `0` 请求、`0` 伪造账户 | [matrix-evidence.json](./matrix-evidence.json) |
| `R3-EPOCH-ACL` | 基础/权限 | 换代复用数字会话 ID 的跨代际权限与轨迹隔离（新库） | **通过** | `ep1 -> ep2` 复用会话 ID `"8"`：`alice` 访新代际快照/聊天/压缩全 `403`，访 `?epoch=<ep1>` 返 `200` 且仅见 `ep1` 审计、`messages = []`（零泄露 `bob` 轨迹）；`bob` 访新代际返 `200` 且仅见 `ep2` 数据、访 `ep1` 返 `403` | [matrix-evidence.json](./matrix-evidence.json) |
| `R3-LEGACY-UPGRADE` | 基础/权限 | 旧版治理库幂等原位迁移、可证旧拒绝补齐与无代际拒绝严格排除 | **通过** | 旧库单列主键 `["conversation_id"]` 经正常开库原位迁移为 `["runtime_epoch","conversation_id"]`（保全 2 条历史授权），二次开库零新增审计事件；换代复用 ID `"8"` 后两条授权并存；`alice` `?epoch=<ep1>` 快照与 SSE 仅见可证补齐拒绝并排除归属不明旧记录（保留于内部审计），`bob` 活跃快照与 SSE 均 `0` 历史拒绝泄漏 | [matrix-evidence.json](./matrix-evidence.json) |
| `F01` | 基础 | Windows 单实例所有权互斥 | **通过** | 第二进程报 `InstanceLockBusyError`（exit `1`），`modelDelta = 0`、`smtpDelta = 0`，首进程（PID `48964`）健康存活 | [matrix-evidence.json](./matrix-evidence.json) |
| `F02` | 基础 | 策略钩子或 Models 出口缺失时失败关闭 | **通过** | 缺钩子报 `missing_required_extension:aegis-policy`，缺包装报 `missing_required_models_egress_wrapper`；`modelDelta = 0`、`smtpDelta = 0` | [matrix-evidence.json](./matrix-evidence.json) |
| `F03` | 基础 | 同代际轨迹回退（含跨页 >200 条同 ID 回退）/替换阻断、换代实时联动与 fork 隔离 | **通过** | 检出 `trace_rollback_missing_conversations`、`trace_replaced_or_anchor_mismatch` 及同 ID 跨页回退 `trace_rollback_watermark_regressed`；换代后首笔新预留与首个新提案均写入 `newEpoch = ep_f9ee17eb...`，旧 `READY` 隔离（1 条）、旧 `HELD` 保留（1 条）、fork 认领被拒（`call_identity_mismatch`） | [matrix-evidence.json](./matrix-evidence.json) |
| `B02` | 预算 | 并发 DAY / TASK 余额竞争原子预留 | **通过** | 并发两轮各仅放行 `1` 笔 `HELD`（`round1ModelDelta = 1`、`round2ModelDelta = 1`），无部分冻结 | [matrix-evidence.json](./matrix-evidence.json) |
| `B03` | 预算 | 显式压缩独立预留与归属 | **通过** | 触发真实 `completeSimple`（`compactionModelDelta = 1`），独立 `request_id = mreq_37491242...` 归属 `b03-compact-task` | [matrix-evidence.json](./matrix-evidence.json) |
| `B04` | 预算 | 持久重试前新预留与禁止 provider 隐藏重试 | **通过** | 预算充足重试发 `2` 次（2 个独立 `request_id`）；余额不足重试阻断（仅发 `1` 次） | [matrix-evidence.json](./matrix-evidence.json) |
| `B05` | 预算 | 缺 usage 经宿主运行循环与启动恢复自动收口 `CHARGED_BOUND` 及延迟账单校正 | **通过** | 提前重启保 `HELD`；推进时钟跨午夜后经**宿主运行中定时收口**（res1）与**宿主启动 Step 2 恢复**（res2）自动转原日 `2026-11-25` `CHARGED_BOUND`；经 `host.applyTrustedLateBill` 校正 res1 至 `60`（重复账单 `delta = 0`，新日 `2026-11-26` 为 `null`） | [matrix-evidence.json](./matrix-evidence.json) |
| `B06` | 预算 | 未知上界、非固定启发式价表拒绝、slot 绑定错配与传输前可证失败 | **通过** | `priceSchedule = null`、无固定上界的启发式价表、绑定错配均 `0` 预留；传输前可证失败释放双账户冻结（`RELEASED`, `held = 0`）；四项物理发送总计 = `0` | [matrix-evidence.json](./matrix-evidence.json) |
| `B07` | 预算 | 双账户事务中途异常回滚 | **通过** | 故障注入后预留 `0`、请求 `0`、双账户无残留；恢复后正常请求 `+1` 且 `SETTLED` | [matrix-evidence.json](./matrix-evidence.json) |
| `E01` | 外部效果 | 工具停泊前已批准的早到信号重入观测 | **通过** | 工具重入直接读取治理库已提交批准并执行，outbox 记为 `ACKED`，`claims = 1`，`smtpReceived = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E02` | 外部效果 | T2 事务提交前后真实 Windows `Stop-Process -Force` 强杀 | **通过** | T2 提交前强杀 PID `50824` 回滚为 `PENDING`（`0` SMTP）；T2 提交后且投递前强杀 PID `14940` 后由 PID `43884` 重启投递并精确发送 `1` 封（`claims = 1`） | [matrix-evidence.json](./matrix-evidence.json) |
| `E03` | 外部效果 | 信号投递后未 ACK 强杀恢复、`decisionKey` 幂等与重复信号值核验 | **通过** | 信号返回 `delivered` 后同步冻结并强杀 PID `12704`（杀前 outbox `PENDING`、SMTP `0`），PID `41344` 重启复投命中 `sdk_result="duplicate"` 并校验 `memos` 一致收口 `ACKED (sdk_duplicate_same_value)`，`claims = 1`、`SMTP = 1`；重放 `200`、冲突 `409`；值冲突与无法证明相同的 `duplicate` 均收口 `ISOLATED` 并隔离 `READY`（`0` SMTP） | [matrix-evidence.json](./matrix-evidence.json) |
| `E04` | 外部效果 | 工具在领取前终止导致孤立 `READY` 隔离 | **通过** | 恢复将 `READY -> QUARANTINED`，视图①展示「未提交，待核对」，`claims = 0`，`smtpReceived = 0` | [matrix-evidence.json](./matrix-evidence.json) |
| `E05` | 外部效果 | `READY -> SUBMITTING` 后、SMTP 连接前真实 `Stop-Process -Force` 强杀 | **通过** | 领取后、建连前强杀 PID `40380`（杀前 `SUBMITTING`、SMTP `0`），PID `43596` 重启恢复为 `UNKNOWN`（结果待核对），`claims = 1`，`smtpReceived = 0`（明确区分于 W1-B 远端已收的 `1` 封） | [matrix-evidence.json](./matrix-evidence.json) |
| `E07` | 外部效果 | 批准后编辑草稿（`r1 -> r2`）隔离旧批准并仅投递 `r2` 字节 | **通过** | `r1` `READY` 隔离为 `QUARANTINED`，旧 `r1` 批准请求返 `409`；批准 `r2` 后精确发送 `1` 封且字节完全匹配 `r2` | [matrix-evidence.json](./matrix-evidence.json) |
| `E08` | 外部效果 | 撤销/取消与提交器领取并发串行化（双序验证） | **通过** | 撤销先到：隔离 `READY`、`SMTP = 0`；领取先到：保留已提交效果并诚实完成、`SMTP = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E09` | 外部效果 | 拒绝、过期、跨会话/非审批人越权与双标签页并发批准 | **通过** | 跨会话 `403`、非审批人 `403`、拒绝 `200`（`0` SMTP）、过期 `410`（`0` SMTP）、双标签并发 `[200, 409]` 且 `totalSmtp = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E10` | 外部效果 | 最终参数篡改阻断、并发领取唯一性与 `SUCCEEDED` 持久保持 | **通过** | 篡改参数 `claims = 0` / `SMTP = 0`；并发领取仅 `1` 个胜出；重启后维持 `SUCCEEDED`（`250 2.0.0 OK fake-msg-1`），`totalSmtp = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `V01–V06` | 视图/第2周 | 完整 Web 纵切、只读连接器端到端视图 | **待验证** | 属第 2 周交付范围，本轮未实施 | 第 2 周 |

---

## 5. W1-A 详细实测数据（预算零逃逸验收）

- **运行标识**：`runId = w1a_6e2e1d19`（完整数据见 [w1-a-evidence.json](./w1-a-evidence.json)）
- **合成定价模型**：单次请求上界 `upperMu = 100 microUSD`，实际账单 `actualMu = 60 microUSD`
- **假模型服务最终物理总请求数**：`8`（包含 3 组对照组各 1 次 + 为压缩对照组和 2 组压缩负例在独立会话中生成前置对话历史的 5 次前置正常生成；所有 6 组预算不足触发点本身的新增物理请求均为 `0`）

### 5.1 三组足额对照组与六组负例明细

表中账户格式为 `limit / held / charged`（单位：`microUSD`）。

| 用例 ID | 入口 | 类别 | 服务端请求（前 -> 后 / 增量） | 新增预留记录 | TASK 账户（前 -> 后） | DAY 账户（前 -> 后） | 视图①拒绝记录（`code` / `purpose`） | 结果 |
|---|---|---|---|---|---|---|---|---|
| `W1A-CTRL-ROUTER` | `router` | 足额对照 | `0 -> 1`（`+1`） | `mreq_96cad8...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `null` -> `5000000 / 0 / 60` | 无 | **PASS** |
| `W1A-CTRL-WORKER` | `worker` | 足额对照 | `1 -> 2`（`+1`） | `mreq_ff66b0...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `5000000 / 0 / 60` -> `5000000 / 0 / 120` | 无 | **PASS** |
| `W1A-CTRL-COMPACTION` | `compaction` | 足额对照 | `3 -> 4`（`+1`） | `mreq_02fd28...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `5000000 / 0 / 180` -> `5000000 / 0 / 240` | 无 | **PASS** |
| `W1A-NEG-1-ROUTER-TASK` | `router` | 任务余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `99 / 0 / 0` -> `99 / 0 / 0` | `10240 / 0 / 240` -> `10240 / 0 / 240` | `task_budget_exceeded` / `router`（`seq=13`） | **PASS** |
| `W1A-NEG-2-ROUTER-DAY` | `router` | 日余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `10000 / 0 / 0` -> `10000 / 0 / 0` | `339 / 0 / 240` -> `339 / 0 / 240` | `day_budget_exceeded` / `router`（`seq=16`） | **PASS** |
| `W1A-NEG-3-WORKER-TASK` | `worker` | 任务余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `99 / 0 / 0` -> `99 / 0 / 0` | `10240 / 0 / 240` -> `10240 / 0 / 240` | `task_budget_exceeded` / `worker`（`seq=19`） | **PASS** |
| `W1A-NEG-4-WORKER-DAY` | `worker` | 日余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `10000 / 0 / 0` -> `10000 / 0 / 0` | `339 / 0 / 240` -> `339 / 0 / 240` | `day_budget_exceeded` / `worker`（`seq=21`） | **PASS** |
| `W1A-NEG-5-COMPACTION-TASK` | `compaction` | 任务余额少 1μ | `6 -> 6`（`0`） | `[]`（0 条） | `219 / 0 / 120` -> `219 / 0 / 120` | `10360 / 0 / 360` -> `10360 / 0 / 360` | `task_budget_exceeded` / `compaction`（`seq=29`） | **PASS** |
| `W1A-NEG-6-COMPACTION-DAY` | `compaction` | 日余额少 1μ | `8 -> 8`（`0`） | `[]`（0 条） | `10120 / 0 / 120` -> `10120 / 0 / 120` | `579 / 0 / 480` -> `579 / 0 / 480` | `day_budget_exceeded` / `compaction`（`seq=37`） | **PASS** |

> 计数与账户说明：`W1A-NEG-5` 与 `W1A-NEG-6` 在各自全新会话（`81`、`97`）中以会话自身宿主绑定任务（`charged = 120`）生成 2 轮历史消息后收紧对应账户至可用 `99 microUSD`，随后向 `POST /api/conversations/:id/compact` 发送**不含 `budgetTaskId`** 的普通 Web 压缩请求，触发压缩前后假服务端增量严格为 `0`。

---

## 6. W1-B 详细实测时间线（外部邮件强杀崩溃恢复验收）

### 6.1 核心追踪标识

| 字段 | 实测值 |
|---|---|
| `runId` | `w1b_ba1e83d4` |
| `runtimeEpoch` | `ep_457e25eaea554d26be0bccdb6d7589dd` |
| `conversationId` | `8` |
| `proposalId` | `prp_5663424c7ff9491c9626faf9c9fbe908` |
| `approvalId` | `apr_b614c3f8022f4b31990cfa791375d49a` |
| `effectId` | `efx_775b79ec01594222b1cd97e1dfe04f95` |
| 宿主进程演进 | Host #1 PID `43916`（强杀） -> Host #2 PID `36876`（首次恢复、HTTP 重放与重复 SDK 唤醒） -> Host #3 PID `16676`（二次重启终验） |

### 6.2 端到端时间线（完整 JSON 见 [w1-b-evidence.json](./w1-b-evidence.json)）

| 步骤 | UTC 时间戳 | 事件 | 关键实测状态 |
|---|---|---|---|
| 1 | `2026-11-26T01:04:42.381Z` | `host1_started` | Host #1（PID `43916`，`http://127.0.0.1:62358`）启动并建立代际 `ep_457e25ea...` |
| 2 | `2026-11-26T01:04:42.580Z` | `proposal_pending_in_view1` | 合成邮件草案在最小视图①呈现：`revision = 1`，`actionHash = 3e6218a9...`，`nonceExposedInSnapshot = false`，经专用受权路由获取挑战，UI 标签「待审批」 |
| 3 | `2026-11-26T01:04:42.585Z` | `approval_decided` | 经最小视图①提交批准（`decisionKey = dk_w1b_ba1e83d4_approve`），生成 `efx_775b79ec...`（初始 `READY`） |
| 4 | `2026-11-26T01:04:42.609Z` | `fake_smtp_received_and_held` | 独立假 SMTP 持久登记第 `1` 封收件（`rawSha256 = ebc861a3...`），按 `hold_after_receive` 扣住应答（`replySent = null`） |
| 5 | `2026-11-26T01:04:42.627Z` | `gov_db_verified_submitting_before_kill` | 控制器只读核对 `aegis-gov.sqlite`：`state = SUBMITTING`，`claimed_at = 1795655082596`，`receipt_ref = null`，`claimCount = 1`，`approvalCount = 1` |
| 6 | `2026-11-26T01:04:43.106Z` | `host1_force_killed` | 执行 `Stop-Process -Id 43916 -Force` 强杀 Host #1（进程退出码 `4294967295`） |
| 7 | `2026-11-26T01:04:44.149Z` | `host2_restarted_and_recovered` | 保留两库与假服务重启 Host #2（PID `36876`），同代际恢复将 `efx_775b79ec...` 转入 `UNKNOWN` |
| 8 | `2026-11-26T01:04:44.867Z` | `host2_refreshed_and_verified` | 重放 HTTP 批准（同 key `200`、新 key `409`）+ 显式触发重复 SDK 唤醒（`POST /api/approvals/:id/redeliver` -> `sdkResult = "closed"`，`outbox = ACKED / delivered`，`effect = UNKNOWN`）+ 刷新原会话 `8`：视图①显示「结果待核对」，假 SMTP 累计仍为 `1` |
| 9 | `2026-11-26T01:04:46.217Z` | `host3_final_verification_passed` | 优雅关闭 Host #2 后再启 Host #3（PID `16676`）：最终 `UNKNOWN`、`claimCount = 1`、`approvalCount = 1`、假 SMTP 累计 = `1`、视图①「结果待核对」、密钥扫描泄漏 = `0` |

### 6.3 最终治理记录、重复 SDK 唤醒记录与假 SMTP 持久记录

- **治理库最终效果记录**：
  - `effect_id`: `efx_775b79ec01594222b1cd97e1dfe04f95`
  - `approval_id`: `apr_b614c3f8022f4b31990cfa791375d49a`
  - `state`: `UNKNOWN`
  - `claimed_at`: `1795655082596`
  - `receipt_ref`: `null`
  - `reason`: `recovered_submitting_without_receipt`
  - `claimCount`: `1`，`approvalCount`: `1`
- **重启后重复 SDK 唤醒记录（R4 补证）**：
  - `deliveryKey`: `sig:ep_457e25eaea554d26be0bccdb6d7589dd:prp_5663424c7ff9491c9626faf9c9fbe908:r1`
  - `sdkResult`: `closed`
  - `outbox`: `state = ACKED`, `sdk_result = delivered`, `reason = sdk_delivered`, `attempts = 1`
  - `effect`: `state = UNKNOWN`, `receipt_ref = null`
- **独立假 SMTP 持久日志（`smtp-received.jsonl`）**：
  - `totalReceived`: `1`
  - `seq = 1`, `receivedAt = 2026-11-26T01:04:42.603Z`, `rcptTo = ["<auditor-w1b@local.test>"]`, `rawSha256 = ebc861a3b89686d0b770216ae2518634f08a2463744158c57ffd1b2d85ef39f2`, `modeAtArrival = hold_after_receive`, `replySent = null`
- **最小视图①最终状态**：`conversationId = "8"`, `effectState = "UNKNOWN"`, `uiStatusLabel = "结果待核对"`
- **脱敏与密钥边界检查**：`secretScan = { clean: true, leaks: [] }`

---

## 7. 高风险前提结论与偏离任务书说明

### 7.1 两项高风险前提实测结论

1. **启动期调度闸门（S1）**：实测确认 `@earendil-works/pi-durable@1.6.0` 的 `Harness.open()` 保持 `scheduling === "paused"`，在 `inspect()` / `getTask()` / `conversation()` 期间不会触发任何阶段回调或模型外发；治理恢复、策略钩子校验与 `Models` 出口安装严格先于首次 `signal()` / `resume()` / `waitForIdle()` 完成。
2. **同会话并行压缩与生成的预算归属（S4 / R1）**：实测确认 `TaskScheduler.#phase` 通过宿主注入的 `HarnessOptions.telemetry` 创建携带 `task.id` / `task.name` 的 `pi.durable.phase` span，并将其原样传入 `streamSimple` 与 `completeSimple`。宿主通过 `src/runtime/telemetry.ts` 的进程内私有 `WeakMap` 与持久化 `budget_task_bindings` 表建立不可伪造的归属映射，在产品账本中实现同会话并行分账、跨 `run_worker` 委派继承与跨重启续跑；缺失可信 span 或归属不明一律失败关闭（`unknown_budget_owner`，新增物理请求 `0`，不另开默认账户）。

### 7.2 相对《任务书 1》附录 DDL 的调整（详见修订版 ADR-0003）

| 调整项 | 相对任务书 1 附录的变化 | 影响口径 |
|---|---|---|
| `paired_manifest`（新增表） | 记录 `trace_identity`、全分页单调观测水位、只读 SQLite file change counter 与已知 Pi 任务 ID | 恢复：支持含跨页历史（>200 条）的同代际轨迹回退与替换识别（F03 / S5 / R3） |
| `conversation_scopes`（新增表） | 以复合主键 `(runtime_epoch, conversation_id)` 绑定 `(scope_id, principal_id)`；开库自动对旧版单列主键 `(conversation_id)` 做幂等原位迁移并保全历史行；快照、SSE、聊天、压缩与轨迹读取均按代际隔离，历史代际不读活跃轨迹库 | 权限/恢复：新旧治理库换代复用数字会话 ID 均不沿用旧 ACL，阻断跨代际越权与轨迹泄露（G1 / R3 / E09） |
| `budget_task_bindings`（新增表） | 持久化 `(runtime_epoch, binding_kind, binding_key) -> (conversation_id, owner_task_id, purpose)` | 账务：确保委派与重启后归属持久生效、不另开默认额度账户（R1 / S4） |
| `approval_challenges`（新增表） | 宿主私有表，仅在 `PENDING` 期间保存明文 nonce，仅通过专用受权 `POST /api/approvals/:id/challenge`（`Cache-Control: no-store`）返回，离开 `PENDING` 即删除 | 审批安全：明文 nonce 零暴露于 SSE / 快照 / URL / 日志（G3） |
| `scopes` 新增列 | 增加 `allowed_principals_json`、`allowed_tools_json`、`allowed_targets_json` | 权限：T1 / T2 / T4 / 核对 / 撤销实时 ACL 复核（G1 / E08 / E09 / E10） |
| `proposals` 新增列 | 增加 `tool_name`、`target`、`created_at` | 提交与视图：T4 工具/目标一致性校验与视图①排序 |
| `effects` 新增列 | 增加 `reconciled_by`、`reconciled_at`、`reconcile_evidence` | 审计：记录 `UNKNOWN` 人工核对信息 |
| `budget_accounts` 新增列 | 增加 `frozen` | 账务：对齐超额结清自动冻结约束 |
| `signal_outbox` 新增列 | 增加 `attempts`、`updated_at` | 恢复：记录投递重试次数与更新时间 |
| `audit_events` 新增列 | 增加 `details_json`；开库时对缺失 `runtimeEpoch` 的旧版 `budget_denial` 仅在三方唯一可证时幂等补齐，归属不明的旧事件保留于内部审计并严格排除出快照与 SSE | 视图①/隔离：记录结构化拒绝原因并在原会话呈现，同时杜绝旧无代际记录跨代际泄漏（W1-A / R3） |

---

## 8. 未验证项与已知边界限制

1. **第 2 周待验证项**：`S6`（MCP 只读连接器超时/降级）、`V01–V06`（完整 Web 纵切、完整视图①/②/③与只读连接器联调）均留待第 2 周实施。
2. **非目标与本轮未启用项**：本轮全部模型与邮件外发均走本地独立替身与合成凭据，且在启动与传输层强制回环限制（G2），未启用真实模型计费、真实 SMTP 外发、真实 GitHub 写入、公网监听或容器逃逸测试。
3. **物理断电与内核强杀差异**：本轮采用 Windows `Stop-Process -Force` 进程强杀 + 治理库 `WAL + synchronous=FULL` 验证崩溃持久化，未在真实物理断电或带写缓存掉电磁盘上做硬件级掉电实验。
4. **阶段一硬计费上界约束**：`estimateUpperBoundMu` 在阶段一仅接受可证明的整数每请求上界（`syntheticFixedUpperMu`）；未来第 2/3 周接入真实按 token 计费模型前，需在独立 ADR 中补齐覆盖系统提示词、工具定义与最大输出的保守上界公式与实测回归，当前未证明路径一律失败关闭。

---

## 9. 历史基线参考（v1 历史成绩，与 v2 本次实测严格分离）

> 以下为 `v1-zero-trust-baseline`（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）封存时的历史测试成绩，仅作基线溯源对照，**不计入**本次 v2 第 1 周实测通过率：
>
> - v1 自动化测试套件：`327/327 PASS`
> - v1 本地自用验收（`selfuse`）：`31/31 PASS`
>
> 本次 **v2 第 1 周实测成绩（候选 `69ce7b9`）**独立统计为：`tsc --noEmit` 通过、`S1–S5` 5/5 通过、`W1-A` 9/9 通过、`W1-B` 通过、矩阵 `25/25` 通过（含 `G1–G3`、`R1–R5`、`R3-EPOCH-ACL` 与 `R3-LEGACY-UPGRADE` 全部回归）。

---

## 10. 审计人独立复跑签收栏（第 1 轮 · 候选 `66f7ee1` 历史归档）

| 核对项 | 审计人复跑结果 | 备注 / 复跑 runId |
|---|---|---|
| 核对基线与候选 | 通过 | 基线 3a88b68，实施候选 66f7ee1；复跑时 HEAD 67a0d96 仅增加本交接报告，工作区干净。 |
| 核对依赖锁定 | 通过 | lockfile 的 SHA-256 与 §2 一致；8 项直接依赖的声明、锁文件完整性字段及已安装版本与清单相符。 |
| 干净目录全量复跑 | 退出码 0 | week1_5442f348。类型检查通过，S1–S5 报绿，矩阵 19/19，其中包含 1 项导入边界检查。 |
| 独立复跑 W1-A | 指定金额、预绑定账户的断言通过 | w1a_84965e4c。3 个足额对照各新增 1 次物理请求；6 个负例各新增 0 次，两账户无残留冻结。真实委派及恢复的所属账户见下文。 |
| 独立复跑 W1-B | 已收件强杀、重启计数和 UNKNOWN 通过 | w1b_24626b72。另对全量运行 w1b_c60baee9 的恢复后数据副本做 Edge 实机页面检查，原会话刷新前后均显示同一效果的“结果待核对”。重复 SDK 唤醒仍缺证。 |
| 审阅 ADR-0002 / ADR-0003 | 部分结论需更正 | 可信任务 span 可观察；账务归属、换代与审批 nonce 传播范围存在下列差异。 |
| **第一周签收** | **退回整改，第 2 周暂缓** | Codex 独立验收，2026-11-25。 |

### 可采信的实测证据

全量运行的 W1-B 使用 Windows 强杀测试宿主 PID 17184。杀前独立 SMTP 持久计数 1，治理记录 SUBMITTING、回执为空；再次启动后同一效果 UNKNOWN，累计批准 1、领取 1、收件 1。浏览器核验使用独立数据副本、临时浏览器配置和本机回环地址，核对实际 DOM 内的效果 ID 与中文状态。原夹具的批准动作使用 HTTP API；本轮浏览器补测覆盖恢复后的展示和整页刷新。

本机原始证据位于规划目录 `audit-reruns/week1-1795615968076/`，其中 `evidence/` 为全量结果与 browser-check.json，`independent-a/evidence/`、`independent-b/evidence/` 为独立复跑结果。全量复跑、单跑 A、单跑 B 均使用 §3 的锁定 Node、Windows x64、SQLite 3.54.1、npm 10.9.9。实际入口如下，三个运行的退出码均为 0。

```powershell
$nodeExe = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$auditDir = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week1-1795615968076'
& $nodeExe tests/week1/run-all.ts --data-dir "$auditDir\data" --evidence-dir "$auditDir\evidence" --keep-data true
& $nodeExe tests/week1/run-w1-a.ts --data-dir "$auditDir\independent-a\data" --evidence-dir "$auditDir\independent-a\evidence"
& $nodeExe tests/week1/run-w1-b.ts --data-dir "$auditDir\independent-b\data" --evidence-dir "$auditDir\independent-b\evidence"
```

以上目录保留本次原始记录；复验请选择新的 auditDir。下面各项根据候选源码、测试断言和任务书作出判定。出站与权限问题通过源码审查确认，本轮流量仅使用本地替身。

### 工程约束审查

| 编号 | 候选实现中的问题 | 复验条件 |
|---|---|---|
| G1 · P1 身份与治理授权 | 登录接口采用请求体提供的 principalId 签发会话，入口还内置了固定默认口令。人工核对 UNKNOWN 和撤销 scope 时把主体记入审计，却没有检查其对目标资源的权限。见 [登录](../../../src/web/server.ts#L127)、[核对与撤销](../../../src/web/server.ts#L453)、[入口](../../../src/index.ts#L33)。 | 主体由宿主绑定；正式入口缺少口令时拒绝启用。用各有独立范围的两个合成主体检查，权限外的决定、核对、撤销全部拒绝，目标治理行无变化。 |
| G2 · P1 本地替身边界 | Web 监听限定回环；模型地址和 SMTP 主机仍直接采用配置，模型目的地址又被原样写入允许列表。默认值为本机不能保证阶段一只向替身出站。见 [入口配置](../../../src/index.ts#L29)。 | 在启动或传输之前限制两种目的端。用受控传输观察器证明不允许的配置被拒且出站调用为 0，不接真实服务。 |
| G3 · P2 审批挑战传播 | 待审批快照含明文 nonce，SSE 直接序列化同一对象。与 ADR-0003 和报告 §7.2 声明的传播范围冲突。见 [快照](../../../src/web/server.ts#L309)、[SSE](../../../src/web/server.ts#L507)。 | 给受权决定页单独获取挑战的入口，或对 SSE 作字段投影。用合成标记核对 SSE 帧、日志和 URL 的命中数为 0。 |

### 任务书与验收证据审查

| 编号 | 候选实现或夹具与签收条件的差异 | 复验条件 |
|---|---|---|
| R1 · P1 预算任务归属（T6、S4、W1-A） | Worker 工具把模型参数 budgetTaskId 直接传给宿主；省略时又新建 Worker 预算标识。宿主的归属映射驻留内存，查不到直接绑定时改用会话绑定或临时任务标识。S4 使用探针自身的 Map 标记两次发送，未断言产品账本按正确任务冻结。见 [工具参数](../../../src/runtime/extensions/aegis-policy.ts#L216)、[委派](../../../src/runtime/harness.ts#L364)、[回退](../../../src/runtime/harness.ts#L293)、[S4](../../../tests/week1/run-sdk-contracts.ts#L772)。 | 从实际委派入口、同会话并行生成/压缩、重启续跑分别采集 requestId、原宿主预算任务、两账户和物理计数。所属任务额度耗尽或归属不明时新增发送 0，不能另开默认额度。 |
| R2 · P1 未知费用超时收口（T7、B05） | 到期结算函数在业务宿主中没有调用点。B05 在测试中直接调用它和账单校正函数，常驻及恢复路径不能据此签收。见 [到期处理](../../../src/governance/budget.ts#L577)、[B05](../../../tests/week1/run-matrix.ts#L785)。 | 经宿主启动和运行中的正常结算路径推进时钟，观察原日 HELD → CHARGED_BOUND；受信迟到账单只更正一次，新日账本不动。 |
| R3 · P1 恢复代际（F03、S5） | 换代更新实例字段并立即 resume；Models 和审批扩展仍读取 start 内捕获的旧代际。另，水位只统计每会话前 200 个条目；现有用例不足以支持报告对已观测回退的一般性结论。见 [Models](../../../src/runtime/harness.ts#L315)、[审批](../../../src/runtime/harness.ts#L342)、[换代](../../../src/runtime/harness.ts#L715)、[水位](../../../src/runtime/harness.ts#L852)。 | 换代后执行首个新审批和首笔预留，检查两者代际与当前治理代际一致，旧 READY/待办不再执行；用保留原会话及任务 ID 的较早快照核验配对，含跨页历史。 |
| R4 · P1 重复唤醒（T3、E03） | 收到 SDK 的 duplicate 时，生产投递器固定传 duplicateValueMatches=true。治理层虽然有冲突隔离分支，调用方没有核对已存值。W1-B 重启后重复的是 HTTP 审批决定，未记录重复 SDK 投递结果。见 [投递器](../../../src/runtime/harness.ts#L960)、[W1-B](../../../tests/week1/run-w1-b.ts#L401)。 | 同键同值收口，冲突隔离；无法证明相同就保留待核对。补录重复唤醒的实际 SDK 返回、outbox 和 effect 行，SMTP 累计仍为 1。 |
| R5 · P2 故障注入点（E02、E03、E05） | E02 用抛错回滚和优雅关闭；E03 在唤醒后等收件、等任务空闲再关闭；E05 在存活进程中手工关闭治理库并释放锁。它们验证了部分状态转换，未命中指定的进程死亡窗口。见 [E02](../../../tests/week1/run-matrix.ts#L1131)、[E03](../../../tests/week1/run-matrix.ts#L1283)、[E05](../../../tests/week1/run-matrix.ts#L1463)。 | 使用独立控制器与屏障在各指定窗口强杀测试 PID；保留前后双库观测、原始替身计数与恢复状态，区分“领取后尚未发送”的 0 封和“远端已收”的 1 封。 |

补充修正范围：非固定价表路径将消息序列化长度除以 3 估算输入 token，且计算未覆盖工具定义等请求内容，无法作为 T6 的硬计费上界。本次实测使用固定合成上界 100 microUSD；继续使用这条已验证路径时，应拒绝无法证明上界的其他价表路径。见 [估价函数](../../../src/runtime/models.ts#L133)。

重新提审时提交新候选 SHA、以上各项对应的回归证据，并在同一候选上完整重跑 W1-A、W1-B 与第一周矩阵。

---

## 11. 第 1 轮审计整改回执与第 2 轮复审签收栏（候选 `681113c`）

### 11.1 逐项整改与回归证据映射

| 审查项 | 整改措施与代码落点 | 回归用例与第 2 轮实测证据（`runId = week1_02e38684`） |
|---|---|---|
| **G1 · P1 身份与治理授权** | 1. [src/index.ts](../../../src/index.ts) 移除固定默认口令，无 `AEGISPI_CONSOLE_TOKEN` / `AEGISPI_PRINCIPAL_TOKENS_JSON` 时启动前退出（exit `1`）。<br>2. [src/web/server.ts](../../../src/web/server.ts) 登录完全忽略请求体 `principalId`，按宿主 `consoleTokens` 恒定时间比对推导主体。<br>3. [src/governance/effects.ts](../../../src/governance/effects.ts) 与 [src/governance/approvals.ts](../../../src/governance/approvals.ts) 对 `reconcileUnknownEffect`、`revokeOrCancelScope`、`decideApproval`、`saveDraftRevision`、`fetchAuthorizedApprovalChallenge` 均强制校验目标 scope 与会话主体归属。 | `G1-AUTH` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：无口令退出 `1`；`alice` 口令夹带 `principalId="bob"` 仍绑定 `alice`；`bob` 越权调用 challenge / decide / reconcile / revoke 全返 `403`，目标治理行零变更；`alice` 自核对返 `200`。 |
| **G2 · P1 本地替身边界** | 1. [src/governance/credentials.ts](../../../src/governance/credentials.ts) 新增 `assertStage1LoopbackModelUrl` / `assertStage1LoopbackSmtpHost`，在 Vault 注册与绑定校验层强制仅放行回环主机。<br>2. [src/index.ts](../../../src/index.ts)、[src/runtime/harness.ts](../../../src/runtime/harness.ts)、[src/runtime/models.ts](../../../src/runtime/models.ts)、[src/runtime/submitter.ts](../../../src/runtime/submitter.ts) 与 [src/capabilities/mail/smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts) 启动与建连前逐层拦截。 | `G2-EGRESS` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：非回环模型/SMTP 启动均退出 `1`；受控传输观察器验证 `smtpConnectCallsObserved = 0`、`modelDispatchCallsObserved = 0`。 |
| **G3 · P2 审批挑战传播** | 1. [src/web/server.ts](../../../src/web/server.ts) 从 `buildAuthoritativeSnapshot`（同时服务 `/snapshot` 与 SSE `/events`）彻底移除明文 `nonce`，仅投影 `hasChallenge: boolean`。<br>2. 新增受权专用端点 `POST /api/approvals/:id/challenge`（带 `Origin` 校验与 `Cache-Control: no-store`），同步更新 [src/web/view1.ts](../../../src/web/view1.ts) 与 [docs/adr/0003](../../adr/0003-week1-budget-attribution-and-paired-recovery.md)。 | `G3-NONCE-SSE` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）与 `W1-B` **PASS**：SSE 帧（1102 B）命中 `0`、快照命中 `0`、审计日志命中 `0`；授权主体获取 `200`，越权主体 `403`。 |
| **R1 · P1 预算任务归属** | 1. [src/governance/db.ts](../../../src/governance/db.ts) 与 [src/governance/budget.ts](../../../src/governance/budget.ts) 新增持久化表 `budget_task_bindings` 并在重启时回载。<br>2. [src/runtime/extensions/aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) 移除 `run_worker` 的 `budgetTaskId` 模型参数；[src/runtime/harness.ts](../../../src/runtime/harness.ts) 委派固定继承父宿主预算任务（`purpose="worker"`），`resolveBudgetOwner` 取消临时任务回退，归属不明一律失败关闭（`unknown_budget_owner`）。 | `S4` **PASS**（[s1-s5-evidence.json](./s1-s5-evidence.json)）通过真实产品账本验证同会话并行压缩+生成分别冻结 `100μ` 并结清 `60μ`；`R1-ATTRIBUTION` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）验证真实 `run_worker` 委派忽略夹带参数（缺 1μ 时 Worker 发 `0`、无默认账户）、重启续跑按持久绑定拒发（`0`）、无绑定失败关闭（`0`）。 |
| **R2 · P1 未知费用超时收口** | [src/runtime/harness.ts](../../../src/runtime/harness.ts) 在启动 Step 2 与运行期定时维护循环中接入 `chargeBoundExpiredReservations`，并暴露宿主方法 `runBudgetSettlementSweep()` 与 `applyTrustedLateBill()`。 | `B05` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：未到期重启保 `HELD`；跨午夜分别经宿主运行循环（`mreq_86905f...`）与启动恢复（`mreq_19f853...`）自动收口至原日 `2026-11-25` `CHARGED_BOUND`；经宿主 API 迟到账单更正一次（`60μ`），重复账单 `delta = 0`，新日 `2026-11-26` 为 `null`。 |
| **R3 · P1 恢复代际与全分页水位** | 1. [src/runtime/harness.ts](../../../src/runtime/harness.ts) 引入共享可变 `epochBox`，使 `Models`、`aegis-policy` 与委派在 `rotateEpochAfterMismatch` 后实时读取新代际；[src/governance/approvals.ts](../../../src/governance/approvals.ts) 阻断已退役代际审批与草稿编辑。<br>2. 新增 `scanAllConversationEntries` 游标全分页扫描，消除 200 条截断。 | `F03` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：换代后首笔新预留与首个新提案均写入 `ep_77692d80...`；新增同会话/任务 ID 跨 200 条分页（230 -> 215 条）回退用例，启动前准确阻断并报 `trace_rollback_watermark_regressed`。 |
| **R4 · P1 重复唤醒值核验** | [src/runtime/harness.ts](../../../src/runtime/harness.ts) 收到 SDK `duplicate` 时回读 Pi 任务 `memos` 与规范化载荷比对（`matched` / `conflict` / `unverifiable`），[src/governance/signal-outbox.ts](../../../src/governance/signal-outbox.ts) 仅在 `matched` 时 `ACKED`，冲突与无法证明一致均 `ISOLATED` 并隔离 `READY`；[tests/week1/run-w1-b.ts](../../../tests/week1/run-w1-b.ts) 补录重启后显式重复 SDK 唤醒记录。 | `E03` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：强杀重启命中 `duplicate -> sdk_duplicate_same_value`；活任务值冲突与无法证明均收口 `ISOLATED` + `QUARANTINED`（`0` SMTP）。`W1-B` **PASS**（[w1-b-evidence.json](./w1-b-evidence.json)）：补录 `duplicateSdkWakeup`（`sdkResult="closed"`，`outbox=ACKED`，`effect=UNKNOWN`，`SMTP=1`）。 |
| **R5 · P2 真实强杀窗口注入** | [src/index.ts](../../../src/index.ts) 新增显式测试屏障参数（`--fault-before-t2-commit`、`--fault-after-signal-before-ack`、`--fault-after-claim-before-smtp`），在指定窗口以 `Atomics.wait` 同步冻结，由独立控制器核对双库后执行真实 Windows `Stop-Process -Id <PID> -Force`。 | `E02`（杀 PID `20224` 与 `43608`）、`E03`（杀 PID `23148`，杀前 outbox `PENDING`、SMTP `0`）、`E05`（杀 PID `45784`，杀前 `SUBMITTING`、SMTP `0`，恢复 `UNKNOWN` 且 `SMTP=0` 明确区别于 W1-B 的 `1` 封）全部 **PASS**（[matrix-evidence.json](./matrix-evidence.json)）。 |
| **补充修正 · 硬计费上界** | [src/runtime/models.ts](../../../src/runtime/models.ts) 移除 `JSON.stringify(messages).length / 3` 字符估算回退；无经验证 `syntheticFixedUpperMu` 的价表一律返回 `null`（`unknown_upper_bound`，0 预留、0 发送）。 | `B06` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：`unprovableHeuristicReservations = 0`，`totalPhysicalRequests = 0`。 |

### 11.2 第 2 轮复审签收栏（请审计人在本栏填写第 2 轮结论）

> 建议审计人使用新的 `$auditDir` 在候选 SHA `681113c` 上执行 §3.1–§3.3 命令复跑。

| 核对项 | 第 2 轮审计复跑结果 | 备注 / 复跑 runId |
|---|---|---|
| 核对第 2 轮候选 `681113c` | 通过 | 复跑前工作区干净。HEAD `0a1d82e` 比候选只多本报告更新，lockfile SHA-256 与报告一致。 |
| 干净目录全量复跑 | 通过 | `week1_76d6db19`，退出码 0。类型检查通过，S1–S5 5/5，矩阵 23/23。 |
| 独立复跑 W1-A、W1-B | 夹具通过 | `w1a_6aa2abca` 足额对照各发送 1 次，六组负例各发送 0 次且双账户无残留冻结。`w1b_73e7312e` 强杀后收件 1、领取 1、效果 UNKNOWN，重放 SDK 唤醒返回 closed。另用 Edge 对全量运行的 W1-B 恢复数据副本验证原会话刷新前后均显示“结果待核对”。 |
| G1 / G2 / G3 | 部分关闭 | G1 登录主体绑定及核对、撤销授权的既有回归通过；换代后会话权限仍需修正。G2 直接配置非回环地址的拒绝通过，HTTP 跳转后的目的端仍需约束。G3 在快照、SSE 和日志中的合成 nonce 检查通过。 |
| R1 / R2 / 硬计费上界 | 部分关闭 | Worker 委派、重启归属、实际账本 S4 已有回归。Web 压缩入口仍可指定预算账户。R2 启动与运行期到期结算、迟到及重复账单已通过。无固定合成上界的拒发通过。 |
| R3 / R4 / R5 | 部分关闭 | F03 的新代际写入、跨页回退通过；同数字会话 ID 跨代际仍可能沿用旧 ACL。R4 实测匹配与冲突、无法核验时的处置，W1-B 实测重复唤醒。R5 在指定屏障实际强杀。 |
| 修订版 ADR-0003 与脱敏证据 | 已复核 | 目前可支持夹具中的并发预留、跨页回退与挑战移出 SSE。出站和会话代际仍有下列源码审查发现。 |
| **第 2 轮签收** | **继续整改，第 2 周暂缓** | Codex 独立复审，2026-11-25。 |

### 剩余签收阻断

| 编号 | 源码发现 | 复验条件 |
|---|---|---|
| R1 · P1 Web 压缩的计费归属由请求选择 | 压缩路由直接把请求体的 `budgetTaskId` 交给宿主，宿主优先使用该值绑定压缩任务。账本按任务 ID 找账户，账户缺失时可初始化默认额度。会话创建路由也接受调用者提供的预算任务 ID，缺少对该账务身份的归属核验。当前 W1-A 的压缩夹具主动传入已设限的 ID，无法证明 Web 入口始终使用宿主指定的所属任务。见 [Web 路由](../../../src/web/server.ts#L294)、[宿主归属](../../../src/runtime/harness.ts#L1072)、[账户初始化](../../../src/governance/budget.ts#L232)。 | 普通 Web 命令的计费归属由宿主持有。正常压缩走已授权的任务绑定；遇到任务或日额度不足，假服务新增 0，两个账户不变。S4 的双任务并发夹具仍可由受信宿主内部设置独立绑定。 |
| G2 · P1 回环检查止于首跳 | Models 校验初始 `baseUrl`，随后把请求交给 pi-ai 的 OpenAI Completions 传输，未提供宿主约束的 fetch。锁定版 pi-ai 把可选 fetch 传给 OpenAI 客户端，未指定时使用全局 fetch。本机 Node 22.23.5 的 `new Request('http://127.0.0.1').redirect` 为 `follow`。因此当前检查约束了首个 URL，后续跳转的目的端不在检查范围内。见 [模型出口](../../../src/runtime/models.ts#L388)、[pi-ai 传输](../../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js#L542)。 | 在实际 HTTP 传输关闭自动重定向，或对每次请求的有效目的地重复执行阶段一约束。用合成回环替身和受控传输观察器佐证被拒目的地的调用次数为 0。 |
| R3 / G1 · P1 会话权限未按代际隔离 | `conversation_scopes` 以裸 Pi 会话 ID 作主键，注册用 `INSERT OR IGNORE`。替换轨迹库并换代后，Pi 可重新分配相同数字 ID，旧行会保留旧主体和作用域。Web 快照按裸 ID 查旧 ACL 和治理记录，再向当前 Pi 读取轨迹；聊天与压缩也只校验旧行主体。F03 检查新提案和预留的 epoch，未检查同 ID 的会话授权。见 [表键](../../../src/governance/db.ts#L168)、[注册](../../../src/governance/approvals.ts#L104)、[快照访问](../../../src/web/server.ts#L312)、[当前轨迹读取](../../../src/web/server.ts#L389)。 | 让会话权限与轨迹读写共同使用代际和会话身份。换代时保留旧治理审计；在两个合成主体和重用会话 ID 的恢复夹具中，旧主体只能访问其授权的历史数据，新主体仅获得其新会话。 |

三个阻断均为源码审查结论。独立复跑使用本地替身。

### 独立复跑记录

原始证据在本机规划目录 `audit-reruns/round2-1795619937294/`。全量结果及 Edge 页面核验在 `evidence/`，两条红线单跑在 `independent-a/evidence/` 和 `independent-b/evidence/`。以下命令在实现仓根目录执行，全部退出码为 0。再次执行请使用新数据目录。

```powershell
$nodeExe = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$auditDir = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\round2-1795619937294'
& $nodeExe tests/week1/run-all.ts --data-dir "$auditDir\data" --evidence-dir "$auditDir\evidence" --keep-data true
& $nodeExe tests/week1/run-w1-a.ts --data-dir "$auditDir\independent-a\data" --evidence-dir "$auditDir\independent-a\evidence"
& $nodeExe tests/week1/run-w1-b.ts --data-dir "$auditDir\independent-b\data" --evidence-dir "$auditDir\independent-b\evidence"
```

---

## 12. 第 2 轮审计阻断整改回执与第 3 轮复审签收栏（候选 `1c6fe81`）

### 12.1 第 2 轮三项剩余阻断逐项闭环

| 阻断编号 | 整改措施与代码落点 | 回归用例与第 3 轮实测证据（`runId = week1_0ab39ee5`） |
|---|---|---|
| **R1 · P1 普通 Web 路由计费归属由宿主持有** | 1. [src/web/server.ts](../../../src/web/server.ts) 从 `POST /api/conversations`、`POST /api/conversations/:id/chat` 与 `POST /api/conversations/:id/compact` 彻底剥离请求体 `budgetTaskId`；建会话始终由宿主签发 `host-task:<runtimeEpoch>:conv:<id>` 并持久化，普通聊天与压缩始终复用该宿主绑定。<br>2. [src/runtime/harness.ts](../../../src/runtime/harness.ts) 新增 `getConversationBudgetTaskId`，`submitChatInput` 与未传内部参数的 `triggerCompaction` 缺失绑定直接失败关闭（`unknown_budget_owner`）。<br>3. [tests/week1/run-w1-a.ts](../../../tests/week1/run-w1-a.ts) 改为对会话自身已绑定账户收紧至可用 `99μ` 后发送不含 `budgetTaskId` 的正常 Web 压缩请求。 | `R1-ATTRIBUTION` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：Web create/chat/compact 夹带 `spoof-web-*` 均被忽略，固定使用 `host-task:ep_d31b4604...:conv:8`，`webSpoofCompactPhysicalDelta = 0`、`webSpoofChatPhysicalDelta = 0`、伪造账户数为 `0`；`W1-A` 9/9 **PASS**（`W1A-NEG-5/6` 不带 `budgetTaskId` 均拒发且增量 `0`）；`S4` 内部受信任双任务并发分账继续 **PASS**。 |
| **G2 · P1 HTTP 重定向全跳回环限制** | 1. [src/runtime/models.ts](../../../src/runtime/models.ts) 新增 `createStage1GuardedFetch` 并经 `ModelsSimpleStreamOptions.fetch` 传入 `pi-ai` OpenAI Completions 客户端：每次物理 `fetch` 均重跑 `assertStage1LoopbackModelUrl`，强制 `redirect: "manual"`，并对任意 `3xx` 响应立即抛出 `Stage1EgressBlockedError`（零二次跳转）。<br>2. [tests/fakes/fake-model-server.ts](../../../tests/fakes/fake-model-server.ts) 增加 `redirect` 剧本（返回 `307 Location: https://api.openai.com/v1/chat/completions`）供回环替身端到端验证。 | `G2-EGRESS` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：真实回环假服务返回 `307 -> https://api.openai.com/...` 时，受控 `fetchImpl` 观察器记录 `redirectLoopbackHops = 1`、`disallowedRedirectFetchCalls = 0`，请求失败关闭。 |
| **R3 / G1 · P1 会话权限与轨迹读写按代际隔离** | 1. [src/governance/db.ts](../../../src/governance/db.ts) 与 [src/governance/approvals.ts](../../../src/governance/approvals.ts) 将 `conversation_scopes` 改为复合主键 `PRIMARY KEY(runtime_epoch, conversation_id)`；所有治理查询（`saveDraftRevision`、`decideApproval`、`fetchAuthorizedApprovalChallenge`、`reconcileUnknownEffect`、`resolveScopeRow`）均按 `(runtime_epoch, conversation_id)` 联合校验。<br>2. [src/web/server.ts](../../../src/web/server.ts) 与 [src/governance/budget.ts](../../../src/governance/budget.ts) 将快照、SSE、聊天、压缩、预留、提案与拒绝记录均按代际过滤；`GET /api/conversations/:id/snapshot?epoch=<ep>` 仅在 `targetEpoch === activeEpoch` 时读取当前活跃 Pi 轨迹，历史代际仅返回该主体已授权的历史治理审计且 `messages = []`。 | `R3-EPOCH-ACL` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：`alice` (`ep1`) 与 `bob` (`ep2`) 换代后复用同一数字会话 ID `"8"`；`alice` 访活跃代际快照/聊天/压缩全 `403`，访 `?epoch=<ep1>` 返 `200`（`messages = []`、零泄露 `bob` 轨迹）；`bob` 访活跃代际返 `200`（仅见 `ep2` 数据、`proposals = 0`），访 `ep1` 返 `403`。 |

### 12.2 第 3 轮复审签收栏（请审计人在本栏填写第 3 轮结论）

> 建议审计人使用新的 `$auditDir` 在候选 SHA `1c6fe81` 上执行 §3.1–§3.3 命令复跑。

| 核对项 | 第 3 轮审计复跑结果 | 备注 / 复跑 runId |
|---|---|---|
| 核对第 3 轮候选 `1c6fe81` | 通过 | 工作区复跑前干净。HEAD `a592a27` 比实施候选只多本报告，lockfile SHA-256 与报告一致。 |
| 干净目录全量复跑 | 通过 | `week1_e11d258e`，退出码 0；类型检查通过，S1–S5 5/5，矩阵 24/24。 |
| 独立复跑 W1-A、W1-B | 通过 | `w1a_4508177d` 六组负例各新增 0 次；`w1b_c612e25a` 重启后收件 1、领取 1、效果 UNKNOWN、重复 SDK 唤醒返回 `closed`。用 Edge 对全量 W1-B 的恢复副本复核，同一效果刷新前后均显示“结果待核对”。 |
| R1 Web 计费归属 | 通过 | 新旧请求格式走同一宿主绑定，R1 回归中普通聊天与压缩的假服务增量均为 0。 |
| G2 传输层防重定向 | 通过 | 在实际 Models 传输上使用受控 fetch 观察。回环 307 首跳 1 次，非回环目的端调用 0 次。源码确认传输强制 `redirect: "manual"` 并拒绝 3xx。 |
| R3/G1 跨代际 ACL | 新库通过，旧库升级未通过 | 新库回归复用 Pi 会话 ID 8，两个主体的活跃与历史访问符合预期。用第二轮治理库副本走新候选正常开库入口，旧主键未迁移。 |
| **第 3 轮签收结论** | **继续整改，第 2 周暂缓** | Codex 独立复审，2026-11-25。 |

### 旧治理库升级的剩余阻断

**R3/G1 · P1**。新候选将 `conversation_scopes` 的主键定义改为 `(runtime_epoch, conversation_id)`，但开库只执行 `CREATE TABLE IF NOT EXISTS`。我用 SQLite Backup 从第二轮独立验收数据创建副本，在锁定 Node 上经 `openGovernanceDb` 打开。副本有 8 条会话授权，打开前后主键均只有 `conversation_id`。空库对照则得到正确的复合主键。由此可见，旧库换代后遇到相同数字会话 ID，仍会因旧约束及 `INSERT OR IGNORE` 无法保存新代际授权。第 12.1 节的新库用例覆盖了新结构的行为，旧库副本保留旧结构是本轮实际观察到的升级缺陷。见 [表定义](../../../src/governance/db.ts#L168)、[正常开库](../../../src/governance/db.ts#L222)、[授权注册](../../../src/governance/approvals.ts#L104)。

同一副本另有 6 条预算拒绝记录只有会话 ID、没有 `runtimeEpoch`。当前快照投影会把这类记录纳入任何请求代际；数字会话 ID 被复用时，旧记录可能混入新主体会话的治理快照。应对能证明归属的旧事件补齐代际，无法证明归属的留在内部审计，并且从按代际授权的快照与 SSE 排除。此处以本机旧记录的字段统计与源码筛选为证。见 [预算记录过滤](../../../src/governance/budget.ts#L843)、[快照调用](../../../src/web/server.ts#L424)。

**复验条件**。在上一候选生成的治理库副本上运行新候选的正常启库流程，再开一次验证幂等。核对复合主键及历史授权和治理记录保留。换代复用同一会话 ID 时，新旧代际的两条授权均可并存，各主体快照只显示自己所属代际的记录，归属不明的旧拒绝记录不会进入快照或 SSE。保留既有新库回归并在同一候选重跑第一周验收。

### 独立复跑证据

本机规划目录 `audit-reruns/round3-1795621206347/` 包含 `all/evidence/week1-summary.json`、`w1-a/evidence/w1-a-evidence.json`、`w1-b/evidence/w1-b-evidence.json`、`browser-check.json` 和 `legacy-schema-check.json`。三条夹具命令在实现仓根目录用 Windows 锁定工具链执行，全部退出码为 0。复跑请使用新目录。

```powershell
$nodeExe = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$auditDir = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\round3-1795621206347'
& $nodeExe tests/week1/run-all.ts --data-dir "$auditDir\all\data" --evidence-dir "$auditDir\all\evidence" --keep-data true
& $nodeExe tests/week1/run-w1-a.ts --data-dir "$auditDir\w1-a\data" --evidence-dir "$auditDir\w1-a\evidence"
& $nodeExe tests/week1/run-w1-b.ts --data-dir "$auditDir\w1-b\data" --evidence-dir "$auditDir\w1-b\evidence"
```

---

## 13. 第 3 轮审计阻断整改回执与第 4 轮复审签收栏（候选 `69ce7b9`）

### 13.1 第 3 轮唯一剩余阻断闭环

| 阻断编号 | 整改措施与代码落点 | 回归用例与第 4 轮实测证据（`runId = week1_ef8d218c`） |
|---|---|---|
| **R3 / G1 · P1 旧治理库升级迁移与无代际拒绝记录过滤** | 1. [src/governance/db.ts](../../../src/governance/db.ts) 在正常开库路径 `openGovernanceDb` 执行 `GOV_SCHEMA_SQL` 后调用 `migrateGovernanceSchema(db)`：<br>   - **复合主键原位迁移**：检查 `PRAGMA table_info(conversation_scopes)`；若为旧版单列主键 `(conversation_id)`，在 `BEGIN IMMEDIATE` 事务内重建 `PRIMARY KEY(runtime_epoch, conversation_id)`、完整拷贝全部历史行并写入幂等迁移审计事件（`schema_migration`）。二次开库检测已为复合主键后零写入。<br>   - **旧 `budget_denial` 可证补齐**：仅当 `conversation_scopes` 对该 `conversationId` 仅存在唯一代际、`runtime_epochs` 在 `occurred_at` 活跃时间窗唯一匹配该代际，且 `budget_task_bindings` / `budget_reservations` 无代际冲突时，才在事务内补齐 `runtimeEpoch`（并标记 `runtimeEpochBackfilled: true`）；无法证明归属的旧行原样保留在 `audit_events` 供内部审计。<br>2. [src/governance/budget.ts](../../../src/governance/budget.ts) 收紧 `listBudgetDenialsForConversation` 过滤条件，移除 `parsed["runtimeEpoch"] === undefined` 宽松分支，强制要求 `typeof parsed["runtimeEpoch"] === "string" && parsed["runtimeEpoch"] === runtimeEpoch`，确保归属不明的旧拒绝记录严格排除出按代际授权的快照与 SSE。<br>3. 同步更新 [docs/adr/0003](../../adr/0003-week1-budget-attribution-and-paired-recovery.md) 与 [tests/week1/audit-regressions.ts](../../../tests/week1/audit-regressions.ts)（新增 `R3-LEGACY-UPGRADE` 并接入 `run-matrix.ts`）。 | `R3-LEGACY-UPGRADE` **PASS**（[matrix-evidence.json](./matrix-evidence.json)）：<br>- 构造与第 2 轮一致的旧单列主键库 `pkBeforeMigration = ["conversation_id"]`（含 2 条历史 `conversation_scopes`、1 条可证旧拒绝与 1 条时间窗冲突不可证旧拒绝）。<br>- 正常 `openGovernanceDb` 首次开库后 `pkAfterOpen1 = ["runtime_epoch", "conversation_id"]`、`legacyScopeRowsPreserved = 2`、可证旧拒绝补齐至 `ep1`、不可证旧拒绝保留于内部审计；二次开库 `auditCountAfterOpen1 = auditCountAfterOpen2 = 9`、`migrationEventsAfterOpen1 = migrationEventsAfterOpen2 = 2`（严格幂等）。<br>- 替换轨迹库换代复用数字会话 ID `"8"` 后，`coexistingScopesForReusedId = 2`（`alice/ep1` 与 `bob/ep2` 并存）；`alice` 访 `?epoch=<ep1>` 快照与 SSE（`200`）仅含可证补齐记录且不含不可证旧记录及 `bob` 轨迹；`bob` 活跃快照与 SSE（`200`）均 `0` 历史拒绝泄漏（`bobActiveDenialsCount = 0`）；跨主体越权快照与 SSE 全 `403`。<br>- 既有 `R3-EPOCH-ACL` 继续 **PASS**；同候选 `69ce7b9` 完整重跑 `tsc`、`S1–S5` 5/5、`W1-A` 9/9、`W1-B` 与矩阵 `25/25` 全绿（退出码 `0`）。 |

### 13.2 第 4 轮复审签收栏（请审计人在本栏填写第 4 轮结论）

> 建议审计人使用新的 `$auditDir` 在候选 SHA `69ce7b9` 上执行 §3.1–§3.3 命令复跑，并可用第 2 轮治理库副本经 `openGovernanceDb` 连续开库两次验证迁移幂等与无代际记录过滤。

| 核对项 | 第 4 轮审计复跑结果 | 备注 / 复跑 runId |
|---|---|---|
| 核对第 4 轮候选 `69ce7b9` | 通过 | 复验前工作区干净；HEAD `8a706ac` 相对实施候选只增加报告更新。lockfile SHA-256 与报告一致。 |
| 干净目录全量复跑 | 通过 | `week1_1778444f`，退出码 0；类型检查通过，S1–S5 5/5，矩阵 25/25。 |
| 独立复跑 W1-A、W1-B | 通过 | `w1a_7d1699cf` 的三个足额对照各发送 1 次、六个额度不足用例各发送 0 次。 `w1b_aa6b9a11` 强杀重启后累计收件和成功领取各 1 次，效果为 UNKNOWN，重复 SDK 唤醒返回 `closed`。Edge 在全量运行的恢复数据副本上刷新前后均显示“结果待核对”。 |
| R3/G1 旧治理库迁移与二次开库幂等 | 通过 | 从第 2 轮原治理库带 WAL 的只读连接做 SQLite Backup，再从正常入口开库两次。主键从 `conversation_id` 迁为 `(runtime_epoch, conversation_id)`，8 条授权以及审批、效果、账户和预留通过摘要比对保留，外键检查 0 项异常。迁移事件数两次均为 2，审计行数两次均为 39。 |
| 旧预算拒绝记录与跨代际读隔离 | 通过 | 第 2 轮库的 6 条旧拒绝均有唯一归属，补齐后逐条核对按代际查询。`R3-LEGACY-UPGRADE` 另覆盖归属不明事件保留在内部审计，既不进入快照也不进入 SSE。换代后两份同 ID 授权并存，两主体对另一代际的请求均为 403。 |
| **第 4 轮签收结论** | **第 1 周通过，准予进入第 2 周** | Codex 独立复审，2026-11-26（香港时间）。 |

### 独立复跑证据

本机规划目录 `audit-reruns/round4-1795655498209/` 保存全量及单跑证据、`browser-check.json`、`legacy-schema-check.json` 和实际使用的迁移核验脚本。环境为 Windows x64、Node 22.23.5、SQLite 3.54.1、npm 10.9.9。夹具和旧库核验命令均退出 0。以下命令在实现仓根目录执行，重新运行夹具时请使用新数据目录。

```powershell
$nodeExe = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$auditDir = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\round4-1795655498209'
& $nodeExe tests/week1/run-all.ts --data-dir "$auditDir\all\data" --evidence-dir "$auditDir\all\evidence" --keep-data true
& $nodeExe tests/week1/run-w1-a.ts --data-dir "$auditDir\w1-a\data" --evidence-dir "$auditDir\w1-a\evidence"
& $nodeExe tests/week1/run-w1-b.ts --data-dir "$auditDir\w1-b\data" --evidence-dir "$auditDir\w1-b\evidence"
$legacySource = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\round2-1795619937294\data\w1-a\host-data\aegis-gov.sqlite'
$probe = Get-Content -Raw -Encoding UTF8 "$auditDir\legacy-schema-probe.mjs"
$copyLabel = [guid]::NewGuid().ToString('N')
& $nodeExe --input-type=module -e $probe $legacySource "$auditDir\legacy-$copyLabel.sqlite" "$auditDir\legacy-$copyLabel.json"
```

第 2 周按任务书的 V01–V06 与 S6 单独验收，只读连接器及其数据出站继续按基线的授权要求执行。
