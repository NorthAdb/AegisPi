# AegisPi v2 任务书 1 阶段一第 2 周交付审计报告

- **文档版本**：Week 2 审计交接第 3 轮提审（2026-11-26，香港时间；完整保留 §1–§10 第 1 轮记录与 §11.3 第 2 轮独立审计原文，§12 追加第 2 轮全部未关闭与新增审计项整改回执、版本化证据目录映射与第 3 轮签收栏）
- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **基线与前置签收**：
  - v1 零信任基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`）
  - 第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（独立验收交接提交 `47a4dd41e663b61b5daf76918dd2b0a48771954d`）
- **第 2 周冻结代码候选链**：
  - 第 1 轮提审候选（已退回整改，见 §10）：`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`（第 1 轮独立审计落于 `2a21134c9a1d5776caba0c75c1c126fcdac3a066`；原始证据恢复至 `evidence/week1/` 与 `evidence/week2/`）
  - 第 2 轮提审候选（已退回整改，见 §11.3）：`efba0eda53a21cf5f935846377f8ab03ff42eb69`（第 2 轮独立审计落于 `fa7f6b1dd9fe8b7701014074886727de7da274b5`；证据固化至 `evidence/round2/`）
  - **第 3 轮冻结代码候选 SHA（本次提审）**：**`2dffb01fe0711a9b727b9f41006ed55bcac335b7`**（13 files changed, +2116 / -711；本次脱敏证据固化至 `evidence/round3/`，随后续仅文档提交入库，不改动任何 `src/` 或 `tests/` 实现）
- **第 3 轮同候选（`2dffb01`）全量实测运行标识**：
  - 第 2 周全量套件：`runId = week2_c948a676`（执行时间 `2026-11-26T05:00:38.475Z`，退出码 `0`）
  - 第 1 周回归与 W1-A / W1-B 复签：`runId = week1_e72893f9`（执行时间 `2026-11-26T04:55:49.413Z`，退出码 `0`）
  - （历史第 1 轮 `ea9b59c` 记录 `week2_203150f4` / `week1_0c6fd47a` 保留于 §1–§9 与 `evidence/`；第 2 轮 `efba0ed` 记录 `week2_57fd5f62` / `week1_61255801` 保留于 §11 与 `evidence/round2/`）
- **审计范围**：阶段一第 2 周（《任务书 1》第一节 D6–D10、第五节 S6、第六节 V01–V06、第七节回归复签）以及 §11.3 第 2 轮独立审计中未关闭的 5 项（`W2-S1`、`W2-S2`、`W2-S3`、`W2-S4`、`W2-S6`）与新增 2 项（`W2-R2-M1`、`W2-R2-E1`）整改复核。

> **审计传递与交流说明**：本文件是第 2 周提审与复审的唯一主交接文档。§1–§11 完整保留第 1、2 轮提审与独立审计原文；**§12** 给出针对 §11.3 全部 7 项未关闭与新增审计编号的逐项整改映射、新冻结候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 上的实测命令/退出码/`runId`/版本化脱敏证据（`evidence/round3/`），并在 **§12.3** 预留第 3 轮审计人复跑与签收栏。

---

## 1. 基线、提交记录与变更清单

### 1.1 分支与提交链（均保留于本地 `v2`，未推送远端）

| 顺序 | 提交 SHA | 提交说明 | 作用 |
|---|---|---|---|
| 基线 | `3a88b6895991d328e8e27fd1072a29846e7a9adf` | `docs(v1): organize docs/v1 archive and reconcile baseline status` | `v1-zero-trust-baseline` 分叉起点 |
| W1 签收 | `69ce7b9ac818d5f80551a8cfcc18add84a1607f8` | `fix(v2): close Round 3 blocker (idempotent legacy DB upgrade and strict denial epoch filter)` | 第 1 周第 4 轮签收代码候选 |
| W1 交接 | `47a4dd41e663b61b5daf76918dd2b0a48771954d` | `docs(v2): record independent Week 1 acceptance` | 第 1 周外部审计签收落盘 |
| **W2 候选 #1** | **`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`** | `feat(v2): implement Stage 1 Week 2 (V01-V06, S6, V04 chat idempotency, V05 SSE projection, memory/IMAP/MCP/Docker import)` | **第 2 周第 1 轮冻结代码候选**（39 files changed, +11689 / -272） |
| W2 证据 | `5cb67ee55da6fef4ea16bc444baccaa1b03aa717` | `docs(v2): add Week 2 acceptance report and sanitized evidence for ea9b59c` | 归档 `ea9b59c` 的脱敏 JSON 证据包与简版验收摘要（仅文档） |
| W2 审计交接 | （本次文档提交） | `docs(v2): add standalone Week 2 audit handoff report for ea9b59c` | 新增本完整审计交接文档（仅文档，不改代码或证据） |

### 1.2 遵循的规范与架构决议文档

- [AGENTS.md](../../../AGENTS.md)：锁定工具链、纯 TypeScript 约束、单向四层依赖、单点导入铁律、双库所有权、阶段一边界与脱敏规范。
- [docs/adr/0002-v2-pi-durable-migration.md](../../adr/0002-v2-pi-durable-migration.md)：v1 到 v2 迁移决议与 exact `1.6.0` 版本锁定。
- [docs/adr/0003-week1-budget-attribution-and-paired-recovery.md](../../adr/0003-week1-budget-attribution-and-paired-recovery.md)：预算归属、全分页配对恢复、换代联动与审批挑战隔离。
- [docs/v2/week1-audit/WEEK1-AUDIT-REPORT.md](../week1-audit/WEEK1-AUDIT-REPORT.md)：第 1 周 4 轮审计交接与签收历史记录。
- [docs/v2/dependency-integrity.json](../dependency-integrity.json)：锁定工具链与依赖完整性摘要。

### 1.3 相对第 1 周交接 `47a4dd4` 的代码变更清单（共 39 个文件，均落于冻结候选 `ea9b59c`）

| 分层 / 类别 | 状态 | 文件路径 | 职责摘要 |
|---|---|---|---|
| 配置与脚本 | M | [package.json](../../../package.json) | 仅新增 `"test:week2": "node tests/week2/run-all.ts"`，依赖锁定与 `package-lock.json` 零变更 |
| L1 治理内核（`src/governance/`） | A | [chat-commands.ts](../../../src/governance/chat-commands.ts) | `chat_commands` 登记、稳定 `pi_request_id`、同键冲突 409、回执补录与 `PENDING_RECONCILE` |
| L1 治理内核（`src/governance/`） | A | [scanner.ts](../../../src/governance/scanner.ts) | 13 类确定性提示注入扫描器（原文 + NFKC 归一化） |
| L1 治理内核（`src/governance/`） | A | [policy.ts](../../../src/governance/policy.ts) | `source_read_grants` 与 `model_disclosure_grants` 双重门控、`conversation_sources` 溯源与污点继承 |
| L1 治理内核（`src/governance/`） | A | [mcp-pin.ts](../../../src/governance/mcp-pin.ts) | MCP 可执行文件 SHA-256 钉扎、规范化工具定义钉扎、漂移隔离与即时撤销 |
| L1 治理内核（`src/governance/`） | M | [db.ts](../../../src/governance/db.ts), [credentials.ts](../../../src/governance/credentials.ts), [recovery.ts](../../../src/governance/recovery.ts) | 新增第 2 周治理表、多槽位内存凭据库、换代时将旧 `REGISTERED` 聊天命令标为 `PENDING_RECONCILE` |
| L2 能力连接器（`src/capabilities/`） | A | [memory/store.ts](../../../src/capabilities/memory/store.ts) | `memory_notes` / FTS5 / `memory_refs` / `memory_tombstones`、运行期冻结 L0 与召回前过滤 |
| L2 能力连接器（`src/capabilities/`） | A | [mail/imap-child.ts](../../../src/capabilities/mail/imap-child.ts), [mail/imap-client.ts](../../../src/capabilities/mail/imap-client.ts) | 短命隔离子进程（最小非密环境、stdin 传凭据）、直连 TLS 与 HTTP CONNECT 隧道登录前内层验真、严格 `EXAMINE + BODY.PEEK` |
| L2 能力连接器（`src/capabilities/`） | A | [workspace/path-jail.ts](../../../src/capabilities/workspace/path-jail.ts), [workspace/docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts), [workspace/importer.ts](../../../src/capabilities/workspace/importer.ts) | Windows/POSIX 逐段路径监牢、`--network none` 零凭据容器与私有卷、全写者退出核验、只读导出、冲突保留两版与回执丢失幂等恢复 |
| L3 Pi 运行时层（`src/runtime/`，唯一 `@earendil-works/*` 导入边界） | A | [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts), [extensions/aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts) | `@earendil-works/pi-mcp@1.6.0` `StdioTransport({ inheritEnv: false })` 封装与写工具/ref/path RPC 前拦截；运行期冻结 L0 `PromptSection` |
| L3 Pi 运行时层（`src/runtime/`） | M | [harness.ts](../../../src/runtime/harness.ts), [models.ts](../../../src/runtime/models.ts), [extensions/aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) | Step 5b 聊天启动核对、V04 确定性屏障、生成/委派/压缩/重试全路径披露复核、Tier 0 工具与子 Worker 归属/事件向父会话汇总 |
| L4 Web 与视图①（`src/web/`, `src/`） | A / M | [projection.ts](../../../src/web/projection.ts), [server.ts](../../../src/web/server.ts), [view1.ts](../../../src/web/view1.ts), [index.ts](../../../src/index.ts) | 先缓冲后建立的游标投影中心、`/chat` 幂等协议、`/snapshot` + `/events` 游标与重同步、本地零 CDN 视图①、启动监听错误安全处理 |
| 独立假服务与客户端（`tests/fakes/`） | A / M | [tls-cert.ts](../../../tests/fakes/tls-cert.ts), [fake-imap-server.ts](../../../tests/fakes/fake-imap-server.ts), [fake-connect-proxy.ts](../../../tests/fakes/fake-connect-proxy.ts), [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts), [fake-model-server.ts](../../../tests/fakes/fake-model-server.ts), [client.ts](../../../tests/fakes/client.ts) | 本地自签 TLS 证书生成、假 IMAP（审计 `\Seen` 与 `SELECT/EXAMINE/PEEK`）、假 HTTP CONNECT 代理、假 GitHub MCP stdio 服务、假模型剧本增强 |
| 第 1 周回归适配（`tests/week1/`） | M | [run-w1-a.ts](../../../tests/week1/run-w1-a.ts), [run-w1-b.ts](../../../tests/week1/run-w1-b.ts), [run-matrix.ts](../../../tests/week1/run-matrix.ts), [audit-regressions.ts](../../../tests/week1/audit-regressions.ts) | 按 V04 协议在 `/chat` 请求体补齐 `chatKey` 与 `runtimeEpoch`（未放宽任何第 1 周断言） |
| 第 2 周验证套件（`tests/week2/`） | A | [run-s6.ts](../../../tests/week2/run-s6.ts), [run-v04-v05.ts](../../../tests/week2/run-v04-v05.ts), [run-v02.ts](../../../tests/week2/run-v02.ts), [run-v03.ts](../../../tests/week2/run-v03.ts), [run-v01-v06-browser.ts](../../../tests/week2/run-v01-v06-browser.ts), [run-all.ts](../../../tests/week2/run-all.ts) | `S6`、`V04/V05`、`V02`、`V03`、`V01/V05/V06` 实机 Edge CDP 浏览器与全量入口 |

---

## 2. 锁定运行环境与依赖完整性

### 2.1 实测环境版本

| 项目 | 实测值 |
|---|---|
| 操作系统与架构 | Windows (`win32 10.0.26300`, `x64`, 6 CPUs) |
| 锁定 Node 与内置 SQLite | `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`）/ `node:sqlite`（`3.54.1`） |
| npm 版本 | `10.9.9` |
| 本地 Docker 与镜像 | Client `29.9.2` / Server `29.9.2`；`node:22.23.5-bookworm-slim`（`sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`） |
| 本地浏览器 | `msedge.exe`（Headless CDP，基于 Node 22 原生 WebSocket） |
| 时区与计费日 | `Asia/Hong_Kong` / `2026-11-26` |
| `package-lock.json` SHA-256 | `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`（相对第 1 周**未变动**，锁定包总数 `175`） |

### 2.2 直接依赖精确版本（无 `^` / `~`，与第 1 周完全一致）

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

以下命令均在仓库根目录 `D:\AegisPi\aegis-pi` 下执行，使用锁定 Node 二进制与全新临时目录，不接触真实模型计费、真实邮件外发或真实 GitHub 写入。

### 3.1 核对冻结候选提交与依赖完整性

```powershell
git status --short
git log -n 4 --format="%H %s"
git diff --stat ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb HEAD
(Get-FileHash package-lock.json -Algorithm SHA256).Hash.ToLower()
```

预期：`git diff --stat ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb HEAD` 仅包含 `docs/v2/week2-audit/` 下的审计报告与脱敏 JSON 证据；`package-lock.json` SHA-256 为 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`。

### 3.2 一键复跑第 2 周全量验收（`tsc` + 分层守卫 + `S6` + `V04/V05` + `V02` + `V03` + `V01/V05/V06` 实机浏览器）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w2Dir = Join-Path $env:TEMP "aegispi-v2-week2-audit-$ts"
& $node ./node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -eq 0) {
  & $node tests/week2/run-all.ts --data-dir (Join-Path $w2Dir 'data') --evidence-dir (Join-Path $w2Dir 'evidence')
}
```

### 3.3 一键复跑第 1 周回归与 W1-A / W1-B 复签（§7 要求，同候选）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1Dir = Join-Path $env:TEMP "aegispi-v2-week1-resign-$ts"
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1Dir 'data') --evidence-dir (Join-Path $w1Dir 'evidence')
```

### 3.4 按子项单独复跑

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$base = Join-Path $env:TEMP "aegispi-w2-single-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
& $node tests/week2/run-s6.ts --data-dir "$base\s6\data" --evidence-dir "$base\s6\ev"
& $node tests/week2/run-v04-v05.ts --data-dir "$base\v0405\data" --evidence-dir "$base\v0405\ev"
& $node tests/week2/run-v02.ts --data-dir "$base\v02\data" --evidence-dir "$base\v02\ev"
& $node tests/week2/run-v03.ts --data-dir "$base\v03\data" --evidence-dir "$base\v03\ev"
& $node tests/week2/run-v01-v06-browser.ts --data-dir "$base\browser\data" --evidence-dir "$base\browser\ev"
& $node tests/week1/run-w1-a.ts --data-dir "$base\w1a\data" --evidence-dir "$base\w1a\ev"
& $node tests/week1/run-w1-b.ts --data-dir "$base\w1b\data" --evidence-dir "$base\w1b\ev"
```

### 3.5 第 1 轮提审实测执行记录（候选 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`）

- 第 1 周回归：`runId = week1_0c6fd47a`，退出码 `0`，脱敏证据位于 `docs/v2/week2-audit/evidence/week1/`：
  - [week1-summary.json](./evidence/week1/week1-summary.json)
  - [s1-s5-evidence.json](./evidence/week1/s1-s5-evidence.json)
  - [w1-a-evidence.json](./evidence/week1/w1-a-evidence.json)
  - [w1-b-evidence.json](./evidence/week1/w1-b-evidence.json)
  - [matrix-evidence.json](./evidence/week1/matrix-evidence.json)
- 第 2 周全量：`runId = week2_203150f4`，退出码 `0`，脱敏证据位于 `docs/v2/week2-audit/evidence/week2/`：
  - [week2-summary.json](./evidence/week2/week2-summary.json)
  - [s6-evidence.json](./evidence/week2/s6-evidence.json)
  - [v04-v05-evidence.json](./evidence/week2/v04-v05-evidence.json)
  - [v02-evidence.json](./evidence/week2/v02-evidence.json)
  - [v03-evidence.json](./evidence/week2/v03-evidence.json)
  - [v01-v06-browser-evidence.json](./evidence/week2/v01-v06-browser-evidence.json)

---

## 4. 第 2 周全量验收矩阵（候选 `ea9b59c` 逐项结果）

### 4.1 第 2 周核心项（S6 / V01–V06 / 工程护栏）

| 编号 | 套件 `runId` | 退出码 | 验收项摘要 | 结果 | 关键实测指标 | 脱敏证据 |
|---|---|---|---|---|---|---|
| `TSC` + `GUARD-BOUNDARY` | `week2_203150f4` | `0` | 原生可擦除 TS 静态检查 + 单点 `@earendil-works/*` 导入与单向分层守卫 | **通过** | `tsc --noEmit` 退出 `0`；`layerBoundary.violations = []` | [week2-summary.json](./evidence/week2/week2-summary.json) |
| `S6` | `s6_317c0d82` | `0` | 5 独立凭据槽全流程零泄漏扫描 + 扫描器阳性对照 + 6 采样点覆盖 | **通过** | 阳性对照 `2/2`；6 采样点全覆盖；5 槽位 `totalForbiddenHits = 0`；Docker 容器环境仅 `["PATH","NODE_VERSION","YARN_VERSION"]`；MCP `inheritEnv: false` | [s6-evidence.json](./evidence/week2/s6-evidence.json) |
| `V01` | `v01v06_667b26b0` | `0` | 实机 Edge 视图①端到端演示句，刷新后来源/步骤/文件/待核对效果核对与 XSS 防护 | **通过**（替身；`firstTokenMs` 待验证） | `conversationId = 8`，`firstToolProgressMs = 168`，`completionMs = 12557`，来源 `["memory","memory","imap","github_mcp","workspace_file"]`，预算步骤 7 条（Router + Worker），`reports/weekly.md` SHA-256 精确匹配 `2ffb1928...`，墓碑与注入笔记已排除，`xssPlainTextVerified = true` | [v01-v06-browser-evidence.json](./evidence/week2/v01-v06-browser-evidence.json) |
| `V02`（替身） | `v02_e07a4c6e` | `0` | 记忆/L0、只读 IMAP（直连 + CONNECT 隧道）、GitHub MCP 钉扎与来源读取/模型披露分离门控 | **通过**（本地替身；真实只读待验证） | 记忆跨主体 `0` / 墓碑 `0` / 注入隔离；IMAP `SELECT = 0` / `EXAMINE = 2` / `BODY.PEEK = 2` / `\Seen` 不变 / 错证书登录前拒（`0` 登录）；GitHub MCP 二进制与工具钉扎、`totalWriteCallsOnServer = 0`、越权/写工具/篡改/撤销均在 RPC 前拦截；披露撤销后假模型物理发送增量 `0` | [v02-evidence.json](./evidence/week2/v02-evidence.json) |
| `V03` | `v03_6ecb96be` | `0` | 实机 Docker 无网零凭据沙箱、私有卷、写者全退导出、冲突保留两版、拒绝不变、回执丢失幂等 | **通过** | Docker `29.9.2` `networkMode = none`、`allWritersExited = true`；正常导入 `reports/weekly.md` SHA-256 精确匹配 `d694d674...`（`installCount = 1`）；编辑/新建冲突均 `CONFLICT_SAVED` 保两版；8 类恶意/越权拒入目标不变；回执丢失恢复 `installCount = 1`、`diskRewrittenOnRetry = false` | [v03-evidence.json](./evidence/week2/v03-evidence.json) |
| `V04` | `v04v05_43885a5b` | `0` | 聊天三段提交协议、窗 2 强杀单逻辑提交、409 冲突/错代际、不可证"受理待核对" | **通过** | 窗 1 + 核对读失败 `PENDING_RECONCILE / 受理待核对`（额外发送 `0`）；窗 2 Pi 受理后强杀恢复 `piRequestId = chatreq:1434dc2c...`、`submissionId = 15`，409 同键异文与错代际通过，并发双击单提交；窗 3 丢 HTTP 响应重放复用 `submissionId = 15` | [v04-v05-evidence.json](./evidence/week2/v04-v05-evidence.json) |
| `V05` | `v04v05_43885a5b` + `v01v06_667b26b0` | `0` | 快照/SSE 游标绑定 `(principalId, runtimeEpoch, conversationId)`、空窗批准不漏、断号/淘汰/慢客户端/重启 `resync`、注销断流、切会话清旧卡 | **通过** | 快照游标 `str_2cec90be-896:1` 后空窗批准首条重放 `:2`；淘汰/慢客户端/同代际重启均发 `resync`；注销后业务帧 `0`；跨主体 `403`；浏览器去重 `1`、断号重取 `1`、旧卡片归零、注销 `401` | [v04-v05-evidence.json](./evidence/week2/v04-v05-evidence.json) / [v01-v06-browser-evidence.json](./evidence/week2/v01-v06-browser-evidence.json) |
| `V06` | `v01v06_667b26b0` | `0` | 实机 Edge 审批全生命周期（改稿/升修订/旧标签 409/过期 410 且 0 SMTP/`UNKNOWN` 刷新保持/Origin 403/未登录 401） | **通过** | 未保存编辑禁批准、保存升 `revision = 2`、旧修订 `409`；过期禁批准、旧标签 `410`、`expiredSmtpSentDelta = 0`；刷新后持续显「结果待核对」；错/缺 Origin `403`、未登录 `401` | [v01-v06-browser-evidence.json](./evidence/week2/v01-v06-browser-evidence.json) |

### 4.2 第 1 周回归与 W1-A / W1-B 复签（同一冻结候选 `ea9b59c`）

| 编号 | 套件 `runId` | 退出码 | 期望 | 实得 | 脱敏证据 |
|---|---|---|---|---|---|
| `W1-A` / `B01` | `w1a_50aba5c5` | `0` | 3 个足额对照各发 1 次；6 个差 1mu 负例各发 0 次且账本/预留不变、视图①见拒绝 | 3 对照全 `+1`；6 负例全 `0`（明细见 §6.6） | [w1-a-evidence.json](./evidence/week1/w1-a-evidence.json) |
| `W1-B` / `E06` | `w1b_9d37a198` | `0` | 假 SMTP 扣应答后 `Stop-Process -Force` 强杀并二次重启与重复 SDK 唤醒，累计收件 1、领取 1、刷新显「结果待核对」 | `effectId = efx_a188d34a...`，强杀 PID `26340`、重启 PID `9180` / `48764`，`totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、`UNKNOWN` / 「结果待核对」、`secretLeaksCount = 0`（时间线见 §6.7） | [w1-b-evidence.json](./evidence/week1/w1-b-evidence.json) |
| `S1–S5` | `week1_0c6fd47a` | `0` | Pi SDK 1.6.0 五项契约全部通过 | `5/5` **PASS** | [s1-s5-evidence.json](./evidence/week1/s1-s5-evidence.json) |
| 第 1 周失败矩阵 | `week1_0c6fd47a` | `0` | `GUARD-BOUNDARY`、`G1–G3`、`R1`、`R3-EPOCH-ACL`、`R3-LEGACY-UPGRADE`、`F01–F03`、`B02–B07`、`E01–E05`、`E07–E10` 全绿 | `25/25` **PASS** | [matrix-evidence.json](./evidence/week1/matrix-evidence.json) |

---

## 5. 关键源码审查导航（按 D6–D10 逐项列出不变量与代码落点）

供审计人直接抽查关键安全边界、并发串行化与恢复逻辑：

| 审查主题 | 关键不变量 | 源码落点 |
|---|---|---|
| **D6 · V04 聊天提交幂等与三窗口恢复** | 1. 治理库以 `UNIQUE(principal_id, runtime_epoch, conversation_id, chat_key)` 登记，生成 RFC 8785 `content_digest` 与确定性 `pi_request_id`。<br>2. 同键异文或错 `runtimeEpoch` 返回 `409`。<br>3. 启动恢复 Step 5b 在 `harness.resume()` 之前通过 `conv.commit(tx => tx.submissionByRequest(cid, piRequestId))` 只读核对受理结果，不提前触发调度；核对读失败转 `PENDING_RECONCILE`（`202`，UI 显示「受理待核对」）。<br>4. 进程内 in-flight 去重防止并发双击双提交。 | [src/governance/chat-commands.ts](../../../src/governance/chat-commands.ts)<br>[src/runtime/harness.ts](../../../src/runtime/harness.ts)（`reconcileChatCommandsBeforeResume`、`submitChatCommand`）<br>[src/web/server.ts](../../../src/web/server.ts)（`POST /api/conversations/:id/chat`） |
| **D6 · V05 快照与 SSE 游标投影** | 1. 游标格式 `<streamInstanceId>:<seq>`，绑定 `(principalId, runtimeEpoch, conversationId)`。<br>2. 先缓冲订阅事件再构造快照，避免「快照返回后、订阅建立前」丢失事件；`serverNow` 移出投影快照体避免时间戳抖动污染 ring buffer。<br>3. 历史淘汰（`cursor_history_evicted`）、慢客户端队列溢出（`slow_client_queue_overflow`）、同代际重启（`stream_instance_changed`）均触发 `resync`。<br>4. 逐帧复核会话有效性与 ACL，注销立即关闭全部归属流。 | [src/web/projection.ts](../../../src/web/projection.ts)<br>[src/web/server.ts](../../../src/web/server.ts)（`/snapshot`、`/events`、`/logout`）<br>[src/web/view1.ts](../../../src/web/view1.ts)（去重、断号重取、切会话清空） |
| **D7 · 记忆 L0、FTS 召回与 13 类注入扫描** | 1. L0 在会话/任务开始时按 `(principalId, scopeId, domain)` 冻结注入 `PromptSection`。<br>2. FTS5 召回先按主体、范围、过期、墓碑与 13 类扫描器（原文 + NFKC）过滤后再排序返回，墓碑引用与注入笔记均不返回模型或 UI。 | [src/capabilities/memory/store.ts](../../../src/capabilities/memory/store.ts)<br>[src/governance/scanner.ts](../../../src/governance/scanner.ts)<br>[src/runtime/extensions/aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts) |
| **D7 · 只读 IMAP 隔离子进程与隧道验真** | 1. 宿主通过短命子进程执行 IMAP，子进程仅获最小非密环境变量，凭据仅经 `stdin` 一次性送入。<br>2. 同时支持直连 TLS 与 HTTP CONNECT 隧道，在发送 `LOGIN` 之前完成目标主机 TLS 证书与主机名验证。<br>3. 仅发送 `EXAMINE` 与 `BODY.PEEK`，严禁 `SELECT` 或改变 `\Seen` 标记。 | [src/capabilities/mail/imap-client.ts](../../../src/capabilities/mail/imap-client.ts)<br>[src/capabilities/mail/imap-child.ts](../../../src/capabilities/mail/imap-child.ts) |
| **D7 · GitHub MCP 只读钉扎与边界隔离** | 1. 全仓唯一 `@earendil-works/pi-mcp@1.6.0` 导入位于 `src/runtime/mcp-bridge.ts`，启动强制 `StdioTransport({ inheritEnv: false })`。<br>2. 启动前校验绝对路径与二进制 SHA-256；`listTools` 后按 RFC 8785 校验 `name/description/inputSchema` SHA-256，漂移立即隔离为 `QUARANTINED`。<br>3. 阶段一在 RPC 之前硬拦截所有写工具及越权 `ref` / `path`。 | [src/governance/mcp-pin.ts](../../../src/governance/mcp-pin.ts)<br>[src/runtime/mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) |
| **D7 · 来源读取与模型披露分离门控** | 1. `source_read_grants` 仅控制读取；`model_disclosure_grants` 按 `(principalId, scopeId, sourceType, sourceId, provider, modelId, baseUrl, slotName)` 控制向指定模型槽披露。<br>2. `conversation_sources` 记录溯源并在委派时通过 `inheritConversationSources` 向子 Worker 继承污点。<br>3. 在生成、委派、压缩与重试的 `beforeRequest` / `beforeCompact` 与 `src/runtime/models.ts` 物理出站前全部复核，撤销后立即拒发（物理增量 0）。 | [src/governance/policy.ts](../../../src/governance/policy.ts)<br>[src/runtime/extensions/aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts)<br>[src/runtime/models.ts](../../../src/runtime/models.ts) |
| **D8 · 无网零凭据 Docker 沙箱与受管文件导入** | 1. Worker 沙箱使用 `--network none`、零凭据环境变量、`/input:ro` 只读输入快照、任务私有命名卷 `/out:rw`。<br>2. 导出前检查 `verifyAllVolumeWritersExited`，确认全部写者已退出后再用受控只读导出容器挂载 `/export:ro`，拒绝符号链接、硬链接、设备文件与超配额。<br>3. 宿主逐段路径监牢拒绝穿越、`:` / ADS、Windows 保留设备名、重解析点/联结点、软硬链接。<br>4. 目标级串行锁 + 会话写授权复核 + 基准版本比对（冲突保留用户文件并落盘 `.conflict-*`）+ 回执丢失时核对目标磁盘 SHA-256 幂等收口不二次写盘。 | [src/capabilities/workspace/path-jail.ts](../../../src/capabilities/workspace/path-jail.ts)<br>[src/capabilities/workspace/docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts)<br>[src/capabilities/workspace/importer.ts](../../../src/capabilities/workspace/importer.ts) |
| **D9 · 视图① 与父子会话聚合** | 1. 本地 HTML/CSS/JS，零外部 CDN，严格 CSP，所有不可信文本仅用 `textContent` 渲染防 XSS。<br>2. 审批草稿未保存编辑时禁用批准；过期卡片禁用批准；刷新后持续显示「结果待核对」。<br>3. `harness.ts` 与 `server.ts` 按 `owner_task_id` 聚合子 Worker 的预算预留与文件导入记录，并将子 Worker 变更事件转发至父会话投影。 | [src/web/view1.ts](../../../src/web/view1.ts)<br>[src/web/server.ts](../../../src/web/server.ts)<br>[src/runtime/harness.ts](../../../src/runtime/harness.ts) |

---

## 6. 专项实测明细（来自冻结候选 `ea9b59c` 脱敏 JSON）

### 6.1 S6 全流程凭据零泄漏矩阵（`runId = s6_317c0d82`）

- 扫描器阳性对照：`plantedMarkers = 2`，`detectedHits = 2`（证明扫描器有效工作）。
- 6 个采样点：`router_generation`、`worker_generation`、`compaction`、`imap_and_mcp_connectors`、`docker_sandbox`、`post_restart`。
- 5 个独立槽位在全部禁止位置（`web_snapshot`、`web_sse_frame`、`fake_model_log`、`fake_imap_log`、`fake_mcp_log`、`aegis-gov.sqlite`、`pi-durable.sqlite`、`model_prompt_bodies`、非授权子进程环境、`docker_container_env`）命中数汇总：

| 槽位 ID | 标记摘要前缀 | 允许位置 | 禁止位置命中数 |
|---|---|---|---|
| `slot:model-router` | `dd73716856640277` | `host_memory_vault`, `loopback_fake_model_router_auth_header` | `0` |
| `slot:model-worker` | `9d8c0c2cf8820ab9` | `host_memory_vault`, `loopback_fake_model_worker_auth_header` | `0` |
| `slot:imap-readonly` | `2be59062f9e9724b` | `host_memory_vault`, `imap_child_stdin_only` | `0` |
| `slot:github-mcp-pat` | `d2dad418c79ba025` | `host_memory_vault`, `github_mcp_child_explicit_env` | `0` |
| `slot:web-console` | `e96a3809a1387dd0` | `host_memory_auth_config` | `0` |

### 6.2 V04 / V05 协议级实测（`runId = v04v05_43885a5b`）

- **V04 窗 1 与核对读失败**：返回 `PENDING_RECONCILE / 受理待核对`，额外模型发送 `0`。
- **V04 窗 2（Pi 已持久受理、宿主尚无回执时强杀）**：恢复核对命中同一 `piRequestId = chatreq:1434dc2c39336407a70fdcebeb4c0b0a` 与 `submissionId = 15`，重试仍只有一个逻辑提交；同键异文 `409`、错代际 `409`、并发双击单提交全部通过。
- **V04 窗 3（回执已写但 HTTP 丢失）**：重放复用 `submissionId = 15`。
- **V05**：快照游标 `str_2cec90be-896:1`，空窗批准后订阅首条重放 `str_2cec90be-896:2`；历史淘汰（`cursor_history_evicted`）、慢客户端（`slow_client_queue_overflow`）、同代际重启（`stream_instance_changed`）均触发 `resync`；注销后业务帧 `0`；跨主体 `403`。

### 6.3 V02 只读连接器与披露门控（`runId = v02_e07a4c6e`，本地替身）

- **记忆**：召回 `["mem-l0-helios", "mem-l1-detail"]`；`otherPrincipalPrivateHits = 0`、`tombstonedRefHits = 0`、`injectedNoteQuarantined = true`（原因 `override_imperatives`、`approval_exemption_claims`）。
- **IMAP**：`uid = 102`，`uidValidity = 20261126`，`flagsBefore = flagsAfterDirect = flagsAfterConnect = []`；`totalSelectCommands = 0`、`totalExamineCommands = 2`、`totalBodyPeekFetches = 2`、`totalNonPeekFetches = 0`、`connectProxyTunnels = 2`；错证书在 `LOGIN` 前阻断（`wrongCertServerLogins = 0`）；撤销读取授权被拒。
- **GitHub MCP**：`serverId = github-readonly`，`pinnedArtifactSha256 = 280b8fd47db464961cb7e76bf6d1c372e8e8d4ff286535d97e47f05cd20fa490`，`inheritEnvFalseVerified = true`，`unrelatedHostEnvLeaked = false`，`totalToolCallsOnServer = 1`，`totalWriteCallsOnServer = 0`；越权 ref、越权 path、写工具、篡改定义、撤销工具全部在 RPC 前拦截。
- **模型披露分离**：授权前物理发送 `0`，阳性对照假模型收到标记 `1`，撤销披露后物理发送增量 `0`、标记命中增量 `0`。

### 6.4 V03 实机 Docker 沙箱与受管文件导入（`runId = v03_6ecb96be`）

- 正常导入 `reports/weekly.md`：`expectedSha256 = actualSha256 = d694d6741eeeec7e3edb0728a42fd7fa2783bd8c4742ae4d261c29e476979466`，`installCount = 1`，`networkMode = none`，`/input:ro` + 私有卷 `/out:rw`，`allWritersExited = true`。
- 冲突保护：用户修改后导入与并发新建文件导入均进入 `CONFLICT_SAVED`（保留用户原文件并写出 `reports/weekly.conflict-da1cd1ed50.md`、`reports/new-note.conflict-92ff32fa4d.md`）。
- 8 类拒绝且目标不变：`active_volume_writers`、`symlink_rejected`、`hardlink_rejected`、`file_size_quota_exceeded`、`windows_ads_or_drive_rejected`、`path_traversal_or_empty_segment`、`windows_device_name_rejected`、`workspace_write_denied`。
- 安装后回执丢失恢复：`reconciled_after_receipt_loss`，`installCount = 1`，`diskRewrittenOnRetry = false`。

### 6.5 V01 / V05 / V06 实机 Edge 浏览器纵切（`runId = v01v06_667b26b0`）

- 浏览器：`msedge.exe`；监听地址 `http://127.0.0.1:60802`（本机实测期间 `4310` 端口已被其他进程占用，套件优先尝试 `4310` 后回落回环随机端口）。
- **V01**：演示句「按我记忆里的项目名，读最新一封周报和仓库 README，把两边时间不一致的地方写到 reports/weekly.md。」执行完成，`firstToolProgressMs = 168`，`completionMs = 12557`，`reports/weekly.md` SHA-256 精确匹配 `2ffb1928c26898842201a80b8f45f56fc1dbfa9a25ea31874ecd2365feb8286d`，刷新后来源、7 步 Router/Worker 预算记录、文件条目可见，墓碑/注入笔记已排除，`xssPlainTextVerified = true`。
- **V05 浏览器**：`duplicateFramesIgnored = 1`、`gapTriggeredResyncCount = 1`、`stalePartialOverwrittenBySnapshot = true`、`oldSessionCardsAfterSwitch = 0`、`logoutClosedStreamAndReturned401 = true`。
- **V06 浏览器**：`unsavedEditDisabledApprove = true`、`savedNewRevision = 2`、`staleRevisionOldTabStatus = 409`、`expiredCardDisabledApprove = true`、`expiredOldTabStatus = 410`、`expiredSmtpSentDelta = 0`、`unknownPersistedAfterReloadLabel = "结果待核对"`、`badOriginStatus = 403`、`missingOriginStatus = 403`、`unauthStatus = 401`。

### 6.6 W1-A 九个用例复签明细（`runId = w1a_50aba5c5`）

| 用例 ID | 入口 | 类别 | 期望物理发送增量 | 实得 `serverCountDelta` | 账本与拒绝核对 | 结果 |
|---|---|---|---|---|---|---|
| `W1A-CTRL-ROUTER` | `router` | 足额对照 | `1` | `1` | `SETTLED`（`upper = 100`, `actual = 60`） | **PASS** |
| `W1A-CTRL-WORKER` | `worker` | 足额对照 | `1` | `1` | `SETTLED`（`upper = 100`, `actual = 60`） | **PASS** |
| `W1A-CTRL-COMPACTION` | `compaction` | 足额对照 | `1` | `1` | `SETTLED`（`upper = 100`, `actual = 60`） | **PASS** |
| `W1A-NEG-1-ROUTER-TASK` | `router` | 任务余额少 1μ | `0` | `0` | `task_budget_exceeded`（`seq=15`），无预留，账本不变 | **PASS** |
| `W1A-NEG-2-ROUTER-DAY` | `router` | 日余额少 1μ | `0` | `0` | `day_budget_exceeded`（`seq=20`），无预留，账本不变 | **PASS** |
| `W1A-NEG-3-WORKER-TASK` | `worker` | 任务余额少 1μ | `0` | `0` | `task_budget_exceeded`（`seq=25`），无预留，账本不变 | **PASS** |
| `W1A-NEG-4-WORKER-DAY` | `worker` | 日余额少 1μ | `0` | `0` | `day_budget_exceeded`（`seq=29`），无预留，账本不变 | **PASS** |
| `W1A-NEG-5-COMPACTION-TASK` | `compaction` | 任务余额少 1μ | `0` | `0` | `task_budget_exceeded`（`seq=37`），无预留，账本不变 | **PASS** |
| `W1A-NEG-6-COMPACTION-DAY` | `compaction` | 日余额少 1μ | `0` | `0` | `day_budget_exceeded`（`seq=45`），无预留，账本不变 | **PASS** |

### 6.7 W1-B 强杀恢复复签明细（`runId = w1b_9d37a198`）

- 核心标识：`runtimeEpoch = ep_96958bee090c4143b2a95250b803f08b`，`conversationId = "8"`，`proposalId = prp_312c05d39d2e4a6c9afa36940abfc50a`，`approvalId = apr_8c11cbeffab840d6a5db84ed82a27e5c`，`effectId = efx_a188d34a18874f61bc76ba52cd3817b3`。
- 进程强杀与二次重启：Host #1 PID `26340`（`Stop-Process -Id 26340 -Force`，退出码 `4294967295`）-> Host #2 PID `9180` -> Host #3 PID `48764`。
- 最终核对：独立假 SMTP `totalReceived = 1`（`rawSha256 = dbb9564b...`，`modeAtArrival = hold_after_receive`，`replySent = null`），`claimCount = 1`，`approvalCount = 1`，重复 SDK 唤醒 `sdkResult = "closed"`，`finalEffectState = UNKNOWN`，原会话刷新后 `uiStatusLabel = "结果待核对"`，`secretLeaksCount = 0`。

---

## 7. 第 2 周治理库新增表与 SDK 实测结论

### 7.1 `aegis-gov.sqlite` 新增表清单（详见 [src/governance/db.ts](../../../src/governance/db.ts)）

| 表名 | 核心键与约束 | 职责 |
|---|---|---|
| `chat_commands` | `UNIQUE(principal_id, runtime_epoch, conversation_id, chat_key)`，`pi_request_id UNIQUE` | V04 聊天提交登记、稳定请求键与三窗口恢复 |
| `source_read_grants` | `source_type IN ('memory','imap','github_mcp','workspace_write')`，含 `revoked_at` | 来源读取与受管工作区写授权 |
| `model_disclosure_grants` | 绑定 `(principal_id, scope_id, source_type, source_id, provider, model_id, base_url, slot_name)` | 与来源读取分离的模型槽披露授权 |
| `conversation_sources` | 绑定 `(runtime_epoch, conversation_id)`，含 `parent_source_ids_json` | 会话来源溯源、污点继承与视图① 展开核对 |
| `mcp_server_pins` / `mcp_tool_pins` | `PRIMARY KEY(server_id, tool_name)`，`state IN ('APPROVED','QUARANTINED','REVOKED')` | MCP 二进制 SHA-256 与规范化工具定义钉扎 |
| `memory_notes` / `memory_notes_fts` / `memory_refs` / `memory_tombstones` | FTS5 虚拟表 + 软删墓碑 + 注入隔离标志 | 记忆 L0/L1/L2 存储、FTS 召回与墓碑过滤 |
| `managed_file_imports` | `logical_key UNIQUE`，`state IN ('PREPARED','INSTALLED','CONFLICT_SAVED','REJECTED','PENDING_RECONCILE')` | Docker 导出受管文件导入状态机与回执丢失幂等恢复 |

### 7.2 锁定 SDK 与 Windows 实测补充结论（无前提被推翻，无需新增偏离 ADR）

1. **`@earendil-works/pi-durable@1.6.0` `submissionByRequest` 核对安全**：实测 `Conversation.commit(tx => tx.submissionByRequest(cid, piRequestId))` 不会激活 `scheduler.resume()`，可在启动恢复 Step 5b（调度释放前）安全完成 V04 聊天核对。
2. **`@earendil-works/pi-mcp@1.6.0` 环境隔离**：`StdioTransport({ inheritEnv: false, env })` 在 Windows 上有效阻断无关宿主环境变量透传，仅向受控子进程注入显式声明变量（S6 与 V02 实测通过）。
3. **本机端口 `4310` 冲突处理**：`src/web/server.ts` 的 `serve()` 补全 `error` 监听器避免 `EADDRINUSE` 未捕获异常；`run-v01-v06-browser.ts` 优先尝试 `127.0.0.1:4310`，若被本机其他进程占用则回落至 `127.0.0.1:0`（实测 `http://127.0.0.1:60802`）并在证据中如实记录。

---

## 8. 替身结果与真实只读 / 未验证项分列

| 类别 | 项目 | 状态 | 说明 |
|---|---|---|---|
| **本地替身** | 假模型、假 IMAP（直连 + CONNECT）、假 GitHub MCP、假 SMTP | **PASS** | `S6`、`V01–V06`、`W1-A`、`W1-B`、`S1–S5` 与 25 项矩阵全绿 |
| **实机容器** | Windows 本地 Docker `29.9.2`（`--network none` 零凭据沙箱 + 私有卷只读导出） | **PASS** | 覆盖 `V03`、`S6`、`V01` |
| **实机浏览器** | Windows 本地 `msedge.exe` Headless CDP 视图① 交互 | **PASS** | 覆盖 `V01`、`V05`、`V06`（端口回落说明见 §7.2） |
| **真实只读连接器** | 真实 Gmail 只读 IMAP（`V02` 真实只读子项） | **待验证** | 缺少本次明确的人工授权范围与只读验收邮箱确认；严格不读取、不动用本机 `.env` 任何凭据 |
| **真实只读连接器** | 真实 GitHub MCP 只读（`V02` 真实只读子项） | **待验证** | 本机缺少授权的 `GITHUB_PAT` 与 `github-mcp-server.exe` |
| **流式指标子项** | V01 `firstTokenMs` 逐 token 首字延迟 | **待验证** | 本地假模型替身按整段 SSE 块返回，未细分逐 token 输出；`firstToolProgressMs = 168ms` 与 `completionMs = 12557ms` 已实测 |
| **阶段一禁区** | 真实模型计费、真实邮件外发、真实 GitHub 写入、公网监听、容器逃逸测试 | **保持关闭** | 阶段一硬边界，代码层与测试层均阻断 |

---

## 9. 历史基线参考（与本次 v2 第 2 周实测严格分离）

- **v1 历史零信任基线**（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）：自动化套件 `327/327 PASS`、自用验收 `31/31 PASS`（仅作历史溯源，不计入 v2 统计）。
- **v2 第 1 周签收基线**（`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`，`runId = week1_ef8d218c`）：`tsc` 通过、`S1–S5` 5/5、`W1-A` 9/9、`W1-B` 通过、矩阵 `25/25`。
- **v2 第 2 周本次实测**（冻结候选 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`）：`week2_203150f4`（`tsc`、分层守卫、`S6`、`V01–V06` 全绿）+ `week1_0c6fd47a`（`S1–S5` 5/5、`W1-A` 9/9、`W1-B`、矩阵 `25/25` 全绿）。

---

## 10. 第 1 轮独立审计结论（2026-11-26，香港时间）

**退回整改，暂缓第 2 周签收。** 冻结候选为 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`。正式启动入口尚无法完成纵切，连接器凭据、来源撤权和受管文件还存在宿主侧校验缺口。§1–§9 保留实施方提审记录，本节登记独立复跑及源码判定。请在同一份报告 §11 追加整改回复，逐项引用以下审计编号，给出新冻结 SHA、代码位置、实际命令、退出码和证据位置。

### 10.1 独立复跑核对表

| 核对项 | 审计人复跑结果 | 备注 / 复跑 `runId` / 证据目录 |
|---|---|---|
| 核对基线（`69ce7b9` / `47a4dd4`）与候选 `ea9b59c` | 通过 | 候选包含相对 W1 交接的 39 个变更文件。提审文档 HEAD `6814aa6` 相对候选仅增加报告与证据。复跑在 `ea9b59c` 的分离工作树上完成。 |
| 依赖锁定、类型检查 | 通过 | 直接依赖及 lockfile 沿用第一周锁定记录，SHA-256 与 §2 一致。独立 `tsc --noEmit` 退出 0。 |
| 第 2 周全量 `tests/week2/run-all.ts` | 未通过 | 退出 1。四个专项完成后，Edge 在 CDP 就绪前退出（子进程码 0，stderr 为空）。全量未生成汇总。浏览器两次独立重试均退出 1，分别见 §10.4。 |
| V04/V05 协议、V02、V03、S6 夹具 | 现有夹具通过 | `v04v05_a448375d`、`v02_0e331fd2`、`v03_18a5a36d`、`s6_bf175985` 均生成 PASS 结果。浏览器、首 token、真实 Gmail / GitHub 只读为待验证。夹具覆盖与任务书的差异见 §10.3。 |
| 同候选第 1 周全量 | 通过 | `week1_c291864d` 退出 0。S1–S5 5/5，矩阵 25/25。W1-A `w1a_9b41ea16` 的足额对照各 +1，六组不足各 +0。W1-B `w1b_38cca226` 实测独立 SMTP 累计收件 1、领取 1，原会话快照标记 UNKNOWN／“结果待核对”。 |
| 旧治理库副本正常开库两次 | 通过 | 退出 0。8 条授权及历史审批、效果、账本摘要保留，6 条预算拒绝归属补齐，外键异常 0，第二次开库结果一致。 |
| **第 2 周第 1 轮签收** | **退回整改** | Codex 独立审计，2026-11-26（香港时间）。 |

### 10.2 工程约束审查发现

| 编号 | 级别（P1/P2） | 候选实现中的问题与源码位置 | 复验条件 |
|---|---|---|---|
| W2-G1 | P1 | **S6 · 凭据选择与实际目的端没有绑定。** 凭据库的连接器查找仅匹配 kind。IMAP 按 mailbox 授权后另取 host、TLS servername 和账号；MCP 校验登记文件的摘要，却通过单独配置的 command/args 启动。实际注入凭据的目标需要由受信配置和授权共同确定。[凭据库](../../../src/governance/credentials.ts#L79) · [IMAP](../../../src/capabilities/mail/imap-client.ts#L73) · [MCP](../../../src/runtime/mcp-bridge.ts#L99) | 在交付凭据前核对账号、目标和允许连接的 TLS 身份，以及实际启动的 MCP 工件、固定启动参数和只读配置。用合成凭据证明匹配配置可读，目标或工件不匹配时登录、启动增量均为 0。 |
| W2-G2 | P2 | **执行镜像按可变 tag 启动。** 执行器在启动后才读取容器镜像 ID，导出器同样按 tag 启动。v2.3 裁决 1 要求记录镜像完整性，v1 设计包 02 §5 要求执行镜像以 digest 固定。[执行](../../../src/capabilities/workspace/docker-sandbox.ts#L77) · [导出](../../../src/capabilities/workspace/docker-sandbox.ts#L294) | 执行和只读导出启动前核对获准的不可变镜像身份，并留各自的实际镜像摘要。缺失或不匹配须在启动前终止。 |

### 10.3 任务书与验收证据审查发现

| 编号 | 级别（P1/P2） | 候选实现或夹具与签收条件的差异 | 复验条件 |
|---|---|---|---|
| W2-S1 | P1 | **V01 · 正式入口没有接通纵切能力。** `src/index.ts` 启动 Runtime 时未传 IMAP、MCP 和工作区处理器，相关工具返回未配置。浏览器夹具自行构建 Runtime、注入处理器及写入预设报告，证明了组件组合路径。[正式入口](../../../src/index.ts#L138) · [能力注册](../../../src/runtime/extensions/aegis-policy.ts#L354) · [浏览器夹具](../../../tests/week2/run-v01-v06-browser.ts#L333) | 用交付的正式入口和受信本地配置启动独立宿主进程，由视图①完成演示。证据含所选邮件 UID、仓库提交 SHA、两处时间差异、Router/Worker 账本、授权文件字节及断线后界面。缺少授权或配置时保持拒绝。 |
| W2-S2 | P1 | **V01–V03/V05 · 来源撤权未贯穿读、派生与回放。** 记忆引用遍历检查主体、作用域和墓碑，缺引用节点的域授权复核。冻结 L0 缓存跨运行复用，最终模型门控只查披露规则。导入只核文件写授权并记录父来源。快照及 SSE 逐帧校验也缺来源权限。[记忆引用](../../../src/capabilities/memory/store.ts#L410) · [L0 缓存](../../../src/runtime/extensions/aegis-context.ts#L39) · [披露门控](../../../src/governance/policy.ts#L413) · [导入](../../../src/capabilities/workspace/importer.ts#L280) · [SSE](../../../src/web/server.ts#L882) | 逐节点与派生物父来源复核实时授权。保留模型披露规则、单独撤销来源读取后，实际 Router、委派 Worker、压缩和 durable 重试均不发送被撤材料。重取快照及旧流后续帧无受限内容，收束旧流，权威目标和冲突候选字节均不变。 |
| W2-S3 | P1 | **V03 · 基准版本来自模型，回执恢复缺产品路径。** 工具把模型参数 `baseSha256` 传入处理器，夹具也采用该值作为导入基准。导入器在重入时可核对 PREPARED，现有夹具只是同一宿主内抛异常后再次直接调用导入器；普通成功路径还在完成回执后另记来源。[工具](../../../src/runtime/extensions/aegis-policy.ts#L521) · [夹具处理器](../../../tests/week2/run-v01-v06-browser.ts#L351) · [导入器](../../../src/capabilities/workspace/importer.ts#L201) · [回执与来源](../../../src/capabilities/workspace/importer.ts#L551) · [V03 夹具](../../../tests/week2/run-v03.ts#L392) | 用宿主在任务快照时记录的目标版本与任务卷，不接受模型声明替代。原子安装后、回执前强杀正式宿主，从正常恢复入口核对同一逻辑导入、来源与原会话，证明累计安装 1 次。目标在快照后发生改变则保留两版。 |
| W2-S4 | P2 | **V04/V05 · 浏览器重试键与游标处理仍有缺口。** 待提交键只在页面内存且切会话即清除，刷新时无法恢复原键。partial 帧绕过序号验证，首个序号断档也可略过。投影的并发刷新在异步读之后直接发布，新序号可以承载先前读到的旧状态。[聊天状态](../../../src/web/view1.ts#L676) · [游标](../../../src/web/view1.ts#L306) · [投影](../../../src/web/projection.ts#L294) | 浏览器跨刷新以同一主体、代际与会话下的原键重试。所有带序号帧走同一连续性检查。用确定性夹具覆盖旧读取后完成、首帧缺号、partial 重复或缺号及真实断线重连，终态和游标与权威快照一致。 |
| W2-S5 | P2 | **V02 · 无符合主题的邮件时扩大了读取范围。** 当前筛选结果为空时改从所有邮件中选择最新 UID，随即读取正文。[IMAP 选择逻辑](../../../src/capabilities/mail/imap-child.ts#L326) | 用包含较新无关邮件的合成邮箱检查有命中和无命中两种路径。无命中返回明确结果，独立 IMAP 记录显示无关正文读取增量 0。 |
| W2-S6 | P2 | **S6/V06 · 提审通过范围超出实际断言。** S6 在宿主关闭后才条件扫描 WAL，未保留运行中 WAL、URL、宿主日志及无关子进程的逐槽覆盖证据。V06 浏览器夹具通过 SQL 将效果改为 UNKNOWN 后刷新，该用例测到了展示，W1-B 另有真实强杀证据。[S6 采样](../../../tests/week2/run-s6.ts#L349) · [V06 状态写入](../../../tests/week2/run-v01-v06-browser.ts#L843) | 分时点记录实际采到的位置、阳性对照和逐槽命中数。未取到的样本标待验证。把 W1-B 实际恢复出的数据库与本候选的浏览器刷新相连，保留同一 effectId 的批准、领取、收件数及 UNKNOWN 页面断言。 |
| W2-S7 | P2 | **V06 · 已打开审批页的本地状态依赖重绘。** 测试在期限经过后手动刷新才检查过期禁批。SSE 重绘只保留 dirty 标记，草稿文本会被服务端版本覆盖。[审批卡](../../../src/web/view1.ts#L486) · [过期夹具](../../../tests/week2/run-v01-v06-browser.ts#L781) | 卡片保持打开并跨过期限，无须手动刷新即可禁批。编辑中收到无关事件后保留本地草稿，旧 revision 仍由服务端拒绝。 |

### 10.4 审计人独立复跑命令与原始证据位置

环境为 Windows x64 10.0.26300、Node 22.23.5、SQLite 3.54.1、npm 10.9.9、Docker Client/Server 29.9.2、Edge 157.0.4341.60，时区 Asia/Hong_Kong。本机使用同锁文件的既有 `node_modules`，通过目录联接供分离工作树使用。Docker 本地测试镜像摘要为 `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`。本次原始材料留在本机规划目录，报告仅写脱敏结果。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round1-fadcc51d'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode ./node_modules/typescript/bin/tsc --noEmit *> '../typecheck.log'
& $auditNode tests/week1/run-all.ts --data-dir '../week1/data' --evidence-dir '../week1/evidence' --keep-data true *> '../week1.log'
& $auditNode tests/week2/run-all.ts --data-dir '../week2/data' --evidence-dir '../week2/evidence' --keep-data true *> '../week2.log'
$probe = Get-Content -Raw -Encoding utf8 '..\..\round4-1795655498209\legacy-schema-probe.mjs'
& $auditNode --input-type=module -e $probe '..\..\round2-1795619937294\data\w1-a\host-data\aegis-gov.sqlite' '../legacy-copy.sqlite' '../legacy-schema-check.json'
$browserData = Join-Path $env:TEMP 'agw2-fadcc51d-browser'
& $auditNode tests/week2/run-v01-v06-browser.ts --data-dir $browserData --evidence-dir '../browser-retry/evidence' *> '../browser-retry.log'
$browserData = Join-Path $env:TEMP 'agw2-fadcc51d-browser2'
& $auditNode --input-type=module -e 'import {runV01V06Browser} from "./tests/week2/run-v01-v06-browser.ts"; const r = await runV01V06Browser({dataDir:process.argv[1],evidenceDir:process.argv[2]}); console.log(JSON.stringify({runId:r.report.runId,status:r.report.status,evidencePath:r.evidencePath}));' $browserData '../browser-retry2/evidence' *> '../browser-retry2.log'
```

第一周、第二周全量使用独立数据目录并行运行。复跑证据在 `week1/evidence/`、`week2/evidence/` 和 `legacy-schema-check.json`，原始错误在上述日志。首次浏览器单项重试的 CLI 忽略目录参数，随后清理 profile 时出现 `EBUSY`。第二次直接调用导出函数传入短临时路径，仍在 CDP 就绪前退出。请在下一候选修正 §3.4 的单项入口参数和浏览器退出后的清理，并确保汇总能记录未完成子项。浏览器环境故障的原因尚未确定。

---

## 11. 第 1 轮审计整改回执与第 2 轮复审签收栏（冻结候选 `efba0ed`）

- **第 2 轮冻结代码候选提交（全号）**：`efba0eda53a21cf5f935846377f8ab03ff42eb69`
- **提交信息**：`fix(v2): remediate Week 2 Round 1 audit findings (W2-G1, W2-G2, W2-S1..S7, browser harness)`
- **相对第 1 轮候选 `ea9b59c` 的代码变更范围**：28 个文件（`+4662 / -1164`），`package.json` 与 `package-lock.json`（SHA-256 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`）零变动，锁定工具链与单向四层依赖保持不变。
- **同候选全量验证结果（均在 `HEAD = efba0eda53a21cf5f935846377f8ab03ff42eb69` 上以锁定 Node 与全新临时目录完成）**：
  - `tsc --noEmit`：退出码 `0`
  - `tests/week1/run-all.ts`：退出码 `0`，`runId = week1_61255801`（`S1–S5` 5/5、`W1-A` 9/9、`W1-B` PASS、矩阵 25/25）
  - `tests/week2/run-all.ts`：退出码 `0`，`runId = week2_57fd5f62`（`typecheck`、`layerBoundary`、`V04_V05`、`V02`、`V03`、`S6`、`V01_V05_V06_BROWSER` 全部 PASS）
  - 脱敏证据目录：[evidence/round2/week1/](evidence/round2/week1/) 与 [evidence/round2/week2/](evidence/round2/week2/)（对应 `efba0ed` 实测产物；第 1 轮 `ea9b59c` 原始证据已按 W2-R2-E1 恢复至 `evidence/week1/` 与 `evidence/week2/`）。

### 11.1 针对 §10 全部 9 项缺陷与 §10.4 的逐项整改映射表

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `efba0ed` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-G1** | P1 | **连接器凭据目标绑定与固定 MCP 启动参数校验。** 在凭据库新增 `ImapCredentialBinding` / `GithubMcpCredentialBinding` 与目标校验解析器 `resolveImapSecretForTarget` / `resolveGithubMcpSecretForTarget`；`aegis-gov.sqlite` Migration 3 为 `mcp_server_pins` 幂等补齐 `command` / `args_json`；`mcp-pin.ts` 同时钉扎并校验可执行工件 SHA-256 与固定 `command` / `args`；`imap-client.ts` 在拉起子进程前核对授权允许的 `host` / `servername` / `username` 与凭据槽目标绑定；`mcp-bridge.ts` 在启动 `StdioTransport` 前核对钉扎工件、参数与只读标志绑定。[credentials.ts](../../../src/governance/credentials.ts) · [db.ts](../../../src/governance/db.ts) · [mcp-pin.ts](../../../src/governance/mcp-pin.ts) · [imap-client.ts](../../../src/capabilities/mail/imap-client.ts) · [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) | `V02`（`runId = v02_2eb0985a`）：错 SNI 返 `imap_grant_tls_identity_mismatch`、错账号返 `imap_grant_account_mismatch`、错目标槽返 `imap_credential_target_mismatch`，`imapMismatchLoginsDelta = 0`；错 MCP 启动参数返 `mcp_args_mismatch`，`mcpMismatchSpawnsDelta = 0`；`pinnedCommandAndArgsVerified = true`；`totalToolCallsOnServer = 1`、`totalWriteCallsOnServer = 0`。证据：[v02-evidence.json](evidence/round2/week2/v02-evidence.json) |
| **W2-G2** | P2 | **执行器与只读导出器启动前核对不可变镜像摘要并直接按 digest 启动。** 新增 `verifyApprovedSandboxImageDigest` / `verifyApprovedSandboxImageDigestAsync` 及异步非阻塞执行/导出通道（`runTaskInDockerSandboxAsync`、`verifyAllVolumeWritersExitedAsync`、`exportRegularFilesFromVolumeReadOnlyAsync`）；执行器与导出器均强制要求 `approvedImageId`（`sha256:<64-hex>`），在 `docker run` 之前检验本地镜像存在且匹配，并以不可变镜像 ID 直接启动，分别落盘 `executorImageId` 与 `exporterImageId`。同时修复同步 `spawnSync("docker", ...)` 长时间阻塞事件循环触发 HTTP keep-alive `ECONNRESET` 的隐患。[docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts) · [importer.ts](../../../src/capabilities/workspace/importer.ts) | `V03`（`runId = v03_00298889`）与 `S6`（`runId = s6_c5a55850`）：`approvedImageId = executorImageId = exporterImageId = sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`；缺失摘要启动前拒返 `unapproved_or_missing_image_digest`，错摘要在执行器与导出器均启动前拒返 `approved_image_digest_not_found`。证据：[v03-evidence.json](evidence/round2/week2/v03-evidence.json) · [s6-evidence.json](evidence/round2/week2/s6-evidence.json) |
| **W2-S1** | P1 | **正式入口 `src/index.ts` 接通完整纵切能力且未配置时保持 fail-closed。** `src/index.ts` 新增 `--connectors-config` / `AEGISPI_CONNECTORS_CONFIG`、`--approval-ttl-ms` 与故障注入开关 `--fault-after-import-install-before-receipt`，从受信本地配置加载连接器定义、仅从宿主环境加载密钥进入目标绑定凭据库，真实接入 `ImapReadOnlyClient`、`GitHubMcpBridge`（钉扎校验）与 `ManagedWorkspaceImporter`（异步 Docker 沙箱）；未配置连接器时保持拒绝。浏览器验收套件 `run-v01-v06-browser.ts` 改为启动独立正式子进程 `src/index.ts` 完成未配置 fail-closed 验证与完整 V01 演示，不再自组装假 handler 或预设写入报告。[index.ts](../../../src/index.ts) · [run-v01-v06-browser.ts](../../../tests/week2/run-v01-v06-browser.ts) | `V01_V05_V06_BROWSER`（`runId = v01v06_4fc0ba05`）：`formalEntrypoint = "src/index.ts"`、`formalEntrypointUsed = true`、`unconfiguredHostFailClosedVerified = true`；通过实机 Edge 在 `http://127.0.0.1:60796` 完成演示句，`selectedEmailUid = 102`，`repoCommitSha = a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`，两处时间差异核对一致，`firstToolProgressMs = 197`、`completionMs = 13821`，`reports/weekly.md` 字节 SHA-256 精确匹配 `31d1598f4b8470cfa54994d6a8e52b0b31f39762dad5b63608bda58837108c1c`，刷新后来源（`memory`/`imap`/`github_mcp`/`workspace_file`）与 7 步 Router/Worker 预算均可见。证据：[v01-v06-browser-evidence.json](evidence/round2/week2/v01-v06-browser-evidence.json) |
| **W2-S2** | P1 | **来源读取实时撤权贯穿记忆遍历、L0 构造、模型门控、受管导入、快照与 SSE 逐帧流。** (1) `memory/store.ts` 在 hop 0 及每一跳引用遍历逐节点调用 `checkSourceReadAuthorized`；(2) `aegis-context.ts` 移除跨运行静态 `frozenL0ByConv` 缓存，每次构造前实时复核域授权；(3) `policy.ts` 新增 `checkRecordedSourceReadStillAuthorized`、`verifyAllConversationSourcesReadAuthorized` 与 `getSourceReadRevocationWatermark`，在 `checkConversationModelDisclosure` 内递归复核全部直接与父来源实时读取授权（覆盖 Router、委派 Worker、Compaction 与 durable retry）；(4) `importer.ts` 在原子安装与写冲突候选前均复核父/会话来源实时读取授权；(5) `server.ts` 与 `projection.ts` 在 `/snapshot` 中过滤并脱敏已撤权来源，在已打开 SSE 流逐帧检查 `source_read_grants` 撤销水位，命中撤权立即发 `resync (source_read_revoked)` 并收束旧流。[store.ts](../../../src/capabilities/memory/store.ts) · [aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts) · [policy.ts](../../../src/governance/policy.ts) · [importer.ts](../../../src/capabilities/workspace/importer.ts) · [server.ts](../../../src/web/server.ts) · [projection.ts](../../../src/web/projection.ts) | `V02`（`v02_2eb0985a`）：`unauthorizedDomainRefHits = 0`；保留模型披露规则、单独撤销来源读取后，`durableRetryExtraSendsAfterRevoke = 0`、`routerWorkerCompactionSendsDelta = 0`、`l0AndTaintedMarkerHitsDelta = 0`；保留读取授权、单独撤销披露后 `disclosureRevokedWhileReadActiveSendsDelta = 0`。`V03`（`v03_00298889`）：撤销父来源后导入拒返 `source_read_revoked`，`targetUnchanged = true`、`conflictFilesCreatedDelta = 0`。`V04_V05`（`v04v05_c965b9dc`）：`sourceRevokeOldStreamResyncReason = "source_read_revoked"`、`sourceRevokeOldStreamBusinessFrames = 0`、`sourceRevokeRefetchedSnapshotRedacted = true`。证据：[v02-evidence.json](evidence/round2/week2/v02-evidence.json) · [v03-evidence.json](evidence/round2/week2/v03-evidence.json) · [v04-v05-evidence.json](evidence/round2/week2/v04-v05-evidence.json) |
| **W2-S3** | P1 | **基准版本改由宿主权威采集，导入回执与来源原子落盘并接入正式启动恢复 Step 5c。** 从 `workspace_write_managed` 模型工具入参中移除 `baseSha256`；宿主在任务快照阶段通过 `ManagedWorkspaceImporter.captureHostBaseline` 记录权威基准并按任务维护，`src/index.ts` 与 `importer.ts` 严格忽略模型声明；`importer.ts` 将 `INSTALLED` 回执与 `conversation_sources (workspace_file)` 溯源写入同一 `BEGIN IMMEDIATE` 事务；新增启动恢复入口 `ManagedWorkspaceImporter.reconcilePendingImportsOnStartup` 并接入 `harness.ts` Step 5c（调度释放之前），在强杀重启后按权威目标哈希核对 `PREPARED` 记录并补齐 `INSTALLED` 回执与 `workspace_file` 来源，不二次写盘。[aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) · [importer.ts](../../../src/capabilities/workspace/importer.ts) · [harness.ts](../../../src/runtime/harness.ts) · [index.ts](../../../src/index.ts) · [run-v03.ts](../../../tests/week2/run-v03.ts) | `V03`（`runId = v03_00298889`）：启动正式 `src/index.ts` 挂载 `--fault-after-import-install-before-receipt`，安装落盘后用 `Stop-Process -Force` 强杀 PID `39896`，重启正式宿主 PID `31736` 由 Step 5c 核对同一逻辑键 `wimp:ep_7717dae9cc624c128b3d560f151c4a8e:8:19:tc_v03_crash_v03_00298889`，`reconciledOutcome = "reconciled_installed"`、`installCount = 1`、`diskRewrittenOnRestart = false`、`workspaceFileSourceReconciledInSnapshot = true`；模型试图伪造基准版本时被忽略并保留两版（`modelSpoofedBaseSha256IgnoredConflictSaved = true`，`spoofConflictRelPath = "reports/spoof-check.conflict-4dc6b87cee.md"`）。证据：[v03-evidence.json](evidence/round2/week2/v03-evidence.json) |
| **W2-S4** | P2 | **浏览器跨刷新保留原聊天提交键，统一所有带序号帧连续性校验，并串行化投影并发刷新。** (1) `view1.ts` 将待提交 `{ key, content }` 按 `(principalId, runtimeEpoch, conversationId)` 持久化到 `sessionStorage`，切会话与刷新后自动恢复原键重试；(2) `view1.ts` 将 `snapshot` / `delta` / `partial` 统一收敛至 `acceptSequencedFrame`，移除 `state.lastSeq > 0` 跳过逻辑，首帧断档与 `partial` 重复/断档均精确去重或触发 `resync`；(3) `projection.ts` 对 `#refreshProjection` 实施 `refreshInFlight` + `pendingRefresh` + `refreshGeneration` 严格串行化，防止后完成的旧异步快照覆盖新状态。[view1.ts](../../../src/web/view1.ts) · [projection.ts](../../../src/web/projection.ts) | `V04_V05`（`v04v05_c965b9dc`）：`projectionConcurrentStaleReadSerialized = true`。`V01_V05_V06_BROWSER`（`v01v06_4fc0ba05`）：`persistedChatKeyAcrossReload = "ui-chat-1795664791640-017144a9"`、`retryAdmittedWithSameChatKey = true`、`duplicateDeltaIgnored = 1`、`duplicatePartialIgnored = 1`、`partialGapTriggeredResync = true`、`firstFrameGapTriggeredResync = true`、`stalePartialOverwrittenBySnapshot = true`、`realDisconnectReconnectCursorMatched = true`。证据：[v04-v05-evidence.json](evidence/round2/week2/v04-v05-evidence.json) · [v01-v06-browser-evidence.json](evidence/round2/week2/v01-v06-browser-evidence.json) |
| **W2-S5** | P2 | **IMAP 按主题筛选无命中时不扩大读取范围。** 删除 `imap-child.ts` 中筛选结果为 0 时回落全邮箱的逻辑，直接返回 `{ ok: true, code: "no_matching_message", found: false, message: null }` 且不执行任何正文 `FETCH`；`fake-imap-server.ts` 独立记录 `bodyTextFetchedUids`。[imap-child.ts](../../../src/capabilities/mail/imap-child.ts) · [fake-imap-server.ts](../../../tests/fakes/fake-imap-server.ts) | `V02`（`v02_2eb0985a`）：合成邮箱含较新无关邮件 UID `103`；有命中时 `filterHitSelectedUid = 102`、`filterHitUnrelatedUid103Fetched = false`；无命中时 `filterMissCode = "no_matching_message"`、`filterMissBodyFetchDelta = 0`、`totalSelectCommands = 0`、`totalNonPeekFetches = 0`。证据：[v02-evidence.json](evidence/round2/week2/v02-evidence.json) |
| **W2-S6** | P2 | **S6 运行期分时点采集完整矩阵；V06 浏览器 `UNKNOWN` 改为直连真实 W1-B 强杀恢复库。** (1) `run-s6.ts` 在宿主运行期间分 5 个活跃时点（含 `router_and_worker_live`、`compaction_web_live`、`imap_mcp_and_unrelated_child_live`、`docker_sandbox_live`、`post_restart_live`）实时扫描 `aegis-gov.sqlite-wal`、`pi-durable.sqlite-wal`、捕获 URL、宿主运行日志、假服务日志与无关子进程环境，按时点记录字节数与命中数，未采样项显式落盘 `uncollectedSamples`；(2) `run-v01-v06-browser.ts` 删除所有直接 SQL 改写 `UNKNOWN` 的逻辑，改为直接执行真实 `runW1B`（实机 `Stop-Process -Force` 强杀扣应答假 SMTP -> 真实重启恢复），再启动正式 `src/index.ts` 挂载恢复后的 `host-data` 数据库，并在 Edge 刷新前后核对同一 `effectId`。[run-s6.ts](../../../tests/week2/run-s6.ts) · [run-v01-v06-browser.ts](../../../tests/week2/run-v01-v06-browser.ts) | `S6`（`s6_c5a55850`）：阳性对照 `2/2`；运行期 WAL 实采非零（`aegis-gov.sqlite-wal` 832272 / 877592 B、`pi-durable.sqlite-wal` 1017672 / 1194832 B），`capturedUrlsCount = 9`、`unrelatedChildEnvKeysCount = 83`、`uncollectedSamples = []`、5 个槽位 `totalForbiddenHits = 0`。`V01_V05_V06_BROWSER`（`v01v06_4fc0ba05`）：直连真实 `runW1B`（`w1bRunId = w1b_a7a10f7b`，强杀 PID `39960`，`effectId = efx_671c924828da4812aa4210f55570079a`，`approvalCount = 1`、`claimCount = 1`、`smtpTotalReceived = 1`），Edge 刷新后仍显 `"结果待核对"`。证据：[s6-evidence.json](evidence/round2/week2/s6-evidence.json) · [v01-v06-browser-evidence.json](evidence/round2/week2/v01-v06-browser-evidence.json) |
| **W2-S7** | P2 | **打开状态审批卡的本地草稿防覆盖与无刷新自动过期禁批。** `view1.ts` 按提案 ID 保留未保存本地草稿 `localDraftTextByProposal`，无关 SSE 重绘时不覆盖用户输入；新增基于服务端时钟偏移（`serverNow`）的 200ms 本地定时器 `enforceLocalProposalExpirations`，卡片保持打开并跨过 `expiresAt` 时无需手动刷新即可自动禁用批准按钮并标记“已过期”；`server.ts` 保存草稿修订时沿用宿主配置的 `approvalTtlMs`。[view1.ts](../../../src/web/view1.ts) · [server.ts](../../../src/web/server.ts) | `V01_V05_V06_BROWSER`（`v01v06_4fc0ba05`）：`unsavedEditDisabledApprove = true`、`unsavedDraftPreservedAcrossUnrelatedSse = true`、`savedNewRevision = 2`、`staleRevisionOldTabStatus = 409`、`openCardAutoExpiredWithoutReload = true`、`expiredOldTabStatus = 410`、`expiredSmtpSentDelta = 0`。证据：[v01-v06-browser-evidence.json](evidence/round2/week2/v01-v06-browser-evidence.json) |
| **§10.4 工程项** | 工程可靠性 | **统一单项入口 CLI 参数、加固 Edge CDP 启动与退出清理、保证全量异常时仍落盘汇总。** 新增 `tests/week2/cli-helpers.ts`：`parseWeek2CliArgs` 统一解析 `--data-dir` / `--evidence-dir` / `--keep-data` 并接入全部 5 个单项 `run-*.ts` 入口；`launchReliableHeadlessBrowser` 使用短临时 `os.tmpdir()` profile 目录与显式空闲端口，轮询 `/json/list` 与 `DevToolsActivePort` 并支持 `--headless=new` 失败自动回落 `--headless`，退出时先优雅关闭再 `taskkill /T /F` 并用 `rmDirWithRetry` 避免 Windows `EBUSY`；`run-all.ts` 在 `finally` 中始终写出 `week2-summary.json`，完整记录每个子项的 `PASS` / `FAIL` / `NOT_RUN`。[cli-helpers.ts](../../../tests/week2/cli-helpers.ts) · [run-all.ts](../../../tests/week2/run-all.ts) | 在 `efba0ed` 上全量运行 `tests/week2/run-all.ts` 退出码 `0`，实机 Edge CDP 一次启动通过、无 `EBUSY` 残留、`week2-summary.json` 完整落盘。证据：[week2-summary.json](evidence/round2/week2/week2-summary.json) |

### 11.2 第 2 轮冻结候选 `efba0ed` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = efba0eda53a21cf5f935846377f8ab03ff42eb69`、工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1 = Join-Path $env:TEMP 'aegis-w2r2-w1-733c4571'
$w2 = Join-Path $env:TEMP 'aegis-w2r2-w2-733c4571'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1 'data') --evidence-dir (Join-Path $w1 'evidence')
& $node tests/week2/run-all.ts --data-dir (Join-Path $w2 'data') --evidence-dir (Join-Path $w2 'evidence')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据 |
|---|---|---|---|---|---|
| `tsc --noEmit` | `0` | `week2_57fd5f62` | 纯 TypeScript 可擦除类型检查通过；单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round2/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_61255801` | `S1–S5` 5/5 PASS；矩阵 25/25 PASS（含 `R3-LEGACY-UPGRADE`）；`W1-A`（`w1a_b7bbd9e1`）3 足额对照各 `+1`、6 不足负例各 `0`；`W1-B`（`w1b_f807b927`）强杀 PID `33088` -> 重启 PID `42368` / `27520`，`effectId = efx_17db48eb65b746bbb311e3036cddb151`，独立假 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新后显“结果待核对”、`secretLeaksCount = 0` | **PASS** | [week1-summary.json](evidence/round2/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round2/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round2/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round2/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round2/week1/matrix-evidence.json) |
| **S6** | `0` | `s6_c5a55850` | 阳性对照 `2/2`；5 个运行期/重启采样点（含实时 WAL 字节）、9 条捕获 URL、宿主日志与 83 键无关子进程环境全覆，`uncollectedSamples = []`，5 个槽位 `totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round2/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_c965b9dc` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:4610d37be4cc20f7111d6d2ce95d7588`），同键异文与错代际返 409；快照后/订阅前批准不漏事件；来源撤权触发 `source_read_revoked` 且旧流 0 业务帧；投影并发旧读串行化通过 | **PASS** | [v04-v05-evidence.json](evidence/round2/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_2eb0985a` | 凭据目标绑定与 MCP 参数不匹配时登录/启动增量 `0`；记忆跨域引用命中 `0`；IMAP 无命中 `no_matching_message` 且无关正文读取增量 `0`、`totalSelectCommands = 0`、`totalNonPeekFetches = 0`；MCP `totalWriteCallsOnServer = 0`；单独撤销读取后 Router/Worker/Compaction/durable 重试发送增量均为 `0` | **PASS（替身）** | [v02-evidence.json](evidence/round2/week2/v02-evidence.json) |
| **V03** | `0` | `v03_00298889` | 实机 Docker `29.9.2` 执行器与导出器均以不可变镜像 ID `sha256:e9f565d3...` 启动；缺/错摘要启动前拒绝；正常导入 SHA-256 精确一致；撤权父来源拒返 `source_read_revoked`；正式宿主回执前强杀（PID `39896` -> 重启 PID `31736`）由 Step 5c 恢复，`installCount = 1`、`diskRewrittenOnRestart = false`、`workspaceFileSourceReconciledInSnapshot = true`；模型伪造基准版本触发冲突保护保留两版 | **PASS** | [v03-evidence.json](evidence/round2/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_4fc0ba05` | 正式入口 `src/index.ts` 启动独立宿主完成 V01 演示（`http://127.0.0.1:60796`、`selectedEmailUid = 102`、`repoCommitSha = a1b2c3d4...`、`reports/weekly.md` SHA-256 `31d1598f...`）及未配置 fail-closed；跨刷新保留原聊天键重试、首帧/partial 缺号与真实断线重连通过；本地草稿防 SSE 覆盖、打开卡片跨期无刷新自动禁批；直连真实 `runW1B`（`w1b_a7a10f7b`）强杀恢复库刷新仍显“结果待核对” | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round2/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 细粒度逐 token `firstTokenMs` 仍明确标为 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测分开列示。

### 11.3 第 2 轮审计人独立复跑与源码审查签收栏

第 2 轮独立复审核对冻结候选 `efba0eda53a21cf5f935846377f8ab03ff42eb69`。§11.1–11.2 为实施方提审结果，本节记录独立实测、源码判定和下轮复验条件。

#### 11.3.1 独立复跑核对表（第 2 轮）

| 核对项 | 审计人复跑结果（通过 / 未通过 / 待验证） | 备注 / 复跑 `runId` / 退出码 |
|---|---|---|
| 核对候选 `efba0eda53a21cf5f935846377f8ab03ff42eb69` 与仅文档差异 | 通过 | 独立分离工作树 HEAD 为该候选。提审 HEAD `c83dc44` 相对代码候选仅变更审计文档和脱敏证据。 |
| 依赖锁定、类型检查 `tsc --noEmit`、分层守卫 | 通过 | 8 项直接依赖与既有安装版本相符。lockfile 的 Git blob SHA-256 与 §11 一致，分离工作树检出的 CRLF 文件转换为 LF 后逐字节相符。两周类型检查退出 0，第二周分层守卫无违规。 |
| 第 2 周全量 `tests/week2/run-all.ts`（含实机 Edge CDP 与汇总落盘） | **未通过** | `week2_13b6b3bf`，退出 1，汇总成功落盘。V04/V05 协议 `v04v05_895ac03d`、V02 `v02_e5f82a3f`、V03 `v03_9035efd5`、S6 `s6_7bcb8bca` 夹具均通过。Edge 到达 V05 切换会话，旧卡片应为 0，实得 5。 |
| 单项 CLI 参数与浏览器退出清理 | 通过 | V02 `v02_48341395`、Edge `v01v06_a12f0f8e` 各在指定新数据目录运行，退出均为 0，产物写入指定证据目录。浏览器单项切换旧卡片为 0，未观察到 Edge profile 清理残留。一次通过与全量一次失败共同记录。 |
| 同候选第 1 周全量 `tests/week1/run-all.ts`（`S1–S5`、`W1-A`、`W1-B`、25 项矩阵） | 通过 | `week1_f52e01e6`，退出 0。S1–S5 5/5，矩阵 25/25。W1-A `w1a_87ecc1da` 三个足额各 +1、六个不足各 +0。W1-B `w1b_d3a98009` 领取 1、SMTP 累计收件 1、UNKNOWN 正确。Edge 单项另从其独立强杀恢复库 `w1b_f6725dc0` 刷新验证同一效果。 |
| 旧治理库副本连续开库升级校验（含 Migration 3 `mcp_server_pins`） | **MCP 迁移未通过** | 第一周旧库副本退出 0，8 条授权保留、6 条拒绝归属补齐、二次一致。第 1 轮 V02 的旧 MCP 库副本退出 1，两次开库均缺两列，见 W2-R2-M1。 |

#### 11.3.2 §10 缺陷逐项关闭复核表（第 2 轮）

| 审计编号 | 级别 | 复核结论（关闭 / 未关闭） | 审计人复核说明 |
|---|---|---|---|
| `W2-G1` | P1 | **关闭** | 新库目标绑定通过 V02。IMAP TLS 名称、账号、目标不匹配均在登录前拒绝，MCP 启动参数不符时无新增子进程启动；旧库迁移单列 W2-R2-M1。 |
| `W2-G2` | P2 | **关闭** | V03/S6 实测执行器和导出器使用同一获准的不可变 ID，缺少或错误摘要在启动前拒绝。 |
| `W2-S1` | P1 | **未关闭** | 正式入口已接通三项能力，独立浏览器全量执行到 V01 文件校验之后。恢复顺序仍有缺口，Runtime 在返回前调用 `resume()`，正式入口随后才赋值工作区处理器使用的宿主引用并连接 MCP。恢复中的调用可能早于依赖就绪。复验需从正式入口启动带挂起工作的合成库，证明依赖准备完毕后才放行相关步骤，并核对同一任务的结果。[恢复放行](../../../src/runtime/harness.ts#L1383) · [正式入口装配](../../../src/index.ts#L525) |
| `W2-S2` | P1 | **未关闭** | 当前 V02 证明普通生成、压缩和 durable 重试拒发；Worker 负例直接建立 Worker 会话后手工继承来源。V05 覆盖已连接的流，投影仍可向新订阅排入撤权前的历史帧，所用撤权水位在订阅建立后读取。新快照的审批草稿与标记为 `role=user` 的派生 Worker 输入也没有统一脱敏。应使历史及待发帧随来源授权失效，并把派生内容纳入同一权限检查。复验需用真实委派、撤权后重新订阅以及重取快照覆盖上述数据形态。文件写入撤权时序见 W2-S3。[Worker 夹具](../../../tests/week2/run-v02.ts#L914) · [历史重放](../../../src/web/projection.ts#L475) · [撤权水位](../../../src/web/server.ts#L927) · [快照](../../../src/web/server.ts#L331) |
| `W2-S3` | P1 | **未关闭** | 正式入口强杀后核对回执的正常样本通过。起始版本仍由进程级路径表共享，表在启动时建立、成功安装后推进，所有任务也复用同一输入目录。写入及父来源授权在异步检查和导出之前判断，目标及冲突候选安装前未复核。复验需按任务冻结输入与基准，覆盖同路径任务重叠、导出期间撤权，并证明撤权后的两处文件字节均无增量。安装恢复还须覆盖基准与产物摘要相同的情况，缺独立安装证据时保留待核对或事先收口为无需写盘。[任务基准](../../../src/index.ts#L285) · [授权检查](../../../src/capabilities/workspace/importer.ts#L511) · [安装](../../../src/capabilities/workspace/importer.ts#L819) · [启动核对](../../../src/capabilities/workspace/importer.ts#L228) |
| `W2-S4` | P2 | **未关闭** | 投影并发刷新及序号夹具通过。Edge 独立全量在新会话 ID 已更新时实得旧卡片 5 条；新建会话分支改变当前 ID 后等待列表请求，清理与关闭旧流延后发生。聊天 POST 的迟到成功回执还会按此时的会话清除输入和待提交键。复验需使切换在等待网络前清理旧视图并收束旧流，迟到回执只更新原命令记录；覆盖宿主已受理而浏览器未取得回执、刷新重试和跨会话回执，确认命令仍只受理一次且旧卡片数为 0。[会话切换](../../../src/web/view1.ts#L749) · [聊天回执](../../../src/web/view1.ts#L787) · [失败断言](../../../tests/week2/run-v01-v06-browser.ts#L731) |
| `W2-S5` | P2 | **关闭** | V02 全量及单项均复跑通过。主题未命中明确返回 `no_matching_message`，独立 IMAP 正文读取增量为 0，有命中时选 UID 102。 |
| `W2-S6` | P2 → P1 | **未关闭** | 活跃 WAL 采样改善，实测的 S6 夹具命中数为 0。正式入口从环境读取模型、控制台和连接器凭据，Docker CLI 子进程未设置独立环境，会继承宿主环境。S6 在测试进程内把标记写入 vault，另起的探测子进程无法证明正式入口隔离。应限制 Docker CLI 的环境并用正式启动入口的合成槽位逐位置取证。未采集位置标待验证，S6 运行期取证与真实 W1-B 恢复库的浏览器断言均须保留。[正式凭据装载](../../../src/index.ts#L147) · [Docker 启动](../../../src/capabilities/workspace/docker-sandbox.ts#L9) · [S6 探测](../../../tests/week2/run-s6.ts#L466) |
| `W2-S7` | P2 | **关闭** | 浏览器单项通过。编辑中收到无关 SSE 后草稿仍在，旧 revision 返回 409，打开的卡片无需刷新即可过期禁批，旧请求返回 410，SMTP 增量为 0。 |
| `§10.4`（CLI / Edge CDP / 清理 / 汇总） | 工程项 | **关闭** | 单项使用显式参数，Edge 成功进入正式页面，失败的第二周全量仍生成汇总。V05 实际失败归 W2-S4。 |

#### 11.3.3 第 2 轮最终签收结论

- **第 2 轮签收结论**：退回继续整改，暂缓阶段一第 2 周签收。来源撤权、导入提交和正式启动的凭据环境仍有阻断。真实 Gmail/GitHub 只读和 V01 首 token 耗时保留待验证。
- **审计人 / 日期**：Codex 独立复审，2026-11-26（香港时间）。

| 新增编号 | 级别 | 发现 | 复验条件 |
|---|---|---|---|
| W2-R2-M1 | P1 | **旧 MCP 钉扎表迁移被提前返回跳过。** 无待补预算拒绝时直接结束 schema 迁移，后续新增 `command` 与 `args_json` 的步骤未执行。对第 1 轮 V02 含实存行的库副本开库两次，各保留 1 条服务器和 1 条工具钉扎，外键异常 0，但两列均缺失。更新钉扎的 INSERT 引用了缺失列。[提前返回](../../../src/governance/db.ts#L465) · [迁移 3](../../../src/governance/db.ts#L567) · [钉扎写入](../../../src/governance/mcp-pin.ts#L83) | 让 MCP 列迁移独立于旧预算事件。用无待补预算拒绝、已有旧 MCP 钉扎行的副本走正常开库两次，列与旧行均保留、外键检查通过，之后能按授权流程补登启动绑定。 |
| W2-R2-E1 | P2 | **第一轮证据链接指向了第二轮数据。** §3.5、§4、§6 的历史 runId 保留，链接所用目录已被本轮证据覆盖。第一轮提审原始脱敏证据仍可由提交 `5cb67ee55da6fef4ea16bc444baccaa1b03aa717` 找回。 | 为各候选保留固定证据路径或不可变提交引用，逐项链接所指文件的 runId 与当轮表格一致。 |

请在同一份报告 §12 按未关闭及新增编号记录整改回执，附新的冻结候选 SHA 和对应证据。两周夹具须在同一最终候选上复跑。

#### 11.3.4 独立复跑命令与证据位置

复跑使用 Windows x64 10.0.26300、Node 22.23.5、SQLite 3.54.1、npm 10.9.9、Docker 29.9.2/29.9.2 和 Edge 157.0.4341.60。候选独立工作树通过目录联接使用既有锁定依赖。两个全量使用新数据目录并行运行，浏览器单项在全量失败后另建数据目录复跑。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round2-c4c3f954'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode tests/week1/run-all.ts --data-dir '../week1/data' --evidence-dir '../week1/evidence' --keep-data true *> '../week1.log'
& $auditNode tests/week2/run-all.ts --data-dir '../week2/data' --evidence-dir '../week2/evidence' --keep-data true *> '../week2.log'
& $auditNode tests/week2/run-v02.ts --data-dir '../cli-v02/data' --evidence-dir '../cli-v02/evidence' *> '../cli-v02.log'
& $auditNode tests/week2/run-v01-v06-browser.ts --data-dir '../browser-retry/data' --evidence-dir '../browser-retry/evidence' *> '../browser-retry.log'
$probe = Get-Content -Raw -Encoding utf8 '..\..\round4-1795655498209\legacy-schema-probe.mjs'
& $auditNode --input-type=module -e $probe '..\..\round2-1795619937294\data\w1-a\host-data\aegis-gov.sqlite' '../legacy-copy.sqlite' '../legacy-schema-check.json'
$probe = Get-Content -Raw -Encoding utf8 '../mcp-legacy-probe.mjs'
& $auditNode --input-type=module -e $probe '..\..\week2-round1-fadcc51d\week2\data\v02\host-data\aegis-gov.sqlite' '../mcp-legacy-confirm.sqlite' '../mcp-legacy-check.json' *> '../mcp-legacy.log'
```

独立原始材料留在 `$auditRoot`。全量及单项的 JSON 位于各自的 `evidence/` 目录；旧库结果见 `legacy-schema-check.json` 和 `mcp-legacy-check.json`。两份旧源库均以只读 SQLite 连接生成副本后才进行开库。第一轮提审的脱敏证据请在历史文档提交 `5cb67ee` 中按 §3.5 的相对路径查阅。

---

## 12. 第 2 轮审计整改回执与第 3 轮复审签收栏（冻结候选 `2dffb01`）

- **第 3 轮冻结代码候选提交（全号）**：`2dffb01fe0711a9b727b9f41006ed55bcac335b7`
- **提交信息**：`fix(v2): remediate Week 2 Round 2 audit findings (W2-R2-M1, W2-S1..S4, W2-S6)`
- **相对第 2 轮候选 `efba0ed` 的代码变更范围**：13 个文件（`+2116 / -711`），`package.json` 与 `package-lock.json`（SHA-256 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`）零变动，锁定工具链与单向四层依赖保持不变。
- **同候选全量验证结果（均在 `HEAD = 2dffb01fe0711a9b727b9f41006ed55bcac335b7` 上以锁定 Node 与全新临时目录完成）**：
  - `tsc --noEmit`：退出码 `0`
  - `tests/week1/run-all.ts`：退出码 `0`，`runId = week1_e72893f9`（`S1–S5` 5/5、`W1-A` 9/9、`W1-B` PASS、矩阵 25/25）
  - `tests/week2/run-all.ts`：退出码 `0`，`runId = week2_c948a676`（`typecheck`、`layerBoundary`、`V04_V05`、`V02`、`V03`、`S6`、`V01_V05_V06_BROWSER` 全部 PASS）
  - **版本化脱敏证据目录（关闭 `W2-R2-E1`）**：
    - 第 1 轮（`ea9b59c`，`week2_203150f4` / `week1_0c6fd47a`）：已完整恢复至 [evidence/week1/](evidence/week1/) 与 [evidence/week2/](evidence/week2/)（与 §1–§9 全部 `runId` 逐项一致）
    - 第 2 轮（`efba0ed`，`week2_57fd5f62` / `week1_61255801`）：独立固化至 [evidence/round2/week1/](evidence/round2/week1/) 与 [evidence/round2/week2/](evidence/round2/week2/)（与 §11 全部 `runId` 逐项一致）
    - **第 3 轮（`2dffb01`，`week2_c948a676` / `week1_e72893f9`）**：独立固化至 [evidence/round3/week1/](evidence/round3/week1/) 与 [evidence/round3/week2/](evidence/round3/week2/)（本机用户路径与合成密钥泄漏均校验为 `0`）。

### 12.1 针对 §11.3 全部 7 项未关闭及新增编号的逐项整改映射表

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `2dffb01` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-R2-M1** | P1 | **独立执行 MCP 钉扎列迁移，不再受预算拒绝回填提前返回跳过。** 将 `src/governance/db.ts` 中 Migration 2 改为 `if (legacyDenials.length > 0) { ... }`（移除提前 `return`），确保 Migration 3（为旧 `mcp_server_pins` 幂等追加 `command` 与 `args_json`）在任意旧库开库时无条件执行。[db.ts](../../../src/governance/db.ts#L465-L576) · [run-v02.ts](../../../tests/week2/run-v02.ts#L984-L1044) | `V02`（`runId = v02_209e8629`）：构造含旧 `mcp_server_pins`（1 行）与 `mcp_tool_pins`（1 行）且待补预算拒绝为 0 的旧库，走 `openGovernanceDb()` 连续开库两次，均补齐 `["command","args_json"]`、保留既有行、`PRAGMA foreign_key_check = 0`，并成功补登启动绑定。证据：[v02-evidence.json](evidence/round3/week2/v02-evidence.json) |
| **W2-S1** | P1 | **将连接器与宿主引用装配前移至 `harness.resume()` 之前。** 在 `AegisHostConfig` 新增异步钩子 `beforeResume?: (host) => Promise<void> | void`，于 `AegisHostRuntime.start()` 构建 `host` 后、调用 `harness.resume()` 释放调度之前执行；`src/index.ts` 将 `hostRef = readyHost` 与 `GitHubMcpBridge.connect()` 全部移入 `beforeResume`，消除恢复任务早于依赖就绪的竞态。[harness.ts](../../../src/runtime/harness.ts#L103-L104) · [harness.ts](../../../src/runtime/harness.ts#L1385-L1395) · [index.ts](../../../src/index.ts#L319-L339) · [run-v01-v06-browser.ts](../../../tests/week2/run-v01-v06-browser.ts#L963-L1165) | `V01_V05_V06_BROWSER`（`runId = v01v06_555dbbe5`）：正式入口 `src/index.ts` 在 Pi 持久受理后立即 `Stop-Process -Force` 强杀，重启挂载带挂起工作的合成库，`beforeResume` 先完成 `hostRef` 绑定与 MCP 建连再释放 `resume()`，恢复任务端到端读 GitHub MCP 并写入 `reports/resumed.md`（SHA-256 精确匹配 `883ccc83e26e65798f23e1da3e6d2a0956e0165457f8002784c2a139f775ed6d`）。证据：[v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **W2-S2** | P1 | **撤权贯穿真实委派 Worker、历史重放失效、订阅前水位采集及快照草稿/派生输入脱敏。** (1) `projection.ts` 为投影与每条缓冲帧记录 `revocationWatermark`，通过 `getRevocationWatermark` 在初始化、刷新、及 `openSubscription`（含游标历史重放前与订阅返回前）逐帧核对，任一历史帧水位过期立即清空缓冲历史并返 `resync (source_read_revoked)`；`server.ts` 直接沿用 `openSubscription` 订阅前采到的水位；(2) `server.ts` 快照构造跨 `convId` 与同任务 `relatedConvIds` 复核实时来源授权，命中撤权后统一脱敏审批草稿（`snapshot = { redacted: true }`、`target` 脱敏、`draftRedacted = true`）及派生 Worker 会话的 `role=user` 输入与 `chatCommands.contentPreview`；(3) `run-v02.ts` 改为通过真实 `run_worker` 工具委派产生子 Worker 会话再验证撤权阻断。[projection.ts](../../../src/web/projection.ts#L37-L600) · [server.ts](../../../src/web/server.ts#L176-L370) · [run-v02.ts](../../../tests/week2/run-v02.ts#L837-L952) · [run-v04-v05.ts](../../../tests/week2/run-v04-v05.ts#L844-L1005) | `V02`（`v02_209e8629`）：`realDelegatedWorkerUsed = true`（`realDelegatedWorkerConvId = "31"`），保留披露单撤读取后 `durableRetryExtraSendsAfterRevoke = 0`、`routerWorkerCompactionSendsDelta = 0`、`l0AndTaintedMarkerHitsDelta = 0`。`V04_V05`（`v04v05_a29b8d30`）：`sourceRevokeOldStreamBusinessFrames = 0`、`sourceRevokeResubscribePreRevokeCursorBusinessFrames = 0`（撤权后携旧游标重连直接 `resync`、0 历史泄漏）、`sourceRevokeApprovalDraftRedacted = true`、`sourceRevokeDelegatedWorkerUserInputRedacted = true`。证据：[v02-evidence.json](evidence/round3/week2/v02-evidence.json) · [v04-v05-evidence.json](evidence/round3/week2/v04-v05-evidence.json) |
| **W2-S3** | P1 | **按任务冻结独立输入快照与基准、导出后安装前复核授权、同摘要无写盘收口与保守恢复。** (1) `importer.ts` 新增 `createTaskFrozenSnapshot` 为每个任务复制独立 `/input` 目录并冻结不可变基准表；`src/index.ts` 按任务键维护 `taskFrozenSnapshots`，同路径重叠任务互不推进基准；(2) `importer.ts` 在异步写者退出检查与只读导出完成后（Step 3b，紧贴落盘前）再次复核 `workspace_write` 与全部父/会话来源读取授权，任一失效即拒且目标与冲突候选字节均无增量；(3) `baseSha256 === artifactSha256` 时正常路径在写 `PREPARED` 与写盘前收口为 `noop_unchanged`（`installCount = 0`），而启动恢复与重入遇 `PREPARED` 同摘要记录且缺独立安装证据时保守转 `PENDING_RECONCILE (ambiguous_same_hash_without_install_proof)`。[importer.ts](../../../src/capabilities/workspace/importer.ts#L149-L332) · [importer.ts](../../../src/capabilities/workspace/importer.ts#L838-L1000) · [index.ts](../../../src/index.ts#L298-L410) · [run-v03.ts](../../../tests/week2/run-v03.ts#L640-L905) | `V03`（`runId = v03_c4621b31`）：同路径重叠两任务独立冻结快照，Task A 安装后 Task B 触发 `CONFLICT_SAVED`（`reports/overlap.conflict-c0213a3d36.md`）并保住 A 版本；导出窗口内撤来源返 `source_read_revoked`、撤写授权返 `workspace_write_denied`，目标与冲突候选增量均为 `0`；同摘要正常路径 `noop_unchanged`（`installCount = 0`），同摘要 `PREPARED` 启动核对转 `pending_reconcile (ambiguous_same_hash_without_install_proof)`；正式宿主回执前强杀（PID `29672` -> 重启 PID `26240`）仍由 Step 5c 唯一恢复 `installCount = 1` 且忽略模型伪造基准。证据：[v03-evidence.json](evidence/round3/week2/v03-evidence.json) |
| **W2-S4** | P2 | **会话切换在等待网络前即时清卡关流，迟到聊天回执严格绑定原会话与原提交键。** (1) `view1.ts` 在 `#new-conv-btn` 拿到新会话 ID 后、调用 `loadConversations()` 等待列表前立即递增 `selectionGeneration`、执行 `closeSse()` 与 `clearAllSessionViews()`、重置游标与输入框，且 `loadConversations(expectedGen)` 丢弃陈旧响应；(2) `#chat-send-btn` 在 `fetch` 前捕获 `reqConvId` / `reqEpoch` / `reqChatKey` / `reqContent`，迟到 `ADMITTED` 回执仅通过 `clearPendingChatIfMatch` 清理原键并记录原会话状态，绝不清空已切换新会话的输入框或待提交键。[view1.ts](../../../src/web/view1.ts#L161-L185) · [view1.ts](../../../src/web/view1.ts#L272-L280) · [view1.ts](../../../src/web/view1.ts#L765-L832) · [run-v01-v06-browser.ts](../../../tests/week2/run-v01-v06-browser.ts#L648-L720) | `V01_V05_V06_BROWSER`（`v01v06_555dbbe5`）：在含 5 张 V01 来源/文件卡的会话点新建会话瞬时检测 `oldSessionCardsAfterSwitch = 0`；延迟 Conv A 聊天回执并切换至 Conv B 录入草稿后释放回执，`lateReceiptCrossSessionPreservedNewInput = true`、`lateReceiptClearedOriginalPendingKeyOnly = true`、`lateReceiptSingleLogicalSubmission = true`；跨刷新原键重试（`ui-chat-1795669198665-62548f30`）、首帧/partial 缺号与真实断线重连全过。证据：[v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **W2-S6** | P1 | **Docker CLI 子进程强制最小白名单环境、正式入口装载后立即擦除宿主 `process.env` 密文，S6 全面切至正式 `src/index.ts` 取证。** (1) `docker-sandbox.ts` 新增 `buildMinimalDockerCliEnv()`（仅放行 `PATH`/`SYSTEMROOT`/`TEMP`/`DOCKER_*` 等非密系统键）并注入所有同步/异步 `docker` 子进程调用；(2) `src/index.ts` 在将控制台、模型、IMAP、GitHub MCP 凭据装入宿主内存 `HostCredentialVault` 后立即 `delete process.env[key]` 擦除全部启动密钥环境变量；(3) `run-s6.ts` 改为启动真实正式 `src/index.ts`（将 5 槽位合成标记经正式启动环境注入），端到端跑通 Router/Worker/Compaction/IMAP/GitHub MCP/Docker 工作区写盘、校验 `docker_cli_minimal_env`、实时扫描活跃 WAL 与重启后双库。[docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L1-L65) · [index.ts](../../../src/index.ts#L250-L265) · [run-s6.ts](../../../tests/week2/run-s6.ts) | `S6`（`runId = s6_e2791b1a`）：`formalEntrypointUsed = true`、`hostStartupSecretEnvScrubbed = true`、阳性对照 `2/2`；3 个正式运行期/重启采样点实采非零活跃 WAL（`aegis-gov.sqlite-wal` 416152/461472 B、`pi-durable.sqlite-wal` 1940552/2117712 B）、`formal_host_stdout_stderr`、`web_snapshot`、`web_sse_frame`、`docker_cli_minimal_env`（仅 14 个非密系统键）、`mcpChildEnvKeys`（0 其他槽位泄漏），`uncollectedSamples = []`，5 槽位 `totalForbiddenHits = 0`。同时 V06 保留真实 `runW1B`（`w1b_55794765`，强杀 PID `50708`，`effectId = efx_ddffdbd441984790bee814ebda146ab1`）浏览器刷新核对“结果待核对”。证据：[s6-evidence.json](evidence/round3/week2/s6-evidence.json) · [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |
| **W2-R2-E1** | P2 | **按提审轮次固化不可变脱敏证据目录，确保各轮表格 `runId` 与所指文件逐项一致。** 从历史提交 `5cb67ee` 恢复第 1 轮原始证据至 `evidence/week1/`、`evidence/week2/`（`week2_203150f4`）；第 2 轮 `efba0ed` 证据迁移固化至 `evidence/round2/`（`week2_57fd5f62`）并同步 §11 链接；本轮 `2dffb01` 证据固化至 `evidence/round3/`（`week2_c948a676`）。[evidence/](evidence/) | 校验三套目录 `week2-summary.json` 的 `runId` 分别为 `week2_203150f4`（R1）、`week2_57fd5f62`（R2）、`week2_c948a676`（R3），均与各自章节表格完全一致且脱敏零泄漏。 |

### 12.2 第 3 轮冻结候选 `2dffb01` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = 2dffb01fe0711a9b727b9f41006ed55bcac335b7`、工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$w1 = Join-Path $env:TEMP 'aegis-w2r3-w1-88fcde82'
$w2 = Join-Path $env:TEMP 'aegis-w2r3-w2-88fcde82'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $w1 'data') --evidence-dir (Join-Path $w1 'evidence')
& $node tests/week2/run-all.ts --data-dir (Join-Path $w2 'data') --evidence-dir (Join-Path $w2 'evidence')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据（第 3 轮固定路径） |
|---|---|---|---|---|---|
| `tsc --noEmit` 与分层守卫 | `0` | `week2_c948a676` | 纯 TypeScript 可擦除类型检查通过；单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round3/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_e72893f9` | `S1–S5` 5/5 PASS；矩阵 25/25 PASS；`W1-A`（`w1a_20c05e1d`）3 足额对照各 `+1`、6 不足负例各 `0`；`W1-B`（`w1b_7248ceb7`）强杀 PID `37916` -> 重启 PID `50260` / `51032`，`effectId = efx_2eb8e2f2b0294671bd80cc98eff88e4c`，独立假 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新后显“结果待核对”、`secretLeaksCount = 0` | **PASS** | [week1-summary.json](evidence/round3/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round3/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round3/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round3/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round3/week1/matrix-evidence.json) |
| **S6（正式入口）** | `0` | `s6_e2791b1a` | 正式 `src/index.ts` 启动并擦除环境密文；阳性对照 `2/2`；活跃 WAL（416152/461472 B 与 1940552/2117712 B）、Docker CLI 最小环境（14 非密键）、MCP 环境、日志、快照、SSE、URL 全覆，`uncollectedSamples = []`，5 槽位 `totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round3/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_a29b8d30` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:36b9942f9589e150e6c94ef8507082f6`）；快照后/订阅前批准不漏；撤权后旧流 0 业务帧、携旧游标重连 0 历史帧重放并返 `resync`、审批草稿与派生 Worker `role=user` 输入均脱敏；并发旧读串行化通过 | **PASS** | [v04-v05-evidence.json](evidence/round3/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_209e8629` | 凭据目标绑定与 MCP 参数不匹配登录/启动增量 `0`；旧 MCP 库 0 预算拒绝两次开库迁移通过；真实 `run_worker` 委派子会话（`id = "31"`）与 Router/Compaction/durable 重试在单撤读取后发送增量均为 `0`；IMAP 无命中 `no_matching_message` 且无关正文读取增量 `0` | **PASS（替身）** | [v02-evidence.json](evidence/round3/week2/v02-evidence.json) |
| **V03** | `0` | `v03_c4621b31` | 不可变镜像 `sha256:e9f565d3...`；同路径重叠两任务独立冻结快照触发 `CONFLICT_SAVED`；导出窗口内撤来源/撤写授权目标与冲突候选均 0 增量；同摘要正常路径 `noop_unchanged (installCount=0)`、同摘要 `PREPARED` 启动转 `pending_reconcile`；正式宿主回执前强杀（PID `29672` -> `26240`）Step 5c 唯一恢复 | **PASS** | [v03-evidence.json](evidence/round3/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_555dbbe5` | 正式 `src/index.ts` 启动演示句（`http://127.0.0.1:54595`，`reports/weekly.md` SHA-256 `31d1598f...`）及未配置 fail-closed；挂起工作正式重启 `beforeResume` 准备完再放行写出 `reports/resumed.md`（SHA-256 `883ccc83...`）；填充会话新建切换 `oldSessionCardsAfterSwitch = 0`；跨会话迟到回执不覆盖新输入；直连真实 `runW1B`（`w1b_55794765`，强杀 PID `50708`，`effectId = efx_ddffdbd4...`）刷新显“结果待核对” | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round3/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 逐 token `firstTokenMs` 仍标注 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测严格分离。

### 12.3 第 3 轮审计人独立复跑与源码审查签收栏

> 本节留白，供外部审计人基于冻结代码候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 填写第 3 轮独立复跑与源码复审结论。

#### 12.3.1 独立复跑核对表（第 3 轮）

| 核对项 | 审计人复跑结果（通过 / 未通过 / 待验证） | 备注 / 复跑 `runId` / 退出码 |
|---|---|---|
| 核对候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 与仅文档差异 | | |
| 依赖锁定、类型检查 `tsc --noEmit`、分层守卫 | | |
| 第 2 周全量 `tests/week2/run-all.ts`（含实机 Edge CDP 与汇总落盘） | | |
| 同候选第 1 周全量 `tests/week1/run-all.ts`（`S1–S5`、`W1-A`、`W1-B`、25 项矩阵） | | |
| 旧治理库副本连续开库升级校验（含第 1 轮 V02 旧 MCP 库副本，0 预算拒绝） | | |

#### 12.3.2 §11.3 未关闭及新增审计项逐项关闭复核表（第 3 轮）

| 审计编号 | 级别 | 复核结论（关闭 / 未关闭） | 审计人复核说明 |
|---|---|---|---|
| `W2-R2-M1` | P1 | | |
| `W2-S1` | P1 | | |
| `W2-S2` | P1 | | |
| `W2-S3` | P1 | | |
| `W2-S4` | P2 | | |
| `W2-S6` | P1 | | |
| `W2-R2-E1` | P2 | | |

#### 12.3.3 第 3 轮最终签收结论

- **第 3 轮签收结论**：[ ] 同意阶段一第 2 周签收（本地替身 + 实机 Docker + 实机浏览器范围，真实只读与首 token 保留“待验证”） / [ ] 退回继续整改
- **审计人 / 日期**：
- **补充意见或新发现（如有）**：


