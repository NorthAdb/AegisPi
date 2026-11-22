# Phase 5 第 2 批独立对抗审计报告（单元 5.3 + 5.4 含 L3 Dreaming + 5.5）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **审计对象**：本地提交 `1d019fc`（基线 `86f5cd2` + 1 提交，`main`，未推送，80 文件 +7716/−235）
> **审计官**：独立对抗审计（`/poteto-mode` + `/code-review` 双技能纪律，证伪优先）
> **方法**：全程锁定 Node `D:\AegisPi\tools\node-v22.23.5\node.exe` 亲手复跑；所有反例为审计官**自写**探针（不是实施者套件样例）；探针与日志落盘 `.audit/batch2-audit/`，未修改任何产品代码
> **文档性质**：审计结论，供主人裁量。对应交接与返工清单见 [HANDOFF-BATCH2-AUDIT.md](../HANDOFF-BATCH2-AUDIT.md)，决策留痕 D-98

---

## VERDICT：**HOLD**（不放行单元 5.6，暂不推送）

1 项 P0（证据完整性）+ 4 项 P1 + 3 项 P2 + 若干 P3 残留。第 1 批审计（D-95）的 6 P0/9 P1/1 P2 为标准线；本批实施质量明显优于第 1 批初版（安全边界类反例全部扛住），但**镜像证据不绑定提交树**单条即足以整批 HOLD，另有 4 项 P1 需返工。

---

## 一、独立复跑对照（锁定 Node 亲手实跑）

### 1.1 本地套件（14 项，全部一致，日志 `.audit/batch2-audit/logs/*.log|*.exit`）

| 套件 | 实施者计数 | 独立复跑 | 判定 |
| --- | --- | --- | --- |
| `eval:scenarios` | 78/78 | **78 pass, 0 fail, exit 0** | 一致 |
| `test:security:unit` | 63/63 | **63/63 exit 0** | 一致 |
| `test:cancel-approval` | 20/20 | **20/20 exit 0** | 一致 |
| `test:memory-lifecycle` | 47/47 | **47/47 exit 0** | 一致 |
| `test:cross-channel` | 23/23 | **23/23 exit 0** | 一致 |
| `test:durability` | 164/164 | **164/164 exit 0** | 一致 |
| `test:acl` | 15/15 | **15/15 exit 0** | 一致 |
| `test:budget` | 20/20 | **20/20 exit 0** | 一致 |
| `test:restore` | 11/11 | **11/11 exit 0** | 一致 |
| `test:ingress-telegram` | 7/7 | **7/7 exit 0** | 一致 |
| `test:contracts` | exit 0 | **exit 0**（15 probes） | 一致 |
| `verify-hono-oracle-pair` | exit 0 | **exit 0**（hono 4.13.19 lockfile sha e5d0c57e…） | 一致 |
| `report:user-value` | 149/149 | **149/149，defaultsFailClosed=true** | 一致 |
| 5 个 real 入口 | exit 4 | **全部 exit 4**（未设任何 AEGISPI_ALLOW_* 环境变量） | 一致 |

### 1.2 Docker 套件（6 项，**全部无法在提交树复现** → F-1）

| 套件 | 实施者计数 | 独立复跑 | 判定 |
| --- | --- | --- | --- |
| `test:model-proposal` | 15/15 | **exit 2，image-gate REFUSED** | 不可复现 |
| `test:repo-observe` | 7/7 | exit 2 同上 | 不可复现 |
| `eval:triage` | 7/7 | exit 2 同上 | 不可复现 |
| `test:offline-jobs` | 14/14 | exit 2 同上 | 不可复现 |
| `test:security:integration` | 29/29 | exit 2 同上 | 不可复现 |
| `test:quota-calibration` | 5/5 | exit 2 同上 | 不可复现 |

---

## 二、发现分级

### P0

