# AegisPi v2 阶段二自测与提审报告（第 3–4 周）

- 目标仓库与分支：`aegis-pi` / 分支 `v2`
- 阶段二起点提交：`5748c6c151174ac655745773660b5eea8cf7698a`
- 阶段二代码候选提交：`5bb326c09878ea8d0bf1ee47bac94f7b4dd5f355`
- 阶段一签收基线：`8b3aad9d564dc966d62c13a1b0814170e2113a9f`（清理 v1 残留后至 `5748c6c`）
- 历史 v1 基线（单独列示，不与 v2 实测混写）：`3a88b6895991d328e8e27fd1072a29846e7a9adf`（tag `v1-zero-trust-baseline`，历史记录 `327/327`、`selfuse 31/31`）

## 1. 锁定环境与依赖完整性

| 项目 | 实测值 |
| --- | --- |
| 操作系统与架构 | Windows (`win32`, `x64`) |
| 锁定 Node 与内置 SQLite | `D:\AegisPi\tools\node-v22.23.5\node.exe` (`v22.23.5`) / `node:sqlite` (`3.54.1`) |
| npm | `10.9.9` |
| 锁定 Pi SDK（无 `^` / `~`） | `@earendil-works/pi-durable@1.6.0`, `@earendil-works/pi-mcp@1.6.0`, `@earendil-works/pi-ai@1.6.0` |
| 根目录 `package-lock.json` SHA-256 | `795485bdfbf93215f07ba67e2185bc513cca3f39879cebff6830b79d0cd8d291`（与 `5748c6c` 完全一致） |
| 独立前端 `web/package-lock.json` SHA-256 | `3661add865032c97d52fd73626aa3ef7404df72883cd7a5d6eceecf34b8234e3`（精确版本锁定，无 `^` / `~`） |
| 本地浏览器 | `msedge.exe`（Headless CDP，Node 22 原生 WebSocket） |

## 2. 变更摘要

- 冻结底座保持原样未改：`src/governance/approvals.ts`、`src/governance/effects.ts`、`src/governance/budget.ts`、`src/capabilities/workspace/importer.ts`、根目录 `package.json` 与 `package-lock.json`。
- 阶段二治理与能力增量：
  - `src/governance/db.ts`：向前迁移新增 `approval_rules`、`skills`、`skill_versions`、`conversation_skill_locks`、`routines`、`routine_triggers`。
  - `src/governance/credentials.ts`：保留阶段一环回硬门，新增显式阶段档（`stage: 1 | 2`）出口校验、SMTP 目标绑定凭据槽位与真实 provider 的 token 上界预留支持。
  - `src/governance/mcp-pin.ts`、`src/runtime/mcp-bridge.ts`：补齐 C4 重连/刷新先暂停执行准入、核对二进制与工具指纹、隔离新增/缺失/漂移工具、撤权即时生效以及旧指纹待领取调用复核拒绝。
  - `src/governance/rules.ts`：新增自有仓 `NorthAdb/*` Tier 0 正向清单判定（排除受保护分支、工作流、标签发布、强推与删除）、Tier 1 作用域记住规则 CRUD 及阶段二纯文本邮件校验。
  - `src/capabilities/mail/smtp-client.ts`、`src/capabilities/mail/imap-client.ts`、`src/capabilities/mail/imap-child.ts`：新增直连 TLS / STARTTLS 与 HTTP CONNECT 隧道内目标证书校验的 SMTP 发送与只读连通性探测。
  - `src/capabilities/skills/store.ts`：交付三级渐进披露与默认技能 `weekly-brief-helper`（L1 索引锁定 `skill_set_hash`，L2 按需正文，L3 人工审阅脚本 SHA-256 引用与无网沙箱执行）。
  - `src/capabilities/timers/routines.ts`：交付自然语言解析确认预览、Tier 1 规则门、30 秒宿主独立轮询器、`(routine_id, scheduled_instant_utc)` 唯一登记、停机漏期合并最近一期、暂停/恢复与重启对账。
  - `src/runtime/models.ts`、`src/runtime/submitter.ts`、`src/runtime/harness.ts`、`src/runtime/extensions/`：新增逐块流式文本增量推送与首 token 计时、受控 GitHub 写入唯一提交器（Tier 0 正向清单自动签发仍执行两次 CAS，Tier 2 走审批卡）与独立于 Hono 的例程轮询生命周期。
  - `src/web/auth.ts`、`src/web/static.ts`、`src/web/server.ts`、`src/index.ts`：托管本地构建产物 `web/dist`、提供视图②③④鉴权接口、显式 `--stage 2` 入口以及可选手机 HTTPS 档（`__Host-` + `Secure` + `HttpOnly` + `SameSite=Strict` + `Path=/`，省略 `Domain`，精确 Host/Origin 校验，配置不满足拒绝启动）。
  - `web/`：独立 Vite + React + Tailwind 四视图控制台，修复原型偏差，补齐窄屏（390x844）会话列表抽屉、轨迹检查器抽屉与完整内联审批卡交互。

## 3. 实际运行命令与退出码

