# Phase 5 第 2 批双提交第二轮独立对抗审计报告（`1d019fc` + `e754899`）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **审计对象**：本地未推送双提交（`origin/main` = `86f5cd27fa567f9c65889289280ccd50414657fb`，`main` ahead 2）：
> - 提交 1 `1d019fc`：第 2 批实现（单元 5.3 + 5.4 含 L3 Dreaming + 5.5，D-97）
> - 提交 2 `e754899`：第 2 批独立审计层（D-98，VERDICT: HOLD）
> **锁定 Node**：`D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`）
> **决策留痕**：`D-99`

---

## VERDICT：**HOLD**（维持 D-98 裁定，不放行单元 5.6，暂不推送）

D-98 的全部 8 项实质发现（F-1 P0 + F-2/F-3/F-5/F-6 P1 + F-7/F-8/F-9 P2；F-4 为跳号留白）经第二轮独立复跑与源码/探针重放**全部成立，零推翻**。同时本轮新发现 **1 项 P2（F-10：`dreaming.mjs` 过期建议幻影重提案噪音）** 与 **1 项 P3（F-11：`console/ui.mjs` 审批表重复渲染 `a.id` 未渲染 `a.action_hash`）**。

---

## 一、红线复核（7+2 条）

| # | 红线 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 版本锁定 | **部分违反（F-1）** | 锁定 Node `v22.23.5`；`@earendil-works/pi-coding-agent` exact `1.5.2`、`hono` exact `4.13.19`；`package-lock.json` 与 `apps/*/package.json` 零改动；`package.json` 仅新增 `eval:scenarios`。但 `probe-evidence-holds.mjs` rc=1（evidence `4f5312e4...` ≠ this tree `883ecf39...`） |
| 2 | 许可 1 边界 | **通过** | `.env` 未被读取；`evals/phase5/scenarios-real/` 不存在；`git rev-list --left-right --count origin/main...HEAD` = `0 2`（未推送） |
| 3 | `defaults.json` | **通过** | `git diff 86f5cd2..1d019fc -- apps/daemon/config/defaults.json` 为纯增量 `mail`/`calendar` 两节，新键全 fail-closed；`report:user-value` `defaultsFailClosed=true` |
| 4 | 门禁文件零触碰 | **通过** | `schema-source.json`、`recall.mjs`、5 个 `*-real` 守卫在 `86f5cd2..1d019fc` diff 全空 |
| 5 | CP4 | **通过（含新反例）** | 除重放 D-98 外，自写新反例 `CP4-NEW-1`（2-hop 传递闭包 `scopeA->scopeB` `mail.send` 提案被拒）与 `CP4-NEW-2a/2b`（`calendar.write` 跨 scope 提案/派发双层拦截）全过 |
| 6 | 无授权外发 | **核心通过 + F-5** | AT_MOST_ONCE UNKNOWN 拒自动重发、拒绝零借道；边界缺陷 F-5（SMTP DATA 354 后断流分类 `local`）复现 |
| 7 | Web 门禁 | **通过** | `ui.mjs` 零 `innerHTML`/`eval`/`document.write`（唯一 `innerHTML` 字样在注释行 3） |
| 8 | 审计提交纯洁性 | **通过** | `git diff --stat 1d019fc..e754899 -- apps/ docker/ evals/ tools/ package.json package-lock.json` 为空；`decision-trail.tsv` 仅修复 D-96/D-97 粘连行界（109→111 行）并追加 D-98，内容零丢失 |
| 9 | 证据口径 | **复核成立** | `probe-evidence-holds.mjs` rc=1；6 套 Docker 套件在 HEAD 全部 rc=2 被拒绝 |

---

## 二、三方复跑对照（D-97 vs D-98 vs 本轮第二轮）

### 2.1 本地 14 项套件 + 5 个 real 入口（全部一致）

