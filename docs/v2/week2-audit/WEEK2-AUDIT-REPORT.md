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

本节记录冻结候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 的第 3 轮独立复跑和源码结论。§12.1–12.2 为实施方提审记录。

#### 12.3.1 独立复跑核对表（第 3 轮）

| 核对项 | 审计人复跑结果（通过 / 未通过 / 待验证） | 备注 / 复跑 `runId` / 退出码 |
|---|---|---|
| 核对候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` 与仅文档差异 | 通过 | 使用分离工作树独立复跑。提审 HEAD `f66366b` 与代码候选之间仅有审计文档和证据差异。 |
| 依赖锁定、类型检查 `tsc --noEmit`、分层守卫 | 通过 | 8 项直接依赖的已安装版本与 lockfile 一致。Git blob SHA-256 与 §12 一致，工作树文件仅有 CRLF 差异。类型检查和分层守卫通过。 |
| 第 2 周全量 `tests/week2/run-all.ts`（含实机 Edge CDP 与汇总落盘） | 通过 | `week2_79a711ec` 退出 0。V04/V05 `v04v05_bef86357`、V02 `v02_e9d8fed2`、V03 `v03_47e5dfd2`、S6 `s6_b3cd2551`、Edge `v01v06_affcd5f1` 均为 PASS。额外正式入口顺序更新夹具退出 1，见 W2-S3。 |
| 同候选第 1 周全量 `tests/week1/run-all.ts`（`S1–S5`、`W1-A`、`W1-B`、25 项矩阵） | 通过 | `week1_021ce305` 退出 0，S1–S5 5/5，矩阵 25/25。W1-A `w1a_7ab92925` 三例足额各发送 1 次，六例不足各发送 0 次。W1-B `w1b_06715189` 独立 SMTP 收件 1、领取 1，原会话 UNKNOWN。 |
| 旧治理库副本连续开库升级校验（含第 1 轮 V02 旧 MCP 库副本，0 预算拒绝） | 通过 | 两份副本各连续开库两次，两项命令均退出 0。第 1 周旧库保留 8 条授权、补齐 6 条拒绝记录的归属。第 1 轮 V02 副本补齐 2 列并保留旧钉扎行。两份副本外键异常均为 0。 |

#### 12.3.2 §11.3 未关闭及新增审计项逐项关闭复核表（第 3 轮）

| 审计编号 | 级别 | 复核结论（关闭 / 未关闭） | 审计人复核说明 |
|---|---|---|---|
| `W2-R2-M1` | P1 | **关闭** | 第 1 轮 V02 实存旧表副本连续开库两次，均有 `command` 和 `args_json`，服务器及工具钉扎各保留 1 行，外键异常 0。V02 夹具另验证重新登记绑定。 |
| `W2-S1` | P1 | **关闭** | 正式入口在 `beforeResume` 绑定宿主并等待 MCP 建连。独立 Edge 套件通过正式重启验证，挂起任务恢复后完成仓库读取和 `reports/resumed.md` 受管写入。[装配](../../../src/index.ts#L330) · [调度放行](../../../src/runtime/harness.ts#L1385) |
| `W2-S2` | P1 | **未关闭** | 旧游标重连、已连接流、Worker 派生输入和服务端草稿快照的整改已覆盖。源码仍显示界面忽略快照的 `draftRedacted`，以 PENDING 为准恢复本地未保存草稿，并继续提供改稿和批准操作。撤权后的页面可重新显示撤权前留存的正文，只有服务端 JSON 脱敏的断言无法证明界面清除。复验需在浏览器覆盖有本地编辑的派生草稿，确认撤权后清除正文、禁用受限操作，并由宿主在处理决定和领取时复核来源权限。[快照标记](../../../src/web/server.ts#L258) · [草稿缓存与按钮](../../../src/web/view1.ts#L600) · [领取](../../../src/runtime/submitter.ts#L94) |
| `W2-S3` | P1 | **未关闭** | 导出后复核授权、同摘要无写盘及保守恢复已落实。额外正式入口实测中，同一会话连续提交两个独立更新，提交号 15 和 24。第一条安装一次，第二条在权威文件无外部编辑的情况下仍以 `null` 为基准，返回 `CONFLICT_SAVED`，权威文件停在第一版。缓存键沿用了会话级预算归属。此外，快照复制器将整个工作区的普通文件收入任务输入，`trackedBaselineRelPaths` 仅补充基准。复验需证明顺序命令各用自己的基准，重叠任务各保留原基准，容器输入仅含获准路径。[缓存键](../../../src/index.ts#L367) · [会话预算归属](../../../src/runtime/harness.ts#L1489) · [快照复制](../../../src/capabilities/workspace/importer.ts#L198) |
| `W2-S4` | P2 | **聊天路径关闭，审批回执待补** | 独立 Edge 复跑旧卡片为 0，迟到聊天回执保留新会话输入，并且只清原键。保存、批准及拒绝的异步回执仍会主动重新选择原会话。按 V05 切换契约，复验待审批操作回执只更新原请求所属记录，并且无法改变当前选择或重开旧流。[审批回执](../../../src/web/view1.ts#L645) |
| `W2-S6` | P1 | **实现已修复，证据未关闭** | 正式入口装载后清除凭据环境键，两个 Docker CLI 启动封装均传白名单环境。报告中 Docker CLI 环境来自审计进程用白名单启动的独立 Node 探针，正式调用的 IMAP 子进程和任务容器环境未采集，`uncollectedSamples` 与环境擦除指标为固定值。保留白名单对照，补正式调用的逐槽采样，实际观察到的活跃 WAL、SSE 帧、子进程和任务卷分别入证，未采样项明确登记。[正式装载](../../../src/index.ts#L250) · [启动封装](../../../src/capabilities/workspace/docker-sandbox.ts#L47) · [独立探针](../../../tests/week2/run-s6.ts#L179) · [覆盖标记](../../../tests/week2/run-s6.ts#L653) |
| `W2-R2-E1` | P2 | **关闭** | 第 1 轮资料与 `5cb67ee` 一致，第 2 轮迁移目录与 `c83dc44` 的原目录 Git tree SHA 一致。三轮归档的两周摘要 runId 均与报告对应，引用的 JSON 文件路径可解析。 |

#### 12.3.3 第 3 轮最终签收结论

- **第 3 轮签收结论**：退回继续整改，暂缓阶段一第 2 周签收。两周既有全量夹具均通过，额外正式入口复跑确认了 W2-S3 的顺序更新缺口。W2-S2 撤权后的本地草稿、W2-S4 的审批回执以及 W2-S6 实际进程证据仍需补齐。真实只读和首 token 保留待验证。
- **审计人 / 日期**：Codex 独立复审，2026-11-26（香港时间）。
- **整改交接**：请在同一份报告 §13 回填四项剩余内容及新候选 SHA，附相应复验和同候选两周全量结果。

#### 12.3.4 独立复跑命令与证据

审计在分离工作树使用 Windows、锁定 Node 22.23.5、SQLite 3.54.1 和既有锁定依赖目录联接。两周全量分别在新数据目录执行，旧源库均通过只读连接备份后再打开副本。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round3-2dffb01'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode tests/week1/run-all.ts --data-dir '../week1/data' --evidence-dir '../week1/evidence' --keep-data true *> '../week1.log'
& $auditNode tests/week2/run-all.ts --data-dir '../week2/data' --evidence-dir '../week2/evidence' --keep-data true *> '../week2.log'
$probe = Get-Content -Raw -Encoding utf8 '..\..\round4-1795655498209\legacy-schema-probe.mjs'
& $auditNode --input-type=module -e $probe '..\..\round2-1795619937294\data\w1-a\host-data\aegis-gov.sqlite' '../legacy-copy.sqlite' '../legacy-schema-check.json'
$probe = Get-Content -Raw -Encoding utf8 '..\..\week2-round2-c4c3f954\mcp-legacy-probe.mjs'
& $auditNode --input-type=module -e $probe '..\..\week2-round1-fadcc51d\week2\data\v02\host-data\aegis-gov.sqlite' '../mcp-legacy-copy.sqlite' '../mcp-legacy-check.json'
$probe = Get-Content -Raw -Encoding utf8 '../sequential-report-final-probe.mjs'
& $auditNode --input-type=module -e $probe *> '../sequential-report-final.log'
```

两周的汇总与专项 JSON 分别位于 `week1/evidence`、`week2/evidence`。旧库证据为 `legacy-schema-check.json` 与 `mcp-legacy-check.json`，顺序更新证据为 `sequential-report-final/result.json`。顺序更新的首次夹具因用字符串检查结构化消息未识别结束状态，复跑修正该观察条件并使用新数据目录。正式候选代码保持冻结。

---

## 13. 第 3 轮审计整改回执与第 4 轮复审签收栏（冻结候选 `8260b8b`）

- **第 4 轮冻结代码候选提交（全号）**：`8260b8bc18185857805d0e15211c70fd28345728`
- **提交链（均位于 `v2` 分支）**：
  - Round 4 代码整改：`0aefdaafffa0995bb239c37b962eb08866ec31b5` + `8260b8bc18185857805d0e15211c70fd28345728`
  - Round 3 独立审计记录：`8e9103860525be88a38e7804efb7d744afd45f8f`（基于 Round 3 代码候选 `2dffb01fe0711a9b727b9f41006ed55bcac335b7` / 文档提交 `f66366be0ea6bfc09744354f035add69be5f3e40`）