### 3.1 阶段二全套自测（在冻结代码候选 `5bb326c` 上执行）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$env:PATH = 'D:\AegisPi\tools\node-v22.23.5;' + $env:PATH
& 'D:\AegisPi\tools\node-v22.23.5\npm.cmd' --prefix web run build
& $node tests/stage2/run-all.ts --data-dir "$env:TEMP\aegis-s2-cand-5bb326c0" --evidence-dir "docs\v2\stage2-audit\evidence"
```

- `web` 构建退出码：`0`（`dist/index.html` 0.48 kB、`dist/assets/*.css` 18.72 kB、`dist/assets/*.js` 246.28 kB）
- `tests/stage2/run-all.ts` 退出码：`0`（`runId = stage2_d23bff27`）
- 脱敏证据路径：
  - [stage2-summary.json](evidence/stage2-summary.json)
  - [stage2-p0-core-evidence.json](evidence/stage2-p0-core-evidence.json)
  - [stage2-browser-e2e-evidence.json](evidence/stage2-browser-e2e-evidence.json)

### 3.2 阶段一全量回归（第 1 周 + 第 2 周未改动脚本）

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$evRoot = Join-Path $env:TEMP 'aegis-stage2-s1-reg'
& $node tests/week1/run-all.ts --data-dir (Join-Path $evRoot 'w1-data') --evidence-dir (Join-Path $evRoot 'w1-ev')
& $node tests/week2/run-all.ts --data-dir (Join-Path $evRoot 'w2-data') --evidence-dir (Join-Path $evRoot 'w2-ev')
```

- `tests/week1/run-all.ts` 退出码：`0`（`runId = week1_c22eec66`，`S1-S5` PASS，`W1-A` 9/9 PASS，`W1-B` PASS 假 SMTP `totalReceived = 1` 且刷新见 `结果待核对`，25/25 矩阵 PASS）
- `tests/week2/run-all.ts` 退出码：`0`（`runId = week2_8e6115ae`，`typecheck` PASS，`layerBoundary` 0 违规，`v04_v05` PASS，`v02` PASS，`v03` 实机 Docker PASS，`s6` PASS `totalForbiddenHits = 0`，`v01_v05_v06_browser` 实机 Edge PASS）

## 4. 分项结果与独立假服务计数

| 类别 | 项目 | 状态 | 实测关键指标与假服务持久计数 |
| --- | --- | --- | --- |
| 本地替身 · 五类 P0 | P0-1 两次 CAS、改稿旧版拒批、Tier 0 自有仓直通与受保护分支拒绝 | PASS | `oldRevisionRejected409 = true`、`duplicateDecisionKeyReplayed = true`、假 SMTP 增量 `1`；Tier 0 假 GitHub MCP 写计数增量 `1`（`claimCount = 1`），受保护分支写增量 `0` |
| 本地替身 · 五类 P0 | P0-2 阶段二 token 上界预算与流式增量 | PASS | 对照假模型物理请求增量 `1`（`progressiveDeltasObserved = 3`、`firstTokenMs = 31ms`、`totalMs = 191ms`）；额度不足假模型物理请求增量 `0` |
| 本地替身 · 五类 P0 | P0-3 MCP Pin C4 重连、漂移、缺失、撤权与待领取旧指纹复核 | PASS | `pendingClaimBlockedOnDrift = mcp_tool_quarantined`、`pendingClaimBlockedOnFingerprintChangeAfterReapprove = mcp_tool_fingerprint_changed`、`revokedCallBlocked = mcp_tool_revoked`、`binaryTamperRejected = mcp_binary_sha256_mismatch`；期间假 MCP 远端调用增量 `0` |
| 本地替身 · 五类 P0 | P0-4 凭据零泄漏与 TLS SMTP（直连 + CONNECT 隧道） | PASS | 5 槽位扫描双库与假服务日志 `totalForbiddenHits = 0`；直连 TLS 与 CONNECT 隧道 TLS 均成功，错配主机名发送前拒连，假 TLS SMTP 持久收件计数 `2` |
| 本地替身 · 五类 P0 | P0-5 阶段一回归、Skills 三级披露、例程幂等与 Hono 解耦 | PASS | 阶段一第 1、2 周全过；3 期停机漏期与重复轮询及重启后 `routine_triggers` 计数恒为 `1`，暂停后增量 `0`；关闭 Hono 后后台任务照常完成 |
| 本地替身 · 浏览器四视图 | 正式入口 `src/index.ts --stage 2` 桌面（1280x800）与窄屏（390x844） | PASS | 结束前观察到 `2` 次递进 partial（`firstTokenUiMetric = 59 ms`）；未保存草稿禁批 `dirtyBlockedApprove = true`，保存批准后假 SMTP 持久收件 `1` 且与改稿正文一致；视图②连通性测试/Skills L3/例程、视图③规则撤权、视图④墓碑清理回执（`ftsCleaned=true`）与账本全过；390x844 窄屏会话抽屉、检查器抽屉与审批卡（宽度 360px <= 390px）全过 |
| 真实模型与计费 | 真实 DeepSeek 逐 token 流式与计费 | **待验证** | 本次未获用户针对真实 DeepSeek 计费与数据出站的显式独立授权，保持关闭 |
| 真实只读连接器 | 真实 Gmail 只读与真实 GitHub MCP 只读 | **待验证** | 缺少本次用户独立账号范围授权及本机 `github-mcp-server.exe`，保持关闭 |
| 单独授权的真实外写 | 真实 Gmail 单封测试发信与选定测试仓单次写 | **待验证** | 缺少用户针对目标测试邮箱与目标测试仓的显式独立授权，保持关闭 |
| 可选手机 HTTPS 档 | 协议安全契约（本机）与实体手机访问 | 协议契约 PASS / 实体手机 **待验证** | 本机已验证非法非 HTTPS 配置拒绝启动、`__Host-aegispi_session` 含 `Secure; HttpOnly; SameSite=Strict; Path=/` 且省略 `Domain`、跨 Origin 写请求返回 `403`、注销撤销会话后返回 `401`；实体手机接入按需独立验收 |