| 套件 | D-97 | D-98 | 第二轮复跑 | 日志 |
| --- | --- | --- | --- | --- |
| `eval:scenarios` | 78/78 | 78/78 | **78 pass, 0 fail, rc=0** | `.audit/second-audit/logs/scenarios.log` |
| `test:security:unit` | 63/63 | 63/63 | **63 pass, 0 fail, rc=0** | `.audit/second-audit/logs/security-unit.log` |
| `test:cancel-approval` | 20/20 | 20/20 | **20 pass, 0 fail, rc=0** | `.audit/second-audit/logs/cancel-approval.log` |
| `test:memory-lifecycle` | 47/47 | 47/47 | **47 pass, 0 fail, rc=0** | `.audit/second-audit/logs/memory-lifecycle.log` |
| `test:cross-channel` | 23/23 | 23/23 | **23 pass, 0 fail, rc=0** | `.audit/second-audit/logs/cross-channel.log` |
| `test:durability` | 164/164 | 164/164 | **164 pass, 0 fail, rc=0** | `.audit/second-audit/logs/durability.log` |
| `test:acl` | 15/15 | 15/15 | **15 pass, 0 fail, rc=0** | `.audit/second-audit/logs/acl.log` |
| `test:budget` | 20/20 | 20/20 | **20 pass, 0 fail, rc=0** | `.audit/second-audit/logs/budget.log` |
| `test:restore` | 11/11 | 11/11 | **11 pass, 0 fail, rc=0** | `.audit/second-audit/logs/restore.log` |
| `test:ingress-telegram` | 7/7 | 7/7 | **7 pass, 0 fail, rc=0** | `.audit/second-audit/logs/ingress-telegram.log` |
| `test:contracts` | exit 0 | exit 0 | **15 probes PASS, rc=0** | `.audit/second-audit/logs/contracts.log` |
| `verify-hono-oracle-pair` | exit 0 | exit 0 | **rc=0** | `.audit/second-audit/logs/hono-pair.log` |
| `report:user-value` | 149/149 | 149/149 | **149/149, defaultsFailClosed=true, rc=0** | `.audit/second-audit/logs/user-value.log` |
| 5 个 `*-real` 入口 | exit 4 | exit 4 | **全部 rc=4** | `.audit/second-audit/logs/real-*.log` |

### 2.2 Docker 6 套件 + `probe-evidence-holds`

| 检查 | 第二轮复跑 | 日志 |
| --- | --- | --- |
| `probe-evidence-holds.mjs` | **rc=1**（`evidence 4f5312e4... ≠ this tree 883ecf39...`） | `.audit/second-audit/logs/probe-evidence-holds.log` |
| 6 套 Docker 套件 | **全部 rc=2**（`model-proposal` / `repo-observe` / `eval-triage` / `offline-jobs` / `security-integration` / `quota-calibration`） | `.audit/second-audit/logs/<name>.log` |

---

## 三、D-98 九项逐条再证伪与新增发现

### 3.1 D-98 九项复核（全部维持，零推翻）
- **F-1（P0）**：复现 `probe-evidence-holds.mjs` rc=1，6 Docker 套件 rc=2。
- **F-2（P1）**：复现 `replay-console-endpoints.log` → `Error: no such column: content` at `apps/daemon/src/console/api.mjs:854:20`，`POST /api/routines/:id/mode -> 500`。
- **F-3（P1）**：`rg -n "ingestInboundMail|processFiredFollowUpTimers|composeMorningBriefing|mergeQuietBriefings" apps/daemon/src/` 仅命中各自定义文件，daemon 无调用方。
- **F-5（P1）**：复现 `replay-adversarial.log` E1 段 → `kinds={"local":8}`（`upstream-mail-child.mjs:576-577`）。
- **F-6（P1）**：复现 `replay-adversarial.log` C1 段 → `timer=SATISFIED evidence=inb:cross-b`（`timers.mjs:114-120` 无 `scope_id` 过滤）。
- **F-7（P2）**：复现 `replay-briefing-childguard.log` G1/G2 → `leaked=1`（`briefing-followup.mjs:255-283`）。
- **F-8（P2）**：复现 `replay-adversarial.log` D4 段 → `skipped=null suggestionsCreated=1`（`dreaming.mjs:59-84`）。
- **F-9（P2）**：源码核实 `evals/phase5/scenarios/run.mjs:195-201` 仅扫描 4 文件 + 双引号静态 import。
- **F-4**：确认 D-98 跳号留白，非发现。
- 另：`probe-parked-restart.mjs` 实测 **8/8 PASS**（真进程 kill -9 重启后 PARKED/nonce/恰 1 封邮件均成立）。