- **`package.json` 与 `package-lock.json`（SHA-256 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`）**：保持第 1 周完全一致零变动；锁定 Node `22.23.5`（SQLite `3.54.1`）、npm `10.9.9` 与纯 TypeScript 单向四层依赖边界不变。
- **同候选全量验证结果（均在 `git rev-parse HEAD = 8260b8bc18185857805d0e15211c70fd28345728` 上以锁定 Node 与全新临时目录执行）**：
  - `tsc --noEmit`：退出码 `0`
  - `tests/week1/run-all.ts`：退出码 `0`，`runId = week1_031bfbc8`（`S1–S5` 5/5、`W1-A` 9/9、`W1-B` PASS `efx_dac3ec47bbb848148ff0f840a7f51f67`、矩阵 25/25）
  - `tests/week2/run-all.ts`：退出码 `0`，`runId = week2_ef5e339a`（`typecheck`、`layerBoundary`、`v04_v05`、`v02`、`v03`、`s6`、`v01_v05_v06_browser` 全部 PASS）
  - **版本化不可变证据归档**：
    - 第 1 轮（`ea9b59c`，`week2_203150f4`）：[evidence/week1/](evidence/week1/) · [evidence/week2/](evidence/week2/)
    - 第 2 轮（`efba0ed`，`week2_57fd5f62`）：[evidence/round2/week1/](evidence/round2/week1/) · [evidence/round2/week2/](evidence/round2/week2/)
    - 第 3 轮（`2dffb01`，`week2_c948a676`）：[evidence/round3/week1/](evidence/round3/week1/) · [evidence/round3/week2/](evidence/round3/week2/)
    - **第 4 轮（`8260b8b`，`week2_ef5e339a` / `week1_031bfbc8`）**：[evidence/round4/week1/](evidence/round4/week1/) · [evidence/round4/week2/](evidence/round4/week2/)（独立目录保存，未覆盖前 3 轮；本地用户路径与合成密钥泄漏均校验为 `0`）。

### 13.1 针对 §12.3 全部 4 项剩余问题的逐项整改映射表

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `8260b8b` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-S2** | P1 | **撤权立即清除浏览器本地未保存草稿、禁用改稿与批准控件，并在宿主保存/批准/效果领取事务内全链复核来源权限。** (1) 前端 `view1.ts` 渲染审批卡时检测 `isRedacted = Boolean(p.draftRedacted \|\| p.snapshot?.redacted)`：一旦为真，立即删除 `dirtyByProposal[pid]` 与 `localDraftTextByProposal[pid]`、清空 `textarea.value = ""`（标 `data-draft-redacted="true"`）并禁用 `textarea`、`save-draft`、`approve`（仅允许显式拒绝关闭待办）；(2) 后端 `policy.ts` 新增 `findRelatedConversationIdsByOwnerTask` 与 `verifyProposalSourcesReadAuthorized`（跨当前会话及共享 `owner_task_id` 的父/子 Worker 会话递归复核全部 `conversation_sources`）；(3) `approvals.ts` 的 `saveDraftRevision` 与 `decideApproval(APPROVE)` 以及 `effects.ts` 的 `claimEffectForSubmission`（唯一提交器 `submitter.ts#L94` 直调事务）在持久化提交前均实时校验来源读授权，失效即返回 `403 source_read_revoked` / 拒绝领取 `source_read_revoked` 并写审计事件。[policy.ts](../../../src/governance/policy.ts#L546-L633) · [approvals.ts](../../../src/governance/approvals.ts#L388-L414) · [approvals.ts](../../../src/governance/approvals.ts#L815-L845) · [effects.ts](../../../src/governance/effects.ts#L160-L176) · [view1.ts](../../../src/web/view1.ts#L607-L660) · [server.ts](../../../src/web/server.ts#L928-L950) | `V01_V05_V06_BROWSER`（`v01v06_4e8ad825`）：在 Edge 中先为基于受限记忆派生的 `send_email` 草稿录入本地未保存编辑，随后撤回底层 `source_read_grant`，SSE 即时重同步后验证 `data-draft-redacted = "true"`、`textarea.value === ""`（无原草稿与本地编辑残留）、`saveDisabled = true`、`approveDisabled = true`、`localDraftCleared = true`。`V04_V05`（`v04v05_211de51d`）：撤权后调用 `/draft` 返回 `403 source_read_revoked`、`/decide(APPROVE)` 返回 `403 source_read_revoked`、已批准 `READY` 效果在撤权后调用 `submitApprovedEmailEffect()` 被 `claimEffectForSubmission` 拒绝（`claimed = false`、`code = "source_read_revoked"`、SMTP 增量 `0`）。证据：[v01-v06-browser-evidence.json](evidence/round4/week2/v01-v06-browser-evidence.json) · [v04-v05-evidence.json](evidence/round4/week2/v04-v05-evidence.json) |
| **W2-S3** | P1 | **按 Pi 实际执行轮次（`pi.live.run.inputs + first`）索引任务冻结快照并严格按活跃 `workspace_write` 授权路径构造容器 `/input`。** (1) `harness.ts` 新增 `resolveExecutionRootTaskId`：通过公开文档观测读取当前对话 `pi.live.run` 的 `{ inputs, first }` 作为单次执行轮次键（`run:<convId>:subs:<inputs>:first:<first>`），委托 Worker 通过 `workerExecutionRootByConv` 继承发起轮次键；同一命令内多轮生成/多工具调用共享原冻结快照，而同会话顺序提交的第 2 条命令拥有新 `submissionId`/`first`，必然新建独立快照读取第 1 版提交后的最新权威基准；并发重叠任务同样各自保留原基准；(2) `importer.ts` 的 `createTaskFrozenSnapshot` 移除全量目录遍历 `walkAndCopy`，改为仅枚举候选路径与活跃非撤回 `workspace_write` 授权 `allowedRelPaths`，逐路径经 `validateAndResolveWorkspacePath`、`checkSourceReadAuthorized` 与符号链接分量校验后才复制进 `/input`；`src/index.ts` 在启动容器前亦前置复核 `workspace_write` 授权并改用 `${runtimeEpoch}:${executionRootTaskId}` 缓存。[harness.ts](../../../src/runtime/harness.ts#L581-L625) · [aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts#L48-L90) · [index.ts](../../../src/index.ts#L380-L445) · [importer.ts](../../../src/capabilities/workspace/importer.ts#L185-L246) | `V03`（`runId = v03_d262dfd9`）：(a) 正式 `src/index.ts` 上同会话 `seqConv` 顺序提交两条更新（`V1` -> 无外改直接写 `V2`），两条均得 `state = "INSTALLED"`（`installCount = 1`、`0` 冲突文件、第 2 条 `baseSha256` 精确等于 `sequentialV1Sha256` `0f859831...`、终盘等于 `sequentialV2Sha256` `7343e7db...`）；(b) 同一执行轮次内前步冻结后外改磁盘且模型伪造 `baseSha256`，仍保留 `CONFLICT_SAVED`；(c) 重叠同路径任务仍触发 `CONFLICT_SAVED`；(d) 沙箱工作区额外放置未授权秘密文件 `secrets/host-private.txt`、`secrets/formal-ungranted.txt` 与未授权 `trackedBaselineRelPaths` 路径，实测容器 `/input` 与正式审计 `inputAuthorizedFiles` 均严禁包含上述未授权路径。证据：[v03-evidence.json](evidence/round4/week2/v03-evidence.json) |
| **W2-S4** | P2 | **统一收口审批保存、批准与拒绝的异步回执作用域，切换会话或注销后迟到响应绝不切回旧会话或重开旧流。** `view1.ts` 新增 `isCurrentView(reqConvId, reqEpoch, reqGen)` 守卫，在 `saveBtn` 与共享的 `submitDecision`（覆盖 `APPROVE` 与 `REJECT` 两次 `fetch`：`challenge` 与 `decide`）点击前捕获 `reqConvId`、`reqEpoch`、`reqGen`，并在 `#logout-btn` 最前递增 `selectionGeneration`；迟到回执仅更新 `state.proposalStatusById[proposalId]`，仅当仍在原视图且代际未变时才更新卡片并调用 `selectAndSubscribe`。[view1.ts](../../../src/web/view1.ts#L198-L204) · [view1.ts](../../../src/web/view1.ts#L652-L718) · [view1.ts](../../../src/web/view1.ts#L771-L780) | `V01_V05_V06_BROWSER`（`v01v06_4e8ad825`）：在 Edge 中针对 `save-draft`、`/approvals/decide(APPROVE)` 与 `/approvals/decide(REJECT)` 三条链路分别注入响应延迟，点击后立刻新建并切换至新会话录入草稿、建立新 SSE 流再放行旧响应：三者全部满足 `stayedOnNewConv = true`、`newConvInputPreserved = true`、`newConvSseActive = true`、`oldConvCardsCount = 0`、`backendUpdated = true`；叠加聊天跨会话迟到回执、`oldSessionCardsAfterSwitch = 0` 与缺号重取全过。证据：[v01-v06-browser-evidence.json](evidence/round4/week2/v01-v06-browser-evidence.json) |
| **W2-S6** | P1 | **在正式宿主启动、IMAP 子进程、GitHub MCP 子进程及 Docker 容器/CLI 路径落地实采审计，并由运行期实测Artifact 动态计算 `uncollectedSamples`。** (1) `src/index.ts` 启动擦除 5 槽位启动密钥后在 `beforeResume` 写入动态实检事件 `host_startup_env_scrubbed`（实时验证 `remainingSecretVars` 为空）；并在沙箱执行后写入 `docker_sandbox_observed`（含真实 `docker inspect` 的 `Config.Env` 键、`mounts`、`networkMode=none`、传给 CLI 的白名单键）；(2) `imap-child.ts` 与 `imap-client.ts` 输出并落盘 `imap_read_completed`（实采短命 IMAP 子进程 `Object.keys(process.env)` 与 `passwordPresentInEnv` 布尔检查）；(3) `run-s6.ts` 保留 `dockerCliWhitelistControlEnvKeys` 对照探针，并改为对全部 16 项真实运行样本（活跃双库 WAL、快照、SSE 非空事件、正式启动日志、`host_env_scrub_audit`、`imap_child_observed_env`、`mcpStartup.envKeysReceived`、`docker_task_container_and_volume_audit`、`model_prompt_bodies` 与日志、工作区文件）逐字节检查并动态计算 `uncollectedSamples`，同时将无法在外部直接 hook 读取的 `docker.exe` OS `GetEnvironmentStrings` 如实登记于 `notDirectlyCapturedFromExternalOs`。[index.ts](../../../src/index.ts#L331-L347) · [index.ts](../../../src/index.ts#L486-L508) · [imap-client.ts](../../../src/capabilities/mail/imap-client.ts#L228-L248) · [docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L44-L70) · [run-s6.ts](../../../tests/week2/run-s6.ts#L562-L700) | `S6`（`runId = s6_a7a9fb26`）：`hostStartupSecretEnvScrubbed = true`（`remainingSecretVars = []`）；阳性对照 `2/2`；实时采样点扫描非零活跃 WAL（`aegis-gov.sqlite-wal` `440872`/`486192`/`494432 B`、`pi-durable.sqlite-wal` `1940552`/`2117712 B`）、`web_sse_frame`（`9589 B`）、`imapChildObservedEnvKeys`（13 个系统键、`imapChildPasswordPresentInEnv = false`）、`mcpChildEnvKeys`（仅自身 PAT + 系统键，0 其余槽位）、`dockerTaskContainer.envKeysInContainer`（仅 `["PATH","NODE_VERSION","YARN_VERSION"]`、`networkMode = "none"`）、`dockerCliMinimalEnvKeysPassed`（11 个系统键），动态校验 `uncollectedSamples = []` 且 5 槽位 `totalForbiddenHits = 0`。证据：[s6-evidence.json](evidence/round4/week2/s6-evidence.json) |

### 13.2 第 4 轮冻结候选 `8260b8b` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = 8260b8bc18185857805d0e15211c70fd28345728`、工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$evRoot = Join-Path $env:TEMP 'aegis-w2r4-final-8260b8bc'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'w1-data') --evidence-dir (Join-Path $evRoot 'w1-ev')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'w2-data') --evidence-dir (Join-Path $evRoot 'w2-ev')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据（第 4 轮固定路径） |
|---|---|---|---|---|---|
| `tsc --noEmit` 与分层守卫 | `0` | `week2_ef5e339a` | 纯 TypeScript 可擦除类型检查通过；单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round4/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_031bfbc8` | `S1–S5` 5/5 PASS；矩阵 25/25 PASS；`W1-A`（`w1a_8f5fe207`）3 足额对照各 `serverCountDelta = 1`、6 不足负例各 `serverCountDelta = 0`；`W1-B`（`w1b_5358fd47`）强杀 PID `20284` -> 重启 PID `12364` / `41860`，`effectId = efx_dac3ec47bbb848148ff0f840a7f51f67`，独立假 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新后显“结果待核对”、`secretLeaksCount = 0` | **PASS** | [week1-summary.json](evidence/round4/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round4/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round4/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round4/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round4/week1/matrix-evidence.json) |
| **S6（正式入口 + 实采）** | `0` | `s6_a7a9fb26` | 正式 `src/index.ts` 启动并动态校验 `remainingSecretVars = []`；阳性对照 `2/2`；活跃 WAL（440872–494432 B / 1940552–2117712 B）、SSE 非空帧（9589 B）、IMAP 子进程观察键（13 非密键、`passwordPresentInEnv = false`）、Docker 容器 `.Config.Env` 与 `/input:ro` `/out:rw`、MCP 子进程仅收本槽位、白名单对照保留、动态 `uncollectedSamples = []`、5 槽位 `totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round4/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_211de51d` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:5f1971f41f1bcdaefec121d5c4d701a2`）；撤权后携旧游标重连 `0` 历史业务帧并返 `resync`、审批草稿与派生 Worker 输入脱敏、编辑草稿 `403`、批准决定 `403`、已批效果领取被拒且 SMTP `0`；并发旧读串行化通过 | **PASS** | [v04-v05-evidence.json](evidence/round4/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_798b138f` | 凭据目标绑定与错配拦截通过；旧 MCP 库 0 预算拒绝两次开库迁移通过；真实委派 Worker（`id = "31"`）与全路径单撤读取后发送增量 `0`；IMAP 无命中 `no_matching_message`（`filterMissBodyFetchDelta = 0`）与不改 `\Seen`；GitHub MCP `totalWriteCallsOnServer = 0` | **PASS（替身）** | [v02-evidence.json](evidence/round4/week2/v02-evidence.json) |
| **V03** | `0` | `v03_d262dfd9` | 不可变镜像 `sha256:e9f565d3...`；同会话顺序两条命令各自取最新基准均 `INSTALLED`；单轮次内前步冻结后外改触发 `CONFLICT_SAVED`（忽略模型伪造基准）；同路径重叠任务保住先行版本；容器 `/input` 与正式审计仅含获准路径；导出后撤权两处文件 `0` 增量；同摘要 `noop_unchanged` 与 `PREPARED` 保守恢复 `pending_reconcile`；正式强杀（PID `27200` -> `19400`）Step 5c 唯一恢复 | **PASS** | [v03-evidence.json](evidence/round4/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_4e8ad825` | 正式 `src/index.ts` 启动（`http://127.0.0.1:65432`）完成未配置 fail-closed、`beforeResume` 挂起恢复写 `reports/resumed.md`、演示句写 `reports/weekly.md`（`31d1598f...`，刷新仍可核对）；`save`/`approve`/`reject` 与聊天跨会话迟到回执均不切回旧会话且保持新流；来源撤权后 Edge 本地草稿清空且 `save`/`approve` 禁用；无刷新过期 `410`；直连真实 `runW1B`（`w1b_911e44fc`，强杀 PID `38280`，`efx_563389c500df4a5c940a1a12c91bafdd`）刷新显“结果待核对” | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round4/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 逐 token `firstTokenMs`（`firstToolProgressMs = 198ms`、`completionMs = 12569ms` 已实测）仍标注 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测严格分离。

### 13.3 第 4 轮审计人独立复审与最终签收栏

**签收结论：退回继续整改，阶段一暂缓签收。** 本轮关闭 W2-S2。剩余 4 项为 W2-S3、W2-S4、W2-S6 和新增 W2-R4-E1。冻结候选 `8260b8b` 的第 1 周全量通过，第 2 周原样全量退出码为 `1`。此外，正式宿主的独立强杀复测确认 V03 可在同一任务恢复后覆盖用户编辑。

#### 13.3.1 同候选独立复跑

| 核对项 | 退出码 / 结果 | 实测与证据 |
|---|---|---|
| 冻结候选和工具链 | 通过 | 分离工作树 `8260b8bc18185857805d0e15211c70fd28345728`，干净。文档提交 `0066bc9` 仅更改审计、验收报告及新增第 4 轮归档。前三轮证据路径在该提交中无变动。锁文件与 W1 交接 `47a4dd4` 相同，Git 中 LF 字节的 SHA-256 为 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`。`package.json` 相对 W1 新增 `test:week2` 脚本，依赖版本相同。Windows x64，Node 22.23.5 / SQLite 3.54.1 / npm 10.9.9 / Docker 29.9.2 / Edge 157.0.4341.60。 |
| 类型检查、分层守卫 | `0` / 通过 | `tsc --noEmit` 通过，分层守卫 `violations: []`。 |
| 第 1 周全量 | `0` / 通过 | `week1_a2121203`，S1–S5 5/5、矩阵 25/25。W1-A `w1a_418e79b4` 三个足额对照各新增 1 次请求，六个不足负例增量均 0。W1-B `w1b_fb3bd21e` 独立 SMTP 累计 1 封、领取 1 次，刷新原会话效果仍为 `UNKNOWN`。 |
| 两份历史库 | 各 `0` / 通过 | W1 旧治理库二次打开保留 8 条会话授权，6 条拒绝记录补齐代际。W2 首轮 V02 旧库二次打开保留服务与工具 Pin 各 1 条，新增 `command` / `args_json`，两份副本的外键异常均为 0。 |
| 第 2 周全量 | `1` / **未通过** | `week2_1eb50d38`，`v04_v05` 断言 Worker 完成投影失败。V02 替身 `v02_2a48606b`、V03 既有夹具 `v03_753a2a85`、S6 既有夹具 `s6_91c6f6c2`、正式入口 Edge `v01v06_f3dfa4b9` 均通过各自断言。 |
| 原样 V04/V05 单独复跑 | `1` / **未通过** | 新目录复现同一失败。两个独立假模型请求日志均记录第 5 次调用仍为审批所在轮次，却取走了排给下一条命令的 Worker 脚本。 |
| V04/V05 诊断夹具 | `0` / 通过 | `v04v05_4f798f3c`。候选实现保持冻结，在独立夹具中等审批轮次完成后再换脚本，并按上限轮询 Worker 完成状态。复跑到达撤权、领取、旧游标和退出场景。 |
| V03 独立正式入口复跑 | 顺序更新 `0`；同轮强杀恢复 `1` | 顺序两条命令受理 ID 为 15、24，各安装 1 次，第 2 条基准为第 1 版摘要 `a63ec651…`。同一条命令在第一文件安装、回执未持久化窗口强杀；同代恢复后第二文件误将用户编辑摘要 `3b574377…` 当作基准，实际安装 1 次，覆盖了该编辑。 |

#### 13.3.2 逐项关闭复核

| 审计编号 | 裁定 | 观察与复签条件 |
|---|---|---|
| W2-S2 | **关闭** | Edge 独立复跑确认收到撤权重同步后，浏览器本地草稿和输入框同步清空，保存、批准均禁用。诊断夹具走到宿主保存与批准的 403、已批准效果领取拒绝、独立 SMTP 增量 0，以及旧游标业务帧 0。 |
| W2-S3（P1） | **未关闭** | 顺序命令隔离、既有 `PREPARED` 对账及初次输入筛选通过。正式入口仅在内存维护轮次快照索引。审计用一次提交在同轮先写 `reports/index.md`，命中真实安装后回执前屏障并强杀（PID 14808 → 37208），停机期间编辑 `reports/weekly.md`，重启后继续同轮的第二个文件操作。原冻结基准 `e257f7df…`，实际基准变为 `3b574377…`，结果为 `INSTALLED`，权威文件新摘要 `c95c6333…`。按 V03 恢复并验证同一轮次的冻结基准，无法确认时停止安装并显示待核对。源码还显示复用缓存时仅复核本次目标，已冻结的其他输入路径若后来撤权，仍随同一目录被挂载。每次挂载前重验全部输入路径，保持原冻结基准。复签同时覆盖同轮强杀、已缓存路径撤权，以及既有顺序和重叠用例。[正式入口](../../../src/index.ts#L380-L418) · [导入对账](../../../src/capabilities/workspace/importer.ts#L524-L547) |
| W2-S4（P2） | **部分关闭** | Edge 对保存、批准、拒绝的延迟响应均通过 A→B 切换，旧卡片 0，新会话输入和 SSE 保留。源码复核发现成功的旧保存回执在视图代际校验前清除提案的本地草稿缓存。若切回 A 后用户已经继续编辑，迟到回执可清除新编辑，后续快照重绘会显示旧保存内容。清除应绑定本次提交时的编辑版本，并在正式 Edge 覆盖 A→B→A 后继续改稿、迟到保存回执后再重绘。另把迟到回执与注销的组合纳入同一组验证。[客户端保存回执](../../../src/web/view1.ts#L660-L685) · [现有 Edge 夹具](../../../tests/week2/run-v01-v06-browser.ts#L816-L935) |
| W2-S6（P1） | **证据未闭合** | 已实测正式宿主启动清除启动槽位，扫描双库活跃 WAL、非空 SSE，阳性对照 2/2，已采位置禁止命中 0。Docker inspect 取到了环境和挂载，但证据丢弃环境值后只查键名，`networkMode` 来自回填常量。IMAP 子进程只对自身口令值做比对，MCP 对其他槽位只核键名。当前 `workspace_output_file` 是已安装文件，证据未关联安装前私有任务卷的标记扫描。对这些实际边界生成每槽位命中数，仅保留脱敏计数，记录 inspect 实得网络模式和只读导出的采样结果。继续区分传给 Docker CLI 的参数白名单与外部 OS 尚未直接采集的进程环境。用采样结果生成覆盖清单及未采项。[Docker 实采](../../../src/capabilities/workspace/docker-sandbox.ts#L750-L795) · [S6 证据生成](../../../tests/week2/run-s6.ts#L612-L706) |
| W2-R4-E1（P2） | **新增，原样回归未通过** | 第 2 周全量及 V04/V05 专项原样复跑均在 Worker 完成投影断言失败。两份假服务日志的第 5 次请求均是 `Send V05 mail` 的 Router 后续生成，却取走 `tool_call`；第 6 次请求已经是该错序轮次派出的 Worker。等待审批轮次的可观察终态后再换脚本，诊断中请求 5 为审批后续文本，6–8 才是独立委派的 Router、Worker 和 Router 后续，退出 0。将同步条件落入正式夹具，以 Worker 完成事件及最终快照取代固定 450ms 等待，同候选重跑全量并保存事件与独立假模型请求顺序。[V04/V05 夹具](../../../tests/week2/run-v04-v05.ts#L725-L766) |

#### 13.3.3 命令与证据索引

以下在分离工作树运行。两周全量、专项复跑和审计诊断分别用新数据目录。诊断夹具未写入候选源码。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round4-8260b8b'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode ./node_modules/typescript/bin/tsc --noEmit
& $auditNode tests/week1/run-all.ts --data-dir "$auditRoot/week1/data" --evidence-dir "$auditRoot/week1/evidence"
& $auditNode tests/week2/run-all.ts --data-dir "$auditRoot/week2/data" --evidence-dir "$auditRoot/week2/evidence"
& $auditNode tests/week2/run-v04-v05.ts --data-dir "$auditRoot/v04-v05-repeat/data" --evidence-dir "$auditRoot/v04-v05-repeat/evidence"
& $auditNode ../v04-v05-diagnostic-probe.mts
$probe = Get-Content -Raw -Encoding utf8 '../sequential-report-final-probe.mjs'
& $auditNode --input-type=module -e $probe
$probe = Get-Content -Raw -Encoding utf8 '../restart-frozen-import-probe.mjs'
& $auditNode --input-type=module -e $probe '../restart-frozen-import'
```

两周汇总和各项 JSON 保存在审计根目录下的 `week1/evidence`、`week2/evidence`。V04/V05 原样失败见 `week2.log`、`v04-v05-repeat.log`，独立服务顺序对照见 `v04-v05-repeat/data/fake-model/model-requests.jsonl` 与 `v04-v05-diagnostic-retry/data/fake-model/model-requests.jsonl`，诊断 JSON 在 `v04-v05-diagnostic-retry/evidence/v04-v05-evidence.json`。同轮强杀实得见 `restart-frozen-import/result.json`，顺序更新实得见 `sequential-report-final/result.json`。此前以模型请求屏障尝试的夹具未观测到第二次文件操作回执，定案依据为命中正式导入屏障的一次。旧库结果见 `legacy-schema-check.json` 和 `mcp-legacy-check.json`，沿用 §12.3.4 的只读备份探针并写入本轮新副本。

V02 真实 Gmail IMAP 与真实 GitHub MCP 只读、V01 逐 token 首延迟继续标为**待验证**。它们与本轮 4 项整改分列。下一轮请在本报告第 14 节按上述四个编号回执。

**审计人 / 日期**　Codex 独立复审 / 2026-11-26（Asia/Hong_Kong）。

---

## 14. 第 4 轮 §13.3 整改回执与第 5 轮复审签收栏（冻结候选 `2a40af7`）

- **第 5 轮冻结代码候选提交（全号）**：`2a40af787c09cc70f4fb247c6dab7fb851cf5f73`（位于 `v2` 分支）
- **多轮提审与审计链（均为只读追溯记录，前 4 轮证据路径保持零修改）**：
  - 第 5 轮代码整改冻结提交：`2a40af787c09cc70f4fb247c6dab7fb851cf5f73`
  - 第 4 轮独立审计记录（§13.3）：`b436e4a5992a2491dc3bce40f98172e92e3dc240`（基于第 4 轮候选 `8260b8bc18185857805d0e15211c70fd28345728` / 文档 `0066bc9b77ae37801eed0694899a50cda87f725b`）
  - 第 3 轮候选与文档：`2dffb01fe0711a9b727b9f41006ed55bcac335b7` / `f66366be0ea6bfc09744354f035add69be5f3e40`（审计归档于 `evidence/round3/`）
  - 第 2 轮与第 1 轮候选：`efba0eda53a21cf5f935846377f8ab03ff42eb69`（`evidence/round2/`）、`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`（`evidence/`）
- **`package.json` 与 `package-lock.json`（LF 字节 SHA-256 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`）**：继续零修改；锁定 Node `22.23.5`（SQLite `3.54.1`）、npm `10.9.9` 与纯 TypeScript 单向四层依赖边界不变。
- **同一冻结候选 `2a40af787c09cc70f4fb247c6dab7fb851cf5f73` 全量验证与归档**：
  - `tsc --noEmit`：退出码 `0`
  - `tests/week1/run-all.ts`：退出码 `0`，`runId = week1_266af2e8`（`S1–S5` 5/5、`W1-A` 9/9 `w1a_085f0156`、`W1-B` `w1b_b74bba87` `efx_e3359339316e4788b150d9e020b16431`、矩阵 25/25）
  - `tests/week2/run-all.ts`：退出码 `0`，`runId = week2_41717bff`（`typecheck`、`layerBoundary`、`v04_v05`、`v02`、`v03`、`s6`、`v01_v05_v06_browser` 全部 PASS）
  - **第 5 轮不可变脱敏证据目录**：[evidence/round5/week1/](evidence/round5/week1/) · [evidence/round5/week2/](evidence/round5/week2/)（前 4 轮目录未改动，已核验无真实用户路径或合成秘钥残留）。

### 14.1 针对 §13.3 全部 4 项剩余问题的逐项整改回执

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `2a40af7` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-S3** | P1 | **在治理库持久化轮次级冻结快照索引，重启缺失即 fail-closed，并在每次容器启动前对全部已缓存 `/input` 路径实时复核 `source_read_grants`。** (1) `db.ts` 在基础 Schema 与 Migration 4 新增 `task_frozen_snapshots(snapshot_key, runtime_epoch, snapshot_id, snapshot_dir, baselines_json, authorized_paths_json, created_at)`；(2) `importer.ts` 新增 `getOrCreateTaskFrozenSnapshot`（按 `runtimeEpoch:executionRootTaskId` 落盘检索或原子创建；重启复用时校验 `snapshot_dir` 与全部已冻结文件存在性，缺失即返回 `frozen_snapshot_missing` fail-closed，且复用时绝不重扫宿主机工作区）与 `prepareVerifiedMountInputDir`（每次启动 Docker 容器前逐个复核 `workspace_write` 实时读/写授权，已撤权路径立即从本次隔离挂载目录剔除并记入 `excludedInputFiles`）；(3) `src/index.ts` 移除内存 `taskFrozenSnapshots` 缓存改调持久化索引，若恢复轮次对已存在磁盘文件缺少冻结基线亦返回 `PENDING_RECONCILE / frozen_snapshot_baseline_missing`。[db.ts](../../../src/governance/db.ts#L326-L335) · [db.ts](../../../src/governance/db.ts#L586-L598) · [importer.ts](../../../src/capabilities/workspace/importer.ts#L276-L445) · [index.ts](../../../src/index.ts#L411-L525) | `V03`（`runId = v03_f829cd7c`）：(a) 正式 `src/index.ts` 新增同执行轮次强杀复测：第 1 个工具写入 `reports/same-round-a.md` 后在安装后回执前窗口强杀 `hostSr1`，停机期改写 `reports/same-round-b.md` 并撤回 `reports/revoked-cached.md` 授权，重启 `hostSr2` 恢复同轮第 2 个工具写 `reports/same-round-b.md` 时准确保持崩溃前原冻结基线 -> 触发 `CONFLICT_SAVED` 保住停机编辑，且容器 `/input` 与 `docker_sandbox_observed` 审计剔除 `reports/revoked-cached.md`；(b) 删除持久化快照目录后调 `getOrCreateTaskFrozenSnapshot` 实得 `frozen_snapshot_missing` fail-closed；(c) 既有顺序更新（`reports/seq-update.md` `43a3c294...` -> `4b01cae4...`）、重叠任务冲突与强杀 PID `39904` -> `15604` Step 5c 恢复全过。证据：[v03-evidence.json](evidence/round5/week2/v03-evidence.json) |
| **W2-S4** | P2 | **保存草稿清除绑定请求时捕获的本地编辑版本号，并对保存/批准/拒绝/聊天异步回执统一加入主体与注销守卫。** (1) `view1.ts` 状态新增 `editVersionByProposal`，`textarea input` 每次递增版本号；(2) `saveBtn` 点击前同时捕获 `reqPrincipal` 与 `reqEditVersion`：回执返回后若 `!state.principalId \|\| state.principalId !== reqPrincipal` 直接丢弃；仅当 `(state.editVersionByProposal[proposalId] \|\| 0) === reqEditVersion` 时才清理 `dirtyByProposal` 与 `localDraftTextByProposal`，若已有更新编辑则继续保留 `dirtyByProposal` 与本地正文并在重绘后保持禁用批准按钮；(3) `submitDecision`（`challenge` 与 `decide` 两步后）与 `#chat-send-btn` 同增 `reqPrincipal` 校验，`#logout-btn` 清空全部草稿与编辑版本映射并重置输入框与状态文本。[view1.ts](../../../src/web/view1.ts#L122-L128) · [view1.ts](../../../src/web/view1.ts#L653-L735) · [view1.ts](../../../src/web/view1.ts#L775-L855) | `V01_V05_V06_BROWSER`（`runId = v01v06_7d9fd2f2`）：Edge CDP 实测覆盖 (a) `A -> B -> 切回 A -> 录入新编辑 -> 放行迟到旧 Save 回执 -> selectAndSubscribe 快照重绘`：验证 `returnedToConvA = true`、`newerLocalEditPreservedAfterLateSaveAndRedraw = true`、`dirtyStillTrue = true`、`approveDisabledStillTrue = true`、`backendRev = 2`；(b) `发起延迟 Save -> 立刻点击注销 -> 放行迟到回执`：验证 `loggedOutPrincipalNull = true`、`sseClosedNull = true`、`authPanelVisible = true`、`approvalsPanelHidden = true`、`approvalsCardsZero = true`、`dirtyCleared = true`、`statusCleared = true`；(c) 既有 `save`/`approve`/`reject` 跨会话切换、`oldSessionCardsAfterSwitch = 0` 与缺号重取全过。证据：[v01-v06-browser-evidence.json](evidence/round5/week2/v01-v06-browser-evidence.json) |
| **W2-S6** | P1 | **逐值采集并扫描容器/子进程/Docker CLI 实参及安装前私有卷只读导出字节，按实采结果动态生成每槽位覆盖与零未采清单。** (1) `docker-sandbox.ts` 扩展 `docker inspect` 模板读取真实 `{{.HostConfig.NetworkMode}}` 与完整 `.Config.Env` 值数组（移除 `networkMode: "none"` 硬编码常量回填），并通过内存回调 `onInspectObserved` 返回 `cliEnvEntries` 与 `rawEnvInContainer`；(2) `imap-child.ts` 与 `imap-client.ts` 生成每个 env 条目值的 SHA-256 前缀摘要 `childEnvValueDigests` 落盘审计，并在传入 `onObserveChildEnv` 时提供真实 `entries`；(3) `fake-github-mcp-server.ts` 记入全部环境变量 `envValueDigests` 与剥离 PAT 后的 `nonPatEnvEntries`；(4) `importer.ts` 新增安装前 `onExportedFilesObserved`；`src/index.ts` 通过仅测试观察开关 `--s6-observe-dir` 输出正式进程真实观察到的 `imap-child-*`、`docker-sandbox-*` 与安装前只读导出的 `volume-export-*.bin` 字节；(5) `run-s6.ts` 逐字节扫描上述全部真实边界，核对 `networkMode === "none"` 与 MCP 全槽位值摘要非命中，由 `samplingMatrix` 与 `checkedLocationsBySlot` 动态汇总 `perSlotReport` 与 `uncollectedSamples`。[docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L44-L108) · [docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L768-L835) · [imap-child.ts](../../../src/capabilities/mail/imap-child.ts#L19-L41) · [imap-client.ts](../../../src/capabilities/mail/imap-client.ts#L232-L260) · [importer.ts](../../../src/capabilities/workspace/importer.ts#L1021-L1028) · [index.ts](../../../src/index.ts#L105-L110) · [run-s6.ts](../../../tests/week2/run-s6.ts#L640-L895) | `S6`（`runId = s6_2b3c0d87`）：正式入口 `src/index.ts` 启动校验 `remainingSecretVars = []`；实测 `dockerTaskContainer.networkMode = "none"`（来自真实 inspect）、`rawEnvEntriesCount = 3`、`dockerCliMinimalEnvKeysPassed`（11 键，含实参值扫描 `docker_cli_passed_env`）、`volumePreInstallExport = { readOnlyMountVerified: true, exportedFilesCount: 1, exportedTotalBytes: 34 }`（安装前只读卷字节扫描 `volume_export_bytes`）、`imapChildObservedValueDigestCount = 13`（`imap_child_raw_env` `2348 B`、`imapChildPasswordPresentInEnv = false`）、`mcpChildNonPatEntriesCount = 14`（`mcp_child_non_pat_env` `2373 B` + `mcp_child_env_digests` 摘要逐键比对），`uncollectedSamples = []`，5 槽位动态统计 `checkedLocations`（25/24 项）与 `forbiddenHits = 0`，阳性对照 `2/2`。继续实事求是登记 `docker.exe` 外部 OS `GetEnvironmentStrings` 为未直接从外部 hook 采样。证据：[s6-evidence.json](evidence/round5/week2/s6-evidence.json) |
| **W2-R4-E1** | P2 | **等待审批轮次可观察终态完成再切换 FakeModel 脚本，并以事件/快照投影轮询取代固定 `450ms` sleep。** `tests/week2/run-v04-v05.ts` 在 `fakeModel.queue({ clear: true, ... })` 前轮询 `/snapshot` 直至 `proposals[0].approvalState === "APPROVED"`、`effect.state === "SUCCEEDED"` 且消息含审批轮结束回复 `"V05 approval done."`；提交 `"Delegate worker"` 后轮询等待 `workerTasks.some(w => w.status === "done")` 与 `"ROUTER_AFTER_WORKER_V05"` 投影到位，并核验独立 FakeModel 物理请求严格按 `["fake-router-1", "fake-worker-1", "fake-router-1"]` 顺序落盘。[run-v04-v05.ts](../../../tests/week2/run-v04-v05.ts#L741-L824) | `V04_V05`（`runId = v04v05_9c4c67ea`）：全量及单项回归均一次性稳定通过；独立 FakeModel 实录 `workerDelegationRequestOrder = ["fake-router-1", "fake-worker-1", "fake-router-1"]`，与其余 `V04` 窗 1–3 强杀及 `V05` 撤权/缺号重取/旧游标/并发竞争检查全部 PASS。证据：[v04-v05-evidence.json](evidence/round5/week2/v04-v05-evidence.json) |

### 14.2 第 5 轮冻结候选 `2a40af7` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = 2a40af787c09cc70f4fb247c6dab7fb851cf5f73`、工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$evRoot = Join-Path $env:TEMP 'aegis-w2r5-final-2a40af78'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'w1-data') --evidence-dir (Join-Path $evRoot 'w1-ev')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'w2-data') --evidence-dir (Join-Path $evRoot 'w2-ev')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据（第 5 轮固定路径） |
|---|---|---|---|---|---|
| `tsc --noEmit` 与分层守卫 | `0` | `week2_41717bff` | 纯 TypeScript 可擦除类型检查通过；单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round5/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_266af2e8` | `S1–S5` 5/5 PASS；矩阵 25/25 PASS；`W1-A`（`w1a_085f0156`）3 足额对照各 `serverCountDelta = 1`、6 不足负例各 `serverCountDelta = 0`；`W1-B`（`w1b_b74bba87`）强杀 PID `37128` -> 重启 PID `5964` / `41428`，`effectId = efx_e3359339316e4788b150d9e020b16431`，独立假 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新后显 `结果待核对`、`secretLeaksCount = 0` | **PASS** | [week1-summary.json](evidence/round5/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round5/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round5/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round5/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round5/week1/matrix-evidence.json) |
| **S6（正式入口 + 逐值实采）** | `0` | `s6_2b3c0d87` | `remainingSecretVars = []`；阳性对照 `2/2`；活跃 WAL（449112–502672 B / 1940552–2117712 B）、SSE（9589 B）、IMAP 原始 env 与 13 键摘要、Docker 真实 `inspect.HostConfig.NetworkMode = "none"` 与 `.Config.Env` 实值、Docker CLI 实传参数、安装前 `volume_export_bytes`（34 B）、MCP `nonPatEnvEntries`（14 项）与摘要全过，动态 `uncollectedSamples = []` 且 5 槽位 `totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round5/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_9c4c67ea` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:ee923336a407d4017460358bff07ff45`）；审批终态同步后委派请求序列严格为 `["fake-router-1","fake-worker-1","fake-router-1"]`；撤权后旧游标重连 `0` 历史业务帧并返 `resync`、服务端与前端脱敏、编辑/批准 `403`、效果领取拒绝与 SMTP `0` | **PASS** | [v04-v05-evidence.json](evidence/round5/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_e7585c63` | 凭据目标绑定与错配拦截通过；旧 MCP 库 0 预算拒绝两次开库迁移通过；真实委派 Worker（`id = "31"`）与全路径单撤读取后发送增量 `0`；IMAP 无命中 `no_matching_message`（`filterMissBodyFetchDelta = 0`）且不改 `\Seen`；GitHub MCP `totalWriteCallsOnServer = 0` | **PASS（替身）** | [v02-evidence.json](evidence/round5/week2/v02-evidence.json) |
| **V03** | `0` | `v03_f829cd7c` | 不可变镜像 `sha256:e9f565d3...`；同执行轮次强杀跨重启保持原冻结基线防覆盖 `CONFLICT_SAVED` 且 `/input` 剔除已撤权缓存路径；持久化快照目录缺失 fail-closed；顺序两步安装（`43a3c294...` -> `4b01cae4...`）；重叠冲突、出口后撤权与强杀 PID `39904` -> `15604` Step 5c 恢复全过 | **PASS** | [v03-evidence.json](evidence/round5/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_7d9fd2f2` | 正式 `src/index.ts`（`http://127.0.0.1:57943`）未配置 fail-closed、`beforeResume` 挂起恢复、`reports/weekly.md` 写入（`31d1598f...`，`firstToolProgressMs = 200`、`completionMs = 12453`）与刷新核对；`A->B->A` 改稿后迟到保存及重绘保留新编辑、`Save+注销` 竞态清洁收口、`save`/`approve`/`reject`/聊天切换、撤权清本地草稿、无刷新过期 410 与直连真实 `runW1B`（`w1b_327f21ab`，PID `20112`，`efx_144eb1c08a5f44e68aad03f97dace206`）全过 | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round5/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 逐 token `firstTokenMs`（`firstToolProgressMs = 200ms`、`completionMs = 12453ms` 已实测）仍标注 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测严格分离。

### 14.3 第 5 轮审计人复审与签收栏

**候选 `2a40af7` 暂缓验收。** 本轮关闭 W2-R4-E1，剩余 **3 项**。独立复跑已确认 Router 的原恢复问题修复，但同一 Worker 在强杀重启后仍覆盖了用户编辑。Edge 另复现了旧登录会话的保存回执清除重新登录后的新草稿。S6 逐值覆盖已补齐，正式宿主的取证路径仍须改为在内存扫描，仅落脱敏计数。

#### 14.3.1 同候选独立复跑

| 核对项 | 退出码 / 结果 | 实得 |
|---|---|---|
| 冻结候选、依赖、证据目录 | 通过 | 分离工作树 HEAD 为 `2a40af787c09cc70f4fb247c6dab7fb851cf5f73`。后续 `ac04235` 只更新两份报告及新增第 5 轮证据，前四轮归档未变化。本轮未修改依赖清单与锁文件。Windows x64、Node 22.23.5、SQLite 3.54.1、npm 10.9.9、Docker 29.9.2、Edge 157.0.4341.60。 |
| 类型检查与分层 | `0` / 通过 | 独立 `tsc --noEmit` 退出 0，分层守卫 `violations: []`。 |
| 第 1 周全量 | `0` / 通过 | `week1_c932e45b`，S1–S5 5/5，矩阵 25/25。W1-A `w1a_29ec81d4` 三个足额对照各新增 1 次，六个不足负例各新增 0 次。W1-B `w1b_bf81f4a5` 独立 SMTP 累计 1 封、领取 1 次，刷新后效果仍为 `UNKNOWN`。 |
| 两份历史治理库 | 各 `0` / 通过 | 旧 W1 治理库二次打开保留 8 条会话授权、补齐 6 条拒绝记录。第 1 轮旧 MCP 库二次打开保留服务与工具 Pin 各 1 条，补齐 `command`、`args_json`。两份副本外键异常均为 0。 |
| 第 2 周原样全量 | `0` / 既有夹具全部通过 | `week2_8d0569c1`，V04/V05 `v04v05_5a65b7e3`、V02 替身 `v02_90261a3d`、V03 `v03_c952b8a8`、S6 `s6_3a8c902b`、正式入口 Edge `v01v06_8c0410a7` 均通过。 |
| S6 原样专项 | `0` / 夹具通过 | `s6_a265b359`，正式进程实得 `networkMode=none`、卷只读导出 1 项 34 B、已测点禁止命中 0；观察器自身的落盘边界见下表。 |
| V04/V05 原样专项与独立 SSE 验证 | 各 `0` / 通过 | 原样专项 `v04v05_768dc585`。附加取证 `v04v05_0366b4bd`，从游标序号 10 打开流，收到 10 帧，序号 17–20 的四个 `delta` 均投影 Worker 完成，最终快照序号 20。独立假模型请求顺序为 Router → Worker → Router。 |
| 正式入口独立强杀恢复 | Router `0`，同一 Worker `1` | 两组均命中第一文件安装后、回执持久化前窗口，在同一代际重启。Router 保住原基准，结果 `CONFLICT_SAVED`、安装 0 次。Worker 重启后取了新基准，结果 `INSTALLED`、安装 1 次，覆盖了停机期用户编辑。 |
| Edge 同主体重新登录 | `1` / **未通过** | 旧保存已由宿主受理，HTTP 回执延迟交给页面。注销、同主体重新登录后，录入一份新的未保存草稿。回执放行前新草稿已录入并标为未保存。放行并重绘后 `keptDirty=false`、`keptDraftOnRedraw=false`、`oldSaveRestored=true`。 |

#### 14.3.2 逐项裁定与复签条件

| 编号 | 裁定 | 实得与复签条件 |
|---|---|---|
| W2-S3（P1） | **未关闭** | Router 持久快照、顺序更新以及重启前撤权的回归已覆盖。独立强杀试验中同一 Worker 会话 20 的第二个工具恢复后新建了 Worker 本地轮次快照，原快照仍以 Router 轮次 8 为键。原基准 `e257f7df…`，错误新基准为停机编辑 `3b574377…`，最终文件变为 `c95c6333…`，安装 1 次。Worker 与发起轮次的关联仅存在内存，须在 Worker 提交前持久化并于调度恢复时使用，无法确认旧关联或基准时停止安装并在原会话显示可核对状态。缓存路径重验目前早于异步镜像检查、建卷与执行，源码仍有撤权到启动之间的间隔。使挂载内容与实际启动时的授权一致，并回归 Router、同一 Worker 和缓存路径撤权。[执行轮次解析](../../../src/runtime/harness.ts#L580-L606) · [委派绑定](../../../src/runtime/harness.ts#L883-L896) · [挂载准备](../../../src/index.ts#L411-L457) |
| W2-S4（P2） | **部分关闭** | 同一次登录中的 A→B→A 新编辑和注销后保持退出状态由原样 Edge 用例覆盖。独立 Edge 检查确认，旧回执仍会通过同主体比较，复用注销时清零的编辑计数，清除下一次登录的新草稿。把回执绑定到认证会话，退出开始时立即作废旧会话回执。批准和拒绝的挑战回执在发起第二次请求前也应复核认证会话与原视图。补齐同主体重新登录后放行旧回执及快照重绘的断言。[保存与决定回执](../../../src/web/view1.ts#L663-L736) · [注销](../../../src/web/view1.ts#L787-L807) |
| W2-S6（P1） | **证据覆盖已补，取证边界未关闭** | 真实 Docker inspect 的网络模式和逐值采样、IMAP/MCP 子进程环境以及安装前私有卷导出均进入检测。正式入口仍可仅凭观察目录开关，把 IMAP、Docker 的环境原值及卷字节在扫描前写入磁盘。若被测禁止值出现，取证器本身会先持久化该值。这是源码审查发现，本轮只用了合成凭据。按 AGENTS 第 4、5 条及任务书 S6，在采样端内存计算各槽位命中数、采样字节数及允许位置，仅落脱敏结果。保留正式进程实采、阳性对照、真实 inspect 和未直接观测项。[观察开关](../../../src/index.ts#L105-L109) · [连接器取证](../../../src/index.ts#L226-L238) · [沙箱及私有卷取证](../../../src/index.ts#L464-L552) |
| W2-R4-E1 | **关闭** | 原样专项和全量的 V04/V05 子项已通过，审批结束后才替换脚本。原样夹具验证快照及物理请求顺序，审计补采 Worker 完成 SSE 的游标、帧与最终快照，补齐 V05 证据。 |

#### 14.3.3 命令与证据索引

在隔离工作树以新数据目录运行。独立探针保存在审计目录，候选实现保持冻结。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round5-2a40af7'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode ./node_modules/typescript/bin/tsc --noEmit
& $auditNode tests/week1/run-all.ts --data-dir "$auditRoot/week1/data" --evidence-dir "$auditRoot/week1/evidence" --keep-data true
& $auditNode tests/week2/run-all.ts --data-dir "$auditRoot/week2/data" --evidence-dir "$auditRoot/week2/evidence" --keep-data true
& $auditNode tests/week2/run-v04-v05.ts --data-dir '../v04-v05-repeat/data' --evidence-dir '../v04-v05-repeat/evidence'
& $auditNode ../v04-v05-sse-probe.mts
& $auditNode tests/week2/run-s6.ts --data-dir '../s6-repeat/data' --evidence-dir '../s6-repeat/evidence'
$probe = Get-Content -Raw -Encoding utf8 '../restart-frozen-import-probe.mjs'
& $auditNode --input-type=module -e $probe '../restart-frozen-import'
$probe = Get-Content -Raw -Encoding utf8 '../restart-same-worker-import-probe.mjs'
& $auditNode --input-type=module -e $probe '../restart-same-worker-import'
& $auditNode ../edge-relogin-probe.mts
```

两周汇总与专项 JSON 分别在 `week1/evidence` 和 `week2/evidence`。S6 原样专项见 `s6-repeat/evidence/s6-evidence.json`。Worker 完成的 SSE 观察见 `v04-v05-sse/evidence/worker-completion-sse.json`。Router 与同一 Worker 的强杀结果分别见 `restart-frozen-import/result.json`、`restart-same-worker-import/result.json`，后者的 `snapshot-index.json` 保存两个快照键与基准。首个委派探针的第二个工具由 Router 执行，未用作同一 Worker 结论。Edge 结果见 `edge-relogin/evidence/same-principal-relogin.json`。两份旧库沿用 §12.3.4 的只读备份探针，独立输出 `legacy-schema-check.json` 和 `mcp-legacy-check.json`。

真实 Gmail IMAP、真实 GitHub MCP 的授权只读和 V01 逐 token 首延迟仍单列为**待验证**。后续在本报告第 15 节按 W2-S3、W2-S4、W2-S6 回执。

**审计人 / 日期**　Codex 独立复审 / 2026-11-26（Asia/Hong_Kong）。

---

## 15. 第 5 轮 §14.3 整改回执与第 6 轮最终复审签收栏（冻结候选 `5269a81`）

- **第 6 轮冻结代码候选提交（全号）**：`5269a81d58c0f20af458ca5f0850dba6ec174d54`（位于 `v2` 分支）
- **多轮提审与审计链（前 5 轮证据目录及文档提交记录均完整保留、零覆写）**：
  - 第 6 轮代码整改冻结提交：`5269a81d58c0f20af458ca5f0850dba6ec174d54`
  - 第 5 轮冻结代码与文档提交：`2a40af787c09cc70f4fb247c6dab7fb851cf5f73` / `ac0423595a96712b99c6a00d4b853e7e5f0ae22f`（证据固化于 `evidence/round5/`）
  - 第 4 轮冻结代码与审计提交：`8260b8bc18185857805d0e15211c70fd28345728` / `0066bc9b77ae37801eed0694899a50cda87f725b` + `b436e4a5992a2491dc3bce40f98172e92e3dc240`（`evidence/round4/`）
  - 第 3 轮候选：`2dffb01fe0711a9b727b9f41006ed55bcac335b7` / `f66366be0ea6bfc09744354f035add69be5f3e40`（`evidence/round3/`）
  - 第 2 轮与第 1 轮候选：`efba0eda53a21cf5f935846377f8ab03ff42eb69`（`evidence/round2/`）、`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`（`evidence/`）
- **`package.json` 与 `package-lock.json`（LF 字节 SHA-256 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`）**：继续零修改；锁定 Node `22.23.5`（SQLite `3.54.1`）、npm `10.9.9` 与纯 TypeScript 单向四层依赖边界不变。
- **同一冻结候选 `5269a81d58c0f20af458ca5f0850dba6ec174d54` 全量验证与归档**：
  - `tsc --noEmit`：退出码 `0`
  - `tests/week1/run-all.ts`：退出码 `0`，`runId = week1_024eb012`（`S1–S5` 5/5、`W1-A` 9/9 `w1a_4a5aa2f4`、`W1-B` `w1b_d554586b` `efx_57ad62a12d214be7aa229bd3af7f52a3`、矩阵 25/25）
  - `tests/week2/run-all.ts`：退出码 `0`，`runId = week2_398e87ed`（`typecheck`、`layerBoundary`、`v04_v05`、`v02`、`v03`、`s6`、`v01_v05_v06_browser` 全部 PASS）
  - **第 6 轮不可变脱敏证据目录**：[evidence/round6/week1/](evidence/round6/week1/) · [evidence/round6/week2/](evidence/round6/week2/)（已校验零本机用户绝对路径与零合成秘钥残留）。

### 15.1 针对 §14.3 剩余 3 项的逐项整改回执

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `5269a81` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-S3** | P1 | **持久化 Worker->Router 执行轮次关联、缺失即停止安装转 `PENDING_RECONCILE`，并消除容器挂载前异步撤权间隔。** (1) `db.ts` 在基础 Schema 与 Migration 5 新增 `worker_execution_roots(runtime_epoch, worker_conversation_id, parent_conversation_id, execution_root_task_id, created_at)`；(2) `policy.ts` 新增 `persistWorkerExecutionRoot` / `getWorkerExecutionRoot` / `listWorkerExecutionRoots`，并将 `findRelatedConversationIdsByOwnerTask` 同步联合 `worker_execution_roots` 血缘；(3) `harness.ts` 在 `workerConv.submit(...)` 前事务持久化 `worker_execution_roots`、启动时（`harness.resume()` 前）全量恢复 `workerExecutionRootByConv` 与 `parentByWorkerConv`；若已标识 `worker` 会话缺少持久根关联，返回 `__MISSING_WORKER_EXECUTION_ROOT__` 拒绝新建 Worker 本地快照；(4) `importer.ts` 新增 `recordPendingReconcileImport`；`index.ts` 遇到缺失 Worker 根关联或缺失持久化快照/基线时立即记录 `PENDING_RECONCILE`（`install_count = 0`）并投影回原父会话；(5) `docker-sandbox.ts` 新增 `prepareInputSnapshotDirSync`，在异步镜像核对与建卷完成后、`docker run` 生成子进程前同步复核目标授权并构筑 `/input` 挂载，消除异步 TOCTOU 窗口。[db.ts](../../../src/governance/db.ts#L336-L343) · [db.ts](../../../src/governance/db.ts#L609-L618) · [policy.ts](../../../src/governance/policy.ts#L546-L645) · [harness.ts](../../../src/runtime/harness.ts#L585-L615) · [harness.ts](../../../src/runtime/harness.ts#L703-L707) · [harness.ts](../../../src/runtime/harness.ts#L923-L940) · [docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L195-L207) · [docker-sandbox.ts](../../../src/capabilities/workspace/docker-sandbox.ts#L755-L808) · [importer.ts](../../../src/capabilities/workspace/importer.ts#L1419-L1479) · [index.ts](../../../src/index.ts#L478-L545) | `V03`（`runId = v03_04950338`）：(a) 正式 `src/index.ts` 委派 Worker（`hostWrk1`）第 1 个工具写 `reports/wrk-a.md` 于安装后回执前屏障强杀，停机期编辑 `reports/wrk-b.md`，重启 `hostWrk2` 后同一 Worker 复用 Router 原冻结快照触发 `CONFLICT_SAVED` 保住停机编辑，全库仅存在 `1` 条 `task_frozen_snapshots` 记录（`sameWorkerCrashRecoveryConflictPreserved = true`）；(b) 删除 `worker_execution_roots` 后恢复 `hostWrk3` 尝试写入 `reports/wrk-missing-root.md`，立即停止安装（`installCount = 0`、磁盘零改写）并在原 Router 会话投影出 `PENDING_RECONCILE`（`sameWorkerMissingRootPendingReconcileVerified = true`）；(c) 既有 Router 同轮强杀（PID `36400` -> `38988`）、缓存路径撤权剔除、缺失快照 `frozen_snapshot_missing` 及顺序更新全过。证据：[v03-evidence.json](evidence/round6/week2/v03-evidence.json) |
| **W2-S4** | P2 | **将全部异步操作回执绑定至单调认证会话序号 `authSessionSeq`，注销起始即失效旧回执并在 `/challenge` 后重验。** (1) `view1.ts` 状态新增 `authSessionSeq`，每次 `#login-btn` 登录成功及 `#logout-btn` 点击最前（`await /api/auth/logout` 之前）立即自增 `++state.authSessionSeq`；(2) `isCurrentView(reqConvId, reqEpoch, reqGen, reqAuthSeq)`、`saveBtn`、`submitDecision`、`#chat-send-btn`、`new-conv-btn`、`loadConversations`、`selectAndSubscribe` 均绑定 `reqAuthSeq`；(3) `submitDecision` 在拿到 `/challenge` 后、发起 `/api/approvals/decide` 前先复核 `state.principalId`、`state.authSessionSeq === reqAuthSeq` 与 `isCurrentView(...)`，决定返回后再次校验。因此同账号快速注销并重新登录后，`authSessionSeq` 已递增，即使新会话将同一草案从 `0` 改写为 `1`，旧会话迟到 `Save` 回执也会被静默丢弃。[view1.ts](../../../src/web/view1.ts#L120-L128) · [view1.ts](../../../src/web/view1.ts#L200-L206) · [view1.ts](../../../src/web/view1.ts#L670-L745) · [view1.ts](../../../src/web/view1.ts#L790-L830) | `V01_V05_V06_BROWSER`（`runId = v01v06_1190173b`）：Edge CDP 实测 `samePrincipalReloginPreservedNewDraft`：Session 1 发出延迟 `Save` -> 注销 -> 以同一 `owner` Token 立刻重新登录 -> 切至原会话录入新未保存草稿（编辑版本从 `0` 增至 `1`）-> 放行旧会话延迟 `Save` 并点击 `refresh-btn` 强制快照重绘，实得 `reloggedInSamePrincipal = true`、`keptDirty = true`、`keptDraftOnRedraw = true`、`oldSaveRestored = false`、`approveDisabled = true`；既有 `A->B->A` 改稿、`Save+注销` 及 `save`/`approve`/`reject` 跨会话测试全过。证据：[v01-v06-browser-evidence.json](evidence/round6/week2/v01-v06-browser-evidence.json) |
| **W2-S6** | P1 | **在采样端内存完成全部禁止值字节扫描，磁盘只落脱敏键名、SHA-256 摘要、字节数与命中计数。** (1) `index.ts` 新增纯内存扫描器 `collectInMemorySlotMarkers()` 与 `scanBufferStrictlyInMemory()`（直接读取内存 `HostCredentialVault` 与 `consoleToken(s)`），在 `--s6-observe-dir` 的 `imapEndpoint.onObserveChildEnv`、`docker.onInspectObserved` 与 `importer.onExportedFilesObserved` 回调内对 IMAP 子进程 env 实体、Docker inspect `.Config.Env` 与 CLI 参数、及导出卷 `Buffer` 字节**完全在内存扫描**，仅将 `{ observedInMemoryOnly: true, rawValuesWrittenToDisk: false / rawBytesWrittenToDisk: false, keys, valueDigests, scannedBytes, networkMode, forbiddenHitsBySlot, totalForbiddenHits }` 写入 JSON，彻底禁止向磁盘写入任何原始环境变量值或 `.bin` 卷文件；(2) `fake-github-mcp-server.ts` 亦移除 `nonPatEnvEntries` 原始值落盘，仅记录键名、全部值 SHA-256 前缀 `envValueDigests` 与 `nonPatEnvCount / nonPatEnvScannedBytes`；(3) `run-s6.ts` 校验观察目录零 `.bin` 文件且脱敏扫描结果 `observedInMemoryOnly = true / totalForbiddenHits = 0`，将内存实采字节数与命中计入 `samplingPointMatrix` 与每槽位 `slots`。[index.ts](../../../src/index.ts#L199-L240) · [index.ts](../../../src/index.ts#L275-L305) · [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts#L73-L102) · [run-s6.ts](../../../tests/week2/run-s6.ts#L640-L790) | `S6`（`runId = s6_4e36e781`）：正式入口启动校验 `remainingSecretVars = []`；实测观察目录零 `.bin` 文件、`observerInMemoryOnly = true`、`rawValuesOrVolumeBytesWrittenToDisk = false`、`volumePreInstallExport = { readOnlyMountVerified: true, exportedFilesCount: 1, exportedTotalBytes: 34, observedInMemoryOnly: true, rawBytesWrittenToDisk: false }`、`dockerTaskContainer.networkMode = "none"`（inspect 实得）、`imapChildObservedValueDigestCount = 13`、`mcpChildNonPatEntriesCount = 14`、`uncollectedSamples = []`、5 槽位 `totalForbiddenHits = 0`（阳性对照 `2/2`）。未直接采集项继续诚实登记 `docker.exe` 外部 OS `GetEnvironmentStrings`。证据：[s6-evidence.json](evidence/round6/week2/s6-evidence.json) |

### 15.2 第 6 轮冻结候选 `5269a81` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = 5269a81d58c0f20af458ca5f0850dba6ec174d54`、源码工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$evRoot = Join-Path $env:TEMP 'aegis-w2r6-final-5269a81d'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'w1-data') --evidence-dir (Join-Path $evRoot 'w1-ev')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'w2-data') --evidence-dir (Join-Path $evRoot 'w2-ev')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据（第 6 轮固定路径） |
|---|---|---|---|---|---|
| `tsc --noEmit` 与分层守卫 | `0` | `week2_398e87ed` | 纯 TypeScript 可擦除类型检查通过；单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round6/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_024eb012` | `S1–S5` 5/5 PASS；矩阵 25/25 PASS；`W1-A`（`w1a_4a5aa2f4`）3 足额对照各 `+1`、6 负例各 `0`；`W1-B`（`w1b_d554586b`）强杀 PID `32208` -> 重启 `21560` / `44420`，`effectId = efx_57ad62a12d214be7aa229bd3af7f52a3`，独立 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新显 `结果待核对`、`secretScan.clean = true` | **PASS** | [week1-summary.json](evidence/round6/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round6/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round6/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round6/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round6/week1/matrix-evidence.json) |
| **S6（正式入口 + 内存态扫描）** | `0` | `s6_4e36e781` | `remainingSecretVars = []`；阳性对照 `2/2`；`observerInMemoryOnly = true`、`rawValuesOrVolumeBytesWrittenToDisk = false`（零 `.bin` 文件）；Docker inspect 实得 `networkMode = "none"` 与 `.Config.Env` 实值内存扫描、安装前 `volume_export_bytes`（34 B）内存扫描、IMAP（13 键摘要、`passwordPresentInEnv = false`）、MCP 非 PAT（14 项）摘要与活跃 WAL/SSE 全过，`uncollectedSamples = []`、`totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round6/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_9466075a` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:287de77c97514ea032eaaee9af9bae8c`）；`workerDelegationRequestOrder = ["fake-router-1","fake-worker-1","fake-router-1"]`；撤权旧游标 `0` 业务帧、前后端脱敏、编辑/批准 `403` 与领取拒 `0` 封 SMTP | **PASS** | [v04-v05-evidence.json](evidence/round6/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_65cec93e` | 凭据绑定拦截、`legacyMcpMigrationCheck`、`run_worker` 委派（`id = "31"`）与全路径单撤读取后发送增量 `0`、IMAP 不改 `\Seen` 且无命中 `0` 正文获取、GitHub MCP `totalWriteCallsOnServer = 0` | **PASS（替身）** | [v02-evidence.json](evidence/round6/week2/v02-evidence.json) |
| **V03** | `0` | `v03_04950338` | 不可变镜像 `sha256:e9f565d3...`；同 Worker 强杀跨重启复用 Router 冻结基线防覆盖 `CONFLICT_SAVED`、缺失 `worker_execution_roots` 停止安装并在原会话显 `PENDING_RECONCILE`、Router 同轮强杀与缓存撤权剔除、挂载前零间隔同步重验、缺失快照 fail-closed、顺序更新（`66bd55d5...` -> `c528c713...`）与强杀 PID `36400` -> `38988` Step 5c 恢复全过 | **PASS** | [v03-evidence.json](evidence/round6/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_1190173b` | 正式 `src/index.ts`（`http://127.0.0.1:64281`）演示句写入 `reports/weekly.md`（`31d1598f...`，`firstToolProgressMs = 202`、`completionMs = 14218`）与刷新核对；同一主体注销重登录后 `samePrincipalReloginPreservedNewDraft` 保住新草稿与脏标（重绘无回滚）、`A->B->A` 改稿、`Save+注销`、撤权清本地草稿、无刷新过期 410 与直连真实 `runW1B`（`w1b_d71601e4`，强杀 PID `38764`，`efx_09e95a5b387e49fc849de09de66a210a`）全过 | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round6/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 逐 token `firstTokenMs`（`firstToolProgressMs = 202ms`、`completionMs = 14218ms` 已实测）继续标注 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测严格分离。

### 15.3 第 6 轮审计人复审与签收栏

**候选 `5269a81` 暂缓验收，还剩 2 项。** 两周原样全量独立复跑均通过。W2-S4 关闭。同一 Worker 已能在强杀恢复后沿用原基准，但新增的待核对分支会降级已经成功的导入回执。S6 正式观察器已改为内存扫描，MCP 子进程的逐槽位取证仍有缺口。

#### 15.3.1 同候选独立复跑

| 核对项 | 结果 | 实得 |
|---|---|---|
| 冻结候选与证据归档 | 通过 | 隔离工作树 HEAD 为 `5269a81d58c0f20af458ca5f0850dba6ec174d54`。后续 `db2b70b` 更新报告并新增第 6 轮证据，前五轮证据目录未改动。依赖清单与锁文件同 `2a40af7`。Windows x64，Node 22.23.5、SQLite 3.54.1、npm 10.9.9、Docker 29.9.2、Edge 157.0.4341.60。 |
| 类型检查与分层 | `0` / 通过 | 独立 `tsc --noEmit` 退出 0。第 2 周分层守卫 `violations: []`。 |
| 第 1 周全量 | `0` / 通过 | `week1_0fd591ea`，S1–S5 5/5，矩阵 25/25。W1-A `w1a_563b82f2` 三个足额对照各新增 1 次，六个不足负例均为 0。W1-B `w1b_76626a5f` 独立假 SMTP 累计 1 封、领取 1 次，原会话刷新仍显示结果待核对。 |
| 两份旧治理库 | 各 `0` / 通过 | 旧 W1 库二次打开保留 8 条会话授权并补齐 6 条拒绝记录。首轮旧 MCP 库二次打开保留服务和工具 Pin 各 1 条，补齐 `command`、`args_json`。两份副本外键异常均为 0。 |
| 第 2 周原样全量 | `0` / 既有夹具通过 | `week2_14075f5c`，V04/V05 `v04v05_06193630`、V02 替身 `v02_6d46541e`、V03 `v03_057ddc3b`、S6 `s6_ffffa842`、正式入口 Edge `v01v06_ef60bc2f` 均通过。V03 覆盖 Router 与 Worker 强杀、缺失 Worker 根关联时新逻辑键停止安装。 |
| 同一 Worker 独立强杀 | `0` / 通过 | 沿用第 5 轮独立探针。Worker 会话 `20` 在同一代际重启（PID 49360 → 5336），同一 Worker 的第二个写入使用原基准 `e257f7df…`，结果为 `CONFLICT_SAVED`、安装 0 次，停机编辑摘要 `3b574377…` 保持。 |
| 同账号重新登录独立 Edge 探针 | `0` / 通过 | 沿用第 5 轮独立探针。旧保存回执放行并重绘后，`keptDirty=true`、`keptDraftOnRedraw=true`、`oldSaveRestored=false`。 |
| 已成功导入回执的待核对分支 | `1` / **未通过** | 只读备份同一 Worker 独立强杀实测的治理库。将第一文件的真实 `INSTALLED` 回执交给候选的缺失快照处理函数。副本中状态由 `INSTALLED` 变为 `PENDING_RECONCILE`，安装次数由 1 变为 0。返回的导入 ID 与库中保留的 ID 不同，文件摘要前后相同。 |
| S6 原样专项与检测对照 | 专项 `0` / 既有夹具通过 | `s6_1fb1ab93`，正式观察目录只写了 3 份 JSON，无 `.bin`。正式任务容器实得网络模式为 `none`，只读导出为 1 项 34 B。另有独立合成字符串对照证实整值摘要可识别整值等于标记，变量值包含标记的情形仅字节扫描检出。 |

#### 15.3.2 逐项裁定与复签条件

| 编号 | 裁定 | 实得与复签条件 |
|---|---|---|
| W2-S3（P1） | **部分关闭，回执一致性仍阻断** | 同一 Worker 复用正确的冻结基准。缺失根关联、快照或基线时，正式入口在查询原安装回执之前调用 `recordPendingReconcileImport`。该函数按逻辑键冲突更新，实测可抹去已有的 `INSTALLED` 和累计安装次数，并返回一个未持久化的导入 ID。源码也显示已为 `PENDING_RECONCILE` 的同键记录在条件恢复后可能继续普通导入。按 V03，先核对并保留已有结论、安装次数及原 ID，仅为尚无回执的逻辑键登记待核对。回归覆盖两种组合，一种是已安装或启动对账已补回执后快照缺失再重入，另一种是已待核对后重复重入。逐项校验文件摘要、回执状态、同一 ID 和累计安装次数。[正式入口](../../../src/index.ts#L478-L545) · [重入判断](../../../src/capabilities/workspace/importer.ts#L724-L748) · [待核对登记](../../../src/capabilities/workspace/importer.ts#L1419-L1474) |
| W2-S4（P2） | **关闭** | 同账号重新登录的原样夹具和上一轮独立 Edge 探针均保住了新草稿。源码确认注销开始即使旧认证会话序号失效，挑战响应在发出决定前复核认证会话与原视图。 |
| W2-S6（P1） | **原始样本落盘已关闭，MCP 取证仍阻断** | 正式宿主观察器已不持久化原始环境值或私有卷字节。MCP 替身对实际环境值生成的是整值摘要和字节数量，汇总对照的是标记的整值摘要，仍把该处的 `hits` 固定写成 0 并计入五槽位覆盖。整值摘要不能检出变量值中包含的标记，已用合成字符串对照独立确认。按任务书 §五 S6，在合成 MCP 子进程内扫描实际变量值，保留允许槽位及位置规则，只持久化每槽位实得命中数。给正式内存采样检测补合成阳性对照，并把实得计数纳入总计与未采清单。现有 2/2 阳性对照覆盖的是控制器的文件与缓冲区扫描。[MCP 样本生成](../../../tests/fakes/fake-github-mcp-server.ts#L73-L101) · [S6 汇总](../../../tests/week2/run-s6.ts#L734-L786) · [现有阳性对照](../../../tests/week2/run-s6.ts#L174-L183) |

#### 15.3.3 命令与证据索引

命令在分离工作树运行，两个周次使用独立数据目录。探针与本地证据位于审计根目录。候选实现保持冻结。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round6-5269a81'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode ./node_modules/typescript/bin/tsc --noEmit
& $auditNode tests/week1/run-all.ts --data-dir "$auditRoot/week1/data" --evidence-dir "$auditRoot/week1/evidence" --keep-data true
& $auditNode tests/week2/run-all.ts --data-dir "$auditRoot/week2/data" --evidence-dir "$auditRoot/week2/evidence" --keep-data true
$probe = Get-Content -Raw -Encoding utf8 '../restart-same-worker-import-probe.mjs'
& $auditNode --input-type=module -e $probe '../restart-same-worker-import'
$probe = Get-Content -Raw -Encoding utf8 '../receipt-before-reconcile-probe.mjs'
& $auditNode --input-type=module -e $probe
& $auditNode ../edge-relogin-probe.mts
& $auditNode tests/week2/run-s6.ts --data-dir '../s6-repeat/data' --evidence-dir '../s6-repeat/evidence'
& $auditNode ../s6-marker-comparison-probe.cjs
```

两周汇总与各专项 JSON 见 `week1/evidence` 和 `week2/evidence`。同一 Worker 实得见 `restart-same-worker-import/result.json`，回执副本实得见 `receipt-before-reconcile.json`，首次回执探针因构造参数类型有误，在修正后重新备份到新副本并完成断言。Edge 结果见 `edge-relogin/evidence/same-principal-relogin.json`。S6 专项与合成字符串对照见 `s6-repeat/evidence/s6-evidence.json` 与 `s6-marker-comparison.json`。旧库复制检查沿用 §12.3.4 的只读探针，结果见 `legacy-schema-check.json` 与 `mcp-legacy-check.json`。

真实 Gmail IMAP、真实 GitHub MCP 的授权只读及 V01 逐 token 首延迟继续列为**待验证**。下一轮在本报告第 16 节按 W2-S3、W2-S6 回执。

**审计人 / 日期**　Codex 独立复审 / 2026-11-26（Asia/Hong_Kong）。

---

## 16. 第 7 轮整改交付、全量验证与最终审签（候选 `8b3aad9`）

本轮针对 §15.3 仅剩的 2 项阻断（`W2-S3`、`W2-S6`）完成源码与回归夹具整改；第 1–15 节历史正文及 `evidence/`、`round2/`–`round6/` 历史证据目录保持完整未动。整改后的唯一冻结代码候选提交为 **`8b3aad9d564dc966d62c13a1b0814170e2113a9f`**（短号 `8b3aad9`）。

### 16.1 针对 §15.3 剩余 2 项的逐项整改回执

| 审计编号 | 级别 | 整改核心措施与源码位置 | 冻结候选 `8b3aad9` 实测结果与脱敏证据 |
|---|---|---|---|
| **W2-S3** | P1 | **在 `recordPendingReconcileImport` 与 `importFileFromTaskVolume` 对已存在逻辑键先判后写，严禁将已安装/冲突/待核对回执覆盖降级，也不允许 `PENDING_RECONCILE` 滑入普通导入。** (1) [importer.ts](../../../src/capabilities/workspace/importer.ts#L722-L785) 在 `importFileFromTaskVolume` 先查询 `managed_file_imports`，对 `CONFLICT_SAVED`、`PENDING_RECONCILE`、`REJECTED` 均与 `INSTALLED` 一并立即幂等/拒绝返回原 `import_id` 与 `install_count`；(2) [importer.ts](../../../src/capabilities/workspace/importer.ts#L1467-L1558) 新增 `getExistingImportRecord`，并将 `recordPendingReconcileImport` 改写为在立即写事务内先读取同 `logical_key` 行：仅当 `state === "PREPARED"` 时转为 `PENDING_RECONCILE` 并保留原 `import_id` 与 `install_count`，其余既有状态（含 `INSTALLED` `install_count = 1`、`CONFLICT_SAVED`、`PENDING_RECONCILE`、`REJECTED`）原样返回并置 `preservedExisting = true`，不再执行覆盖 `ON CONFLICT DO UPDATE` 或返回未落库新 ID；(3) [index.ts](../../../src/index.ts#L490-L565) 在 `workspaceWriteHandler` 缺失根/快照/基线检查之前先行复用 `getExistingImportRecord` 并以 `pendOutcome` 包装待核对返回。[run-v03.ts](../../../tests/week2/run-v03.ts) 新增两项回归（缺失冻结快照后向已有 `INSTALLED` 行调用 `recordPendingReconcileImport`；向 `PENDING_RECONCILE` 行携带恢复后的根/ACL 再次调用 `importFileFromTaskVolume` 与 `recordPendingReconcileImport`）。 | `V03`（`runId = v03_86efe65f`）：(a) Router `reports/same-round-a.md` 真实 `INSTALLED`（`install_count = 1`）在删除冻结快照目录后调用 `recordPendingReconcileImport`，实得 `state = "INSTALLED"`、`installCount = 1`、`importId` 不变、`preservedExisting = true` 且磁盘摘要不变（`missingSnapshotPreservesInstalledReceipt = true`）；(b) Worker `reports/wrk-a.md` 在缺失 `worker_execution_roots` 后亦保持 `INSTALLED` / `installCount = 1`；(c) `reports/wrk-missing-root.md` 转入 `PENDING_RECONCILE`（`install_count = 0`）后再次调用 `importFileFromTaskVolume` 与 `recordPendingReconcileImport`，均返回原 `import_id`、`code = "pending_reconcile"`、`state = "PENDING_RECONCILE"`、`installCount = 0` 且磁盘零改写（`pendingReconcileReentryBlocked = true`）；其余全部 V03 项同轮通过。证据：[v03-evidence.json](evidence/round7/week2/v03-evidence.json) |
| **W2-S6** | P1 | **以加盐 SHA-256 承诺（zero raw secrets）驱动 MCP 子进程内存逐变量子串扫描，并将真实每槽位命中计数接入 `S6` 总表与未采清单。** (1) 新增 L1 纯内存扫描模块 [leak-scanner.ts](../../../src/governance/leak-scanner.ts#L29-L154)（仅依赖 `node:crypto`），提供 `scanBufferInMemory`、`createSaltedMarkerCommitments` 与 `scanEntriesAgainstCommitmentsInMemory`：后者在子进程 RAM 内对全部 `process.env` 键值做滑动窗口加盐 SHA-256 子串匹配，同时强制 `slot:github-mcp-pat` 仅允许精确等值出现于 `GITHUB_PERSONAL_ACCESS_TOKEN`，包裹形态（如 `prefix_<marker>_suffix`）或落入其他键即计为对应槽位命中；(2) [index.ts](../../../src/index.ts#L318-L323) 于密钥注册完成、任何子进程启动前向 `--s6-observe-dir/mcp-commitments.json` 写入加盐承诺（零明文、零其他槽位密钥传入 MCP 子进程）；(3) [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts#L76-L135) 支持 `--commitments-file` 并在内存扫描全量 `process.env`，日志仅持久化 `substringScanPerformed`、`allEnvScannedBytes`、`forbiddenHitsBySlot` 与 `totalForbiddenHits`（`rawValuesWrittenToDisk = false`）；(4) [run-s6.ts](../../../tests/week2/run-s6.ts#L178-L250) 移除硬编码 `hits: 0`，将全量 `mcpStartups.forbiddenHitsBySlot` 实时汇入 `forbiddenHits`、`samplingPointMatrix` 与 `slots`，并新增两条子串阳性对照（`inMemoryCanaryRes` 与真实 SPAWN `fake-github-mcp-server.ts` 携带包裹型 `S6_POS_WRAP` / `S6_POS_EXTRA_PAT`）。 | `S6`（`runId = s6_b7ef93fd`）：(a) 阳性对照全部检出：缓冲区直扫 `2/2`、内存子串 `2/2`、MCP 子进程加盐子串扫描实得 `substringScanPerformed = true`、`rawValuesWrittenToDisk = false`、命中 `{"slot:model-worker":1,"slot:github-mcp-pat":1}`（`totalForbiddenHits = 2`，日志不含原始泄露串）；(b) 正式入口启动 `remainingSecretVars = []`、`mcp_commitments_salted` 与全量 `mcp-calls.jsonl` startup 记录均校验 `substringScanPerformed = true`、`allEnvScannedBytes = 2136`、5 槽位 `mcpChildForbiddenHitsBySlot` 实得全为 `0`、`observerInMemoryOnly = true`、`rawValuesOrVolumeBytesWrittenToDisk = false`（零 `.bin` 文件）、`uncollectedSamples = []`、`totalForbiddenHits = 0`。证据：[s6-evidence.json](evidence/round7/week2/s6-evidence.json) |

### 16.2 第 7 轮冻结候选 `8b3aad9` 全量实测命令、退出码、`runId` 与脱敏证据

以下命令均在 `git rev-parse HEAD = 8b3aad9d564dc966d62c13a1b0814170e2113a9f`、源码工作区干净、锁定工具链 `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`，SQLite `3.54.1`，npm `10.9.9`，Docker `29.9.2/29.9.2`，`msedge.exe`）与全新临时目录下执行：

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$evRoot = Join-Path $env:TEMP 'aegis-w2r7-final-8b3aad9d'
& $node ./node_modules/typescript/bin/tsc --noEmit
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'w1-data') --evidence-dir (Join-Path $evRoot 'w1-ev')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'w2-data') --evidence-dir (Join-Path $evRoot 'w2-ev')
```

| 验证项 | 退出码 | `runId` | 关键实得摘要 | 结果 | 脱敏证据（第 7 轮固定路径） |
|---|---|---|---|---|---|
| `tsc --noEmit` 与分层守卫 | `0` | `week2_30006bf0` | 纯 TypeScript 可擦除类型检查通过；含新增 L1 [leak-scanner.ts](../../../src/governance/leak-scanner.ts) 在内单向分层与单点导入 `violations = []` | **PASS** | [week2-summary.json](evidence/round7/week2/week2-summary.json) |
| **第 1 周全量复签** | `0` | `week1_5c7dc025` | `S1–S5` 5/5 PASS；矩阵 `25/25` PASS；`W1-A`（`w1a_1e4ad6c6`）3 足额对照各 `+1`、6 负例各 `0`；`W1-B`（`w1b_43d54a18`）强杀 PID `13280` -> 重启 `9972` / `40964`，`effectId = efx_c6eb3b2d88b84b7682491078babb4807`，独立 SMTP `totalReceived = 1`、`claimCount = 1`、`approvalCount = 1`、原会话刷新显 `结果待核对`、`secretScan.clean = true` | **PASS** | [week1-summary.json](evidence/round7/week1/week1-summary.json) · [w1-a-evidence.json](evidence/round7/week1/w1-a-evidence.json) · [w1-b-evidence.json](evidence/round7/week1/w1-b-evidence.json) · [s1-s5-evidence.json](evidence/round7/week1/s1-s5-evidence.json) · [matrix-evidence.json](evidence/round7/week1/matrix-evidence.json) |
| **S6（正式入口 + 全链路内存/子串扫描）** | `0` | `s6_b7ef93fd` | `remainingSecretVars = []`；阳性对照三项全过（文件/缓冲 `2/2`、内存子串 `2/2`、MCP 子进程加盐子串 `2/2`）；`observerInMemoryOnly = true`、`rawValuesOrVolumeBytesWrittenToDisk = false`（零 `.bin` 文件）；MCP `mcpChildSubstringScanPerformed = true`（`2136` B、`mcpChildForbiddenHitsBySlot` 全 `0`）；Docker inspect `networkMode = "none"`、安装前 `volume_export_bytes`（34 B）、IMAP（13 键摘要、`passwordPresentInEnv = false`）与 WAL/SSE 全过，`uncollectedSamples = []`、`totalForbiddenHits = 0` | **PASS** | [s6-evidence.json](evidence/round7/week2/s6-evidence.json) |
| **V04 / V05** | `0` | `v04v05_dfe11c9e` | 窗 2 强杀重试唯一提交 `submissionId = 15`（`piRequestId = chatreq:2304300b1ed8fdf382a6b8ebfff5221d`）；`workerDelegationRequestOrder = ["fake-router-1","fake-worker-1","fake-router-1"]`；撤权旧游标 `0` 业务帧、前后端脱敏、编辑/批准 `403` 与领取拒 `0` 封 SMTP | **PASS** | [v04-v05-evidence.json](evidence/round7/week2/v04-v05-evidence.json) |
| **V02（本地替身）** | `0` | `v02_4ddb310c` | 凭据绑定拦截、`legacyMcpMigrationCheck`（`["command","args_json"]`、`foreignKeyViolations = 0`）、`run_worker` 委派（`id = "31"`）与全路径单撤读取后发送增量 `0`、IMAP 不改 `\Seen` 且无命中 `0` 正文获取、GitHub MCP `totalWriteCallsOnServer = 0` | **PASS（替身）** | [v02-evidence.json](evidence/round7/week2/v02-evidence.json) |
| **V03** | `0` | `v03_86efe65f` | 不可变镜像 `sha256:e9f565d3...`；新增 `missingSnapshotPreservesInstalledReceipt = true` 与 `pendingReconcileReentryBlocked = true`；同 Worker 强杀与缺失根 `PENDING_RECONCILE`、Router 同轮强杀与缓存撤权剔除、挂载前同步重验、顺序更新（`ad672a44...` -> `ca0c2662...`）与强杀 PID `32140` -> `42736` Step 5c 恢复全过 | **PASS** | [v03-evidence.json](evidence/round7/week2/v03-evidence.json) |
| **V01 / V05 / V06（实机 Edge）** | `0` | `v01v06_90dfa38d` | 正式 `src/index.ts`（`http://127.0.0.1:49947`）演示句写入 `reports/weekly.md`（`31d1598f...`，`firstToolProgressMs = 226`、`completionMs = 13958`）与刷新核对；同一主体注销重登录 `samePrincipalReloginPreservedNewDraft`、`A->B->A` 改稿、`Save+注销`、撤权清草稿、无刷新过期 410 与直连真实 `runW1B`（`w1b_4a1e12c1`，强杀 PID `31712`，`efx_cbf05de1fb00471599dbbaa5b7fbe64a`）全过 | **PASS（替身 + 实机浏览器）** | [v01-v06-browser-evidence.json](evidence/round7/week2/v01-v06-browser-evidence.json) |

> **替身与真实只读 / 历史基线分列声明**：
> - 真实 Gmail 只读 IMAP、真实 GitHub MCP 只读（缺本机人工授权、`GITHUB_PAT` 与 `github-mcp-server.exe`）及 V01 逐 token `firstTokenMs`（`firstToolProgressMs = 226ms`、`completionMs = 13958ms` 已实测）继续标注 **待验证**；阶段一真实模型计费、真实邮件发送与真实 GitHub 写入保持关闭。
> - v1 历史零信任基线（`3a88b6895991d328e8e27fd1072a29846e7a9adf`，`327/327`、`selfuse 31/31`）仅作历史参考，与本次 v2 实测严格分离。

### 16.3 第 7 轮审计人复审与签收栏

- **结论**　`[x] 签收`　`[ ] 退回整改`。签收候选为 `8b3aad9d564dc966d62c13a1b0814170e2113a9f`，适用阶段一本机验收范围。W2-S3、W2-S6 均关闭，阶段一无剩余代码整改项。
- **审计人 / 日期**　Codex 独立复审 / 2026-11-26（Asia/Hong_Kong）。

#### 16.3.1 同候选独立复跑

| 核对项 | 退出码 / 结果 | 实得 |
|---|---|---|
| 候选与归档 | 通过 | 分离工作树固定在 `8b3aad9d564dc966d62c13a1b0814170e2113a9f`。后续 `dcb0b58` 只更改两份报告并新增第 7 轮证据，前六轮的证据目录未改动。依赖清单与锁文件同第 6 轮，8 项直接依赖实装版本与锁定值一致。锁文件 LF 字节 SHA-256 为 `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`。Windows x64，Node 22.23.5、SQLite 3.54.1、npm 10.9.9、Docker 29.9.2、Edge 157.0.4341.60。 |
| 类型及分层 | `0` / 通过 | 独立 `tsc --noEmit` 退出 0，分层守卫 `violations: []`。 |
| 第 1 周全量 | `0` / 通过 | `week1_9feecd58`，S1–S5 5/5，矩阵 25/25。W1-A `w1a_3f7b6283` 足额对照各新增 1 次，六个不足负例各新增 0 次。W1-B `w1b_bde79ca4` 独立 SMTP 累计收件与成功领取各 1 次，原会话刷新仍显示 `UNKNOWN` 对应的“结果待核对”。 |
| 第 2 周全量 | `0` / 通过 | `week2_9701b8cc`，V04/V05 `v04v05_a1a6e1db`、V02 替身 `v02_1951bb6f`、V03 `v03_764ced13`、S6 `s6_bf6a155b` 和正式入口 Edge `v01v06_4d696acf` 均通过。 |
| 两份历史治理库 | 各 `0` / 通过 | 旧 W1 库二次打开保留 8 条会话授权，补齐 6 条拒绝记录代际。首轮旧 MCP 库二次打开保留服务与工具 Pin 各 1 条，补齐 `command` 和 `args_json`。两份副本外键异常均为 0。 |

#### 16.3.2 逐项签收

| 编号 | 裁定 | 独立核对结果 |
|---|---|---|
| W2-S3 | **关闭** | 用同一份上轮已失败的回执探针复跑，新治理库副本中的 `INSTALLED` 状态、原 `importId` 和安装次数 1 均保留，权威文件 SHA-256 前后一致。独立待核对重入探针退出 0，重复登记与普通导入均返回原 `importId` 和 `PENDING_RECONCILE`，安装次数 0、文件摘要不变。同候选 V03 同时覆盖正式入口的 Router 和同一 Worker 强杀、缺失 Worker 根、恢复后使用原基准以及缓存路径撤权。 |
| W2-S6 | **关闭（合成凭据与本地替身）** | 独立专项 `s6_de408f31` 退出 0。文件/缓冲、内存子串、实际 MCP 替身子进程三个阳性对照各 2/2，替身运行包含实际环境值扫描，五个槽位及模型别名的实测禁止命中为 0，`uncollectedSamples=[]`。补测精确 PAT 在允许变量中命中 0，同一值增加前后缀时命中 1，Worker 标记包含于普通变量值中时命中 1。变量名用于判定允许位置，子串匹配作用于变量值。独立观察目录只有 4 份脱敏 JSON，卷原始字节未落盘。MCP 加盐承诺仅在本地合成夹具中用作扫描输入。 |

真实 Gmail IMAP 与真实 GitHub MCP 的授权只读分别保留**待验证**，本轮 V02 签收使用本地替身。V01 逐 token 首延迟继续列为待验证。S6 签收覆盖合成凭据下的观察器，真实凭据取证随授权实机项另行核对。

#### 16.3.3 独立复跑命令与证据

命令在分离工作树及各自的新数据目录中执行。专项探针和独立证据位于以下审计根目录。

```powershell
$auditRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\week2-round7-8b3aad9'
$auditNode = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
Set-Location (Join-Path $auditRoot 'candidate')
git rev-parse HEAD
& $auditNode ./node_modules/typescript/bin/tsc --noEmit
& $auditNode tests/week1/run-all.ts --data-dir "$auditRoot/week1/data" --evidence-dir "$auditRoot/week1/evidence" --keep-data true
& $auditNode tests/week2/run-all.ts --data-dir "$auditRoot/week2/data" --evidence-dir "$auditRoot/week2/evidence" --keep-data true
$probe = Get-Content -Raw -Encoding utf8 '../receipt-before-reconcile-probe.mjs'
& $auditNode --input-type=module -e $probe
$probe = Get-Content -Raw -Encoding utf8 '../pending-reconcile-reentry-probe.mjs'
& $auditNode --input-type=module -e $probe
& $auditNode tests/week2/run-s6.ts --data-dir '../s6-repeat/data' --evidence-dir '../s6-repeat/evidence'
$probe = Get-Content -Raw -Encoding utf8 '../s6-allowed-placement-probe.mjs'
& $auditNode --input-type=module -e $probe
```

两周汇总、V03 和 S6 全量实得见 `week1/evidence`、`week2/evidence`。原回执与待核对探针的结果分别见 `receipt-before-reconcile.json` 和 `pending-reconcile-reentry-final/result.json`。待核对探针的两次初始化尝试因测试库 seed 参数有误未进入断言，修正后使用全新库完成。S6 专项与放置规则对照见 `s6-repeat/evidence/s6-evidence.json`、`s6-allowed-placement.json`。旧库沿用 §12.3.4 的只读备份探针，结果见 `legacy-schema-check.json` 和 `mcp-legacy-check.json`。