**F-1 镜像纪元 14 证据不绑定提交树（image-gate context 漂移）；六套 Docker 隔离套件在 HEAD 全部拒绝运行。**
- 复现：`node evals/phase3/image-gate/probes/probe-evidence-holds.mjs` → **rc=1**，`the build context for agent changed after the recorded build (evidence sha256:4f5312e4…, this tree sha256:883ecf39…)`（日志 `.audit/batch2-audit/logs/gate-refusal.log`；六套件日志同拒绝，rc=2）。
- 事实：提交的 `docs/phase3/reports/image-digest.md` 记录 `agent.context=sha256:4f5312e4…`，但对 HEAD 树重算（`appImageContextHash`，覆盖 `docker/agent/Dockerfile + package.json + package-lock.json + apps/daemon/package.json + apps/daemon/{config,src} 全树 + docker/agent/src/worker.mjs`）得 `sha256:883ecf39…`。基线树重算得 `1bde74ba…`。三者互异。
- 根因考古（`.audit/batch2-audit/logs/context-drift-probe.log`，探针 `probes/probe-context-hash.mjs` + `probe-context-bisect.mjs`）：HEAD 工作树对上下文路径干净（git status 空）；对 25 个差异文件做单文件/双文件/三文件「替换回基线或移除」穷举，**均无法复原 4f5312e4**——纪元 14 的构建树与提交树差异 ≥3 处，或构建时上下文目录中存在提交后删除的额外文件。即：**该镜像证据无法证明是「这个提交」构建的**。
- 加重项：收口报告 §三 的「`evals/phase3/lib/image-gate.mjs` exit 0」按字面执行是**无 CLI 入口的空跑**（该文件只导出函数，直接 `node` 运行恒 exit 0、零输出；本审计首次 standalone 复跑亦如此）。真实检查入口是 `requireAppImageDigests()`（套件内）或 `evals/phase3/image-gate/probes/probe-evidence-holds.mjs`——后者在 HEAD 拒绝。
- 影响：06 §容器纪律与 AUDIT-RESOLUTION-MATRIX F12 的 digest 绑定要求失守；六套 Docker 隔离套件（真实容器安全验证层）在本批提交树上零覆盖。
- 定级理由：证据完整性是本项目纪律的承重墙；「17 套全绿」声明中 6 套不可复现，属整批收口结论失真。

### P1

**F-2 `POST /api/routines/:id/mode` 引用 `objects.content` 幽灵列，对真实库必 500；收口 §六.6「已修复」不成立。**
- 复现：`.audit/batch2-audit/probes/probe-console-endpoints.mjs`（canonical schema 全新库）→ `Error: no such column: content`（`apps/daemon/src/console/api.mjs:854`），POST → 500（日志 `logs/console-endpoints-probe.log`）。canonical objects 无 content 列、无 ALTER 补列。
- 收口 §六.6 声称修复「/api/memory 与 /api/routines 引用 objects 不存在的 content 列」——实际只修了 GET /api/routines 与 /api/memory；mode 切换端点的 SELECT 漏网。
- 零覆盖：security-unit 63 用例中无任何 routine 用例（grep 仅命中注释行）。

**F-3 场景一/场景二编排闭环在 daemon 运行时断链（拉到即丢；提醒与晨报无人编排）。**
- 邮件：daemon tick 2b2 调 `pullMailMessages` 后仅 `console.log(fetched=…)`（`apps/daemon/src/daemon.mjs:516-517`）；`ingestInboundMail`（`mail-triage.mjs:91`）在 `apps/daemon/src/` **零调用方**（仅 `evals/phase5/scenarios/run.mjs` 调用）。IMAP 拉到的邮件不建 payload、不入 inbox、不生成任务——5.6 实盘接真实邮箱将**拉到即丢**。对照：calendar 拉取路径有 `insertObjectRow(kind='calendar_event')` 落库（`calendar-adapter.mjs:194`），是接通的。
- 跟进提醒：`processFiredFollowUpTimers`、`composeMorningBriefing`、`mergeQuietBriefings`（`briefing-followup.mjs`）在产品代码零调用方。daemon 只接了 `processDueTimers` + `cancelSatisfiedFollowUpReminders` + `runDreamingLoop`。离线 daemon 下 FIRED 跟进 Timer 的任务将永远排队，确定性 followup-reminder 路径永不触发。
- 定级理由：单元 5.3「分诊闭环」与 5.4「提醒闭环」的组件层全部有套件验证（78/78 通过），但 daemon 侧集成缺失使两个单元的**运行时价值为零**；套件绿不能替代接线。
- 佐证：浏览器 E2E（RECORD.md 步骤 3）必须「用 mail-triage 直接构造」种子卡——恰因 daemon 无法自行从邮件产生卡。

