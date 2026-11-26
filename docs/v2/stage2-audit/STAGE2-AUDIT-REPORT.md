# AegisPi v2 任务书 2 阶段二（第 3–4 周）交付审计报告

- **文档版本**：Stage 2 审计交接第 1 轮提审（2026-11-26，香港时间）
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

> **审计传递与交流说明**：本文件是阶段二实施方与独立审计人（GPT / Codex）的唯一主交接与交流文档。独立安全审计最多两轮，按五类 P0 判定，P1/P2 记入备忘；产品签收另核对四视图日常流程及任务书规定的真实联调必测项。请审计人在 **§10** 直接追加第 1 轮独立复跑核对表、五类 P0 裁定、P1/P2 备忘与整改编号（建议采用 `S2-P0-1`、`S2-P1-1` 等稳定编号）。若需整改，实施方将在 **§11** 逐项回复新冻结候选 SHA、代码落点与复跑证据，并由审计人在 **§11.3** 完成第 2 轮最终签收。

---

## 1. 基线、提交记录与变更清单

### 1.1 分支与提交链（均保留于本地 `v2`，未推送远端）

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

## 3. 审计人独立复跑命令（PowerShell）

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

## 8. 替身结果、真实联调必测项（待验证）与手机档分列

| 验收类别 | 项目 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| 本地替身 | 五类 P0 红线、TLS/CONNECT SMTP、C4 MCP Pin、Tier 0/2 写入、Skills、30 秒幂等例程、Hono 解耦、阶段一回归 | **PASS** | 候选 `5bb326c` 实测通过，见 §4 与 §6 |
| 本地替身 · 实机浏览器 | 正式入口 `--stage 2` 四视图桌面（1280x800）与窄屏（390x844） | **PASS** | 实机 `msedge.exe` CDP 实测通过，见 §4 与 §6 |
| 真实模型与计费（必测） | 真实 DeepSeek 逐 token 流式、首 token 延迟与账本结算 | **待验证** | 缺少用户针对真实 DeepSeek 计费与数据出站的显式独立授权，默认关闭 |
| 真实只读连接器（必测） | 真实 Gmail 只读与真实 GitHub MCP 只读 | **待验证** | 缺少用户针对真实账号与仓库范围的显式独立授权，且本机未提供 `github-mcp-server.exe` |
| 单独授权的真实外写（必测） | 真实 Gmail 单封测试发信与选定测试仓单次写 | **待验证** | 缺少用户针对获准测试邮箱与测试仓的显式独立授权，默认关闭 |
| 可选手机 HTTPS 档 | 协议安全契约（本机） / 实体手机接入 | 协议 **PASS** / 实体手机 **待验证** | 本机已实测非 HTTPS 拒启、`__Host-` Cookie 属性、跨 Origin `403` 与注销失效；实体手机按需独立验收 |

---

## 9. 历史基线参考（与本次 v2 阶段二实测严格分离）

- **v1 历史零信任基线**（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）：自动化套件 `327/327 PASS`、自用验收 `31/31 PASS`（历史档案，不计入 v2 统计）。
- **v2 阶段一签收基线**（`8b3aad9d564dc966d62c13a1b0814170e2113a9f` -> `5748c6c`）：第 1 周 `S1-S5` + `W1-A` + `W1-B` + 25/25 矩阵与第 2 周 `S6` + `V01-V06` 独立审计签收通过。
- **v2 阶段二本次提审**（冻结候选 `5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`）：`stage2_d23bff27`（五类 P0 + 四视图桌面/窄屏浏览器）PASS，同代码树阶段一回归 `week1_c22eec66` / `week2_8e6115ae` PASS；真实 DeepSeek / Gmail / GitHub 联调项与实体手机项明确标为待验证。

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

## 11. 预留：第 1 轮整改回执与第 2 轮最终复审签收栏（封顶 2 轮）

> 如第 1 轮存在 P0 退回项，实施方将在此节逐项给出新冻结候选 SHA、最小修复、复跑命令与版本化脱敏证据，随后由审计人在 §11.3 完成第 2 轮复审与最终签收。
