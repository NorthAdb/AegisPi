# AegisPi v2 任务书 2 阶段二（第 3–4 周）交付审计报告

- **文档版本**：Stage 2 第 5 轮整改与验收（2026-11-27，香港时间）
- **最终验收**：候选 `a10500daca6b92cfa20786283432f91bf5fe320f` **通过**。五类 P0 全部关闭，阶段二四视图与阶段一两周回归通过。真实服务联调为后续验证项。见 §11.8。
- **目标仓库与分支**：`aegis-pi` / 分支 `v2`
- **基线与前置签收**：
  - v1 零信任基线：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`）
  - 阶段一第 1 周签收候选：`69ce7b9ac818d5f80551a8cfcc18add84a1607f8`
  - 阶段一第 2 周最终签收候选：`8b3aad9d564dc966d62c13a1b0814170e2113a9f`（清理 v1 遗留目录后阶段二起点提交为 `5748c6c151174ac655745773660b5eea8cf7698a`）
- **阶段二冻结代码候选 SHA（第 1 轮提审）**：**`5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`**（42 files changed, +12935 / -302；后续仅提交文档、依赖完整性记录与脱敏证据，不改动任何 `src/`、`web/` 或 `tests/` 代码）
- **冻结候选实测运行标识**：
  - 阶段二全量套件（直接运行于 `5bb326c`）：`runId = stage2_d23bff27`（`p0Core = s2_p0_ecef9608`、`browserDesktopAndNarrow = s2_browser_fdc2fd68`，执行时间 `2026-11-26T12:30:27.518Z`，退出码 `0`）
  - 阶段一第 1 周回归（运行于相同代码树提交前）：`runId = week1_c22eec66`（执行时间 `2026-11-26T12:22:46.749Z`，退出码 `0`）
  - 阶段一第 2 周回归（运行于相同代码树提交前）：`runId = week2_8e6115ae`（执行时间 `2026-11-26T12:28:51.780Z`，退出码 `0`）
- **审计范围**：《任务书 2》阶段二全部工程交付（独立 `web/` 四视图、窄屏交互、流式增量与 token 上界预算、TLS/CONNECT SMTP、GitHub MCP C4 重连核对与受控写入、Tier 0 正向清单与 Tier 1 记住规则、Skills 三级披露、30 秒幂等例程、Hono 解耦、可选手机 HTTPS 档及五类 P0 红线）。

> 本文件按五类 P0 记录阶段二审计。影响正常使用或受支持部署的实质性 P0 需有源码或实测证据，整改复验集中在相关红线与受影响的回归。§10 至 §11.7 保留前四轮审计与整改记录，§11.8 记录最终候选及验收证据。真实联调按本轮调整保留为后续工作，见 §8。

---

## 1. 基线、提交记录与变更清单

### 1.1 分支与首轮提审提交链

| 顺序 | 提交 SHA | 提交说明 | 作用 |
| --- | --- | --- | --- |
| 历史基线 | `3a88b6895991d328e8e27fd1072a29846e7a9adf` | `docs(v1): organize docs/v1 archive and reconcile baseline status` | `v1-zero-trust-baseline` 分叉起点 |
| 阶段一签收 | `8b3aad9d564dc966d62c13a1b0814170e2113a9f` | `v2-week2: fix W2-S3 receipt preservation and W2-S6 MCP substring commitment scan` | 阶段一第 2 周第 7 轮签收代码候选 |
| 阶段二起点 | `5748c6c151174ac655745773660b5eea8cf7698a` | `chore(v2): remove archived v1 legacy directories (preserved at v1-zero-trust-baseline)` | 阶段二实施起点 |
| **Stage 2 候选 #1** | **`5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`** | `feat(v2-stage2): deliver 4-view web console, streaming, TLS SMTP, C4 MCP Pin, skills, routines, and mobile HTTPS profile` | **阶段二第 1 轮冻结代码候选**（42 files changed, +12935 / -302） |
| Stage 2 证据 | `65dbd1784366e6497101f44e70769a2520ef554e` | `docs(v2-stage2): record Stage 2 self-test report and sanitized evidence for 5bb326c` | 归档 `5bb326c` 脱敏证据 JSON 与自测简报（仅文档） |
| Stage 2 审计交接 | （本次文档提交） | `docs(v2-stage2): add Stage 2 audit handoff report and web dependency integrity record` | 新增本审计主文档与 `web/` 依赖完整性记录（仅文档） |

### 1.2 遵循的规范与架构决议文档

- [AGENTS.md](../../../AGENTS.md)：已按任务书要求补齐阶段一与阶段二边界、真实外发默认关闭及显式独立授权规则。
- `D:\AegisPi\aegis-pi-v2-planning\taskbook-2.md`：阶段二任务书。
- `D:\AegisPi\aegis-pi-v2-planning\baseline-v2.3\aegispi_v2_overview.md`：总体规划 v2.3（重点裁决 3、5、6、7 及 §5.3、§6、§7）。
- `D:\AegisPi\aegis-pi-v2-planning\baseline-v2.3\aegispi_web_v2_4.html`：四视图布局与交互参照。
- [docs/v2/week2-audit/WEEK2-ACCEPTANCE-REPORT.md](../week2-audit/WEEK2-ACCEPTANCE-REPORT.md) 与 [WEEK2-AUDIT-REPORT.md](../week2-audit/WEEK2-AUDIT-REPORT.md)：阶段一签收基线与复跑口径。
- [docs/adr/0002-v2-pi-durable-migration.md](../../adr/0002-v2-pi-durable-migration.md) 与 [docs/adr/0003-week1-budget-attribution-and-paired-recovery.md](../../adr/0003-week1-budget-attribution-and-paired-recovery.md)。
- [docs/v2/dependency-integrity.json](../dependency-integrity.json)（根目录锁定记录）与 [docs/v2/web-dependency-integrity.json](../web-dependency-integrity.json)（`web/` 独立前端锁定记录）。

### 1.3 冻结底座零修改确认

以下阶段一冻结核心文件与根目录依赖文件在 `5748c6c..5bb326c` 之间 **零字节改动**：

- `src/governance/approvals.ts`
- `src/governance/effects.ts`
- `src/governance/budget.ts`
- `src/capabilities/workspace/importer.ts`
- `package.json`、`package-lock.json`
- `tests/week1/*`、`tests/week2/*`

### 1.4 相对阶段二起点 `5748c6c` 的代码变更清单（共 42 个文件，均落于冻结候选 `5bb326c`）

| 分层 / 类别 | 状态 | 文件路径 | 职责摘要 |
| --- | --- | --- | --- |
| 工程约束 | M | [AGENTS.md](../../../AGENTS.md) | 更新第 3 条补充阶段二启用条件与显式独立授权边界 |
| L1 治理内核（`src/governance/`） | M | [db.ts](../../../src/governance/db.ts) | Migration 6 向前迁移：`approval_rules`、`skills`、`skill_versions`、`conversation_skill_locks`、`routines`、`routine_triggers` |
| L1 治理内核（`src/governance/`） | M | [credentials.ts](../../../src/governance/credentials.ts) | 保留阶段一环回硬门，新增 `StageProfile` / `assertModelUrlForStage` / `assertSmtpHostForStage`、`resolveSmtpSecretForTarget`、token 估算价格表扩展 |
| L1 治理内核（`src/governance/`） | M | [mcp-pin.ts](../../../src/governance/mcp-pin.ts) | 新增 `listMcpServerPins`、`listMcpToolPins`、`quarantineMissingMcpTools`、`recordObservedDriftDefinition`、`approveStoredMcpToolPin`、`verifyLiveMcpToolPin` |
| L1 治理内核（`src/governance/`） | A | [rules.ts](../../../src/governance/rules.ts) | `evaluateGithubWritePolicy`（自有仓 Tier 0 正向清单与受保护分支/工作流/删除/强推硬排除）、`validateStage2PlainTextEmail`、Tier 1 记住规则 CRUD |
| L2 能力层（`src/capabilities/`） | M | [mail/smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts), [mail/imap-client.ts](../../../src/capabilities/mail/imap-client.ts), [mail/imap-child.ts](../../../src/capabilities/mail/imap-child.ts) | 新增直连 TLS / STARTTLS 与 HTTP CONNECT 隧道内目标证书校验的 SMTP 发送、`AUTH PLAIN` 内存凭据擦除、`testSmtpConnectivity` 以及只读 `connectivityOnly` IMAP 探测 |
| L2 能力层（`src/capabilities/`） | A | [skills/store.ts](../../../src/capabilities/skills/store.ts) | Skills 三级渐进披露、`skill_set_hash` 会话锁定、版本切换仅对新任务生效、撤权即时生效、默认三级技能 `weekly-brief-helper` |
| L2 能力层（`src/capabilities/`） | A | [timers/routines.ts](../../../src/capabilities/timers/routines.ts) | 自然语言例程解析预览、Tier 1 规则门、30 秒宿主轮询器、`(routine_id, scheduled_instant_utc)` 唯一登记、漏期合并最近一期、暂停/恢复与重启对账 |
| L3 运行时（`src/runtime/`，唯一 `@earendil-works/*` 导入边界） | M | [models.ts](../../../src/runtime/models.ts) | 阶段二出口守卫、保守 token 上界整数预留、`cacheReadPerMTokMu` 结算、非侵入式 `text_delta` 增量监听与 `firstTokenMs` 统计 |
| L3 运行时（`src/runtime/`） | M | [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) | C4 重连/刷新先暂停执行准入、核对二进制与 `tools/list`（含缺失工具隔离与漂移定义保存）、阶段二受控 `callWriteTool` 与实时指纹复核 |
| L3 运行时（`src/runtime/`） | M | [submitter.ts](../../../src/runtime/submitter.ts) | 邮件提交器接入阶段二 TLS SMTP 与宿主内存 AUTH 凭据；新增 `submitApprovedGithubWriteEffect` 复用同一 T4 两次 CAS 与 C4 实时指纹 precondition |
| L3 运行时（`src/runtime/`） | M | [harness.ts](../../../src/runtime/harness.ts), [extensions/aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts), [extensions/aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts) | 接入阶段二配置、流式增量 overlay 与首 token 指标、独立于 Hono 的 `RoutinePoller` 生命周期、L1 Skills 索引注入、Tier 0/2 `github_write_file` / `skill_*` / `routine_create` 工具 |
| L4 Web 网关与入口（`src/web/`, `src/`） | A / M | [web/static.ts](../../../src/web/static.ts), [web/auth.ts](../../../src/web/auth.ts), [web/server.ts](../../../src/web/server.ts), [index.ts](../../../src/index.ts) | 托管本地 `web/dist` 与严格 CSP、可选手机 HTTPS 档（`__Host-` + `Secure` + `HttpOnly` + `SameSite=Strict` + `Path=/` 无 `Domain`，精确 Host/Origin，非 HTTPS 拒绝启动）、视图②③④鉴权 API、`--stage 2` 正式入口与扩展环境变量擦除 |
| 独立前端工程（`web/`） | A | [web/package.json](../../../web/package.json), [web/package-lock.json](../../../web/package-lock.json), `web/src/**`（15 文件） | 独立 Vite 6 + React 19 + Tailwind 3.4 四视图控制台，修复原型偏差，支持桌面与窄屏（390x844）抽屉交互，零外链 CDN |
| 假服务与阶段二测试（`tests/`） | A / M | [tests/fakes/fake-model-server.ts](../../../tests/fakes/fake-model-server.ts), [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts), [fake-smtp-server.ts](../../../tests/fakes/fake-smtp-server.ts), [tests/stage2/run-p0-core.ts](../../../tests/stage2/run-p0-core.ts), [run-browser-e2e.ts](../../../tests/stage2/run-browser-e2e.ts), [run-all.ts](../../../tests/stage2/run-all.ts) | 假模型多块流式、假 GitHub MCP 写模式与丢工具/漂移开关、假 SMTP TLS + AUTH PLAIN、阶段二五类 P0 红线与真实 Edge 桌面/窄屏四视图纵切 |

---

## 2. 锁定运行环境与依赖完整性

### 2.1 实测环境版本

| 项目 | 实测值 |
| --- | --- |
| 操作系统与架构 | Windows (`win32`, `x64`) |
| 锁定 Node 与内置 SQLite | `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`）/ `node:sqlite`（`3.54.1`） |
| npm 版本 | `10.9.9` |
| 本地 Docker 与不可变镜像 | Docker `29.9.2` / `node:22.23.5-bookworm-slim`（`sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`） |
| 本地浏览器 | `msedge.exe`（Headless CDP，Node 22 原生 WebSocket） |
| 根目录 `package-lock.json` SHA-256 | `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`（与 `5748c6c` 完全一致，锁定包 `175` 个） |
| 独立前端 `web/package-lock.json` SHA-256 | `3661add865032c97d52fd73626aa3ef7404df72883cd7a5d6eceecf34b8234e3`（锁定包 `182` 个） |

### 2.2 `web/` 直接依赖精确版本（无 `^` / `~`，根目录直接依赖与第 1 周完全一致）

| 包名 | 锁定版本 | 类型 | Integrity（SHA-512） |
| --- | --- | --- | --- |
| `react` | `19.0.0` | dependencies | `sha512-V8AVnmPIICiWpGfm6GLzCR/W5FXLchHop40W4nXBmdlEceh16rCN8O8LNWm5bh5XUX91fh7KpA+W0TgMKmgTpQ==` |
| `react-dom` | `19.0.0` | dependencies | `sha512-4GV5sHFG0e/0AD4X+ySy6UJd3jVl1iNsNHdpad0qhABJ11twS3TTBnseqsKurKcsNqCEFeGL3uLpVChpIO3QfQ==` |
| `@types/react` | `19.0.10` | devDependencies | `sha512-JuRQ9KXLEjaUNjTWpzuR231Z2WpIwczOkBEIvbHNCzQefFIT0L8IqE6NV6ULLyC1SI/i234JnDoMkfg+RjQj2g==` |
| `@types/react-dom` | `19.0.4` | devDependencies | `sha512-4fSQ8vWFkg+TGhePfUzVmat3eC14TXYSsiiDSLI0dVLsrm9gZFABjPy/Qu6TKgl1tq1Bu1yDsuQgY3A3DOjCcg==` |
| `@vitejs/plugin-react` | `4.3.4` | devDependencies | `sha512-SCCPBJtYLdE8PX/7ZQAs1QAZ8Jqwih+0VBLum1EGqmCCQal+MIUqLCzj3ZUy8ufbC0cAM4LRlSTm7IQJwWT4ug==` |
| `autoprefixer` | `10.4.20` | devDependencies | `sha512-XY25y5xSv/wEoqzDyXXME4AFfkZI0P23z6Fs3YgymDnKJkCGOnkL0iTxCa85UTqaSgfcqyf3UA6+c7wUvx/16g==` |
| `postcss` | `8.5.3` | devDependencies | `sha512-dle9A3yYxlBSrt8Fu+IpjGT8SY8hN0mlaA6GY8t0P5PjIOZemULz/E2Bnm/2dcUOena75OTNkHI76uZBNUUq3A==` |
| `tailwindcss` | `3.4.17` | devDependencies | `sha512-w33E2aCvSDP0tW9RZuNXadXlkHXqFzSkQew/aIa2i/Sj8fThxwovwlXHSPXTbAHwEIhBFXAedUhP2tueAKP8Og==` |
| `typescript` | `5.9.3` | devDependencies | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` |
| `vite` | `6.2.0` | devDependencies | `sha512-7dPxoo+WsT/64rDcwoOjk76XHj+TqNTIvHKcuMQ1k4/SeHDaQt5GFAeLYzrimZrMpn/O6DtdI03WUjdxuPM0oQ==` |

---

## 3. 首轮审计复跑命令（PowerShell）

以下命令均在仓库根目录 `D:\AegisPi\aegis-pi` 下执行，使用锁定 Node 22.23.5 与全新临时目录，不触发任何真实模型计费、真实邮件外发或真实 GitHub 写入。

### 3.1 核对冻结候选提交、冻结底座零改动与锁文件哈希

```powershell
git status --short --branch
git log -n 4 --format="%H %s"
git diff --stat 5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355 HEAD
git diff --stat 5748c6c151174ac655745773660b5eea8cf7698a 5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355 -- package.json package-lock.json src/governance/approvals.ts src/governance/effects.ts src/governance/budget.ts src/capabilities/workspace/importer.ts tests/week1 tests/week2
(Get-FileHash package-lock.json -Algorithm SHA256).Hash.ToLower()
(Get-FileHash web/package-lock.json -Algorithm SHA256).Hash.ToLower()
```

预期：`git diff --stat 5bb326c HEAD` 仅含 `docs/v2/` 下的文档与脱敏 JSON；冻结底座与阶段一测试路径的 diff 为空；根目录与 `web/` 锁文件 SHA-256 与 §2.1 完全一致。

### 3.2 构建独立前端并一键复跑阶段二全套验收（锁文件校验 + 前后端 `tsc` + 分层守卫 + 五类 P0 核心 + 实机 Edge 桌面/窄屏四视图）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
$s2Dir = Join-Path $env:TEMP "aegispi-v2-stage2-audit-$ts"
& 'D:\AegisPi\tools\node-v22.23.5\npm.cmd' --prefix web run build
if ($LASTEXITCODE -eq 0) {
  & $node tests/stage2/run-all.ts --data-dir (Join-Path $s2Dir 'data') --evidence-dir (Join-Path $s2Dir 'evidence')
}
```

### 3.3 复跑阶段一第 1、2 周全量回归（验证阶段一档原断言零退化）

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$s1Dir = Join-Path $env:TEMP "aegispi-v2-stage1-reg-$ts"
& $node tests/week1/run-all.ts --data-dir (Join-Path $s1Dir 'w1-data') --evidence-dir (Join-Path $s1Dir 'w1-ev')
if ($LASTEXITCODE -eq 0) {
  & $node tests/week2/run-all.ts --data-dir (Join-Path $s1Dir 'w2-data') --evidence-dir (Join-Path $s1Dir 'w2-ev')
}
```

### 3.4 按子项单独复跑

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$base = Join-Path $env:TEMP "aegispi-s2-single-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
& $node tests/stage2/run-p0-core.ts --data-dir "$base\p0\data" --evidence-dir "$base\p0\ev"
& $node tests/stage2/run-browser-e2e.ts --data-dir "$base\browser\data" --evidence-dir "$base\browser\ev"
```

---

## 4. 阶段二五类 P0 红线与验收矩阵（候选 `5bb326c` 实测）

| 编号 | 套件 / `runId` | 退出码 | 验收口径 | 实测结果与独立假服务计数 | 状态 | 脱敏证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 工程护栏 | `stage2_d23bff27` | `0` | 根锁文件 SHA-256 保持 `5748c6c`、前后端 `tsc --noEmit` 通过、仅 `src/runtime/` 导入 Pi SDK、四层单向零违规 | `rootLockIntegrity = PASS`、`typecheckRoot = 0`、`typecheckWeb = 0`、`layerBoundary.violations = []` | PASS | [stage2-summary.json](evidence/stage2-summary.json) |
| **P0-1 两次 CAS 与分级写** | `s2_p0_ecef9608` + `week1_c22eec66` | `0` | 改稿后旧 revision 409、重复 `decisionKey` 幂等、取消阻断领取、W1-B 强杀后审批/领取/假 SMTP 均为 1；Tier 0 正向清单自动签发仍走两次 CAS、受保护分支/工作流/删除拒写 | `oldRevisionRejected409 = true`、`duplicateDecisionKeyReplayed = true`、改稿假 SMTP 增量 `1`；Tier 0 假 GitHub MCP 写增量 `1`（`tier0ClaimCount = 1`）、受保护分支写增量 `0`；W1-B `smtpTotalReceived = 1` 且刷新见 `结果待核对` | PASS | [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json) |
| **P0-2 预算与流式增量** | `s2_p0_ecef9608` + `week1_c22eec66` | `0` | W1-A 9/9 通过；阶段二真实适配路径采用 token 上界估算，每次物理发送均有预留，额度不足物理发送增量 0，流式文本增量在生成结束前可见 | 对照假模型物理请求增量 `1`（`progressiveDeltasObserved = 3`、`firstTokenMs = 31ms`、`totalMs = 191ms`）；额度不足假模型物理请求增量 `0`；W1-A 3 对照 + 6 负例全过 | PASS | [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json) |
| **P0-3 MCP Pin C4 与执行** | `s2_p0_ecef9608` | `0` | 二进制 SHA-256 不符暂停准入、工具定义漂移/缺失隔离、撤权即时生效、待领取调用在漂移及新指纹核准后仍按原指纹复核拒绝，远端调用增量 0 | `pendingClaimBlockedOnDrift = mcp_tool_quarantined`、`pendingClaimBlockedOnFingerprintChangeAfterReapprove = mcp_tool_fingerprint_changed`、`revokedCallBlocked = mcp_tool_revoked`、`missingToolQuarantined = true`、`binaryTamperRejected = mcp_binary_sha256_mismatch`、`remoteToolCallDeltaDuringC4 = 0` | PASS | [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json) |
| **P0-4 凭据零泄漏与 TLS SMTP** | `s2_p0_ecef9608` + `week2_8e6115ae` | `0` | 合成凭据覆盖模型/IMAP/TLS SMTP/GitHub MCP/Web 控制台，双库/WAL/日志/子进程禁止位置命中 0；直连 TLS 与 CONNECT 隧道 TLS 校验目标证书 | 5 槽位扫描双库与假服务日志 `totalForbiddenHits = 0`；直连 TLS 与 CONNECT 隧道 TLS 均成功、错配主机名发送前拒连且错误文本不含密钥，假 TLS SMTP 收件 `2`；阶段一 `S6` `totalForbiddenHits = 0` | PASS | [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json) |
| **P0-5 阶段一回归、Skills、例程、Hono 解耦与手机 HTTPS** | `s2_p0_ecef9608` + `week1_c22eec66` + `week2_8e6115ae` | `0` | 阶段一第 1、2 周全过；例程同触发跨重复轮询/漏期/重启最多受理 1 次；关闭 Hono 后后台任务继续完成；Skills 三级披露与即时撤权；手机 HTTPS 档安全契约 | 第 1 周 25/25 + S1-S5 + W1-A/B 与第 2 周 V01-V06/S6 全过；3 期停机漏期与重复轮询及重启 `routine_triggers` 恒为 `1`；关闭 Hono 后后台任务完成；非 HTTPS 配置拒启、`__Host-` Cookie 含 `Secure; HttpOnly; SameSite=Strict; Path=/` 且无 `Domain`、跨 Origin 返回 `403`、注销后返回 `401` | PASS | [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json) |
| **四视图桌面 + 窄屏浏览器纵切** | `s2_browser_fdc2fd68` | `0` | 正式入口 `src/index.ts --stage 2` 在 Edge 1280x800 与 390x844 串通四视图、逐段流式、改稿禁批/保存/批准、Skills L2/L3、例程启停、规则撤销、记忆墓碑清理回执、账本及窄屏抽屉 | `progressivePartialRendersObserved = 2`、`firstTokenUiMetric = 59 ms`、`dirtyBlockedApprove = true`、假 SMTP 收件 `1` 且正文与改稿一致、`ftsCleaned=true` 墓碑回执、390x844 会话抽屉/检查器抽屉/审批卡（宽度 360px）全过 | PASS | [stage2-browser-e2e-evidence.json](evidence/stage2-browser-e2e-evidence.json) |

---

## 5. 关键源码审查导航（供独立审计人定位核查）

| 审计焦点 | 核心不变量 | 主要代码落点 |
| --- | --- | --- |
| 冻结底座与显式阶段档 | 默认 `stage = 1` 保持阶段一环回硬门与视图①原断言；阶段二仅通过显式 `stage = 2` 与白名单放开目标主机；`approvals.ts` / `effects.ts` / `budget.ts` / `importer.ts` 未改 | [src/governance/credentials.ts](../../../src/governance/credentials.ts#L56-L120), [src/index.ts](../../../src/index.ts#L46-L190) |
| Tier 0 自有仓正向清单与两次 CAS | `evaluateGithubWritePolicy` 强制要求命中精确 `repoId`、`operation`、`ref`、`path`，硬排除 `main`/`master`/`refs/tags/*`/`.github/workflows/*`/删除/强推；Tier 0 命中后在 `beforeTool` 内经 `proposeOrGetApproval` + `decideApproval`（`auto:tier0:*`）完成第一次 CAS，再由 `submitApprovedGithubWriteEffect` 执行第二次 CAS `READY -> SUBMITTING` | [src/governance/rules.ts](../../../src/governance/rules.ts#L47-L155), [src/runtime/extensions/aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts#L760-L875), [src/runtime/submitter.ts](../../../src/runtime/submitter.ts#L280-L435) |
| 阶段二纯文本邮件限制与 TLS SMTP | `strictPlainTextEmail` 在建单前拒绝 `cc`/`bcc`/附件；SMTP 客户端支持直连 TLS / STARTTLS 与 HTTP CONNECT 隧道内 `rejectUnauthorized: true` 证书校验，仅在验证 TLS 后发 `AUTH PLAIN`，错误信息擦除密码 | [src/governance/rules.ts](../../../src/governance/rules.ts#L160-L210), [src/capabilities/mail/smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts#L1-L390) |
| Models 预算与流式增量 | `estimateUpperBoundMu` 在阶段一保持无 `syntheticFixedUpperMu` 即拒绝，在阶段二启用 `allowTokenBoundEstimation` 按 UTF-8 字节保守上界 + `maxTokens` + 10% 余量整数预留；`maxRetries: 0` + `redirect: "manual"` 阻断 3xx；`underlyingStream.push` 旁路监听 `text_delta` 合并推送 SSE `livePartial` 并记录 `firstTokenMs` | [src/runtime/models.ts](../../../src/runtime/models.ts#L125-L210), [src/runtime/models.ts](../../../src/runtime/models.ts#L500-L565), [src/runtime/harness.ts](../../../src/runtime/harness.ts#L810-L865) |
| C4 MCP Pin 重连、缺失、漂移与撤权 | `connect()`/`reconnect()`/`recheckToolPins()` 先置 `#admissionPaused = true`，核对二进制 SHA-256 与 `tools/list`，隔离新增/变更/缺失工具后才放开准入；提案快照固化 `mcpSchemaSha256`，`callReadOnlyTool`、`callWriteTool` 与 `submitApprovedGithubWriteEffect` 的 T4 `precondition` 均调用 `verifyLiveMcpToolPin` 复核 | [src/governance/mcp-pin.ts](../../../src/governance/mcp-pin.ts#L344-L509), [src/runtime/mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts#L61-L445), [src/runtime/submitter.ts](../../../src/runtime/submitter.ts#L330-L395) |
| Skills 三级披露与锁定 | 上下文 `section("aegis-skills")` 仅注入 L1 名称/摘要/版本并按 `(runtime_epoch, conversation_id)` 锁 `skill_set_hash`；版本切换只影响新会话；撤权过滤所有现存会话与 L2/L3 工具；L3 脚本执行前校验源码 SHA-256 并在无网 Docker 沙箱运行 | [src/capabilities/skills/store.ts](../../../src/capabilities/skills/store.ts#L1-L534), [src/runtime/extensions/aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts#L64-L82) |
| 30 秒幂等例程与 Tier 1 规则 | `RoutinePoller` 挂在 `AegisHostRuntime`（独立于 Hono）；漏期由 `collapseMissedInstantsToLatest` 折叠为最近一期；`UNIQUE(routine_id, scheduled_instant_utc)` + `correlation_key` 对接 `chat_commands` 幂等受理与启动对账；Tier 1 规则撤销后页面与聊天均拒绝免确认创建/恢复 | [src/capabilities/timers/routines.ts](../../../src/capabilities/timers/routines.ts#L1-L580), [src/runtime/harness.ts](../../../src/runtime/harness.ts#L1525-L1575) |
| Web 四视图、静态托管与手机 HTTPS 档 | `uiMode = "stage2"` 托管 `web/dist` 并设严格 CSP（无外部 CDN）；前端纯文本渲染不可信输出、改稿脏态禁批、保存刷新 `revision/actionHash`、切会话立即清旧卡、窄屏抽屉可开会话列表与检查器；手机 HTTPS 档校验 `https://` `publicOrigin`，签发 `__Host-aegispi_session`（`Secure; HttpOnly; SameSite=Strict; Path=/`，无 `Domain`），精确校验 Host/Origin，注销撤销会话并关存量 SSE | [src/web/auth.ts](../../../src/web/auth.ts#L6-L185), [src/web/static.ts](../../../src/web/static.ts#L1-L45), [src/web/server.ts](../../../src/web/server.ts#L475-L585), [web/src/components/InlineApprovalCard.tsx](../../../web/src/components/InlineApprovalCard.tsx), [web/src/views/ChatView.tsx](../../../web/src/views/ChatView.tsx) |

---

## 6. 专项实测明细（来自候选 `5bb326c` 脱敏 JSON）

1. **阶段二汇总**（[stage2-summary.json](evidence/stage2-summary.json)，`runId = stage2_d23bff27`，`commitSha = 5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`）：
   - `rootLockIntegrity`: `PASS`（`795485bd...`）
   - `typecheckRoot`: `PASS (0)`、`typecheckWeb`: `PASS (0)`、`layerBoundary`: `PASS (violations = [])`
   - `p0Core`: `PASS`（`s2_p0_ecef9608`）、`browserDesktopAndNarrow`: `PASS`（`s2_browser_fdc2fd68`）
2. **五类 P0 核心实测**（[stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json)，`runId = s2_p0_ecef9608`）：
   - `smtpTls`: `directTlsOk = true`、`connectTunnelTlsOk = true`、`badHostnameRejectedBeforeSend = true`、`fakeTlsSmtpTotalReceived = 2`、`plainTextGuardRejectedCcAndAttachments = true`
   - `p0_1_two_cas`: `tier0GithubAutoIssued = true`、`tier0ClaimCount = 1`、`tier0FakeMcpWriteDelta = 1`、`protectedBranchWriteDelta = 0`、`oldRevisionRejected409 = true`、`duplicateDecisionKeyReplayed = true`、`editedEmailFakeSmtpDelta = 1`
   - `p0_2_budget_streaming`: `progressiveDeltasObserved = 3`、`firstTokenMs = 31`、`totalMs = 191`、`controlSendDelta = 1`、`shortfallSendDelta = 0`
   - `p0_3_mcp_c4`: `driftQuarantined = true`、`pendingClaimBlockedOnDrift = mcp_tool_quarantined`、`pendingClaimBlockedOnFingerprintChangeAfterReapprove = mcp_tool_fingerprint_changed`、`revokedCallBlocked = mcp_tool_revoked`、`missingToolQuarantined = true`、`binaryTamperRejected = mcp_binary_sha256_mismatch`、`remoteToolCallDeltaDuringC4 = 0`
   - `p0_4_credentials_zero_leak`: 5 个凭据槽位在 `aegis-gov.sqlite`（409,600 B）、`pi-durable.sqlite`（188,416 B）、`model-requests.jsonl`（3,921 B）、`smtp-received.jsonl`（569 B）、`mcp-calls.jsonl`（2,733 B）中 `totalForbiddenHits = 0`
   - `p0_5_skills_routines_hono_mobile`: 9 项布尔断言全 `true`
3. **四视图桌面 + 窄屏实机 Edge 纵切**（[stage2-browser-e2e-evidence.json](evidence/stage2-browser-e2e-evidence.json)，`runId = s2_browser_fdc2fd68`）：
   - 桌面 `1280x800`：`progressivePartialRendersObserved = 2`、`firstTokenUiMetric = "59 ms"`、`dirtyBlockedApprove = true`、`fakeSmtpTotalReceived = 1`、`editedDraftMatchedDeliveredSmtp = true`、视图②/③/④与墓碑清理回执（`ftsCleaned=true`）全过
   - 窄屏 `390x844`：`narrowScreenThreadsDrawerOk = true`、`narrowScreenInspectorDrawerOk = true`、`narrowScreenApprovalCardBounds = { width: 360, right: 372, viewportWidth: 390 }`
4. **阶段一同代码树回归实测**：
   - `tests/week1/run-all.ts`：`runId = week1_c22eec66`，退出码 `0`（`S1-S5` PASS、`W1-A` 9/9、`W1-B` `smtpTotalReceived = 1` / `结果待核对`、25/25 矩阵 PASS）
   - `tests/week2/run-all.ts`：`runId = week2_8e6115ae`，退出码 `0`（`typecheck` PASS、`layerBoundary` 0 违规、`v04_v05`、`v02`、`v03`、`s6` `totalForbiddenHits = 0`、`v01_v05_v06_browser` 全过）
   - 注：上述两条阶段一回归运行于提交 `5bb326c` 前的同一代码树，建议审计人在 `5bb326c` 上按 §3.3 命令同候选独立复跑。

---

## 7. 阶段二治理库新增表与实测结论

| 表名 | 核心键与约束 | 职责 |
| --- | --- | --- |
| `approval_rules` | `rule_id PK`，`tier IN (1)`，`scope_id FK`，含 `expires_at` / `revoked_at` | Tier 1 有作用域、有期限、可即时撤销的记住规则 |
| `skills` / `skill_versions` | `PRIMARY KEY(skill_id, version)`，`state IN ('ACTIVE','REVOKED')` | Skills 三级渐进披露、正文摘要、审阅脚本 SHA-256 与版本切换/回退 |
| `conversation_skill_locks` | `PRIMARY KEY(runtime_epoch, conversation_id)` | 任务级 `skill_set_hash` 锁定，使版本切换仅对新任务生效 |
| `routines` | `routine_id PK`，`schedule_kind IN ('once','daily','weekly')`，`enabled IN (0,1)` | 自然语言例程定义、时区、跳过条件、下次运行 UTC 与最近状态 |
| `routine_triggers` | `UNIQUE(routine_id, scheduled_instant_utc)`，`correlation_key UNIQUE` | 例程触发唯一登记、跨重启与 `chat_commands` 对账及待核对状态 |

补充说明：锁定 Pi SDK 1.6.0 与 Windows 实测均未推翻既有架构前提，无需新增偏离 ADR。

---

## 8. 替身验收、真实联调与手机档

| 验收类别 | 项目 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| 本地替身 | 五类 P0 红线、TLS/CONNECT SMTP、C4 MCP Pin、Tier 0/2 写入、Skills、30 秒幂等例程及 Hono 解耦 | **PASS** | 候选 `a10500d` 实测通过，见 §11.8 |
| 本地替身 · 实机浏览器 | 正式入口 `--stage 2` 四视图桌面（1280x800）与窄屏（390x844） | **PASS** | 候选 `a10500d` 使用实机 Edge CDP 实测通过，见 §11.8 |
| 真实模型与计费 | 真实 DeepSeek 逐 token 流式、首 token 延迟与账本核对 | **待验证** | 真实计费与数据出站须另行取得授权 |
| 真实只读连接器 | 真实 Gmail 只读与真实 GitHub MCP 只读 | **待验证** | 按获准账号、邮箱和仓库范围实测 |
| 单独授权的真实外写 | 真实 Gmail 单封测试发信与选定测试仓单次写 | **待验证** | 按获准测试邮箱及测试仓实测 |
| 可选手机 HTTPS 档 | 协议安全契约（本机） / 实体手机接入 | 协议 **PASS** / 实体手机 **待验证** | 本机已实测非 HTTPS 拒启、`__Host-` Cookie 属性、跨 Origin `403` 与注销失效；实体手机按需独立验收 |

按项目负责人本轮调整，真实服务实测保留为后续联调项，本阶段以本地替身、桌面与窄屏浏览器验证、五类红线和阶段一回归的结果签收。

---

## 9. 历史基线参考（与本次 v2 阶段二实测严格分离）

- **v1 历史零信任基线**（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）：自动化套件 `327/327 PASS`、自用验收 `31/31 PASS`（历史档案，不计入 v2 统计）。
- **v2 阶段一签收基线**（`8b3aad9d564dc966d62c13a1b0814170e2113a9f` -> `5748c6c`）：第 1 周 `S1-S5` + `W1-A` + `W1-B` + 25/25 矩阵与第 2 周 `S6` + `V01-V06` 独立审计签收通过。
- **v2 阶段二首轮提审**（冻结候选 `5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`）：`stage2_d23bff27`（五类 P0 + 四视图桌面/窄屏浏览器）PASS，同代码树阶段一回归 `week1_c22eec66` / `week2_8e6115ae` PASS；真实 DeepSeek / Gmail / GitHub 联调项与实体手机项明确标为待验证。

---

## 10. 第 1 轮独立审计结论（Codex · 2026-11-26）

**安全审计退回整改。阶段二完整签收待完成。** 冻结候选 `5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355` 的本地替身套件与桌面、窄屏浏览器用例独立复跑通过。下文的 P0 来自源码与锁定 SDK 核查，涉及现有夹具未覆盖的生产配置或新入口。真实 DeepSeek 流式与计费、Gmail 只读与单封发信、GitHub MCP 只读与测试仓单次写均待授权实测。实体手机 HTTPS 是可选独立项。

### 10.1 独立复跑核对表（第 1 轮）

| 核对项 | 结果 | 独立证据 |
| --- | --- | --- |
| 候选、冻结文件与锁文件 | PASS | 分支起点 `5748c6c`，候选 `5bb326c`，提审文档 HEAD `8f2d69f`。候选之后只有文档和证据。§1.3 所列冻结路径的代码差异为空。根与前端锁文件逐字节匹配候选 Git 对象，SHA-256 与 §2.1 一致。`git diff --check 5748c6c...5bb326c` 退出 0。 |
| 依赖安装、前端构建、前后端类型检查与分层守卫 | PASS | 锁定 npm 的两次离线安装及 Vite build 均退出 0。前后端 `tsc --noEmit` 均退出 0。现有分层守卫零违规，v2.3 的 Web 调用边界见 S2-P1-5。 |
| 阶段二替身与桌面、窄屏浏览器 | PASS | `stage2_80fb90d8`，退出 0。核心 `s2_p0_13d720f1`，浏览器 `s2_browser_e9cd44f3`。预算不足替身发送增量 0，批准修订的邮件独立假服务收件增量 1，C4 已覆盖的阻断路径调用增量 0。桌面实际呈现 2 次中间文本，390×844 尺寸可打开会话和轨迹抽屉，最终邮件与改稿一致。带 `--keep-data` 重跑 `stage2_cd4475d4` 同样退出 0，并保留独立服务日志。 |
| 阶段一第 1 周与第 2 周 | PASS | 两个入口均退出 0。第 1 周 `week1_a7692d4c`，矩阵 25/25，W1-B 假 SMTP 累计 1 封，刷新见「结果待核对」。第 2 周 `week2_387da5c8`，V01–V06 与 S6 均通过。V03 `v03_fb3dc780`，S6 `s6_54ed7744`，禁止位置命中 0。 |
| **第 1 轮安全审计裁定** | **退回整改** | 见 S2-P0-1 至 S2-P0-5。 |

### 10.2 五类 P0 源码与红线审查发现（第 1 轮）

**S2-P0-1 · 两次 CAS 与 SMTP 最终发信范围。** 两次 CAS 和替身最终版本用例通过。正式入口未接入独立获准的 SMTP 收件范围，默认作用域仍使用通配目标。现有纯文本校验只在原始工具建单时运行，改稿可保存未经过相同校验的字段。SMTP 将主题直接序列化成头字段，未约束其单行边界，导致已批准的纯文本快照与实际邮件结构可能不一致。真实发信须在宿主绑定获准收件范围，建单、改稿和领取共用字段校验，提交器只序列化通过校验的最终快照。[正式入口](../../../src/index.ts#L498) · [默认作用域](../../../src/runtime/harness.ts#L602) · [改稿](../../../src/web/server.ts#L904) · [SMTP 序列化](../../../src/capabilities/mail/smtp-client.ts#L426)

**S2-P0-2 · 真实预算预留上界。** 真实模型缺少价表时会落入合成固定预留和结算。启用 token 估算时，现有 UTF-8 字节折半和固定余量无法证明覆盖供应商实际计费，且以配置值截断输入上界。要求真实端点具备版本化的真实价表和有证据的请求计费上界，覆盖有效输入、输出及适用价格。缺项或上界无法确定时发送增量须为 0。合成固定价格只适用于替身档。[正式入口价表](../../../src/index.ts#L233) · [预留计算](../../../src/runtime/models.ts#L147) · [实际预留](../../../src/runtime/models.ts#L451)

**S2-P0-3 · C4 与执行准入。** 重连、明确复核和撤权替身用例通过。以下路径仍须收紧。

- **3a 工具清单变更。** MCP 客户端未订阅锁定 SDK 已支持的工具清单变更通知。连接存续期间，已知变更无法触发即时暂停和重核，执行继续参考旧 Pin。收到通知时先暂停，再复用现有校验路径，校验失败继续关闭准入。[桥接连接](../../../src/runtime/mcp-bridge.ts#L209) · [复核](../../../src/runtime/mcp-bridge.ts#L307) · [MCP 工具清单通知规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#list-changed-notification)
- **3b 人工 Pin 核准。** 界面未展示供审阅的完整规范化定义，核准请求只传工具身份，服务端批准的是提交时存储的定义。核准须绑定用户所见的定义和指纹，陈旧请求由同一事务拒绝。[Pin 展示与核准](../../../src/web/server.ts#L1212) · [核准事务](../../../src/governance/mcp-pin.ts#L434)
- **3c GitHub 最终工具与作用域。** 写入许可用 `operation` 裁定，最终投递却用另一个可由草稿携带的字段。文件写入遇到空路径清单也可通过，受保护分支仅按常见名称判断。应以同一受控操作绑定许可、Pin 和实际投递，文件写须匹配明确路径，Tier 0 仅适用于已确认非保护的 ref。[写入策略](../../../src/governance/rules.ts#L99) · [提交器策略](../../../src/runtime/submitter.ts#L303) · [投递](../../../src/runtime/submitter.ts#L378)
- **3d Skills 授权。** 正文读取仅查技能状态。L3 路径核验脚本摘要和技能状态，正式入口通过工作区配置即可启用执行。正文按主体和作用域检查现行授权，沙箱启动另核对任务书要求的脚本执行许可。[正文读取](../../../src/web/server.ts#L1303) · [L3 工具](../../../src/runtime/extensions/aegis-policy.ts#L741) · [正式入口](../../../src/index.ts#L508)

**S2-P0-4 · 新增连接器凭据输出边界。** SMTP 成功回执为远端原始应答行，原因字段只有字面密码擦除。GitHub 写入同样把截断的工具文本当回执。提交器将这些内容直接写入效果记录，部分内容还进入模型工具输出与 Web 投影。应在接收边界把远端回执和错误归约为受控状态及验证过的标识，避免持久化或投影未校验的远端文本。现有阶段二扫描命中 0，扫描范围主要是指定的数据库、WAL 和假服务日志。复审应补最小合成凭据输出检查，覆盖本项新增的落库和投影路径。[SMTP 返回](../../../src/capabilities/mail/smtp-client.ts#L255) · [邮件提交](../../../src/runtime/submitter.ts#L198) · [MCP 回执](../../../src/runtime/submitter.ts#L392) · [扫描范围](../../../tests/stage2/run-p0-core.ts#L1224)

**S2-P0-5 · 阶段一撤权保护在视图③回归。** 新的跨会话审批列表只按会话主体筛选，直接返回原审批草稿、目标和效果明细。视图①会重新核对当前来源读取权，撤权后对同一草稿脱敏。视图③应复用同等的实时来源授权和投影裁剪，撤权后两处均须隐藏受限草稿并禁用相应动作。[视图③列表](../../../src/web/server.ts#L1497) · [原授权投影](../../../src/web/server.ts#L312)

### 10.3 P1 / P2 备忘与产品签收差项

下列 P1 独立于五类安全裁定。涉及任务书主流程的项目仍按产品签收验收。

- **S2-P1-1 · GitHub 必测契约。** 正式读写把组合仓库标识作为 `repo`，缺少官方 MCP 的 `owner` 字段。现有假服务定义未覆盖该要求。已存在的阶段一默认 scope 也不会由 `INSERT OR IGNORE` 获得新增写工具。应按实际固定版本的 schema 映射受控目标，并从阶段一数据库副本验证获准工具可用。[读取](../../../src/runtime/extensions/aegis-policy.ts#L508) · [写入](../../../src/runtime/submitter.ts#L378) · [作用域初始化](../../../src/governance/approvals.ts#L68) · [GitHub 官方工具契约](https://github.com/github/github-mcp-server#repositories)
- **S2-P1-2 · Skills 版本生效。** 当前锁键是运行代际与会话，既有会话开启的新任务仍用旧版本。当前用例比较两个会话。补同一会话中旧任务保持锁定、后续新任务取得更新版本的证据。[版本锁](../../../src/capabilities/skills/store.ts#L257) · [自测](../../../tests/stage2/run-p0-core.ts#L977)
- **S2-P1-3 · 例程最近结果。** 当前记录最近受理状态和会话号，缺少任务完成结果回流。应在视图②核对实际最近结果或提供可打开的结果入口。[触发结果记录](../../../src/capabilities/timers/routines.ts#L829)
- **S2-P1-4 · 成本汇总。** 当日账户余额来自账本，当日已结算及保守计费明细却从最新 100 条跨日预留累计。按计费日聚合，展示历史明细时再限条数。[成本查询](../../../src/web/server.ts#L1780)
- **S2-P1-5 · 分层与阶段一规范。** v2.3 §5.2 规定 Web 调用 Runtime 与治理层，新 Web 路由直接导入 Skills 和 Timers 能力层。候选 `AGENTS.md` 字面禁止阶段一任何外部出站，正式入口仍保留阶段一受配置的连接器只读路径，应和 v2.3 的阶段边界对齐。[Web 导入](../../../src/web/server.ts#L11) · [阶段一配置入口](../../../src/index.ts#L303)
- **S2-P2-1 · Windows 复跑。** 默认 `core.autocrlf=true` 在全新 checkout 会改变锁文件行尾，原始字节哈希校验随之失败。复跑说明应要求在检出时保留锁文件的 Git 对象字节。独立复跑未变更冻结锁文件内容或验收断言。

### 10.4 审计人独立复跑命令与证据位置

环境为 Windows x64、Node `22.23.5`、npm `10.9.9`、SQLite `3.54.1`、Docker `29.9.2`、Edge `157.0.4341.60`。V03 使用签收镜像 `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`。独立工作树固定在 `5bb326c`，从 Git 对象恢复两份锁文件的原始字节。复跑仅用合成凭据与本地服务。审计进程清除项目与常用连接器凭据环境变量。第一次启动阶段一套件时根依赖尚未安装完成，两个入口均因模块缺失退出 1。§10.1 记录依赖安装完成后的复跑结果。

```powershell
$evRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\stage2-r1-5bb326c-204300'
Set-Location (Join-Path $evRoot 'candidate')
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$npm = 'D:\AegisPi\tools\node-v22.23.5\npm.cmd'
& $npm ci --offline --no-audit --no-fund
& $npm --prefix web ci --offline --no-audit --no-fund
& $node -e 'const fs=require("node:fs"); const cp=require("node:child_process"); for (const p of ["package-lock.json","web/package-lock.json"]) fs.writeFileSync(p, cp.execFileSync("git", ["show", "HEAD:"+p]));'
& $npm --prefix web run build
& $node tests/stage2/run-all.ts --data-dir (Join-Path $evRoot 'stage2/data') --evidence-dir (Join-Path $evRoot 'stage2/evidence')
& $node tests/stage2/run-all.ts --keep-data --data-dir (Join-Path $evRoot 'stage2-preserved/data') --evidence-dir (Join-Path $evRoot 'stage2-preserved/evidence')
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'week1/data') --evidence-dir (Join-Path $evRoot 'week1/evidence')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'week2/data') --evidence-dir (Join-Path $evRoot 'week2/evidence')
```

本机审计目录保留 `npm-root.log`、`npm-web.log`、`web-build.log`、`stage2.log`、`stage2-preserved.log`、`week1.log`、`week2.log`。各套件的 `evidence/` 保存对应 summary、浏览器与核心断言 JSON。保留原始计数的阶段二复跑证据在 `stage2-preserved/data/`。浏览器假 SMTP 日志 1 条、假模型 3 条、假 MCP 4 条。核心假 SMTP 日志 1 条，独立 TLS SMTP 日志 2 条，假模型 9 条，假 MCP 8 条。阶段一的默认清理保留已提取计数的 `evidence/`。源码发现依据上述代码位置，未调用真实服务。

---

## 11. 整改回执与独立复审

### 11.1 第 1 轮整改回执（实施方 · 2026-11-26）

- **第 2 轮冻结代码候选提交（`v2`）**：`4ec3bb5b74d7046d26a01950adb6d9ed8076b14d`（相对起点 `5748c6c` 与第 1 轮候选 `5bb326c`，§1.3 所列冻结底座路径与根/前端锁文件保持零改动：`git diff --stat 5748c6c 4ec3bb5 -- src/governance/approvals.ts src/governance/effects.ts src/governance/budget.ts src/capabilities/workspace/importer.ts package.json package-lock.json tests/week1 tests/week2` 输出为空）。
- **第 2 轮脱敏证据目录**：`docs/v2/stage2-audit/evidence/round2/`（`stage2-summary.json`、`stage2-p0-core-evidence.json`、`stage2-browser-e2e-evidence.json`），所有后续文档提交与 `4ec3bb5` 的代码差异严格为空。

#### 五类 P0 逐项整改对照表

| 编号 | 第 1 轮问题摘要 | 最小修复与落地位置 | 新增自动化验证与结果 |
| --- | --- | --- | --- |
| **S2-P0-1** | 正式入口未绑定独立获准 SMTP 收件范围；改稿未共用纯文本与单行头校验；SMTP 主题未限制单行边界 | 1) [rules.ts](../../../src/governance/rules.ts) 新增 `validateEmailEnvelopeSingleLine`、`validateEmailRecipientsAllowlist` 并加固 `validateStage2PlainTextEmail`（拒绝 CR/LF/NUL/控制字符及非数组 `cc`/`bcc`/`attachments`，非环回真实 SMTP 强制非空且无 `*` 收件白名单）。<br>2) [index.ts](../../../src/index.ts) 接入 `smtp.allowedRecipients` / `--allowed-email-targets` 并在启动前 fail-closed；[harness.ts](../../../src/runtime/harness.ts) 绑定 `allowedEmailRecipients`。<br>3) [aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts)、[server.ts](../../../src/web/server.ts)（`POST /api/proposals/:id/draft`）、[submitter.ts](../../../src/runtime/submitter.ts)（T4 领取前与 `precondition` 内）及 [smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts)（发包前）共用同一套单行头、纯文本与收件白名单校验。 | `s2_p0_12e6cd1e` 实测：CRLF 主题注入在校验、改稿接口（`400`）、提交器与 `sendSmtpMessage`（`bytesSent=0`）全链路拒绝；非环回 SMTP 通配或越界收件人拒绝；合规改稿独立假 SMTP 增量 `1`。 |
| **S2-P0-2** | 真实模型缺价表时回退合成固定价格；UTF-8 折半估算与 `contextWindow` 截断无法证明覆盖真实计费 | 1) [credentials.ts](../../../src/governance/credentials.ts) 新增 `validateModelPriceScheduleForEndpoint`：合成固定价表仅允许本机环回假端点，非环回真实端点强制提供非合成版本化价表且 `allowTokenBoundEstimation=true`，支持 `cacheWritePerMTokMu` 与 `maxReasoningTokens`。<br>2) [index.ts](../../../src/index.ts) 非环回端点不再回退 `synthetic-v1`，缺失或非法价表启动前即拒绝。<br>3) [models.ts](../../../src/runtime/models.ts) 移除 `bytes/2` 与 `Math.min(contextWindow, ...)` 截断，改用字节级 BPE 数学最坏上界 `1 UTF-8 byte = 1 token` 加显式消息/工具帧开销，拒绝无法定界的非文本块（如图像），取 `max(input, cacheRead, cacheWrite)` 单价，并将预留所使用的 `effectiveMaxTokens` 显式透传到上游请求选项；结算纳入 `cacheWrite`。 | `s2_p0_12e6cd1e` 实测：非环回 `https://api.deepseek.com` 缺价表或合成价表均 fail-closed（`0` 物理请求）；token 定界预算不足拦截发送增量 `0`；正常流式首 token `89 ms`。 |
| **S2-P0-3a** | MCP 客户端未订阅 `notifications/tools/list_changed`，连接存续期工具变更无法即时暂停重核 | [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) 在 `client.connect` 前订阅锁定 `@earendil-works/pi-mcp@1.6.0` 的 `client.onNotification("notifications/tools/list_changed", ...)` 与 `client.onClose`；收到通知立即同步置 `admissionPaused=true`、记录审计事件并串行触发 `recheckToolPins()`，校验失败保持关闭准入。 | `s2_p0_12e6cd1e` 实测：假 MCP 运行中写漂移标记并主动发送 `notifications/tools/list_changed`，桥接立即暂停并隔离漂移工具，期间远端 `tools/call` 增量 `0`。 |
| **S2-P0-3b** | 界面未展示完整规范化定义；核准只传工具身份，未绑定用户所见定义与指纹 | 1) [mcp-pin.ts](../../../src/governance/mcp-pin.ts) 新增 `inspectStoredMcpToolPin`，并将 `approveStoredMcpToolPin` 改为强制要求 `expectedSchemaSha256`（及可选 `expectedCanonicalDefJson`），在同一 `BEGIN IMMEDIATE` 事务内核对失败返回 `409`。<br>2) [server.ts](../../../src/web/server.ts) 的 `GET /api/mcp/pins` 返回完整 `canonicalDefJson`、`observedSchemaSha256`、`pinnedSchemaSha256` 与 `drifted`；`POST .../approve` 缺指纹返回 `400`、陈旧返回 `409`。<br>3) [WorkspaceView.tsx](../../../web/src/views/WorkspaceView.tsx) 与 [api.ts](../../../web/src/client/api.ts) 展示可审阅完整规范化定义 JSON 并在点击核准时绑定提交。 | `s2_p0_12e6cd1e` 实测：空指纹请求返回 `400`，陈旧指纹在同一事务返回 `409`，匹配审阅指纹方可通过。 |
| **S2-P0-3c** | GitHub 策略用 `operation` 而投递用草稿字段；空 `allowedPaths` 可放行文件写；Tier 0 仅按常见保护分支名判断 | 1) [rules.ts](../../../src/governance/rules.ts) 新增 `resolveControlledGithubMcpTool`，以单一受控操作映射同时绑定策略、Pin 与投递；文件写操作强制要求非空 `allowedPaths` 匹配；Tier 0 除排除保护分支/标签/工作流/高危写外，强制要求 `ref` 为显式 `refs/heads/...` 且列入 `confirmedNonProtectedRefs`（未确认 ref 自动升级 Tier 2）。<br>2) [aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts)、[submitter.ts](../../../src/runtime/submitter.ts) 与 [server.ts](../../../src/web/server.ts) 改稿接口一致强制 `mcpToolName === controlledTool` 且草稿不可篡改 MCP 绑定。 | `s2_p0_12e6cd1e` 实测：篡改 `mcpToolName` 在 T4 领取前被 `github_write_tool_mismatch` 拒绝；空 `allowedPaths` 返回 `allowed=false`；未确认非保护分支 `refs/heads/develop` 升级为 Tier 2。 |
| **S2-P0-3d** | Skills 正文读取仅查技能状态；正式入口凭 `workspace` 配置即开启 L3 脚本执行 | 1) [db.ts](../../../src/governance/db.ts) 前向迁移 7 扩展 `source_read_grants.source_type` 支持 `'skill'`；[policy.ts](../../../src/governance/policy.ts) 支持 `scriptId`/`scriptSha256` 约束。<br>2) [store.ts](../../../src/capabilities/skills/store.ts)、[aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) 与 [server.ts](../../../src/web/server.ts) 对 L2 正文披露强制核验现行 `(principalId, scopeId)` 的 `read_body` 授权；L3 `resolveVerifiedSkillScript` 额外强制核验独立 `execute_script` 许可（默认不授予）。<br>3) [index.ts](../../../src/index.ts) 要求显式 `skills.allowScriptExecution === true` 才启用 L3 沙箱 runner，并在容器启动前再次核验 `execute_script` 许可。 | `s2_p0_12e6cd1e` 实测：无授权主体（含 HTTP `guest`）读取正文返回 `403` / `skill_read_denied`；无独立 `execute_script` 许可调用 L3 脚本返回 `skill_script_execution_denied`。 |
| **S2-P0-4** | SMTP 与 GitHub MCP 远端原始应答与错误文本直接落库 `effects` 并进入工具输出与 Web 投影 | 1) [smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts) 在接收边界将成功回执归约为 `smtp:<code>:accepted`（或严格校验的 `qid=<alnum>`），所有远端/本地错误归约为受控错误码，不再透传原始应答行或 banner。<br>2) [submitter.ts](../../../src/runtime/submitter.ts) 对 SMTP 与 GitHub MCP 二次归约：GitHub 写入仅提取经正则验证的 hex Commit SHA（`github:commit:<sha>` 或 `github:write:committed`），失败归约为受控状态码。 | `s2_p0_12e6cd1e` 实测：让假 SMTP（250 成功与 550 拒绝）和假 GitHub MCP 故意在响应中回显合成凭据标记，扫描双库、`WAL`、日志及 `/api/approvals`、`/snapshot` 投影，新增与既有 7 槽位命中均为 `0`。 |
| **S2-P0-5** | 视图③ `/api/approvals` 未复用视图①的实时来源读取权核对与撤权脱敏 | [server.ts](../../../src/web/server.ts) 抽取并复用同源 `countRevokedSourcesForConversation` 与作用域校验：`GET /api/approvals` 在来源撤权后与视图①一致脱敏 `target`、`snapshot` 与 `effect` 明细，置 `draftRedacted: true`、`hasChallenge: false`，禁用编辑与批准（同时保持 `POST /api/approvals/:id/challenge` 与阶段一 `V04/V05` 的 `REJECT` 取消路径兼容，而 `APPROVE` 与改稿一律 `403 source_read_revoked`）。 | `s2_p0_12e6cd1e` + `v04v05_d306ca14` 实测：来源撤权后视图①与视图③同步隐藏受限草稿并禁批，改稿与 `APPROVE` 返回 `403`，且阶段一 `V04/V05` 全部通过。 |

#### P1 / P2 备忘项同步闭环情况

- **S2-P1-1（GitHub 官方 `owner/repo` 契约与阶段一库升级）**：[aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) 与 [submitter.ts](../../../src/runtime/submitter.ts) 按已 Pin 工具的 `inputSchema` 动态映射 `{ owner, repo }`（兼容官方 `github-mcp-server` 与既有假服务）；[rules.ts](../../../src/governance/rules.ts) 新增 `upgradeStage2ScopeAllowedTools` 并在 [harness.ts](../../../src/runtime/harness.ts) 阶段二启动时原地补齐既有阶段一 `scope:default` 的 `allowed_tools_json`（不改冻结的 `approvals.ts`），已在 `s2_p0_12e6cd1e` 验证。
- **S2-P1-2（Skills 同会话新任务生效）**：[store.ts](../../../src/capabilities/skills/store.ts)、[aegis-context.ts](../../../src/runtime/extensions/aegis-context.ts) 与 [harness.ts](../../../src/runtime/harness.ts) 改按会话活跃任务键（`lockKey`）锁定版本，已在 `s2_p0_12e6cd1e` 验证同一会话内任务 1 保持 v1、切版后任务 2 取得 v2。
- **S2-P1-3（例程最近结果回流）**：[routines.ts](../../../src/capabilities/timers/routines.ts) 新增 `recordRoutineTriggerCompletion`，[harness.ts](../../../src/runtime/harness.ts) 在例程受理后异步回写实际完成状态与摘要，[server.ts](../../../src/web/server.ts) 与 [WorkspaceView.tsx](../../../web/src/views/WorkspaceView.tsx) 暴露 `lastConversationId` 及「打开结果会话」入口。
- **S2-P1-4（按计费日聚合成本）**：[server.ts](../../../src/web/server.ts) 的 `GET /api/budget/summary` 改为按当日 `day_account` 全量聚合当日 `settledMu` / `chargedBoundMu` / `heldMu` / `byPurpose`，历史明细再单独 `LIMIT 100`；已在 `s2_p0_12e6cd1e` 插入 105 条跨日记录验证当日汇总无截断漂移。
- **S2-P1-5（Web 分层与阶段一规范对齐）**：新增 L3 门面 [console-facade.ts](../../../src/runtime/console-facade.ts)，[server.ts](../../../src/web/server.ts) 清除全部 `../capabilities/*` 直接导入，并在 [tests/stage2/run-all.ts](../../../tests/stage2/run-all.ts) 收紧 `checkLayerBoundary()` 禁止 `src/web/` 越层导入 `capabilities/`；同步修订 [AGENTS.md](../../../AGENTS.md) 第 3 条对齐 v2.3 阶段一受控只读连接器边界。
- **S2-P2-1（Windows 检出锁文件行尾）**：下方 §11.2 复跑命令显式纳入 `git show HEAD:<lockfile>` 原始字节校验步骤。

### 11.2 第 2 轮实测结果与一键复跑命令（实施方自测 · 冻结候选 `4ec3bb5b74d7046d26a01950adb6d9ed8076b14d`）

| 套件 | 候选 SHA | 实际命令 | 退出码 | Run ID | 关键指标 / 独立计数 |
| --- | --- | --- | --- | --- | --- |
| 前端重建 + 前后端类型检查 | `4ec3bb5` | `tsc --noEmit`（根 + `web/`）& `npm --prefix web run build` | `0` | — | `web/dist` 零报错构建；根/前端锁文件未变更 |
| **阶段二全套（含全部 R1 P0/P1 新增用例）** | `4ec3bb5` | `node tests/stage2/run-all.ts --evidence-dir docs/v2/stage2-audit/evidence/round2` | **`0`** | `stage2_8ef7176d` | `rootLockIntegrity` PASS、`layerBoundary` PASS（0 违规，含禁止 `web->capabilities`）、`p0Core` `s2_p0_12e6cd1e` PASS（7 槽位含远端回显零命中 `totalForbiddenHits=0`）、`browserDesktopAndNarrow` `s2_browser_137ed8f1` PASS（桌面 `1280x800` + 窄屏 `390x844`、假 SMTP `1`、改稿一致） |
| **阶段一第 2 周全套回归** | `4ec3bb5` | `node tests/week2/run-all.ts` | **`0`** | `week2_00be19c3` | `typecheck` PASS、`layerBoundary` PASS、`v04_v05` `v04v05_d306ca14` PASS、`v02` `v02_b4537830` PASS、`v03` `v03_60bea256`（Docker）PASS、`s6` `s6_66d8c9aa`（`totalForbiddenHits=0`）PASS、`v01_v05_v06_browser` `v01v06_83fa8173`（Edge）PASS |
| **阶段一第 1 周全套回归** | 同代码树 | `node tests/week1/run-all.ts` | **`0`** | `week1_b5699147` | `typecheck`、`s1_s5`、`w1_a_and_b01`（9/9）、`w1_b_and_e06`（假 SMTP `1` / `结果待核对`）、`matrix` `25/25` 全通过 |
| 真实 DeepSeek / Gmail / GitHub / 实体手机 | `4ec3bb5` | — | — | — | **待验证**（无新增授权，未触发真实计费或外部写入，与 §8 保持一致） |

#### 第 2 轮审计人一键复跑命令（含 S2-P2-1 Windows 锁文件原始字节保真）

```powershell
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$npm = 'D:\AegisPi\tools\node-v22.23.5\npm.cmd'

# 1. 在独立 worktree 固定到第 2 轮候选提交 4ec3bb5b74d7046d26a01950adb6d9ed8076b14d，并恢复锁文件 Git 原始字节（规避 Windows core.autocrlf）
& $node -e 'const fs=require("node:fs"); const cp=require("node:child_process"); for (const p of ["package-lock.json","web/package-lock.json"]) fs.writeFileSync(p, cp.execFileSync("git", ["show", "4ec3bb5b74d7046d26a01950adb6d9ed8076b14d:"+p]));'
& $npm ci --offline --no-audit --no-fund
& $npm --prefix web ci --offline --no-audit --no-fund
& $npm --prefix web run build

# 2. 复跑阶段二全套（含全部 S2-P0-1..5 与 P1 自动化回归）及阶段一第 1、2 周全套回归
& $node tests/stage2/run-all.ts
& $node tests/week1/run-all.ts
& $node tests/week2/run-all.ts
```

### 11.3 第 2 轮独立复审裁定（Codex · 2026-11-26）

**候选 `4ec3bb5b74d7046d26a01950adb6d9ed8076b14d` 未通过阶段二安全审计，阶段二完整签收未通过。** 实质性 P0 继续按 §11.4 整改和复审。受影响的真实出站与执行能力在红线关闭前保持关闭，真实联调项维持待验证。§11.2 的实施方结果与下表独立复跑结果均保留。

#### 独立复跑

| 核对项 | 结果 | 独立证据 |
| --- | --- | --- |
| 冻结候选与分层 | PASS | `092dad3` 相对候选只新增或更新报告与证据。§1.3 冻结底座、阶段一脚本及根锁文件相对 `5748c6c` 零差异，前端锁文件与第 1 轮一致。两份锁文件 SHA-256 与 §2.1 一致，候选 diff 检查无空白错误。 |
| 前端构建及阶段二套件 | PASS | 两个入口均退出 0。`stage2_254d3884`，核心 `s2_p0_a36b8794`，桌面与窄屏 `s2_browser_42ea2e03`。前后端类型检查与分层守卫通过。额度不足的假模型增量 0，浏览器合规改稿收件 1 封，单次 C4 变更夹具调用增量 0，现有凭据扫描命中 0。 |
| 阶段一第 1、2 周全套 | PASS | 两个入口均退出 0。第 1 周 `week1_7276d8d9`，矩阵 25/25，W1-B 独立假 SMTP 累计 1 封，状态 `UNKNOWN`。第 2 周 `week2_64f71a06`，V01–V06、V03 Docker `v03_bc3e79e0` 和 S6 `s6_821870df` 均通过，S6 命中 0。 |

#### 五类红线复审

| 编号 | 裁定 | 整改剩余范围 |
| --- | --- | --- |
| S2-P0-1 | **未关闭** | 默认配置下的单行头字段、收件白名单和两次 CAS 回归通过。正式阶段二配置仍可关闭纯文本校验。该分支可把额外收件人或附件摘要纳入已批准快照，而 SMTP 仅发送 To、主题和正文。阶段二真实 SMTP 须强制使用支持的快照字段，建单、改稿、领取与实际发信保持一致。[入口](../../../src/index.ts#L543) · [最终校验](../../../src/runtime/submitter.ts#L133) · [发信参数](../../../src/runtime/submitter.ts#L267) |
| S2-P0-2 | **未关闭** | 非环回缺价表由校验函数拒绝，预算不足的独立物理计数用例使用环回替身且发送增量为 0。环回地址仍自动取得固定合成价表，校验依据主机地址，无法区分替身与环回的真实计费代理。通用真实配置也仅凭开关启用固定帧开销估算，缺少与供应商及模型绑定的上界证明。固定价仅限显式替身，真实计费路径在上界不可证时保持拒绝。[价表选择](../../../src/index.ts#L262) · [端点校验](../../../src/governance/credentials.ts#L160) · [输入上界](../../../src/runtime/models.ts#L198) |
| S2-P0-3 | **未关闭** | 单次清单通知暂停、陈旧指纹拒绝、受控 GitHub 操作绑定和 Skills 独立授权用例通过。已隔离工具再次变更时，桥接更新内存定义，但只在首次报告差异时持久化审阅定义。人工核准及最终调用继续依赖数据库中的旧记录。每次清单核对均须更新最新观察定义与在场状态，核准和实际执行须核对同一最新指纹。[已隔离分支](../../../src/governance/mcp-pin.ts#L280) · [桥接核对](../../../src/runtime/mcp-bridge.ts#L317) · [核准事务](../../../src/governance/mcp-pin.ts#L514) · [执行准入](../../../src/runtime/mcp-bridge.ts#L536) |
| S2-P0-4 | **未关闭** | SMTP 和 GitHub 普通写入回显夹具通过。SMTP 可选队列号仍只按字符格式接受，字符检查不证明其与凭据无关。真实模型错误仍从锁定 SDK 的远端错误正文进入未归约的事件和结果。新增例程完成逻辑还把该错误文本保存为治理库摘要并由 Web 返回。MCP 只读错误同样保留原始远端正文。应在各连接器信任边界归约错误并只持久化受控状态。现有回显用例未验证这些路径。[模型事件](../../../src/runtime/models.ts#L629) · [例程错误摘要](../../../src/runtime/harness.ts#L1684) · [MCP 只读结果](../../../src/runtime/mcp-bridge.ts#L502) |
| S2-P0-5 | **未关闭** | 视图③审批列表的受限草稿和效果字段已脱敏，其改稿与批准拒绝用例通过。视图①草稿已脱敏时仍返回原始效果回执、原因及核对证据。新增例程接口也直接返回持久摘要和触发原因，读取时未核对关联会话、当前作用域和来源授权。撤权后的跨视图投影应共用实时授权，只保留仍可显示的状态。[视图①效果投影](../../../src/web/server.ts#L378) · [例程持久摘要](../../../src/capabilities/timers/routines.ts#L892) · [例程读取](../../../src/web/server.ts#L1557) |

五类剩余项为源码与锁定 SDK 核查。真实 DeepSeek 流式与计费、Gmail 只读和单封测试发信、GitHub MCP 只读和测试仓单次写均缺实测证据。实体手机 HTTPS 按任务书独立验收，不阻塞主签收。

#### 残留项来源

按第 1 轮候选 `5bb326c` 与整改候选 `4ec3bb5` 的代码差异核对。第二轮首次写入审计报告的路径可能早已存在。

| 编号 | 来源与已收敛范围 |
| --- | --- |
| S2-P0-1 | **第一轮问题部分修复。** 收件白名单和默认纯文本字段校验已补齐。第一轮已有关闭纯文本校验的配置，第二轮共用校验仍受它控制，批准快照与实际发送一致性的要求未完全落实。 |
| S2-P0-2 | **第一轮问题部分修复。** 非环回端点已禁止合成价表，原估算折半与截断已移除。真实计费的可信上界仍缺供应商和模型契约，环回计费代理是第二轮定位出的遗留配置路径。 |
| S2-P0-3 | **同一红线下，第二轮补录第一轮已有路径。** 通知订阅、单次指纹核准、GitHub 操作绑定和 Skills 独立授权的复跑通过。隔离中再次漂移仍使用旧审阅定义的路径在 `5bb326c` 已存在，第一轮未单列。 |
| S2-P0-4 | **第一轮问题部分修复，另有两种来源。** 普通写回执已收敛，第二轮采用的 SMTP 可选队列号仍采纳远端文本。模型与 MCP 只读的原始错误路径在 `5bb326c` 已存在，第二轮补录。例程把原始错误保存为摘要是 `4ec3bb5` 结果回流新增的路径。 |
| S2-P0-5 | **首轮点名的视图③列表已修，其他路径仍开放。** 视图①原始效果明细在 `5bb326c` 已存在，第二轮补录。例程结果回流在 `4ec3bb5` 新增了需受来源撤权约束的摘要和触发原因。例程的凭据与撤权问题共用一个输出边界处理。 |

#### 复跑命令与本机证据

独立工作树固定到 `4ec3bb5`，两份锁文件使用 Git 对象原始字节。因锁文件未改，候选复用第 1 轮通过锁定 npm 离线安装的依赖目录，重新构建前端。测试环境使用 Windows x64、Node `22.23.5`、npm `10.9.9`、SQLite `3.54.1`、Docker `29.9.2` 与 Edge `157.0.4341.60`。V03 使用签收镜像 `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`。进程环境清除项目和常用连接器凭据变量，使用合成凭据与本地替身。以下程序从独立候选根目录运行。

```powershell
$evRoot = 'D:\AegisPi\aegis-pi-v2-planning\audit-reruns\stage2-r2-4ec3bb5-223039'
Set-Location (Join-Path $evRoot 'candidate')
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
& 'D:\AegisPi\tools\node-v22.23.5\npm.cmd' --prefix web run build
& $node tests/stage2/run-all.ts --keep-data --data-dir (Join-Path $evRoot 'stage2/data') --evidence-dir (Join-Path $evRoot 'stage2/evidence')
& $node tests/week1/run-all.ts --keep-data --data-dir (Join-Path $evRoot 'week1/data') --evidence-dir (Join-Path $evRoot 'week1/evidence')
& $node tests/week2/run-all.ts --keep-data --data-dir (Join-Path $evRoot 'week2/data') --evidence-dir (Join-Path $evRoot 'week2/evidence')
```

日志位于 `$evRoot` 下的 `web-build.log`、`stage2.log`、`week1.log` 和 `week2.log`，各套件 `evidence/` 留存 JSON，`data/` 留存独立假服务原始计数。阶段二浏览器纵切假 SMTP 收件日志 1 条、模型日志 3 条、MCP 日志 4 条。核心套件假 SMTP 收件日志 2 条、独立 TLS SMTP 收件日志 2 条、模型日志 9 条、MCP 日志 11 条。

### 11.4 后续整改与提审（实施方 · 2026-11-26）

针对 §11.3 裁定的全部五类实质性 P0 残留项（相对 `4ec3bb5` 增量收敛），实施方已完成全部代码修复、最小红线闭合验证及阶段二 + 阶段一第 1、2 周全量回归。

- **本轮冻结代码候选提交**：`81ec02acdd5f05c919675bc45bc1e559eef7f798`（`fix(v2-stage2): close all five Round 2 residual P0 findings (S2-P0-1..5)`，共修改 15 个代码与测试文件，不含文档与证据）。
- **冻结底座与锁文件零改动核验**：`git diff 5748c6c -- src/governance/approvals.ts src/governance/effects.ts src/governance/budget.ts src/capabilities/workspace/importer.ts package.json package-lock.json tests/week1 tests/week2` 输出为空；两份锁文件 SHA-256 与 §2.1 完全一致；`git diff --check` 零空白错误；本报告及 `docs/v2/stage2-audit/evidence/round3/` 独立落于后续文档提交，确保 `git diff 81ec02a HEAD` 仅包含 `docs/v2/stage2-audit/`。

#### 五类 P0 残留项逐项闭合对照表

| 编号 | 本轮根因与最小修复 | 源码核查位置 | 最小红线闭合验证（`s2_p0_959e8b69`） |
| --- | --- | --- | --- |
| **S2-P0-1** | 新增 `isStrictPlainTextEmailRequired()`，在阶段二及任意非环回 SMTP 端点无条件强制纯文本白名单字段；`src/index.ts` 与 `AegisHostRuntime.start()` 启动期拒绝阶段二配置 `strictPlainTextEmail: false`；`validateStage2PlainTextEmail()` 除 `cc`/`bcc`/`attachments`/`attachmentDigests` 外拒绝一切额外未知字段；建单、改稿、T4 领取前/内及 SMTP 序列化严格统一为 `{ to, subject, body }`，批准快照与实际发信字段 1:1 一致。 | [rules.ts](../../../src/governance/rules.ts) · [index.ts](../../../src/index.ts) · [harness.ts](../../../src/runtime/harness.ts) · [aegis-policy.ts](../../../src/runtime/extensions/aegis-policy.ts) · [server.ts](../../../src/web/server.ts) · [submitter.ts](../../../src/runtime/submitter.ts) | `validateStage2PlainTextEmail` 拒绝额外 `html` 字段；阶段二 `AegisHostRuntime.start(..., strictPlainTextEmail: false)` 启动拒绝；即便调用方传 `strictPlainTextEmail: false`，提交器在 T4 前拒绝含 `cc` 载荷（`claimed=false`、`unsupported_email_field_cc`、假 SMTP 增量 `0`）。 |
| **S2-P0-2** | 固定合成价表严格收口至**显式** `provider === "fake-local"` 且环回主机；环回地址上的真实计费代理（如 `127.0.0.1` + `deepseek`）不再自动取得合成价表；新增受验供应商/模型上界契约注册表 `VERIFIED_MODEL_BOUND_CONTRACTS`（当前仅登记已验证的 `deepseek/deepseek-chat` 契约 `deepseek-chat-openai-compat-v1`，绑定 UTF-8 字节 BPE 上界、帧开销与 `maxTokensHardCeiling=8192`）；非显式替身必须提供绑定 `provider`+`modelId` 且命中已验契约的价表，通用未验模型或未验推理模型即使配置 `allowTokenBoundEstimation=true` 亦在启动与发送前默认拒绝（`unproven_model_bound_contract`）；非推理槽强制清除 `reasoning` 选项。 | [credentials.ts](../../../src/governance/credentials.ts) · [index.ts](../../../src/index.ts) · [models.ts](../../../src/runtime/models.ts) | 环回代理 `http://127.0.0.1:7890/v1` + `deepseek/deepseek-chat` 缺价表或合成价表均拒绝；通用模型 `generic-llm/mystery-1` 及未验推理模型 `deepseek/deepseek-reasoner` 开 `allowTokenBoundEstimation=true` 均拒绝；已验契约 `deepseek/deepseek-chat` 通过，且预算不足时物理发送增量 `0`。 |
| **S2-P0-3** | 前向 Migration 8（兼容阶段一遗留 `definition_sha256` 列）为 `mcp_tool_pins` 增加 `observed_schema_sha256` 与 `present_in_last_list`；`verifyOrQuarantineMcpTool()` 在 `QUARANTINED`、`REVOKED` 与首次漂移分支均原子刷新最新 `canonical_def_json`、`observed_schema_sha256` 与 `present_in_last_list=1`；`quarantineMissingMcpTools()` 对全部缺失工具（含已隔离/已撤权）标记 `present_in_last_list=0`；`#reconcileLiveToolsList()` 原子替换内存 `#loadedTools` 与 `#loadedToolFingerprints`；`approveStoredMcpToolPin()` 拒绝不在场工具（`409 mcp_tool_not_present`）及陈旧指纹（`409`）；`verifyLiveMcpToolPin()`、桥接读写与提交器 T4 前/内同时核对数据库核准指纹、最新观察指纹、在场状态及实时内存指纹。 | [db.ts](../../../src/governance/db.ts) · [mcp-pin.ts](../../../src/governance/mcp-pin.ts) · [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) · [submitter.ts](../../../src/runtime/submitter.ts) · [server.ts](../../../src/web/server.ts) | 工具已隔离（`v2`）期间再次变更至 `v3` 并推送第二次 `notifications/tools/list_changed` 后，库内审阅定义与观察指纹更新至 `v3`，提交 `v1` 或 `v2` 指纹均被 `409` 拒绝，仅 `v3` 核准成功；缺失工具 `presentInLastList=false` 且核准返回 `409 mcp_tool_not_present`；C4 期间远端工具调用增量 `0`。 |
| **S2-P0-4** | `smtp-client.ts` 移除可选远程 `qid=` 文本提取，SMTP 2xx 严格归约为 `smtp:<code>:accepted`（提交器正则同步收口为 `/^smtp:2\d{2}:accepted$/`）；`models.ts` 在 `createGuardedModelFetch` 边界立即取消非 2xx 远程错误响应体并替换为受控 `model_provider_http_<status>`，同时在 `underlyingStream.push`/`end` 归约全部远端错误事件与终态 `errorMessage` 并将受控 `errorCode` 透传至 `onStreamFinished`；`harness.ts` 与 `routines.ts` 仅持久化受控错误码；`mcp-bridge.ts` 对只读与写入的 `isError` 及传输异常均归约为 `mcp_remote_tool_error:<tool>` / `mcp_transport_error:<code>`，`#lastPauseReason` 与 `/api/mcp/pins/recheck` 异常同样收敛为受控码。 | [smtp-client.ts](../../../src/capabilities/mail/smtp-client.ts) · [submitter.ts](../../../src/runtime/submitter.ts) · [models.ts](../../../src/runtime/models.ts) · [harness.ts](../../../src/runtime/harness.ts) · [routines.ts](../../../src/capabilities/timers/routines.ts) · [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) · [server.ts](../../../src/web/server.ts) | 假 SMTP 250 回复 `queued as QIDSECRET-...` 归约为 `smtp:250:accepted`；假模型返回 HTTP 401 回显秘文触发例程失败，落库 `routine_triggers.reason === "model_provider_http_401"`；假 MCP 只读 `isError` 回显秘文归约为 `mcp_remote_tool_error:get_file_contents`；全盘双库、WAL、假服务日志与 Web 投影 9 个槽位扫描命中 `0`。 |
| **S2-P0-5** | 视图①与视图③共用 `projectEffectForAuthorization(effect, redacted)`，来源撤权后视图①同步脱敏 `effect.receiptRef`、`effect.reason`、清空 `effect.reconcileEvidence` 并置 `hasChallenge=false`；视图② `GET /api/routines` 读取时实时核验例程 `scope_id`、每条触发记录关联会话（`chat_commands` + `conversation_scopes`）主体/作用域与 `countRevokedSourcesForConversation()`，撤权或失权后同步脱敏 `lastResultSummary` 与 `triggers[].reason`（附 `resultRedacted=true` / `redacted=true`），仅保留受控状态。 | [server.ts](../../../src/web/server.ts) | 撤销来源读授权后，视图① `/snapshot` 与视图③ `/api/approvals` 均脱敏草稿及效果回执/原因/核对证据（`hasChallenge=false`）；视图② `/api/routines` 同步脱敏 `lastResultSummary` 与 `triggers[0].reason`，三视图均不含原始受限文本。 |

#### 第 3 轮自测实跑结果（冻结候选 `81ec02acdd5f05c919675bc45bc1e559eef7f798`）

环境：Windows x64、锁定 `D:\AegisPi\tools\node-v22.23.5\node.exe`（Node `v22.23.5`、SQLite `3.54.1`）、npm `10.9.9`、Docker `29.9.2`、Edge `157.0.4341.60`。

| 套件 | 实际执行命令 | 退出码 | 结果与脱敏证据摘要 |
| --- | --- | --- | --- |
| 前端类型检查与构建 | `npm --prefix web run build` | `0` | PASS（`tsc --noEmit && vite build`，35 modules，`2.65s`） |
| 阶段二全量验收 | `node tests/stage2/run-all.ts --evidence-dir docs/v2/stage2-audit/evidence/round3` | `0` | PASS（`stage2_a61930b6`，`commitSha=81ec02acdd5f05c919675bc45bc1e559eef7f798`；锁文件/前后端 `tsc`/分层守卫全过；核心 `s2_p0_959e8b69` 9 槽位扫描 `totalForbiddenHits=0`、C4 远端调用增量 `0`、预算不足增量 `0`、假 TLS SMTP=2；浏览器桌面/窄屏 `s2_browser_0fb4f145` 假 SMTP=1）。证据：[stage2-summary.json](evidence/round3/stage2-summary.json) · [stage2-p0-core-evidence.json](evidence/round3/stage2-p0-core-evidence.json) · [stage2-browser-e2e-evidence.json](evidence/round3/stage2-browser-e2e-evidence.json) |
| 阶段一第 2 周全量回归 | `node tests/week2/run-all.ts` | `0` | PASS（`week2_984d75fd`，`commitSha=81ec02acdd5f05c919675bc45bc1e559eef7f798`；`v04_v05` `v04v05_f32a13f4`、`v02` `v02_d3eebeaf`、`v03` Docker `v03_0e4d0050`、`s6` `s6_aaa4d8d7` `totalForbiddenHits=0`、浏览器 `v01v06_8e218cff` 全通过） |
| 阶段一第 1 周全量回归 | `node tests/week1/run-all.ts` | `0` | PASS（`week1_ebabc747`；`typecheck`、`S1-S5`、`W1-A` 9/9、`W1-B` 假 SMTP=1/`UNKNOWN`/`结果待核对`、`matrix` 25/25 全通过） |

#### 真实服务实测口径

- 真实 DeepSeek 流式与计费、真实 Gmail 只读与单封测试发信、真实 GitHub MCP 只读与选定测试仓单次写、可选实体手机 HTTPS 仍保持默认关闭并标记**待验证**，待本轮安全红线独立复审签收且取得用户逐项独立授权后按产品签收口径实测登记。

#### 第 3 轮审计人一键复跑命令（PowerShell · 含 Windows 锁文件原始字节保真）

```powershell
$sha = '81ec02acdd5f05c919675bc45bc1e559eef7f798'
git diff 5748c6c $sha -- src/governance/approvals.ts src/governance/effects.ts src/governance/budget.ts src/capabilities/workspace/importer.ts package.json package-lock.json tests/week1 tests/week2
git diff --check 5748c6c..$sha

# 在独立工作树按 Git 对象原始字节保真两份锁文件
$tmp = Join-Path $env:TEMP "aegispi-stage2-r3-$($sha.Substring(0,7))"
git worktree add --detach $tmp $sha
git -C $tmp show "${sha}:package-lock.json" | Set-Content -Path (Join-Path $tmp 'package-lock.json') -AsByteStream -NoNewline
git -C $tmp show "${sha}:web/package-lock.json" | Set-Content -Path (Join-Path $tmp 'web/package-lock.json') -AsByteStream -NoNewline
Set-Location $tmp
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
& 'D:\AegisPi\tools\node-v22.23.5\npm.cmd' --prefix web run build
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/stage2/run-all.ts --evidence-dir "$tmp\evidence-stage2"
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/week1/run-all.ts
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/week2/run-all.ts
```

### 11.5 第 3 轮独立复审裁定（Codex · 2026-11-27）

冻结候选 `81ec02acdd5f05c919675bc45bc1e559eef7f798` **退回定向整改，阶段二暂不签收**。原 SMTP 快照问题和已隔离工具再次漂移问题已关闭。当前阻塞涉及真实模型预算、GitHub 写入结果不明、连接器错误输出和例程撤权投影。以下裁定来自独立源码核查与本机替身回归。真实服务必测仍待授权实测。

#### 独立复跑

| 核对项 | 结果 | 独立证据 |
| --- | --- | --- |
| 候选与冻结基线 | PASS | `9f8a77e` 相对冻结候选只增加报告和证据。相对 `5748c6c` 核对 `approvals.ts`、`effects.ts`、`budget.ts`、`importer.ts`、根依赖和阶段一脚本均无差异。两份锁文件从 Git 对象恢复原始字节，SHA-256 与 §2.1 一致。候选 `git diff --check` 通过。 |
| 前端构建与阶段二 | PASS | `npm --prefix web run build` 和 `node tests/stage2/run-all.ts --keep-data --evidence-dir <证据目录>` 均退出 `0`。总套件 `stage2_5a3347f6`，核心 `s2_p0_c3c8f7df`，Edge 桌面与窄屏 `s2_browser_d4836e15`。类型检查及分层通过。额度不足和 C4 阻断用例的独立服务增量均为 `0`。浏览器看到 2 次递进渲染，首 token `138 ms`，最终改稿与假 SMTP 唯一收件一致。已覆盖的凭据扫描命中 `0`。 |
| 阶段一第 1 周 | PASS | `node tests/week1/run-all.ts --keep-data` 退出 `0`，`week1_2bb4ca40`。矩阵 25/25，W1-B 独立假 SMTP 收件 1 封并保持 `UNKNOWN`，界面显示「结果待核对」。 |
| 阶段一第 2 周 | PASS | `node tests/week2/run-all.ts --keep-data` 退出 `0`，`week2_44bc0ab0`。V01–V06 全通过，含 V03 Docker `v03_21cb5736`、Edge `v01v06_e45265fe` 和 S6 `s6_739309b7`，S6 命中 `0`。 |

使用 Windows x64、Node `22.23.5`（SQLite `3.54.1`）、npm `10.9.9`、Edge `157.0.4341.60`、Docker `29.9.2` 和候选独立工作树。依赖复用首轮离线 `npm ci` 的两个目录，复用前按字节核对锁文件。原始运行日志与脱敏证据保留于本机 `D:/AegisPi/aegis-pi-v2-planning/audit-reruns/stage2-r3-81ec02a-independent`。

#### 工程约束

双库、分层、根与前端独立锁文件的核对通过。本轮源码仍有两个工程红线问题。MCP 日常连通性检查可以把 SDK 远端错误带到视图②和治理审计，模型流式错误也仍提取可由远端正文提供的字符串。GitHub 写入的异常归约将传输结果不明合并到普通失败，破坏唯一提交链的对账语义。见下表 S2-P0-1 和 S2-P0-4。

#### 任务书与红线

| 红线 | 裁定 | 独立发现与定向整改 |
| --- | --- | --- |
| S2-P0-1 | **SMTP 已关闭。GitHub 写入新增阻塞** | 正式阶段二硬门、纯文本字段收口、两次 CAS 和合规改稿送达均复核通过。`81ec02a` 的 `callWriteTool()` 新捕获 SDK 传输异常并返回普通失败。写请求超时或失去连接时，提交器于是落 `FAILED`，原有 `UNKNOWN` 与人工核对分支被越过。保留已证明失败与结果不明两种语义，错误内容使用宿主状态码。复验远端已记账而回执丢失时，持久状态为 `UNKNOWN`，界面显示待核对，独立写入计数保持 1。[桥接捕获](../../../src/runtime/mcp-bridge.ts#L575) · [终态分支](../../../src/runtime/submitter.ts#L566) |
| S2-P0-2 | **未关闭** | 正式配置把环回代理声明为真实模型时能拒绝合成价。阶段二只配置环回地址、缺少 `modelProfile` 时仍默认套用 `fake-local`，替身价须由测试档显式启用。唯一契约绑定 `deepseek-chat`，该官方别名已于 2026-07-24 退役，当前官方模型无法通过启动校验。所谓已验上界仍使用无来源的固定帧余量，价表还接受低于实际计费费率的数值，包括全零。为一个当前可用的真实端点和模型建立可核查的输入与输出计费上限及价格版本。预留用的费率须覆盖适用峰时和缓存费率。若依赖非思考模式，核对最终 HTTP 请求显式设定该模式。价表、端点或计费边界无法确认时，物理发送增量须为 0。[启动默认档](../../../src/index.ts#L246) · [唯一模型契约](../../../src/governance/credentials.ts#L156) · [价表校验](../../../src/governance/credentials.ts#L303) · [T6 上界](../../../src/runtime/models.ts#L276) · [DeepSeek 退役公告](https://api-docs.deepseek.com/news/news260424/) · [当前官方模型和价格](https://api-docs.deepseek.com/quick_start/pricing/) · [思考模式协议](https://api-docs.deepseek.com/guides/thinking_mode/) |
| S2-P0-3 | **§11.3 残留已关闭** | 已隔离工具再次漂移会刷新库内定义与观察指纹，旧指纹和缺席核准均返回 `409`。桥接读写和 T4 再核对在场状态与实时指纹。独立替身用例通过，阻断期间物理工具调用增量为 0。[观察定义更新](../../../src/governance/mcp-pin.ts#L314) · [核准事务](../../../src/governance/mcp-pin.ts#L619) · [调用前校验](../../../src/runtime/mcp-bridge.ts#L560) |
| S2-P0-4 | **未关闭** | SMTP 队列号、模型 HTTP 非 2xx 错误和 MCP 普通调用错误的本轮夹具均通过。正常使用中的视图②「测试连通性」仍可把 MCP 清单核对的原始 SDK 错误返回给浏览器，失败的手动核对也会把原始文本保存为暂停原因并带入后续拒绝审计。模型 HTTP 200 流内错误仍可通过字符串提取留下未经信任的字母数字片段。将该类错误按 HTTP 状态或宿主枚举归约到同一错误边界，只保存和显示受控值。复验正常的连通性失败、流式错误、例程结果及持久审计输出。[MCP 核对与连通性](../../../src/runtime/mcp-bridge.ts#L399) · [MCP 拒绝审计](../../../src/runtime/mcp-bridge.ts#L460) · [Web 返回](../../../src/web/server.ts#L1362) · [模型错误归约](../../../src/runtime/models.ts#L164) |
| S2-P0-5 | **未关闭** | 视图①和③的效果回执、核对证据及单次例程撤权用例通过。例程汇总按异步完成顺序覆盖，读取却按计划时刻选最新触发来做授权。较早的运行晚完成时，汇总可能属于已撤权的旧会话，授权却采用仍有权限的新会话。汇总须和产出它的准确触发对应，来源无法确定时收起文本。复验两个运行以相反顺序完成、旧运行来源已撤权时的例程投影。[触发排序](../../../src/capabilities/timers/routines.ts#L471) · [完成回写](../../../src/capabilities/timers/routines.ts#L923) · [汇总投影](../../../src/web/server.ts#L1670) |

#### 下次提审与真实签收

后续只复核表内未关闭项及其受影响的回归。GitHub 结果不明为本轮新增回归。真实模型上界和连接器错误输出延续上一轮红线，MCP 连通性错误是本轮定位到的既有路径。例程摘要的来源绑定缺口出现在本轮补上的读取授权中。SMTP 与 C4 已通过的条目保留关闭状态。

预算整改可先支持一个当前官方模型。若采用供应商公布的上下文限制作为保守输入上界，配合请求中明确传送的输出限额与可信最高适用费率，即可复用现有预算账本，省去额外的 tokenizer 和帧估算。复验须包含能获准发送的常用任务与预算耗尽后物理发送增量为 0 的任务。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

真实 DeepSeek 流式与账本核对、真实 Gmail 只读及单封测试发信、真实 GitHub MCP 只读及测试仓单次写仍待授权和脱敏证据。实体手机 HTTPS 档继续按需启用，桌面 Edge 窄屏验收已通过。

---

### 11.6 第 4 轮定向整改回执与提审（实施方 · 2026-11-27）

本轮针对 `§11.5` 裁定的 4 项未关闭红线（`S2-P0-1` GitHub 写入结果不明、`S2-P0-2` 真实模型预算契约与显式测试档、`S2-P0-4` 连接器连通性/清单核对错误与 HTTP 200 流内错误归约、`S2-P0-5` 例程汇总精确来源触发绑定）完成定向闭环，并在 `3ca9074` 中进一步收敛 [models.ts](../../../src/runtime/models.ts) 为直接复用 `@earendil-works/pi-ai/providers/all` 内置 Provider 目录与协议（消除手写 DeepSeek 方言字段）。全部代码与自测变更冻结于提交 **`3ca9074869a98894765bda54670e7b5ebae7c600`**（`3ca9074`，在 `a879b97` 基础上对 `src/runtime/models.ts` 做了 1 文件收口，总计修改 12 个源码与测试文件）；相对 `5748c6c` 全部冻结底座路径与两份锁文件保持 **0 字节差异**，候选 `git diff --check` 零告警；本回执与 `evidence/round4/` 脱敏证据单独成提交，确保冻结候选与代码树零漂移。

#### 四项未关闭红线逐项闭合对照表

| 红线 | §11.5 未关闭缺口 | 冻结候选 `3ca9074` 整改与最小证明 |
| --- | --- | --- |
| **S2-P0-1** | `callWriteTool()` 捕获 SDK 传输异常并返回普通失败，导致写请求超时/断连落 `FAILED` 越过 `UNKNOWN` 与人工核对 | 1. [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) 引入 `outcome?: "failed_local" \| "failed_remote" \| "unknown"`：前置本地校验返回 `failed_local`；远端显式 `isError` 或 JSON-RPC 前置派发错误（`-32601`/`-32602`）返回 `failed_remote`；派发后的超时（`McpTimeoutError`）、断连（`McpConnectionClosedError`）、中止（`McpAbortError`）及其他传输/内部异常一律返回 `outcome: "unknown"` 与宿主闭合状态码。<br>2. [submitter.ts](../../../src/runtime/submitter.ts) `submitApprovedGithubWriteEffect` 对 `outcome === "unknown"` 持久化 `effects.state = 'UNKNOWN'` 与受控状态码（如 `mcp_connection_closed`），严禁合并为 `FAILED` 或自动重发。<br>3. [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts) 新增 `DROP_AFTER_WRITE` 模式（远端完成写入并落盘日志后直接断连不回执），[run-p0-core.ts](../../../tests/stage2/run-p0-core.ts) 实测：`effects.state === 'UNKNOWN'`、`effects.reason === 'mcp_connection_closed'`、独立写入增量严格为 `1`、二次提交被拒（`claimed=false` 且计数维持 `1`）、视图① `/snapshot` 与视图③ `/api/approvals` 均投影 `uiStatusLabel === "结果待核对"`。 |
| **S2-P0-2** | 阶段二环回缺 `modelProfile` 仍默认套用 `fake-local`；唯一契约绑定已退役的 `deepseek-chat`；估算依赖无来源帧余量且接受全零/低于峰时费率；未校验最终 HTTP 请求显式关闭思考模式 | 1. [index.ts](../../../src/index.ts) 阶段二缺少 `modelProfile`（或声明 `provider: "fake-local"`）时默认直接拒绝启动（`stage2_model_profile_required` / `stage2_synthetic_fake_not_enabled`），仅在测试档显式启用 `--allow-synthetic-fake-model`（或 `AEGISPI_ALLOW_SYNTHETIC_FAKE_MODEL=1` / `allowSyntheticFakeModel: true`）且为环回地址时允许替身价；阶段一保持原行为兼容冻结脚本。<br>2. [credentials.ts](../../../src/governance/credentials.ts) 移除已退役的 `deepseek-chat`，注册当前官方模型契约 **`deepseek/deepseek-flash`**（`deepseek-flash-v4.1-2026-11`，依据官方 `api-docs.deepseek.com` 定价与思考模式文档及锁定 `@earendil-works/pi-ai@1.6.0` 内置目录：`publishedContextWindowTokens: 1_000_000`、`maxTokensHardCeiling: 384_000`、官方峰时/缓存未命中美元费率底线 `minInputPerMTokMu: 300_000` / `minOutputPerMTokMu: 1_200_000` / `minCacheReadPerMTokMu: 6_000`、`allowedOfficialBaseUrls: ["https://api.deepseek.com", "https://api.deepseek.com/v1"]`、`requiredWireThinkingMode: "disabled"`）。严格拒绝已退役 `deepseek-chat`、全零/非正/低于峰时底线的费率以及未核验远端端点。<br>3. [models.ts](../../../src/runtime/models.ts) 直接复用 `@earendil-works/pi-ai/providers/all` 的 `builtinProviders()` 内置 Provider 目录、模型元数据（含 `api`、`reasoning`、`thinkingLevelMap`、`compat`、`headers`）与流式实现，仅在宿主层覆盖受控 `baseUrl`、`input: ["text"]`、`contextWindow`、`maxTokens`、`cost` 与内存 `HostCredentialVault` 鉴权（严禁回落至环境变量）；采用供应商公布的上下文窗口上限（`1_000_000` tokens）作为保守输入上界，叠加显式 `max_tokens` 与峰时最高适用费率计算 T6 预留上界（例如 `max_tokens=1024` 时上界为 `301_229 mu`，稳妥落入默认任务限额 `800_000 mu`），并在 `createGuardedModelFetch` 物理发包前对最终 HTTP JSON 正文执行 `validateOutgoingWireRequestForContract` 硬校（核对 `model`、`max_tokens <= effectiveMaxTokens`、`thinking.type === "disabled"` 且无 `reasoning_effort`，不满足则物理发送为 `0` 并释放预留）。<br>4. [run-p0-core.ts](../../../tests/stage2/run-p0-core.ts) 实测：阶段二无 `modelProfile` 启动被拒（exit ≠ 0）；`deepseek-chat`/全零/非峰时价/未知远端端点全拒；`deepseek-flash` 常用任务获准发送（`upper_mu=301229`、实测结算 `actual_mu=540`、假服务抓包确认 `thinking={"type":"disabled"}` 与 `maxTokens=1024`）；任务预算不足（`200_000 < 301_229`）时物理 HTTP 发送增量严格为 **`0`**。 |
| **S2-P0-4** | 视图②「测试连通性」与失败手动核对可把 MCP 清单核对的原始 SDK 错误写入 `pauseReason`/响应/拒绝审计；模型 HTTP 200 流内错误仍经正则提取未经信任的字母数字片段 | 1. [mcp-bridge.ts](../../../src/runtime/mcp-bridge.ts) 引入 `McpHostPolicyError` 与闭合枚举归约器 `reduceMcpBridgeError`（仅输出宿主闭合状态码如 `mcp_jsonrpc_error`、`mcp_request_timeout`、`mcp_connection_closed`、`mcp_recheck_failed`、`mcp_connectivity_failed` 等），覆盖 `connect()`、`recheckToolPins()`、`testConnectivity()`、`callReadOnlyTool()` 与 `callWriteTool()` 全部路径；[server.ts](../../../src/web/server.ts) `POST /api/connectors/test` 与 [index.ts](../../../src/index.ts) `testGmailConnectivity` 同步收口至受控状态码，禁止任何原始 SDK/远端文本进入浏览器响应、`#lastPauseReason` 或 `audit_events`。<br>2. [models.ts](../../../src/runtime/models.ts) 移除对远端错误文本的正则提取，改为基于宿主侧 `createGuardedModelFetch` 权威记录的 `fetchBoundaryOutcome`（HTTP 状态码 / 宿主闭合传输错误枚举 / 出口拦截 / 线缆契约拦截 / `http_ok`）与 `stopReason` 的权威归约器 `reduceAuthoritativeModelErrorCode`：凡 HTTP 200 流内出错一律归约为固定常量 **`model_provider_stream_error`**，零字符提取自远端正文。<br>3. [fake-github-mcp-server.ts](../../../tests/fakes/fake-github-mcp-server.ts) 新增 `LIST_ERROR:<secret>` 注入、[fake-model-server.ts](../../../tests/fakes/fake-model-server.ts) 新增 HTTP 200 SSE `stream_error`（伪造 `model_transport_error:<secret>`），[run-p0-core.ts](../../../tests/stage2/run-p0-core.ts) 实测连通性失败、手动核对失败、暂停期拒绝审计与 HTTP 200 流内错误例程均只落库/投影受控代码，11 槽位全盘零泄漏扫描命中 **`0`**。 |
| **S2-P0-5** | 例程汇总按异步完成顺序覆盖，读取却按计划时刻选最新触发授权；较早旧运行晚完成时可能以新会话权限暴露已撤权旧会话汇总；缺来源时未收起 | 1. [db.ts](../../../src/governance/db.ts) 在 `routines` 建表与幂等 **Migration 9** 中新增 `last_result_trigger_id TEXT`。<br>2. [routines.ts](../../../src/capabilities/timers/routines.ts) 全部三处写入 `routines.last_result_summary` 的事务（触发登记/跳过、受理结果、完成回写）同步写入精确产出该汇总的 `last_result_trigger_id`。<br>3. [server.ts](../../../src/web/server.ts) `GET /api/routines` 严格按 `routines.last_result_trigger_id` 精确查回产出触发（含超出最近 10 条时的直接主键回查）并对其执行实时作用域与源授权复核；凡 `last_result_trigger_id` 为空、对应触发缺失或成功汇总缺失会话来源者一律按 fail-closed 收起 `lastResultSummary`（`[redacted_after_source_revocation]`，`resultRedacted: true`）。<br>4. [run-p0-core.ts](../../../tests/stage2/run-p0-core.ts) 实测两次运行以相反顺序完成（较新的已授权运行先完成，较早的已撤权源运行后完成覆盖汇总）及 `last_result_trigger_id = NULL` 遗留记录，视图②均准确收起汇总并零暴露敏感文本。 |

#### 第 4 轮自测实跑结果（冻结候选 `3ca9074869a98894765bda54670e7b5ebae7c600`）

以下全部在冻结候选 **`3ca9074869a98894765bda54670e7b5ebae7c600`** 上直接实跑，Windows x64、Node `v22.23.5`（SQLite `3.54.1`）、npm `10.9.9`：

| 套件 | 命令 | 退出码 | 实测结果与脱敏证据 |
| --- | --- | :---: | --- |
| 独立前端构建 | `npm --prefix web run build` | `0` | PASS（`web/` 未改，`tsc --noEmit && vite build` 复用 `web/dist`，阶段二总套件同步复检 `typecheckWeb`） |
| 阶段二总套件 | `node tests/stage2/run-all.ts --evidence-dir docs/v2/stage2-audit/evidence/round4` | `0` | PASS（`stage2_6279a6c3`，`commitSha=3ca9074869a98894765bda54670e7b5ebae7c600`；根/前端锁文件哈希一致、前后端 `tsc`、分层零违规；`p0Core=s2_p0_29192196`，`round4_p0_closure` 12 项全过，`totalForbiddenHits=0` 覆盖 11 槽位；`browserDesktopAndNarrow=s2_browser_073a7d47`，Edge `1280x800` & `390x844` 2 次递进渲染、首 token `293 ms`、假 SMTP=`1`）[round4/stage2-summary.json](./evidence/round4/stage2-summary.json) · [round4/stage2-p0-core-evidence.json](./evidence/round4/stage2-p0-core-evidence.json) · [round4/stage2-browser-e2e-evidence.json](./evidence/round4/stage2-browser-e2e-evidence.json) |
| 阶段一第 1 周全量回归 | `node tests/week1/run-all.ts` | `0` | PASS（`week1_a550deb0`；`typecheck`、`S1-S5`、`W1-A` 9/9、`W1-B` 假 SMTP=1/`UNKNOWN`/`结果待核对`、`matrix` 25/25 全通过） |
| 阶段一第 2 周全量回归 | `node tests/week2/run-all.ts` | `0` | PASS（`week2_297da078`，`commitSha=3ca9074869a98894765bda54670e7b5ebae7c600`；`v04_v05=v04v05_0dd40e95`、`v02=v02_c7920d01`、`v03` Docker=`v03_b6b027fe`、`s6=s6_8facf0c4` 命中 `0`、Edge `v01_v05_v06=v01v06_fdc9bc00` 全通过） |

#### 真实服务实测口径

- 真实 DeepSeek（`deepseek-flash`）流式与账本核对、真实 Gmail 只读与单封测试发信、真实 GitHub MCP 只读与测试仓单次写、可选实体手机 HTTPS 仍保持默认关闭并标记**待验证**，待本轮安全红线独立复审签收且取得用户逐项独立授权后实测登记。

#### 第 4 轮审计人一键复跑命令（PowerShell · 含 Windows 锁文件原始字节保真）

```powershell
$sha = '3ca9074869a98894765bda54670e7b5ebae7c600'
git diff 5748c6c $sha -- src/governance/approvals.ts src/governance/effects.ts src/governance/budget.ts src/capabilities/workspace/importer.ts package.json package-lock.json tests/week1 tests/week2
git diff --check 5748c6c..$sha

# 在独立工作树按 Git 对象原始字节保真两份锁文件
$tmp = Join-Path $env:TEMP "aegispi-stage2-r4-$($sha.Substring(0,7))"
git worktree add --detach $tmp $sha
git -C $tmp show "${sha}:package-lock.json" | Set-Content -Path (Join-Path $tmp 'package-lock.json') -AsByteStream -NoNewline
git -C $tmp show "${sha}:web/package-lock.json" | Set-Content -Path (Join-Path $tmp 'web/package-lock.json') -AsByteStream -NoNewline
Set-Location $tmp
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
& 'D:\AegisPi\tools\node-v22.23.5\npm.cmd' --prefix web run build
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/stage2/run-all.ts --evidence-dir "$tmp\evidence-stage2"
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/week1/run-all.ts
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' tests/week2/run-all.ts
```

### 11.7 第 4 轮独立复审裁定（Codex · 2026-11-27）

冻结候选 `3ca9074869a98894765bda54670e7b5ebae7c600` **退回两项定向整改，阶段二暂不签收**。Pi 内置 DeepSeek 模型复用已核实。S2-P0-4 的错误输出和 S2-P0-5 的撤权摘要已通过定向复审。S2-P0-1 仍有 GitHub 上游写入结果不明的分支，S2-P0-2 仍有真实模型目的端准入缺口。

#### 独立复跑

| 核对项 | 结果 | 独立证据 |
| --- | --- | --- |
| 冻结候选与底座 | PASS | `7f8eba7` 相对候选只有报告与证据。冻结的 `approvals.ts`、`effects.ts`、`budget.ts`、`importer.ts`、根依赖及阶段一测试相对 `5748c6c` 无差异。按 Git 对象恢复两份锁文件的原始字节，再按 SHA-256 核对 §2.1，候选 `git diff --check` 通过。 |
| 前端与阶段二 | PASS | `npm --prefix web run build` 和 `node tests/stage2/run-all.ts --keep-data --evidence-dir <阶段二证据目录>` 均退出 `0`。总套件 `stage2_758a922e`，核心 `s2_p0_8f638cb9`，Edge 桌面与窄屏 `s2_browser_a5874f01`。两次递进渲染，首 token `242 ms`，合规改稿的独立假 SMTP 收件 `1`。核心验证 GitHub 写入独立计数 `1` 并落 `UNKNOWN`、预算预留 `301229 mu`、预算不足物理请求增量 `0`、11 个槽位扫描命中 `0`。 |
| 阶段一第 1 周 | PASS | `node tests/week1/run-all.ts --keep-data --evidence-dir <第1周证据目录>` 退出 `0`，`week1_6331c1dd`。矩阵 25/25，W1-B 独立假 SMTP 收件 `1`，保持 `UNKNOWN` 并显示待核对。 |
| 阶段一第 2 周 | PASS | `node tests/week2/run-all.ts --keep-data --evidence-dir <第2周证据目录>` 退出 `0`，`week2_2e309c00`。V01–V06 全通过，含 V03 Docker `v03_58ba0483`、Edge `v01v06_e0bd7eb7` 和 S6 `s6_76f8d2d0`，S6 命中 `0`。 |

使用 Windows x64、Node `22.23.5`（SQLite `3.54.1`）、npm `10.9.9`、Docker `29.9.2` 和独立工作树。依赖目录复用首轮的离线 `npm ci` 安装，复用前按字节核对两份锁文件。脱敏运行日志和通过证据保存在本机 `D:/AegisPi/aegis-pi-v2-planning/audit-reruns/stage2-r4-3ca9074-independent`。本轮运行使用本机替身与合成凭据。

#### 工程约束

根锁文件、分层、冻结模块与阶段一断言通过核对。`models.ts` 从锁定 `pi-ai@1.6.0` 的内置 Provider 取得模型定义并委托 SDK 流式接口，宿主覆盖派发配置和预算参数，凭据由 `HostCredentialVault` 供给。官方 MCP 工具级错误的提交语义仍违反「结果不明记 `UNKNOWN`」，见 S2-P0-1。例程启动对账另外两处仅更新受理状态摘要，漏更新触发 ID。该路径可能把受理状态错误归属或显示为已隐藏，记为回归备忘。[SDK 复用](../../../src/runtime/models.ts#L536) · [启动对账](../../../src/capabilities/timers/routines.ts#L659)

#### 任务书与红线

| 红线 | 裁定 | 独立发现与定向整改 |
| --- | --- | --- |
| S2-P0-1 | **部分关闭** | MCP 子进程在写入后断连的回归通过，持久结果为 `UNKNOWN`，两处 Web 投影显示待核对，再次领取被拒且写入计数为 `1`。但写工具对一切 MCP `isError` 仍记 `FAILED`。GitHub 官方 MCP 在调用上游写入 API 后也会把 HTTP 调用错误装成 `isError`，该标志不足以确认仓库未发生写入。对已派发且无确证的工具错误保留 `UNKNOWN`，仅将有证据的未执行或确证失败记 `FAILED`。复验 MCP 子进程仍在线、上游写入结果不明时的账本和展示。[桥接分类](../../../src/runtime/mcp-bridge.ts#L648) · [终态记录](../../../src/runtime/submitter.ts#L589) · [官方写入实现](https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/github/repositories.go#L610) · [官方错误映射](https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/errors/error.go#L147) · [工具错误标志](https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/utils/result.go#L24) |
| S2-P0-2 | **部分关闭** | 显式替身档、现行 `deepseek-flash`、SDK 协议、官方上下文上界、最低峰时费率和最终请求的 `max_tokens` / 思考模式均核对通过。正式入口仍会为填写了真实 `modelProfile`、但 `baseUrl` 缺失或为空的配置使用默认环回地址。契约校验跳过环回地址的官方目的端匹配，随后凭据按该地址注册。此时 DeepSeek 计费契约与实际目的端缺少绑定，替身所用的环回凭据注入路径也未与正式档隔离。正式真实档须显式指定可核验的 HTTPS 目的端，缺失或无法证明时拒绝发送。真实协议的替身测试可经测试注入保留。复验真实档缺 URL 或目的端未获准时物理发送增量为 `0`。[默认地址](../../../src/index.ts#L68) · [正式配置选址](../../../src/index.ts#L212) · [环回例外](../../../src/governance/credentials.ts#L321) · [凭据绑定](../../../src/index.ts#L333) |
| S2-P0-3 | **保持关闭** | 本轮无变更放宽二进制、清单指纹或领取准入。已隔离再次漂移、工具缺席与受控写的阶段二回归通过。 |
| S2-P0-4 | **已关闭** | 连通性测试、手动清单复核、暂停期拒绝审计和模型 HTTP 200 流内错误均归约为宿主受控值。独立核心套件的对应夹具及 11 槽位扫描通过。[MCP 状态归约](../../../src/runtime/mcp-bridge.ts#L72) · [模型传输边界](../../../src/runtime/models.ts#L404) |
| S2-P0-5 | **已关闭** | 异步完成写入实际产出摘要的触发 ID，读取复核该触发的来源权限。两个触发倒序完成与遗留摘要缺来源的独立夹具均收起受限摘要。[完成写入](../../../src/capabilities/timers/routines.ts#L938) · [实时授权投影](../../../src/web/server.ts#L1693) |

#### 真实签收待验证项

真实 DeepSeek 流式及账本核对、Gmail 只读及单封测试发信、GitHub MCP 只读及测试仓单次写仍待独立授权和实测。DeepSeek 的预留用峰时价能覆盖保守上界，现有结算也把同一峰时价写成 `SETTLED.actual_mu`。官方谷时价为峰时的一半，因此真实联调还须核对提供方实际扣费与账本，或明确显示宿主按峰时价估算的金额。桌面窄屏已通过，实体手机 HTTPS 按需另验。[结算计算](../../../src/runtime/models.ts#L373) · [结算展示](../../../src/web/server.ts#L2202) · [DeepSeek 峰谷时价](https://api-docs.deepseek.com/quick_start/pricing/)

### 11.8 第 5 轮整改与验收（Codex · 2026-11-27）

**阶段二通过验收。** Codex 在候选 `a10500daca6b92cfa20786283432f91bf5fe320f` 修复 §11.7 的两项 P0，并复跑阶段二与阶段一两周全套。五类 P0 均已关闭。

| 红线 | 结果 | 整改与证据 |
| --- | --- | --- |
| S2-P0-1 外发 CAS 与结果核对 | **关闭** | GitHub MCP 写工具派发后若只收到 `isError`，持久化为 `UNKNOWN`。宿主以固定码 `mcp_remote_write_unconfirmed` 记录待核对原因。替身在落盘写入后分别断开 IPC 和保持进程在线返回 `isError`，每例均只有一次派发与一次实际应用。再次领取被拒，视图①和③均显示「结果待核对」。正常 Tier 0 写入与邮件改稿后提交各实测一次。两次 CAS 和唯一提交器仍走原路径。[写入分类](../../../src/runtime/mcp-bridge.ts#L645) · [核心证据](./evidence/round5/stage2-p0-core-evidence.json) |
| S2-P0-2 预算与目的端 | **关闭** | 真实档须显式填写 `modelProfile.baseUrl`，目的端须同时匹配宿主白名单和已核实计费契约中的官方 HTTPS URL。正式入口在登记凭据与打开双库前拒绝缺失、空白、显式环回及非官方地址。四项均退出 `1`，独立假模型 HTTP 请求增量为 `0`。测试通过宿主已有 `fetchImpl` 将官方逻辑目的端接到替身，验证 pi-ai 流式协议、`max_tokens=1024`、关闭思考模式和 `301229 mu` 预留。预算不足的物理请求增量为 `0`。[启动准入](../../../src/index.ts#L207) · [契约校验](../../../src/governance/credentials.ts#L321) · [核心证据](./evidence/round5/stage2-p0-core-evidence.json) |
| S2-P0-3 MCP Pin 与执行 | **保持关闭** | 二进制篡改、重连清单漂移、撤权及旧指纹领取回归通过，禁止操作的假 MCP 调用增量为 `0`。 |
| S2-P0-4 凭据 | **保持关闭** | 阶段二核心对 11 个合成凭据槽位和错误输出做扫描，禁止位置命中为 `0`。 |
| S2-P0-5 阶段一与撤权回归 | **保持关闭** | 阶段二例程摘要倒序完成、旧摘要缺来源及撤权投影复验通过。 |

#### 复跑证据

运行环境为 Windows x64、Node `22.23.5`、SQLite `3.54.1`、npm `10.9.9`、Docker `29.9.2`、Edge `157.0.4341.60`。两份锁文件的 SHA-256 匹配 §2.1，`git diff --check 5748c6c..a10500d` 通过。相对阶段一起点 `5748c6c`，§1.3 所列冻结路径无差异。`harness.ts`、Web 代码和两份锁文件相对 §11.7 候选无差异。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `npm --prefix web run build` | `0` | 前端类型检查及 Vite 构建通过。 |
| `node tests/stage2/run-all.ts --keep-data --data-dir <stage2/data> --evidence-dir <stage2>` | `0` | `stage2_6e6b26af`，核心 `s2_p0_313c3483`，Edge `s2_browser_703d111d`。前后端类型检查、分层及四视图桌面和窄屏均通过。替身流式 2 次递进渲染、首 token `198 ms`，改稿与独立假 SMTP 收件一致，收件数 `1`。[汇总](./evidence/round5/stage2-summary.json) · [浏览器证据](./evidence/round5/stage2-browser-e2e-evidence.json) |
| `node tests/week1/run-all.ts --keep-data --data-dir <week1/data> --evidence-dir <week1>` | `0` | `week1_2fabd8e6`，矩阵 `25/25`。W1-B 独立假 SMTP 收件 `1`，宿主持久化 `UNKNOWN` 并显示「结果待核对」。[阶段一回归汇总](./evidence/round5/stage1-regression-summary.json) |
| `node tests/week2/run-all.ts --keep-data --data-dir <week2/data> --evidence-dir <week2>` | `0` | `week2_e1bc26f5`，V01–V06 全通过，含 V03 Docker `v03_6c19004c`、Edge `v01v06_ed25533d`、S6 `s6_5f70d0bf`。S6 禁止位置命中 `0`，V02 撤权后独立模型发送增量 `0`。[阶段一回归汇总](./evidence/round5/stage1-regression-summary.json) |

完整本机输出位于规划目录 `audit-reruns/stage2-r5-a10500d/`，仓库归档上述脱敏证据。

按本轮验收口径，真实 DeepSeek 流式与扣费核对、Gmail 只读及一封测试邮件、GitHub MCP 只读及测试仓单次写均为后续待验证项。DeepSeek 账本目前按配置费率结算用量，真实联调时核对谷时扣费差额。实体手机 HTTPS 按需验证。§11.7 的例程启动对账状态归属备忘仍保留。