**F-5 SMTP 子进程在 DATA 已被接受（354）后的传输中断被分级为 `local`（可重排）而非 `unknown`——违反 06 §6 诚实纪律，存在 AT_MOST_ONCE 重复投递窗口。**
- 复现：`.audit/batch2-audit/probes/probe-adversarial.mjs` E1 段（自建环回 TLS SMTP 夹具：354 后 30ms 销毁连接）→ **8/8 分类 `local`**（日志 `logs/adversarial-probe.log`）。
- 机制：`upstream-mail-child.mjs:576` 将 `dataPayload + "\r\n.\r\n"` 作为**一次合并写**；`sentDot` 仅在该写回调成功后置 true（:577）；失败 → 未过 dot → 分类 local（:634-638）。但 354 之后内核缓冲的部分字节是否已上链**从客户端不可证**——正是「unknown，不当成功或可重试失败」的定义域。对照：同批 `upstream-calendar-child.mjs:104-118` 用 `requestWritten` 正确实现同一纪律（请求写出后任何中断即 unknown），mail child 的边界画错了位置。
- 后果：dispatcher 对 `failed_local` 可重排（RECORD.md 步骤即有 `requeueLocalFailure` 先例）→ 对同一 `AT_MOST_ONCE` 邮件可能二次完整提交。

**F-6 `contact_no_reply` 条件求值无 scope 隔离：跨 scope 同 `thread_key` 的 inbox 行可以满足另一 scope 的 Timer。**
- 复现：`probe-adversarial.mjs` C1 段：scope A（`dm:mail:acct-c@example.test`）的 Timer，被 scope B（`dm:mail:acct-d@example.test`）中同 `thread_key` 的真人回信 **SATISFIED**（evidence=跨 scope 行 `inb:cross-b`）；C2 对照（不同 thread_key）正常 FIRED。
- 机制：`apps/daemon/src/timers.mjs:114-120` 的 inbox 查询仅按 `thread_key + received_at + state` 过滤，**无 `scope_id` 条件**；`evaluateCondition` 也不接收 scope 参数。03 §5 的跨通道隔离纪律要求条件判定锁定在本 scope。实际影响：另一邮箱账号（或任何能构造同 thread_key 的通道事件）可以吞掉本 scope 的跟进提醒。

### P2

**F-7 `composeMorningBriefing` 跨 scope 元数据泄露（潜伏缺陷）。**
- 复现：`.audit/batch2-audit/probes/probe-briefing-and-childguard.mjs` G1/G2：为 scope A 组晨报，**包含了 scope B 的 WAITING 审批卡元数据**（`pendingApprovals` 查询 `briefing-followup.mjs:255-262` 无 scope 过滤）与 **scope B 的 audit_alert**（`unrecoveredAlerts` :277-283 无 scope 过滤）；同文件 calendar/timers 查询均按 scope 过滤，独这两处遗漏。
- 缓解：该模块当前无 daemon 调用方（F-3），泄露 today 不可达；一旦按 F-3 接线即成为跨 scope 读路径。与 F-3 一并修复。

**F-8 Dreaming 循环在无 ledger 时照跑，与收口 §六.3 声明相反。**
- 复现：`probe-adversarial.mjs` D4 段：`runDreamingLoop(..., ledger: null)` 在静默窗内**完整执行**（归档+建议均落库），无 `dreaming_budget_refused` 审计。收口 §六.3 写「无 ledger/冻结/超额 → 审计 dreaming_budget_refused 并跳过」——代码（`dreaming.mjs:59-84`）只在 ledger **存在**时预留，不存在时静默放行。
- 缓解：daemon 总是传 ledger，现网不可达；属模块契约与声明不一致，修复为一行门禁。

