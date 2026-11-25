# AegisPi v2 任务书 1 第 1 周交付审计报告

- **文档版本**：Week 1 审计交接定稿（2026-11-25，香港时间）
- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **基线提交（v1 零信任基线）**：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`）
- **代码与证据提交（实施候选 SHA）**：`66f7ee19f5c25c95c757ced4d85497f36fbf770d`（本报告随后续文档提交入库，不改动任何实现或证据文件）
- **本次实测运行标识**：`runId = week1_6e841c79`（执行时间 `2026-11-25T13:56:22.413Z`，退出码 `0`）
- **审计范围**：阶段一第 1 周（宿主持久治理、预算双账户预留/结算、不可变审批与唯一提交器、双库崩溃恢复、最小视图①、独立假服务与契约 S1–S5 / W1-A / W1-B / F01–F03 / B01–B07 / E01–E10）。第 2 周只读连接器（S6）与完整 Web 纵切（V01–V06）不在本次签收范围内。

---

## 1. 基线、提交记录与变更清单

### 1.1 分支与提交链（均保留于本地 `v2`，未推送远端）

| 顺序 | 提交 SHA | 提交说明 | 作用 |
|---|---|---|---|
| 基线 | `3a88b6895991d328e8e27fd1072a29846e7a9adf` | `docs(v1): organize docs/v1 archive and reconcile baseline status` | `v1-zero-trust-baseline` 分叉起点 |
| 1 | `b452a23c8ae93bf12776e9934ed55c4d69e65b69` | `chore(v2): land ADR-0002 migration rules, locked Pi 1.6.0 deps, and TS config` | 落地 ADR-0002、v2 工程约束、锁定依赖与 TS 配置 |
| 2 | `f7b65893d3ffe9b40936e8c24b859e04dcf80af0` | `feat(v2): implement Week 1 governance kernel, Pi runtime layer, and minimal View 1` | 落地 L1–L4 核心实现与 ADR-0003 |
| 3 | `66f7ee19f5c25c95c757ced4d85497f36fbf770d` | `test(v2): add standalone fakes, S1-S5 probes, W1-A/W1-B, and Week 1 audit pack` | 落地独立假服务、验证夹具与脱敏 JSON 证据包 |

### 1.2 迁移与架构决策文档

- [docs/adr/0002-v2-pi-durable-migration.md](../../adr/0002-v2-pi-durable-migration.md)：v1 到 v2 迁移决议、工具链与 exact `1.6.0` 版本锁定、四层单向依赖与单点导入铁律。
- [docs/adr/0003-week1-budget-attribution-and-paired-recovery.md](../../adr/0003-week1-budget-attribution-and-paired-recovery.md)：预算任务归属（S4）、同代际轨迹回退识别（S5 / F03）及相对任务书 1 附录 DDL 的增量调整说明。
- [docs/v2/dependency-integrity.json](../dependency-integrity.json)：锁定工具链信息、`package-lock.json` SHA-256 及全部直接依赖完整性摘要。

### 1.3 相对基线 `3a88b68` 的变更文件清单（共 37 项代码/配置/证据文件，不含本报告）

| 分层 / 类别 | 状态 | 文件路径 |
|---|---|---|
| 工程约束与配置 | M / A | `AGENTS.md`, `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json` |
| L1 治理内核（`src/governance/`） | A | `canonical.ts`, `db.ts`, `lock.ts`, `credentials.ts`, `budget.ts`, `approvals.ts`, `effects.ts`, `signal-outbox.ts`, `recovery.ts` |
| L2 能力连接器（`src/capabilities/`） | A | `mail/smtp-client.ts` |
| L3 Pi 运行时层（`src/runtime/`，全仓唯一 `@earendil-works/*` 导入边界） | A | `telemetry.ts`, `models.ts`, `submitter.ts`, `extensions/aegis-policy.ts`, `harness.ts` |
| L4 最小视图①与宿主入口（`src/web/`, `src/`） | A | `src/web/auth.ts`, `src/web/server.ts`, `src/web/view1.ts`, `src/index.ts` |
| 独立假服务进程（`tests/fakes/`） | A | `fake-model-server.ts`, `fake-smtp-server.ts`, `client.ts` |
| 第 1 周验证套件（`tests/week1/`） | A | `run-sdk-contracts.ts`, `run-w1-a.ts`, `run-w1-b.ts`, `run-matrix.ts`, `run-all.ts` |
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
| 时区与计费日 | `Asia/Hong_Kong` / `2026-11-25` |
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

执行 `tsc --noEmit`、`S1–S5`、`W1-A`（含 `B01`）、`W1-B`（含 `E06`）与全量矩阵（`GUARD-BOUNDARY`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10`），并将新的脱敏证据输出至独立临时目录：

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

### 3.3 独立复跑 W1-B（最小视图①批准 + 假 SMTP 扣应答 + `Stop-Process -Force` 强杀 + 重启核对）

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

### 3.5 本次实测执行记录

- **执行命令**：
  ```powershell
  $node='D:\AegisPi\tools\node-v22.23.5\node.exe'; & $node ./node_modules/typescript/bin/tsc --noEmit; if ($LASTEXITCODE -eq 0) { & $node tests/week1/run-all.ts --data-dir "$env:TEMP\aegispi-v2-week1-clean-$(Get-Date -Format 'yyyyMMdd-HHmmss')" --evidence-dir "docs/v2/week1-audit" }
  ```
- **退出码**：`0`（`tsc --noEmit` 退出码 `0`；`run-all.ts` 退出码 `0`）
- **脱敏证据目录**：`docs/v2/week1-audit/`
  - [week1-summary.json](./week1-summary.json)
  - [s1-s5-evidence.json](./s1-s5-evidence.json)
  - [w1-a-evidence.json](./w1-a-evidence.json)
  - [w1-b-evidence.json](./w1-b-evidence.json)
  - [matrix-evidence.json](./matrix-evidence.json)

---

## 4. 第 1 周全量验收矩阵（逐项结果）

### 4.1 工程护栏与 SDK 契约（S1–S5 / S6）

| 用例 ID | 验收项 | 结果 | 关键实测证据 | 证据文件 |
|---|---|---|---|---|
| `TSC` | Node 22 原生可擦除 TS 静态类型检查 | **通过** | `tsc --noEmit` 退出码 `0` | [week1-summary.json](./week1-summary.json) |
| `GUARD-BOUNDARY` | 单点导入与单向分层护栏 | **通过** | `violations = []`；仅 `src/runtime/` 导入 `@earendil-works/*`，`src/governance/` 零上行依赖 | [matrix-evidence.json](./matrix-evidence.json) |
| `S1` | 启动调度闸门（遗留任务不提前调度） | **通过** | `Harness.open` 后 `scheduling = "paused"`，`phaseCallbacksBeforeFence = 0`，`transportCallsBeforeFence = 0`；`signal()` 与 `waitForIdle()` 均切为 `running` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S2` | 工具调用身份与草稿重写/分叉隔离 | **通过** | `beforeTool` 与 `execute` 在顶层（`call_s2_model`）与嵌套调用（`call_s2_model/child1`）上三元组 `(conversationId, taskId, callId)` 完全一致；`{ arguments }` 改写生效；fork 分配独立 `conversationId = 18` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S3` | Signal 全部返回值与观察句柄关闭 | **通过** | 完整命中 `not_found`、`invalid`、`delivered`、`duplicate`、`closed` 5 种 `SignalResult`；`watch` / `watchTaskGraph` 正常关闭，`Harness.close` 优雅退出 | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S4` | 同会话并行压缩与生成归属及 `maxRetries = 0` | **通过** | 同一 `conversationId = 1` 下并行 `completeSimple`（`pi.compaction`, `taskId = 15`）与 `streamSimple`（`pi.generation`, `taskId = 18`）借 `HostPhaseTelemetry` `WeakMap` 精确分账至各自预算任务；`503` 时物理请求 = `1` | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S5` | 双库 PRAGMA、Windows 强杀锁释放与轨迹回退检测 | **通过** | 治理库 `WAL + synchronous=2 (FULL) + foreign_keys=1`，Pi 库 `WAL`；`Stop-Process -Id 50968 -Force` 后命名管道独占锁立即释放；缺失已观测 `conversationId = 7` 检出回退 | [s1-s5-evidence.json](./s1-s5-evidence.json) |
| `S6` | MCP 只读连接器超时、降级与工具面约束 | **待验证** | 属第 2 周交付范围，本轮未实施 | 第 2 周 |

### 4.2 核心签收单与失败矩阵（F01–F03 / B01–B07 / E01–E10 / V01–V06）

| 用例 ID | 类别 | 验收项摘要 | 结果 | 关键实测指标 | 证据文件 |
|---|---|---|---|---|---|
| `W1-A` / `B01` | 预算 | 足额对照 + 三入口 × 双账户少 1 microUSD 零逃逸 | **通过** | 3 组对照各 `+1` 物理请求且 `SETTLED`；6 组负例新增物理请求全为 `0`、冻结残留 `0`、原会话视图①返回准确 `code` 与 `purpose` | [w1-a-evidence.json](./w1-a-evidence.json) |
| `W1-B` / `E06` | 外部效果 | 视图①批准 + 假 SMTP 扣应答 + `Stop-Process -Force` 强杀 + 重启核对 | **通过** | 同一 `effectId = efx_738115729bd94cb097d01b423c8ef0fe`：批准 `1` 次、领取 `1` 次、SMTP 累计 `1` 封、强杀恢复后 `UNKNOWN`、重启与刷新后持续显示「结果待核对」、密钥扫描 `0` 泄漏 | [w1-b-evidence.json](./w1-b-evidence.json) |
| `F01` | 基础 | Windows 单实例所有权互斥 | **通过** | 第二进程报 `InstanceLockBusyError`（exit `1`），`modelDelta = 0`、`smtpDelta = 0`，首进程（PID `29140`）健康存活 | [matrix-evidence.json](./matrix-evidence.json) |
| `F02` | 基础 | 策略钩子或 Models 出口缺失时失败关闭 | **通过** | 缺钩子报 `missing_required_extension:aegis-policy`，缺包装报 `missing_required_models_egress_wrapper`；`modelDelta = 0`、`smtpDelta = 0` | [matrix-evidence.json](./matrix-evidence.json) |
| `F03` | 基础 | 同代际轨迹回退/替换阻断、代际轮换与 fork 隔离 | **通过** | 调度前检出 `trace_rollback_missing_conversations` 与 `trace_replaced_or_anchor_mismatch`；轮换后隔离旧 `READY`（1 条）、保留旧 `HELD`（1 条）、阻断 fork 认领（`call_identity_mismatch`）；恢复期间外发 `0` | [matrix-evidence.json](./matrix-evidence.json) |
| `B02` | 预算 | 并发 DAY / TASK 余额竞争原子预留 | **通过** | 并发两轮各仅放行 `1` 笔 `HELD`（`round1ModelDelta = 1`、`round2ModelDelta = 1`），无部分冻结 | [matrix-evidence.json](./matrix-evidence.json) |
| `B03` | 预算 | 显式压缩独立预留与归属 | **通过** | 触发真实 `completeSimple`（`compactionModelDelta = 1`），独立 `request_id = mreq_25f53bdc6e454f298362857fe31c2d35` 归属 `b03-compact-task` | [matrix-evidence.json](./matrix-evidence.json) |
| `B04` | 预算 | 持久重试前新预留与禁止 provider 隐藏重试 | **通过** | 预算充足重试发 `2` 次（2 个独立 `request_id`）；余额不足重试阻断（仅发 `1` 次） | [matrix-evidence.json](./matrix-evidence.json) |
| `B05` | 预算 | 缺 usage 跨重启保 `HELD`、跨日按原日 `CHARGED_BOUND` 与延迟账单校正 | **通过** | `2026-11-25` 按上界 `100` 扣减后经延迟账单校正为 `60`，重复账单 `delta = 0`，次日 `2026-11-26` 无账户变动（`day2Final = null`），物理发送 = `1` | [matrix-evidence.json](./matrix-evidence.json) |
| `B06` | 预算 | 未知上界、slot 绑定错配与传输前可证失败 | **通过** | 未知上界与绑定错配 `0` 预留；传输前可证失败释放双账户冻结（`RELEASED`, `held = 0`）；三项物理发送总计 = `0` | [matrix-evidence.json](./matrix-evidence.json) |
| `B07` | 预算 | 双账户事务中途异常回滚 | **通过** | 故障注入后预留 `0`、请求 `0`、双账户无残留；恢复后正常请求 `+1` 且 `SETTLED` | [matrix-evidence.json](./matrix-evidence.json) |
| `E01` | 外部效果 | 工具停泊前已批准的早到信号重入观测 | **通过** | 工具重入直接读取治理库已提交批准并执行，outbox 记为 `ACKED`，`claims = 1`，`smtpReceived = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E02` | 外部效果 | T2 事务提交前后崩溃语义 | **通过** | 提交前崩溃干净回滚为 `PENDING`（`0` SMTP）；提交后崩溃经重启投递 outbox 精确发送 `1` 封 | [matrix-evidence.json](./matrix-evidence.json) |
| `E03` | 外部效果 | Signal 已投递未 ACK 重启对齐与 `decisionKey` 幂等/冲突 | **通过** | 重启后 outbox 核对为 `ACKED (reentry_observed)`，`claims = 1`，`smtpTotalReceived = 1`；同 `decisionKey` 重放返回 `200`，异负载返回 `409` | [matrix-evidence.json](./matrix-evidence.json) |
| `E04` | 外部效果 | 工具在领取前终止导致孤立 `READY` 隔离 | **通过** | 恢复将 `READY -> QUARANTINED`，视图①展示「未提交，待核对」，`claims = 0`，`smtpReceived = 0` | [matrix-evidence.json](./matrix-evidence.json) |
| `E05` | 外部效果 | `READY -> SUBMITTING` 后、SMTP 连接前崩溃恢复 | **通过** | 恢复转 `UNKNOWN`（结果待核对），`claims = 1`，`smtpReceived = 0`，不自动重发 | [matrix-evidence.json](./matrix-evidence.json) |
| `E07` | 外部效果 | 批准后编辑草稿（`r1 -> r2`）隔离旧批准并仅投递 `r2` 字节 | **通过** | `r1` `READY` 隔离为 `QUARANTINED`，旧 `r1` 批准请求返 `409`；批准 `r2` 后精确发送 `1` 封且字节完全匹配 `r2` | [matrix-evidence.json](./matrix-evidence.json) |
| `E08` | 外部效果 | 撤销/取消与提交器领取并发串行化（双序验证） | **通过** | 撤销先到：隔离 `READY`、`SMTP = 0`；领取先到：保留已提交效果并诚实完成、`SMTP = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E09` | 外部效果 | 拒绝、过期、跨会话/非审批人越权与双标签页并发批准 | **通过** | 跨会话 `403`、非审批人 `403`、拒绝 `200`（`0` SMTP）、过期 `410`（`0` SMTP）、双标签并发 `[200, 409]` 且 `totalSmtp = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `E10` | 外部效果 | 最终参数篡改阻断、并发领取唯一性与 `SUCCEEDED` 持久保持 | **通过** | 篡改参数 `claims = 0` / `SMTP = 0`；并发领取仅 `1` 个胜出；重启后维持 `SUCCEEDED`（`250 2.0.0 OK fake-msg-1`），`totalSmtp = 1` | [matrix-evidence.json](./matrix-evidence.json) |
| `V01–V06` | 视图/第2周 | 完整 Web 纵切、只读连接器端到端视图 | **待验证** | 属第 2 周交付范围，本轮未实施 | 第 2 周 |

---

## 5. W1-A 详细实测数据（预算零逃逸验收）

- **运行标识**：`runId = w1a_600f7dfe`（完整数据见 [w1-a-evidence.json](./w1-a-evidence.json)）
- **合成定价模型**：单次请求上界 `upperMu = 100 microUSD`，实际账单 `actualMu = 60 microUSD`
- **假模型服务最终物理总请求数**：`8`（包含 3 组对照组各 1 次 + 为压缩对照组和 2 组压缩负例在独立会话中生成前置对话历史的 5 次前置正常生成；所有 6 组预算不足触发点本身的新增物理请求均为 `0`）

### 5.1 三组足额对照组与六组负例明细

表中账户格式为 `limit / held / charged`（单位：`microUSD`）。

| 用例 ID | 入口 | 类别 | 服务端请求（前 -> 后 / 增量） | 新增预留记录 | TASK 账户（前 -> 后） | DAY 账户（前 -> 后） | 视图①拒绝记录（`code` / `purpose`） | 结果 |
|---|---|---|---|---|---|---|---|---|
| `W1A-CTRL-ROUTER` | `router` | 足额对照 | `0 -> 1`（`+1`） | `mreq_78e167...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `null` -> `5000000 / 0 / 60` | 无 | **PASS** |
| `W1A-CTRL-WORKER` | `worker` | 足额对照 | `1 -> 2`（`+1`） | `mreq_2d8814...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `5000000 / 0 / 60` -> `5000000 / 0 / 120` | 无 | **PASS** |
| `W1A-CTRL-COMPACTION` | `compaction` | 足额对照 | `3 -> 4`（`+1`） | `mreq_098937...` (`SETTLED`, 100/60) | `null` -> `800000 / 0 / 60` | `5000000 / 0 / 180` -> `5000000 / 0 / 240` | 无 | **PASS** |
| `W1A-NEG-1-ROUTER-TASK` | `router` | 任务余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `99 / 0 / 0` -> `99 / 0 / 0` | `10240 / 0 / 240` -> `10240 / 0 / 240` | `task_budget_exceeded` / `router`（`seq=13`） | **PASS** |
| `W1A-NEG-2-ROUTER-DAY` | `router` | 日余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `10000 / 0 / 0` -> `10000 / 0 / 0` | `339 / 0 / 240` -> `339 / 0 / 240` | `day_budget_exceeded` / `router`（`seq=16`） | **PASS** |
| `W1A-NEG-3-WORKER-TASK` | `worker` | 任务余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `99 / 0 / 0` -> `99 / 0 / 0` | `10240 / 0 / 240` -> `10240 / 0 / 240` | `task_budget_exceeded` / `worker`（`seq=19`） | **PASS** |
| `W1A-NEG-4-WORKER-DAY` | `worker` | 日余额少 1μ | `4 -> 4`（`0`） | `[]`（0 条） | `10000 / 0 / 0` -> `10000 / 0 / 0` | `339 / 0 / 240` -> `339 / 0 / 240` | `day_budget_exceeded` / `worker`（`seq=21`） | **PASS** |
| `W1A-NEG-5-COMPACTION-TASK` | `compaction` | 任务余额少 1μ | `6 -> 6`（`0`） | `[]`（0 条） | `99 / 0 / 0` -> `99 / 0 / 0` | `10360 / 0 / 360` -> `10360 / 0 / 360` | `task_budget_exceeded` / `compaction`（`seq=29`） | **PASS** |
| `W1A-NEG-6-COMPACTION-DAY` | `compaction` | 日余额少 1μ | `8 -> 8`（`0`） | `[]`（0 条） | `10000 / 0 / 0` -> `10000 / 0 / 0` | `579 / 0 / 480` -> `579 / 0 / 480` | `day_budget_exceeded` / `compaction`（`seq=37`） | **PASS** |

> 计数差值说明：`W1A-CTRL-COMPACTION` 从 `3` 起算，系在触发压缩前先向会话 `8` 写入 1 轮历史消息（第 3 次请求）；`W1A-NEG-5` 从 `6` 起算、`W1A-NEG-6` 从 `8` 起算，系各自在全新会话（`81`、`97`）中先生成 2 轮前置消息使 `pi.compaction` 达到可压缩条件，随后精确收紧目标账户至可用 `99 microUSD` 再触发真实压缩。触发压缩动作前后假服务端增量严格为 `0`。

---

## 6. W1-B 详细实测时间线（外部邮件强杀崩溃恢复验收）

### 6.1 核心追踪标识

| 字段 | 实测值 |
|---|---|
| `runId` | `w1b_820fb06c` |
| `runtimeEpoch` | `ep_096f4d8732ce47c9a095e0981a56792c` |
| `conversationId` | `8` |
| `proposalId` | `prp_2b0e91238e9f484c9bb10ea0c3cb87df` |
| `approvalId` | `apr_58402b984c174f4e9064f9e0b39a97b8` |
| `effectId` | `efx_738115729bd94cb097d01b423c8ef0fe` |
| 宿主进程演进 | Host #1 PID `48488`（强杀） -> Host #2 PID `25896`（首次恢复与重放） -> Host #3 PID `48412`（二次重启终验） |

### 6.2 端到端时间线（完整 JSON 见 [w1-b-evidence.json](./w1-b-evidence.json)）

| 步骤 | UTC 时间戳 | 事件 | 关键实测状态 |
|---|---|---|---|
| 1 | `2026-11-25T13:56:00.455Z` | `host1_started` | Host #1（PID `48488`，`http://127.0.0.1:59986`）启动并建立代际 `ep_096f4d87...` |
| 2 | `2026-11-25T13:56:00.629Z` | `proposal_pending_in_view1` | 合成邮件草案在最小视图①呈现：`revision = 1`，`actionHash = cb8e9e75...`，`noncePresent = true`，UI 标签「待审批」 |
| 3 | `2026-11-25T13:56:00.634Z` | `approval_decided` | 经最小视图①提交批准（`decisionKey = dk_w1b_820fb06c_approve`），生成 `efx_73811572...`（初始 `READY`） |
| 4 | `2026-11-25T13:56:00.662Z` | `fake_smtp_received_and_held` | 独立假 SMTP 持久登记第 `1` 封收件（`rawSha256 = e39cd6b2...`），按 `hold_after_receive` 扣住应答（`replySent = null`） |
| 5 | `2026-11-25T13:56:00.680Z` | `gov_db_verified_submitting_before_kill` | 控制器只读核对 `aegis-gov.sqlite`：`state = SUBMITTING`，`claimed_at = 1795614960646`，`receipt_ref = null`，`claimCount = 1`，`approvalCount = 1` |
| 6 | `2026-11-25T13:56:01.183Z` | `host1_force_killed` | 执行 `Stop-Process -Id 48488 -Force` 强杀 Host #1（进程退出码 `4294967295`） |
| 7 | `2026-11-25T13:56:02.314Z` | `host2_restarted_and_recovered` | 保留两库与假服务重启 Host #2（PID `25896`），同代际恢复将 `efx_73811572...` 转入 `UNKNOWN` |
| 8 | `2026-11-25T13:56:02.756Z` | `host2_refreshed_and_verified` | 重放批准（同 key 返 `200`、新 key 返 `409`）、刷新原会话 `8`：视图①显示「结果待核对」，`effectState = UNKNOWN`，假 SMTP 累计仍为 `1` |
| 9 | `2026-11-25T13:56:04.148Z` | `host3_final_verification_passed` | 优雅关闭 Host #2 后再启 Host #3（PID `48412`）：最终 `UNKNOWN`、`claimCount = 1`、`approvalCount = 1`、假 SMTP 累计 = `1`、视图①「结果待核对」、密钥扫描泄漏 = `0` |

### 6.3 最终治理记录、假 SMTP 持久记录与页面证据

- **治理库最终效果记录**：
  - `effect_id`: `efx_738115729bd94cb097d01b423c8ef0fe`
  - `approval_id`: `apr_58402b984c174f4e9064f9e0b39a97b8`
  - `state`: `UNKNOWN`
  - `claimed_at`: `1795614960646`
  - `receipt_ref`: `null`
  - `reason`: `recovered_submitting_without_receipt`
  - `claimCount`: `1`，`approvalCount`: `1`
- **独立假 SMTP 持久日志（`smtp-received.jsonl`）**：
  - `totalReceived`: `1`
  - `seq = 1`, `receivedAt = 2026-11-25T13:56:00.655Z`, `rcptTo = ["<auditor-w1b@local.test>"]`, `rawSha256 = e39cd6b21f6238e781a8c34eef2eed1d9011ed1ce3caffe4765b6376062792d8`, `modeAtArrival = hold_after_receive`, `replySent = null`
- **最小视图①最终状态**：
  - `conversationId = "8"`, `effectState = "UNKNOWN"`, `uiStatusLabel = "结果待核对"`
- **脱敏与密钥边界检查**：
  - 扫描双库文件、WAL、日志及页面快照，结果 `secretScan = { clean: true, leaks: [] }`。

---

## 7. 高风险前提结论与偏离任务书说明

### 7.1 两项高风险前提实测结论

1. **启动期调度闸门（S1）**：实测确认 `@earendil-works/pi-durable@1.6.0` 的 `Harness.open()` 保持 `scheduling === "paused"`，在 `inspect()` / `getTask()` / `conversation()` 期间不会触发任何阶段回调或模型外发；治理恢复、策略钩子校验与 `Models` 出口安装严格先于首次 `signal()` / `resume()` / `waitForIdle()` 完成。
2. **同会话并行压缩与生成的预算归属（S4）**：实测确认 `TaskScheduler.#phase` 通过宿主注入的 `HarnessOptions.telemetry` 创建携带 `task.id` / `task.name` 的 `pi.durable.phase` span，并将其原样传入 `streamSimple` 与 `completeSimple`。宿主通过 `src/runtime/telemetry.ts` 的进程内私有 `WeakMap` 建立不可伪造的 span 到任务映射，配合 `observeTaskGraph` 与显式预算归属绑定，无需依赖 `conversationId` 即可精确归属；缺失可信 span 一律失败关闭（`unknown_budget_owner`，新增物理请求 `0`）。

### 7.2 相对《任务书 1》附录 DDL 的调整（详见 ADR-0003）

以下调整均向后兼容并收紧安全与恢复语义，不放宽任何签收口径：

| 调整项 | 相对任务书 1 附录的变化 | 影响口径 |
|---|---|---|
| `paired_manifest`（新增表） | 记录 `trace_identity`、单调观测水位、只读 SQLite file change counter 与已知 Pi 任务 ID | 恢复：支持同代际轨迹回退与替换识别（F03 / S5） |
| `conversation_scopes`（新增表） | 绑定 `(conversation_id, scope_id, principal_id, runtime_epoch)` | 权限：强校验会话归属，阻断跨会话与非审批人越权（E09） |
| `approval_challenges`（新增表） | 宿主私有表，仅在 `PENDING` 期间保存明文 nonce 供已鉴权指定审批人经权威快照读取，离开 `PENDING` 即删除；`approvals` 仍仅存 `nonce_digest` | 审批安全：明文 nonce 零暴露于 URL / SSE / 日志 |
| `scopes` 新增列 | 增加 `allowed_principals_json`、`allowed_tools_json`、`allowed_targets_json` | 权限：T1 / T2 / T4 实时 ACL 复核（E08 / E09 / E10） |
| `proposals` 新增列 | 增加 `tool_name`、`target`、`created_at` | 提交与视图：T4 工具/目标一致性校验与视图①排序 |
| `effects` 新增列 | 增加 `reconciled_by`、`reconciled_at`、`reconcile_evidence` | 审计：记录 `UNKNOWN` 人工核对信息 |
| `budget_accounts` 新增列 | 增加 `frozen` | 账务：对齐超额结清自动冻结约束 |
| `signal_outbox` 新增列 | 增加 `attempts`、`updated_at` | 恢复：记录投递重试次数与更新时间 |
| `audit_events` 新增列 | 增加 `details_json` | 视图①：记录结构化拒绝原因并在原会话呈现（W1-A） |

### 7.3 实现期发现并修复的问题（供审计复核）

1. **单点导入越界修复**：初版 `src/web/server.ts` 曾直接导入 `@earendil-works/chord/context` 与 `@earendil-works/pi-durable`，已收口至 `src/runtime/harness.ts` 暴露宿主方法，`GUARD-BOUNDARY` 实测 `violations = []`。
2. **草稿编辑后信号键对齐（E07）**：当工具已停泊于 `r1` 信号键而草稿编辑升级至 `r2` 时，outbox 投递需按任务实际等待的信号键唤醒（`sig:<epoch>:<proposalId>:r*`），工具重入忽略信号载荷并直接读取治理库权威 `r2` 快照，确保仅投递 `r2` 字节。
3. **Worker 会话目的标签覆盖修复**：初版 `submitChatInput` 会将已有 `worker` 会话覆写为 `router`，已修正为保留既有 `purpose`，并在 `run-w1-a.ts` 中对 `router` / `worker` / `compaction` 逐项严格断言。

---

## 8. 未验证项与已知边界限制

1. **第 2 周待验证项**：`S6`（MCP 只读连接器超时/降级）、`V01–V06`（完整 Web 纵切、完整视图①/②/③与只读连接器联调）均留待第 2 周实施。
2. **非目标与本轮未启用项**：本轮全部模型与邮件外发均走本地独立替身与合成凭据，未启用真实模型计费、真实 SMTP 外发、真实 GitHub 写入、公网监听或容器逃逸测试。
3. **物理断电与内核强杀差异**：本轮采用 Windows `Stop-Process -Force` 进程强杀 + 治理库 `WAL + synchronous=FULL` 验证崩溃持久化，未在真实物理断电或带写缓存掉电磁盘上做硬件级掉电实验。
4. **同代际回退水位保守窗口**：`paired_manifest` 水位在宿主提交会话/任务与优雅停机时单调推进；若宿主在极短窗口内崩溃早于水位推进，仅会导致水位保守偏小（避免误报正常崩溃），而不会放行回退到更早已知快照。

---

## 9. 历史基线参考（v1 历史成绩，与 v2 本次实测严格分离）

> 以下为 `v1-zero-trust-baseline`（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）封存时的历史测试成绩，仅作基线溯源对照，**不计入**本次 v2 第 1 周实测通过率：
>
> - v1 自动化测试套件：`327/327 PASS`
> - v1 本地自用验收（`selfuse`）：`31/31 PASS`
>
> 本次 **v2 第 1 周实测成绩**独立统计为：`tsc --noEmit` 通过、`S1–S5` 5/5 通过、`W1-A` 9/9 通过、`W1-B` 通过、矩阵 `19/19` 通过。

---

## 10. 审计人独立复跑签收栏

| 核对项 | 审计人复跑结果 | 备注 / 复跑 runId |
|---|---|---|
| 核对基线 SHA `3a88b68` 与候选 SHA `66f7ee1` | [ ] 通过 / [ ] 异常 | |
| 核对依赖锁定与 `docs/v2/dependency-integrity.json` | [ ] 通过 / [ ] 异常 | |
| 干净临时目录执行完整第 1 周命令退出码为 `0` | [ ] 通过 / [ ] 异常 | |
| 独立复跑 `W1-A`：6 组负例新增请求全为 `0` 且无残留冻结 | [ ] 通过 / [ ] 异常 | |
| 独立复跑 `W1-B`：强杀重启后 SMTP 累计 `1`、状态 `UNKNOWN`、页面「结果待核对」 | [ ] 通过 / [ ] 异常 | |
| 审阅 ADR-0002 / ADR-0003 及 DDL 调整说明 | [ ] 通过 / [ ] 异常 | |
| **审计结论** | [ ] 准予进入第 2 周 / [ ] 退回整改 | 审计人 / 日期： |
