# AegisPi v2 任务书 1 阶段一第 2 周交付审计报告

- **文档版本**：Week 2 审计交接第 1 轮提审（2026-11-26，香港时间；供外部审计人独立复跑、源码审查、签收与多轮整改交流）
- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **基线与前置签收**：
  - v1 零信任基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`）
  - 第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`（独立验收交接提交 `47a4dd41e663b61b5daf76918dd2b0a48771954d`）
- **第 2 周冻结代码候选 SHA（第 1 轮提审）**：`ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`（脱敏证据与本交接报告随后续仅文档提交入库，不改动任何 `src/` 或 `tests/` 实现）
- **同候选全量实测运行标识**：
  - 第 2 周全量套件：`runId = week2_203150f4`（执行时间 `2026-11-26T02:36:34.805Z`，退出码 `0`）
  - 第 1 周回归与 W1-A / W1-B 复签：`runId = week1_0c6fd47a`（执行时间 `2026-11-26T02:34:06.170Z`，退出码 `0`）
- **审计范围**：阶段一第 2 周（《任务书 1》第一节 D6–D10、第五节 S6、第六节 V01–V06、第七节回归复签）：聊天提交幂等与恢复协议（V04）、快照/SSE 游标投影协议（V05）、Router/Worker 委派、记忆 L0 与 FTS 召回、只读 IMAP（直连 TLS + HTTP CONNECT 隧道内层验真）、GitHub MCP 只读钉扎、来源读取与模型披露分离门控（V02）、无网零凭据 Docker 沙箱与受管文件导入（V03）、视图① 完整交互与实机浏览器验收（V01/V05/V06）、全流程凭据零泄漏扫描（S6），以及在同一冻结候选上复签 `W1-A`、`W1-B`、`S1–S5` 与第 1 周 25 项矩阵。

> **审计传递与交流说明**：本文件是第 2 周提审与复审的唯一主交接文档。外部审计人可直接按 §3 在新临时目录复跑、按 §5 导航至核心源码审查、并将第 1 轮复跑记录、源码审查发现、复验条件与签收结论直接填写在 **§10（第 1 轮审计人独立复跑与审查签收栏）** 后回传。若需整改，实施方将在后续章节（§11 起）逐项给出整改回执与新冻结候选 SHA。

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

## 10. 第 1 轮审计人独立复跑与审查签收栏（请外部审计人在此填写并回传）

> 建议审计人在全新临时目录下按 §3.1–§3.4 独立复跑冻结候选 `ea9b59c6883e8f86f6f459f5b2cee3b96c44d6bb`，并结合 §5 源码导航与第 1 周旧治理库升级副本做源码/黑盒复核，将结果填写在下方表格后回传本文件。

### 10.1 独立复跑核对表

| 核对项 | 审计人复跑结果 | 备注 / 复跑 `runId` / 证据目录 |
|---|---|---|
| 核对基线（`69ce7b9` / `47a4dd4`）与候选 `ea9b59c` | （待填写） | |
| 核对依赖锁定（`package-lock.json` SHA-256 与 8 项直接依赖） | （待填写） | |
| 干净目录全量复跑 `tests/week2/run-all.ts`（`tsc` + 分层 + `S6` + `V01–V06`） | （待填写） | |
| 同候选干净目录全量复跑 `tests/week1/run-all.ts`（`S1–S5` + 矩阵 + `W1-A` + `W1-B`） | （待填写） | |
| 独立复跑或抽查 `V04`/`V05`、`V02`、`V03`、`V01`/`V06` 浏览器与 `S6` | （待填写） | |
| 源码审查（D6–D10 权限、隔离、幂等、披露门控、Docker 导入、旧库升级兼容性） | （待填写） | |
| **第 2 周第 1 轮签收结论** | **（待填写：通过 / 退回整改）** | （审计人署名与日期） |

### 10.2 工程约束审查发现（如无问题可填“无”）

| 编号 | 级别（P1/P2） | 候选实现中的问题与源码位置 | 复验条件 |
|---|---|---|---|
| （待填写） | | | |

### 10.3 任务书与验收证据审查发现（如无问题可填“无”）

| 编号 | 级别（P1/P2） | 候选实现或夹具与签收条件的差异 | 复验条件 |
|---|---|---|---|
| （待填写） | | | |

### 10.4 审计人独立复跑命令与原始证据位置（选填）

```powershell
# 审计人可在此粘贴实际执行的复跑命令与本地 auditDir 路径，便于下一轮复验对齐
```