**F-9 `child-entries-never-imported-by-host` 防复发检查真实但窄（可绕过面 4 类）。**
- 实现（`evals/phase5/scenarios/run.mjs:191-206`）：仅扫描 **4 个宿主文件**（daemon/mail-adapter/calendar-adapter/adapters），且仅匹配**双引号静态 import** 的 mail/calendar child。
- 绕过面（审计官逐一验证正则行为）：单引号 import、动态 `import()`、间接 re-export 链、以及其余全部宿主模块（router/effects/scheduler/console/worker/…）均不可见。
- 现状核实：全树扫描（含动态 import）**当前零宿主 import child 入口**——事故根治成立（见 §四），但防护强度与「防复发」目标不匹配。建议扩为全 src 扫描 + 双引号/单引号/动态 import 三形态。

### P3（残留，不阻断，如实记录）

1. `proposeMailReplyEffect` 缺 `evidenceManifestHash` 实参时以 `canonicalJson: undefined is not representable` 崩溃（`keys.mjs:38`），报错不指向真因（本审计探针踩中一次）。
2. 凭据 scrub 无最小长度策略：单字符密码会对错误消息过度涂改（诊断质量）；scrub 不覆盖 base64 形态（AUTH PLAIN 行被服务器回显时）。
3. `reproposeAfter412` 的 task 重停车 UPDATE（`calendar-adapter.mjs:358-360`）无 CAS 校验，仅记审计；竞态窗口窄且后续审批 CAS 兜底失败关闭。
4. IMAP LOGIN 密码未拒 CRLF（`upstream-mail-child.mjs:617` 只验长度）；凭据来自宿主槽位，在威胁模型外，hardening 项。
5. RRULE 解析不展开（`calendar-ics.mjs:44`），重复事件在晨报中按 DTSTART 单次呈现。
6. 静默窗内 Dreaming 每 tick 新增一条 settled-0 预留行（requestKey 含 now 哈希），夜间 DB 噪音。
7. 无 Message-ID 邮件使 `mailThreadKey` 抛错——F-3 接线修复时需一并处理 pass 级容错，避免单封畸形邮件楔死整轮拉取。
8. `GET /api/tasks/:id/checkpoints` 对不存在任务返回 200 空表（无存在性 oracle 方向安全，语义小瑕疵）。

---

## 三、红线复核（7 条逐项）

| # | 红线 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 版本锁定 | **部分违反（F-1）**：全程只用锁定 Node（v22.23.5，探针与套件均显式路径）；pi-coding-agent 1.5.2 / hono 4.13.19 未动（lockfile 零改动、hono 配对自检 exit 0）；零新增依赖（package.json 仅 +1 脚本行）。**但纪元 14 证据不绑定提交树** | `logs/gate-refusal.log`、`logs/context-drift-probe.log`、`git diff 86f5cd2..1d019fc -- package-lock.json` 空 |
| 2 | 许可 1 边界 | **通过**：`.env` 零读取（daemon 源码与 Phase 5 套件 grep 无 dotenv/.env 读取；real 守卫先于一切）；缺省无任何真实邮箱/日历/Telegram/模型路径可达（`probe-adversarial` B 段 + 关闭门探针）；`evals/phase5/scenarios-real/` 不存在；`git status -sb` = ahead 1 未推送 | `logs/adversarial-probe.log`、`ls evals/phase5/scenarios-real` 报错 |
| 3 | defaults.json | **通过**：diff 为纯增量 mail/calendar 两节；新键全部 false/null/[]/有界数值（端口 993/465、TTL 14400000、附件上限 4194304）；既有键逐字节零改动（单 hunk 纯增）；`defaultsFailClosed=true` | `git diff` 全文见本报告工作记录；user-value 149/149 |
| 4 | 门禁文件零触碰 | **通过**：`schema-source.json`、canonical `schema.sql` 27 表、`recall.mjs`、5 个 real 守卫 diff 全空 | `git diff --stat` 空输出 |
| 5 | CP4 | **通过（自写反例）**：提案层跨 scope 父链 mail.send **行前拒绝**（A1：throw + 0 effects/0 approvals/0 payloads）；派发层白名单收件人 + 跨 scope 闭包仍 DEAD + 零字节 + 审计（B-A2）；同 scope 放行不过宽（A3）；`adapters.allowedRecipients` 在任何代码路径仅作传输白名单（`mail-adapter.mjs:151` 注释与实现一致） | `logs/adversarial-probe.log` A/B 段 |
| 6 | 无授权外发 | **核心通过 + 1 边界缺陷**：AT_MOST_ONCE UNKNOWN 拒自动重发（B1：两轮 recovery 均 none，submit=1）；拒绝零借道（B2：0 个 notify/im effect）；`calendar.write` 缺 `expected_head` 即拒（adapters validate + calendar-adapter submit 双层）；412/头失配走重审（daemon 1045-1100 三路径：READY→reproposeHeadChanged、FAILED→reproposeAfter412，后者先 CAS FAILED→CANCELLED 无风暴）。**边界缺陷 = F-5（mid-DATA 分级）** | `logs/adversarial-probe.log`、daemon diff |
| 7 | Web 门禁 | **通过**：ui.mjs 零 innerHTML/外链/URL token（静态扫描 + 套件）；跨 Host 403（curl `Host: rebind.example.com` → 403）；无 CSRF mutation 401（bootstrap 直调 401）；对象统一 404（无权限/不存在/已删除同码，`api.mjs:911-931`）；nonce 四路隔离 + 消费即删 + **重启存活后仍仅 designated approver 活会话可见**（F1-F6 + 重启探针 P5）；SSE scope 过滤 + nonce 绝不入流/审计 | `logs/adversarial-probe.log` F 段、curl 输出 |