### 3.2 第二轮新发现
- **F-10（P2）：`dreaming.mjs` 对已过期/已删除的 `dreaming_suggestion` 反复产出幻影重提案审计与流事件**
  - **机制**：`apps/daemon/src/dreaming.mjs:152-154` 仅按 `status IN ('candidate','active')` 查重；当该建议变为 `expired` 或 `deleted` 后查重未命中，随后调用 `insertObjectRow` 因内容寻址命中 `alreadyPresent: true`（不新建行也不复活），但 `:173-187` 仍无条件写 `memory_dreaming_merge_proposed` 审计、`memory_changed` 流事件并推入 `out.mergeSuggestions`。
  - **复现**：`D:\AegisPi\tools\node-v22.23.5\node.exe .audit/second-audit/probes/probe-second-audit.mjs`（`BLIND-2`：`r1=1 r2=1 audits=2`，日志 `.audit/second-audit/logs/second-audit-probe.log`）。
- **F-11（P3）：`console/ui.mjs` 审批列表重复渲染 `a.id` 未渲染 `a.action_hash` 且 `detail` 节点未挂载**
  - **机制**：`apps/daemon/src/console/ui.mjs:313` 表头第 4 列为 `action_hash`，`:355` 却渲染 `el("td", { text: a.id })`；`:316-318` 创建的 `detail` 未加入行 DOM。
  - **复现**：同上 `BLIND-3b`（`duplicate_a_id_count=2`）。

---

## 四、本轮探针自伤诚实记录

第二轮自写探针 `probe-second-audit.mjs` 开发中出现三次自伤（均已修正并如实记录，未修改任何产品代码）：
1. 构造 `effects` 测试行时 `retry_mode` 误写为 `'IDEMPOTENT'`（应为 `'IDEMPOTENCY_KEY'`）触发 SQLite CHECK 约束错误。
2. 调用 `proposeMemoryFact` 漏传 `stateDir` 参数与 `parentObjectIds` 键名（误写为 `sourceObjectIds`）。
3. `BLIND-1` 初始在同进程内用 `http.createServer` + `spawnSync` 导致事件循环阻塞超时 5000ms，且单字符用户名 `"u"` 触发 child `scrub` 过度脱敏；改用异步 `spawn` + `"caluser"` 后 `BLIND-1` 正常跑通并验证通过。

---

## 五、对六项待敲定事项的独立意见

1. **HOLD 维持或推翻**：维持 **HOLD**（与 D-98 在 P0/P1 上零分歧，新增 F-10 P2 + F-11 P3）。
2. **F-3 范围裁定**：建议**全部接进 `daemon.mjs` tick**（`ingestInboundMail` 必接；`processFiredFollowUpTimers` / `composeMorningBriefing` / `mergeQuietBriefings` 已有完整实现且在 `phase5-kickoff-plan.md` §三 5.4 明确列为交付项，不宜以 ADR 退回）。
3. **推送时机**：建议**待 R1–R5（及 F-7/F-8/F-10）返工通过复核后一并 `git push`**，当前 HOLD 树不推送。
4. **F-9 归属**：建议**随本轮返工一并修完**（改动极小）。
5. **P3 处置**：登记在册，其中 F-11（`ui.mjs:355`）与 P3-7（无 Message-ID 容错，随 F-3 接线）建议顺手修复。
6. **5.6 放行条件**：维持 `HANDOFF-BATCH2-AUDIT.md` §三 四条不变，在 R6 补入 F-10。