## 四、诚实条款核实（收口 §六.5 / §六.6）

1. **§六.5 child-import 事故**：根治成立。`calendar-ics.mjs` 拆分后全树（静态 + 动态 import）零宿主模块引用任何 `*-child.mjs` 入口（仅 spawn 路径常量）。防复发检查存在但窄（F-9）——根治真实、护栏需加宽。
2. **§六.6 四处既有缺陷修复**：3 处核实已修（`/api/budget` 不再查 `budget_accounts.kind`（`api.mjs:540-548`）、trace 的 execution_jobs 查询无 `started_at` 幽灵列（`api.mjs:1018`）、`currentWindowsAccount` 改 USERDOMAIN\USERNAME 权威解析）。**`objects.content` 幽灵列只修了两处中的一处半——`POST /api/routines/:id/mode` 漏网（F-2），且该端点零测试覆盖**。
3. **§六.7 已知残留**：expectedRevision CAS 窄窗、SSE 轮询式实现、thread_key 防扩权沿用——核实为如实披露，本审计未发现其声明范围之外的更严重同类问题（F-6 是声明之外的同类问题）。
4. **审计官自述偏差**：探针开发中三次自伤（ESM 导入路径、控制协议首行 ready 误当应答、审批 id 含 `%3A` 需 encodeURIComponent 拼 URL——后者一度造成 F 段假 FAIL，修正后产品行为干净）；全程未修改产品代码、未读 `.env`、未带任何 AEGISPI_ALLOW_* 变量；复跑套件再生了 `docs/phase{1..4}/evidence/` 下的报告文件（时间戳漂移，未纳入审计提交，返工终树复跑会再次刷新）。

## 五、浏览器 E2E 复验（亲手点击，全程环回）

环境：`serve-fixtures.mjs`（环回 TLS SMTP/IMAP/CalDAV）+ 独立数据目录 daemon（E2E 配置仅存审计探针目录，仓库 defaults 未动）。种子因 F-3 由审计官用 mail-triage 直接构造（与实施者 RECORD 同法）。

| 步骤 | 结果 |
| --- | --- |
| 登录（bootstrap token → session） | 四页签出现，顶栏 generation 1 · watermark 2，SSE 状态如实显示 |
| ① 点击「批准此动作」 | CAS 消费（WAITING 清空、watermark→3）；daemon dispatcher 经环回 SMTP **恰投 1 封**（control `smtpStats count=1`）；effect `SUCCEEDED` + external_id（Message-ID）+ attempt_count=1 |
| ① UNKNOWN 对账（填 evidence + CONFIRMED_NOT_SENT） | 列表清零（watermark→4）；DB 终态 `FAILED / "confirmed not sent by human reconciliation"` |
| ③ XSS 候选 `<script>alert(1)</script>` | ARIA 树中以**纯文本**呈现；`getJsDialog()` 为 null（零脚本执行）；隔离原因 `hidden_html_or_comment` 同行展示；无「激活」按钮 |
| 跨 Host 403 / 无 CSRF 401 | curl 复核：`Host: rebind.example.com` → 403；无 Bearer `/api/health` → 401 |
| 截图 | `.audit/batch2-audit/evidence/e2e-xss-governance-tab.png` |

## 六、攻击面 8 项小结（任务书 §五）

1. **nonce 交付**：bootstrap 会话/其他 principal 会话/SSE/审计日志四路全 null（F1-F5）；消费后即删（F6）；备份恢复重放后 nonce 行随 WAITING 卡存活，但活会话 + designated approver 双门不变（重启探针 P5）。
2. **timers contact_no_reply**：payload 不可读跳过方向保守（`continue`）；`sinceAt` 优先、无 `sinceMs` 时回退 timer.created_at；bot/self/bounce 剔除仅信封地址（显示名无效）——**但无 scope 过滤（F-6）**；伪造 systemNotification 仅能阻止满足（保守方向），真实风险是跨 scope 满足。
3. **dreaming**：quietHours 边界（22:59/23:00/06:59/07:00）正确；出窗跳过无 force 缝；合并建议指纹幂等且**不跨 scope 混合**（D2）；隔离项与受禁类别不触碰（D3/D3b）；`settle actual=0` 附 basis 非虚构用量——**无 ledger 照跑与声明相反（F-8）**。
4. **upstream children**：stdin 参数全部强校验（host/端口/用户名/密码/超时/模式白名单）；SMTP 多行应答按 offset 消费无错位；IMAP literal 消费正确（literal 内嵌 `{N}` 不可注入）；错误分级——calendar 侧正确，mail 侧 mid-DATA 边界错误（F-5）；scrub 过度涂改单字符凭据（P3）。
5. **briefing-followup**：supersede 路径每次换新 naturalKey（`:beat<occurrence>`）无自碰撞；静默合并仅 READY 集，infra_error/UNKNOWN 永不入合并（06 §7 达标）——**构图两查询无 scope 过滤（F-7）**；TTL 与 expiry 由 expireStaleNotifications 事务清理。
6. **console api**：steer 需 request 授权 + 同 scope durable inbox + 202 queued（诚实语义）；trace 时间线字段经逐列核对无正文/密钥载体（错误串全部为已 scrub 值）；routines mode 的 auto 强制 reviewReportRef（422）不可绕过——**但该端点本身 500（F-2）**。
7. **repropose**：FAILED→CANCELLED CAS 先行无铸造风暴；新卡绑当前 ETag、旧 approver 继承、task 回 WAITING_APPROVAL；重停车 UPDATE 无 CAS（P3）。
8. **恢复/重启语义**：**真实进程 kill -9 + 重启 8/8 通过**（`logs/restart-probe.log`）——PARKED/fence/审批/nonce 全存活，批准后恰 1 封且无第二封。实施者用「新开 DB 连接」模拟的部分，本审计以真进程补齐。

## 七、放行条件（详见 HANDOFF-BATCH2-AUDIT.md）

1. **F-1（P0）**：在提交树执行 `node tools/build-app-images.mjs --only=agent` 重建纪元 15 并提交刷新证据块；随后六套 Docker 套件在锁定 Node 实跑全绿。此为唯一 P0，修复纯机械。
2. **F-2/F-3/F-5/F-6（P1）**：修复并各自补入反例（F-3 需 daemon 接线 mail ingest + 对 followup/晨报编排做明确的接线或范围裁定 ADR）；重跑 `eval:scenarios` 与受影响套件。
3. F-7/F-8/F-9（P2）建议同批修复；P3 项由实施者择机登记。
4. 全部修复后按 D-96 惯例在终树刷新全量计数，独立审计官复核后方可进入单元 5.6。
