# Phase 5 第 2 批收口报告（单元 5.3 + 5.4（含 D-95 转入的 L3 Dreaming 编排）+ 5.5）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **基线**：`86f5cd2`（`main`，第 1 批 5.1+5.2 经 `D-96` 全量验收放行第 2 批，镜像纪元 13）→ 本批提交（见下）
> **依据**：[docs/phase5/phase5-kickoff-plan.md](../phase5-kickoff-plan.md) 单元 5.3、5.4（含 L3 Dreaming）、5.5；规范来源为本机设计包 v1.4.1（README、PRE-READ、00、02、03 §3–4、04 §2–6、06 §4–7、AUDIT-RESOLUTION-MATRIX F03/F04/F11）
> **许可级别**：全程许可 1。邮件/日历走本地环回 TLS 夹具（SMTP/IMAP/CalDAV helper 进程 + 预生成自签证书 fixture），凭据为套件夹具假值；零真实邮箱、零真实日历、零真实 Telegram、零真实模型调用；单元 5.6（`evals/phase5/scenarios-real/`）未提前实施。
> **文档性质**：实施者自测收口报告，供主人与独立审计官整批复核。

---

## 一、交付范围与改动清单

### 1. 基础件

| 产物 | 职责 |
| --- | --- |
| [apps/daemon/config/defaults.json](../../../apps/daemon/config/defaults.json)（纯增量） | 新增 `mail` 节（`imapHost/smtpHost: null`、双端口/TLS、`allowRealMailRead/Send: false`、`allowedFolders:["INBOX"]`、双白名单 `[]`、`approvalTtlMs: 14400000`、`maxAttachmentBytes: 4194304`）与 `calendar` 节（`caldavUrl: null`、双 allow `false`、`allowedCalendars: []`、`defaultTimezone/quietHours`）；既有键零改动（预算 $0.80/$5.00/1000、全部既有开关零放宽） |
| [apps/daemon/src/config.mjs](../../../apps/daemon/src/config.mjs) | `parseMailConfig`/`parseCalendarConfig`：null 失败关闭、环回缝仍需显式 allow、端口/上限有界、IANA 时区校验（含 quietHours） |
| [apps/daemon/src/quiet-time.mjs](../../../apps/daemon/src/quiet-time.mjs)（新增） | IANA 墙钟算术：`wallClockInstant`（两遍偏移收敛，DST 跳变安全）、`nextWallClockOccurrence`、`countOccurrencesBetween`（补跑计数）、`parseQuietHours`/`inQuietHours`/`nextQuietBoundary`；全部经 Intl 时区表，不用 Date 本地时区 |
| [apps/daemon/src/calendar-ics.mjs](../../../apps/daemon/src/calendar-ics.mjs)（新增） | 纯函数 .ics 解析（DTSTART/DTEND/TZID/RRULE/SUMMARY/ATTENDEE/UID、折行展开）——从 child 拆出，保证宿主 import 不执行任何子进程入口 |

### 2. 单元 5.3：场景一（邮件分诊、草稿先行、4h 持久停车与对账）

| 产物 | 职责 |
| --- | --- |
| [apps/daemon/src/upstream-mail-child.mjs](../../../apps/daemon/src/upstream-mail-child.mjs)（新增） | 隔离子进程（stdin 单行 JSON → stdout 单行 JSON）：IMAP over TLS（LOGIN→SELECT→UID SEARCH→UID FETCH 头/有界正文预览/BODYSTRUCTURE 附件清单，附件逐个 SHA-256，逐附件+总量受 `maxAttachmentBytes` 约束）与 SMTP over TLS（EHLO→AUTH PLAIN/LOGIN 回退→MAIL FROM→RCPT TO→DATA 点 stuffed→QUIT）。**诚实分级**：`remote`=服务器明确拒信（4xx/5xx、LOGIN/SELECT/DATA refused）、`local`=连接/协议超时/断流（零后果字节）、`unknown`=final `.` 已写出后的任何中断（06 §6 永不当成功或可重试失败）；环回 host 为自签证书验证缝（`rejectUnauthorized:false` 仅限 127.0.0.1/::1/localhost），非环回全证书校验；输出经凭据脱敏 |
| [apps/daemon/src/mail-adapter.mjs](../../../apps/daemon/src/mail-adapter.mjs)（新增） | 宿主传输层：凭据槽 `"mail"`（JSON 或 `user:password` 形态，经 credentials.mjs 解析，子进程 stdin 传参 + `buildSafeChildEnv()` 清洁环境）、失败关闭阶梯（smtpHost null / allowRealMailSend false / 槽位未接线 → 零字节）、收件人传输白名单复验、`createMailUpstream`（submit 结果映射 effect 四态）与 `pullMailMessages`（IMAP 拉取运行时，双关闭门） |
| [apps/daemon/src/mail-triage.mjs](../../../apps/daemon/src/mail-triage.mjs)（新增） | 分诊闭环：scope `dm:mail:<account>`（owner_dm）；thread_key 取 References 根（回退 In-Reply-To/Message-ID）；**仅信封地址建 principal——From 显示名绝不作身份**；allowedSenders 空即全拒（失败关闭），拒信零持久化仅脱敏审计；payload 最小指针（信封/脱敏摘要（redactSecrets）/Message-ID 线索/附件 sha256 清单）；`proposeMailReplyEffect`：To/Cc/Bcc 白名单 + 固定发送身份 + 正文/附件哈希确定性校验（行前拒绝）→ `proposeEffect`（AT_MOST_ONCE、approvalTtlMs=4h；RUNNING 任务同事务 attempt=PARKED + lease 清空 + fence 不递增——容器由 daemon 既有 reclaim 回收，停车跨重启持久）；natural_key 按逐封回信唯一（threadTag+messageTag），不碰撞；回信入库联动 `handleThreadReply` 满足跟进 Timer |

### 3. 单元 5.4：场景二（晨报、条件 Timer、CalDAV ETag 审批、L3 Dreaming）

| 产物 | 职责 |
| --- | --- |
| [apps/daemon/src/timers.mjs](../../../apps/daemon/src/timers.mjs)（升级） | `evaluateCondition` 新增 `{type:"contact_no_reply", threadKey, expectedSender, sinceMs, ownerAddresses}`：仅信封地址匹配的真人回信满足；`source_actor=bot`、主人自发消息（ownerAddresses）、退信/系统通知（payload.systemNotification 或 mailer-daemon/postmaster/noreply 等已知机器身份）一律剔除；不可读 payload 跳过（保守不取消提醒）、无 payload reader 硬错（fail closed）。新增墙钟 recurrence `{type:"daily_wall_clock", timeOfDay, timezone}`：DST 安全、错过多周期合并单次补跑并如实记 `missed_count`、nextDue 回到墙钟锚点；单 Timer 条件不可读时审计 `timer_condition_refused` 且不 wedge 扫描。新增 `cancelScopeTimers(InTx)` 级联 |
| 级联接入（acl/effects/control 三处，同事务） | `revokePermission('read')`、`cancelScope`（任务取消）、`/pause`（scope 暂停）均在**同一事务**内将 SCHEDULED Timer 置 CANCELLED（03 §4：撤权/取消/暂停关联 Timer 必须取消） |
| [apps/daemon/src/briefing-followup.mjs](../../../apps/daemon/src/briefing-followup.mjs)（新增） | `handleThreadReply`（回信→SCHEDULED Timer 逐个重判，首提交者胜=06 §7 事务序）；`processFiredFollowUpTimers`（FIRED 跟进 Timer→`followup-reminder` 窄例行 READY 提醒 effect + outbox（notify_reason `followup:<timerId>`、AT_MOST_ONCE、静默期 `not_before` 推至静默结束不丢弃）；同 Timer 已有 pending 提醒则走 `supersedeNotification` 合并取代——每 Timer 至多一张 live 提醒）；`composeMorningBriefing`（结构化晨报：日历事件/待审卡/待跟进 Timer/未恢复告警）；`mergeQuietBriefings`（静默期 briefing 按旧 outbox 合并取代，仅 READY 可并入——**持续 infra_error/UNKNOWN 永不被静默隐藏**） |
| [apps/daemon/src/upstream-calendar-child.mjs](../../../apps/daemon/src/upstream-calendar-child.mjs)（新增） | CalDAV 隔离子进程：`calendar.read`（REPORT RFC 4791 calendar-query Depth 1 → multistatus → {href, etag, ics}）；`calendar.write`（PUT/DELETE + `If-Match: "<etag>"`；412/409 → kind `precondition` + `head_changed:` 前缀）；`calendar.head`（GET 单资源当前 ETag，供 dispatcher precondition）；凭据槽 `"calendar"`、环回自签缝同 mail、输出脱敏 |
| [apps/daemon/src/calendar-adapter.mjs](../../../apps/daemon/src/calendar-adapter.mjs)（新增） | `pullCalendarEvents`（双关闭门 → calendar_event objects，uid 键 replace-in-place 保 ETag 最新，TZID 经 quiet-time 重锚定到真实时刻）；`createCalendarUpstream`（submit 载 If-Match、expected_head 缺失即拒——**零静默覆盖**；`lookupHead` 供 precondition）；`reproposeAfter412`（FAILED+head_changed → 取消旧卡 + 任务回 WAITING_APPROVAL + 新卡绑定当前 ETag 重审） |
| [apps/daemon/src/dreaming.mjs](../../../apps/daemon/src/dreaming.mjs)（新增） | L3 Dreaming 编排循环（D-95 转入）：**仅在 quietHours 内**运行（无 force 缝，时钟即门）；**purpose='summary' 独立预算预留是许可 slips**（无 ledger/冻结/超额 → 审计 `dreaming_budget_refused` 并跳过；确定扫描零模型调用 → settle actual 0 并注明）；归档 `expires_at<=now` 的 candidate/active/conflicted → `expired`；同域（per-scope 查询、同 factKey 族）干净 candidate 生成 `dreaming_suggestion` 合并建议（**严禁自动激活、受禁类别（NEVER_ACTIVATABLE_CATEGORIES）与隔离项不触碰、绝不跨 scope 混合**，指纹幂等）；久未裁决 conflicted 生成治理告警（audit + stream audit_alert + suggestion，交 5.5 控制台） |

### 4. 单元 5.5：控制台后端 API + 本地 Web 前端

| 产物 | 职责 |
| --- | --- |
| [apps/daemon/src/console/api.mjs](../../../apps/daemon/src/console/api.mjs)（升级） | 新增：`GET /api/memory`（可见 scope 过滤 candidate/active/conflicted + 隔离告警 + Dreaming 建议）；`POST /api/memory/:id/decide`（mutationGuard + expectedRevision(version) CAS 409；activate 拒隔离/受禁（activateMemoryFact 原语义）、reject→expired 归档、forget→两阶段遗忘 + deletion-manifest 追加；均需 scope admin）；`GET /api/routines` 与 `POST /api/routines/:id/mode`（admin + expectedRevision + policyVersion 校验 + auto 强制 reviewReportRef，`autoStillApprovesExternalWrites: true` 常量回显）；`GET /api/objects/:id`（object_required_scopes 全闭包逐跳复验 read，offset/limit 有界分页，无权限/不存在/已删除统一 404——零存在性 oracle）；`POST /api/tasks/:id/steer`（request 权限 + expectedRevision → 同 scope durable inbox 事件 → `202 {code:"queued"}`）；`GET /api/effects-unknown`；`GET /api/budget` 增强 `byPurpose`（spent=SETTLED actual、held=HELD upper、chargedBound=CHARGED_BOUND upper、请求数；cache tokens `null`+“未测”）；`GET /api/tasks/:id/trace`（可见 scope 404 过滤 + 全阶段脱敏时间线 + `computedButUnconfirmed`（Task SUCCEEDED 但 Effect UNKNOWN）诚实标注）；`GET /` 挂载前端；Phase 6 五端点维持 catch-all `501 not_implemented_yet`。**顺带修复三处既有潜伏缺陷**：/api/budget 查询了不存在的 `budget_accounts.kind` 列（对真实库必 500）、`currentWindowsAccount` 的 PATH 依赖 whoami（Git Bash 环境返回裸名致 ACL 校验必败，D-77 残留——改用 USERDOMAIN\\USERNAME 权威解析）、approval nonce 交付通道（见下） |
| [apps/daemon/src/approvals.mjs](../../../apps/daemon/src/approvals.mjs)（升级） | `createApprovalRow` 同事务将 raw nonce 写 `system_state('console_nonce:<id>')`（approvals 表仍只存 hash；宿主专用存储）；designated approver 的**活会话**可经 `GET /api/approvals/:id` 取回 decisionMaterials（nonce+完整 action_hash）——bootstrap token 永远拿不到、绝不进 URL/SSE/日志；consume/reject/invalidate/expire 四路即清 |
| [apps/daemon/src/console/ui.mjs](../../../apps/daemon/src/console/ui.mjs)（新增） | 同源单页前端（零外链 CDN/字体/脚本；`innerHTML` 零使用——全部 `textContent`/DOM API，链接不从数据渲染故无 href 协议面）；四页签：① 待办与审批台（默认置顶：WAITING 卡 + 批准/在线编辑重签/拒绝 + UNKNOWN 对账）② 任务与故障诊断台（health/recovery/disk 栏 + scope 分组任务 + Steer/取消 + objects/spill 分页查看）③ 记忆与治理台（激活/拒绝/遗忘、Dreaming 建议、Routine Observe/Auto、ACL 授权/撤权）④ 链路与分用途成本台（账户进度条 + byPurpose（cache 未测显式标注）+ Trace 时间线查询）；SSE 状态机按 04 §5：先快照记 generation/watermark，再经 fetch 流（EventSource 无法带 Bearer、URL 传 token 被禁）连 SSE，`reset`/410/acl_changed 清空重拉；token 只存页面内存 |
| [apps/daemon/src/cp4.mjs](../../../apps/daemon/src/cp4.mjs)（升级） | `mail.send`/`calendar.write` 成为**显式 CP4 形状**（mail-send/calendar-write）：提案与派发双重门禁严格校验完整上游 `object_required_scopes` 闭包——闭包留在 effect 自身 scope 内放行（传输白名单/ETag 预条件仍由 adapter 层独立把关），越界则 audience 不可判定 → 仅披露 allowlist 可放行，否则拒绝。**`adapters.allowedRecipients`/`mail.allowedRecipients` 仅传输可达白名单，绝不是 CP4 跨私域披露授权**（D-96 红线继承） |
| [apps/daemon/src/adapters.mjs](../../../apps/daemon/src/adapters.mjs)（升级） | OPERATIONS 注册 `calendar.write`（caldav: 资源 + expectedHead + href/method 校验）；mail/calendar 专用子进程传输路由进 `createAdapterUpstream`；`lookupHead` 按 caldav 目标路由 calendarUpstream；凭据 needed 映射补 `calendar.* → "calendar"` |
| [apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs)（升级） | tick 接入：2b2 mail 拉取（间隔记忆 + 函数内关闭门）、2b3 calendar 拉取、2b4 Dreaming 编排循环（quietHours + summary 预算）、dispatch 过滤行扩 mail.send/calendar.write、calendar.write FAILED+head_changed 的 412 重提案扫（reproposeAfter412） |
| 守卫 | 新增套件静态检查 `child-entries-never-imported-by-host`（daemon/adapters/mail/calendar 宿主模块零 import 子进程入口脚本——本批开发中真实发生过 child 顶层入口在 import 时 `process.exit(0)` 杀死 daemon 的事故，已由 calendar-ics.mjs 拆分根治并结构化防复发） |

### 5. 测试扩编

| 套件 | 计数 | 说明 |
| --- | --- | --- |
| `evals/phase5/scenarios/run.mjs`（新增，脚本 `eval:scenarios`） | **78/78 PASS，exit 0** | 环回 TLS SMTP/IMAP/CalDAV 夹具（helper 进程 + JSON 控制协议）全矩阵：5.3 关闭门 ×2、TLS 拉取 + 附件 sha256、显示名伪造拒信零持久化、thread_key/scope/脱敏、PARKED 停车（lease 清空 + fence 不变 + 跨重启）、单次消费/双击幂等、真实环回 SMTP 恰 1 封 + external_id、CP4 跨 scope 载荷拒绝、白名单/身份/附件哈希行前拒绝、组任务零邮件读（CP2）、编辑换卡旧卡死、拒绝/4h 超时零重发零借道、DATA 断流 UNKNOWN + AT_MOST_ONCE 拒自动重发 + 人工对账双向、5.4 bot/self/bounce 不满足/真人回信满足/错发件人不满足、回信先到 SATISFIED 零提醒、5 周期重启合并 missed_count=4 + 墙钟回锚、NY DST 跳变、撤权/暂停级联取消、晨报结构化、CalDAV 双关闭门/入库带 ETag/TZID 锚定、If-Match 写入成功、远程改 ETag → precondition head_changed 拒发 + 零覆盖 + 换卡重审成功、412 竞态（PUT 时刻注入突变）→ FAILED+head_changed → reproposeAfter412 新卡、Dreaming 出窗跳过/入窗执行/过期归档/合并建议/受禁不触碰/不自动激活/跨 scope 不混合/summary 预算 reserve+settle0/冻结预算拒绝、defaults 失败关闭自检 ×4 |
| [evals/phase3/security-unit/run.mjs](../../../evals/phase3/security-unit/run.mjs)（扩编 +15） | **63/63 PASS，exit 0** | 5.5 面：GET / 200 text/html + 跨 Host 403、页面零 innerHTML/零 token 泄露/零外链、会话铸造 + bootstrap token 不可变更（401）、XSS 记忆事实隔离（hidden_html_or_comment）+ 隔离激活 409、revision CAS 409 + 激活成功、reject 归档、forget 两阶段 + 墓碑清单落盘、对象 404 统一（无存在性 oracle）+ 有界分页、steer 403→202 queued + inbox PENDING、byPurpose 算术与账本逐分一致（cache 未测=null）、Trace 404 过滤 + UNKNOWN 诚实标注、Phase 6 端点 501 |
| [evals/phase3/cancel-approval/run.mjs](../../../evals/phase3/cancel-approval/run.mjs)（扩编 +4） | **20/20 PASS，exit 0** | 5.5 API 驱动：decisionMaterials 仅 designated approver 活会话可见（bootstrap 全 null）、API revise 换新卡旧卡 409、API 批准 → fake 传输派发 SUCCEEDED、UNKNOWN 对账阶梯（列表可见/无 CSRF 403/CONFIRMED_SUCCESS 无 externalId 409/带证据 200→SUCCEEDED） |

## 二、镜像与守卫

- 因改动 `apps/daemon/`：`tools/build-app-images.mjs --only=agent` 重建 → **镜像纪元 14**：agent manifest `sha256:e33246a557d32002ea14a22d960e66e8cdd24bd3f5e34c70e9603c7c79b0ec3e`（config `b6c33aec…`、context `4f5312e4…`，self-check exit 0）；acquisition/execution 携带原 digest（context 复核一致）。`evals/phase3/lib/image-gate.mjs` **exit 0**；`evals/contracts/tools/verify-hono-oracle-pair.mjs` **exit 0**（hono exact 4.13.19 不变）。

## 三、终树全量回归（锁定 Node `D:\AegisPi\tools\node-v22.23.5\node.exe` 实跑，全部 exit 0）

| 套件 | 结果 |
| --- | --- |
| `test:contracts` | exit 0 |
| `test:durability` | **164/164** |
| `test:acl` | **15/15** |
| `test:budget` | **20/20** |
| `test:cancel-approval` | **20/20**（16 既有 + 4 新增 5.5 用例） |
| `test:restore` | **11/11** |
| `test:ingress-telegram` | **7/7** |
| `test:security:unit` | **63/63**（48 既有 + 15 新增 5.5 用例） |
| `test:memory-lifecycle` | **47/47** |
| `test:cross-channel` | **23/23** |
| `eval:scenarios`（新增） | **78/78** |
| `test:model-proposal`（Docker） | **15/15** |
| `test:repo-observe`（Docker） | **7/7** |
| `eval:triage`（Docker） | **7/7** |
| `test:offline-jobs`（Docker） | **14/14** |
| `test:security:integration`（Docker） | **29/29** |
| `test:quota-calibration`（Docker） | **5/5**（直接重跑，未引用豁免：docker/ 零改动且镜像门禁一致，重跑消歧） |
| `report:user-value` | **149/149 PASS，`defaultsFailClosed=true`**（较第 1 批 134 增加 15 项 = security-unit 5.5 扩编自动并入聚合） |

### real 入口守卫（未设任何环境变量实测，全部先于 `.env` 读取拒绝）

| 入口 | 结果 |
| --- | --- |
| `test:ingress-telegram:real` | **exit 4** |
| `eval:triage:real` | **exit 4** |
| `test:model:real` | **exit 4** |
| `test:external-write:real` | **exit 4** |
| `repo-observe-real`（`evals/phase4/repo-observe-real/run.mjs`） | **exit 4** |

## 四、浏览器交互端到端实测（含截图）

本机 daemon（E2E 专用配置，仅落在 gitignore 的 workspace-state）+ 环回 TLS 夹具后端，浏览器真实点击操作，截图与逐步记录归档于 [docs/phase5/evidence/browser-e2e/RECORD.md](../evidence/browser-e2e/RECORD.md)：

1. **登录**：粘贴 bootstrap token → `POST /api/session`；generation/watermark 记录；四页签出现（01 截图）。
2. **① 审批台批准**：`mail.send` 草稿卡点击「批准此动作」→ CAS 消费 → daemon dispatcher 经 SMTP 子进程**真实投递恰 1 封**至环回 TLS 夹具（`smtpStats count=1`），effect `SUCCEEDED` + external_id 入账（02 截图批准后 WAITING 清空）。
3. **UNKNOWN 对账**：填 `externalEvidenceRef` 选 `CONFIRMED_NOT_SENT` 点击「对账」→ 列表清零。
4. **② 任务台**：health/recovery/disk 栏、scope 分组任务、对象分页读取（textContent 渲染）（03 截图）。
5. **③ 治理台**：XSS 候选以纯文本渲染（零脚本执行、隔离原因可见）、干净候选激活 `candidate→active`、隔离候选无激活按钮（04 截图）。
6. **④ 成本台**：$5.00 进度条、byPurpose（cache=未测）、Trace 完整脱敏时间线（05、06 截图）。
7. **SSE 状态机**：快照先行 → Bearer fetch 流 → 断线/reset 自动重连（顶栏如实显示状态）。

## 五、红线自检

1. **defaults.json 失败关闭**：`git diff apps/daemon/config/defaults.json` 为纯增量（新增 `mail`/`calendar` 两节，键值全部 `false`/`null`/`[]`/有界数值）；既有预算（`$0.80`/`$5.00`/`1000`）与既有开关逐字节零改动；`report:user-value` 复核 `defaultsFailClosed=true`。E2E 测试专用配置（policy/allowlists/env 放行）只存在于 gitignore 的 `workspace-state/e2e/`，未触仓库默认值。
2. **schema/契约门禁**：`apps/daemon/config/schema-source.json`（`ede73eca…`）与 canonical `schema.sql` 27 表零触碰；本批未新增任何表（nonce 交付走既有 `system_state`，dreaming 建议/routine/calendar 事件/晨报走既有 `objects`，凭据走既有 `credential_slots`，全部沿用 `ensure*` 幂等模式）；`recall.mjs` 零触碰；5 个 `*-real` 入口 `exit 4` 守卫零改动且实测通过。
3. **主模型唯一**：`deepseek/deepseek-flash`（reasoning high）零变更；零新增模型 ID；purpose 枚举沿用既有 8 类（Dreaming 用 `summary` 既有预留）。
4. **零新增 npm 依赖**：邮件 IMAP/SMTP 与 CalDAV 全部使用 Node 内置 `node:tls`/`node:net`/`node:http(s)`；lockfile 零漂移（hono 配对自检 exit 0 复核）。
5. **敏感扫描**：新增文件含套件夹具假凭据（自标 fixture/not-a-real-secret，沿用 phase3 套件假 token 惯例）、预生成自签 TLS 证书 fixture（非密钥、CN=127.0.0.1、SAN=loopback）；`.env` 全程未读；daemon 运行期凭据只经 credentials.mjs 槽位解析、子进程 stdin 传参、错误输出先脱敏后截断；审批 nonce 只经 designated approver 活会话交付，URL/SSE/日志零 token/nonce。
6. **CP4 红线**：`mail.send`/`calendar.write` 成为显式 CP4 形状（提案+派发双门禁、闭包越界即拒、`adapters.allowedRecipients`/`mail.allowedRecipients` 仅传输可达）；场景套件 5.3-7a 断言跨 scope 载荷在提案前被拒。
7. **容器与临时区**：`docker ps -a` 仅本机常驻 `aegispi-build-registry`（其余为非本项目的既有容器，未触碰）；本批零测试容器残留；`workspace-state/` 下批内临时工作区（e2e/、tmp-smoke/、phase3/phase5 各套件工作区）已清理，workspace-state 本身不入库。
8. **git push**：未推送（本地提交待主人与独立审计官验收）。

## 六、设计取舍与待审计确认点

1. **审批 nonce 交付通道**：04 §2 的 HMAC 回调语义针对平台卡片；本地控制台以「designated approver 活会话 + CSRF」为传输认证，raw nonce 经 `system_state`（宿主专用存储）在卡片 GET 中回显给该会话。approvals 表仍只存 nonce_hash；消费/失效/过期即删。待审计确认：该交付面是否满足「nonce 不进 URL/SSE/日志」的读法（当前实现满足字面约束）。
2. **环回 TLS 自签缝**：mail/calendar 子进程对 loopback host 允许自签证书（`rejectUnauthorized:false` 仅限 127.0.0.1/::1/localhost），非环回强制全证书校验。与 model.baseUrl/telegram apiBase 的本地验证缝同一惯例；5.6 实盘将走真证书。
3. **Dreaming 预算记账**：编排循环是确定性宿主扫描（Phase 5 无模型调用），预留 summary 上界后以 `actual=0` settle 并注明依据——独立预算门禁可证（冻结即拒），未虚构任何 token 用量。
4. **静默期合并范围**：`mergeQuietBriefings` 仅对 `briefing:%` READY 通知合并；followup 提醒走「每 Timer 单 live 提醒」的 supersede 语义；持续 `infra_error`（UNKNOWN/FAILED 效果）不在 READY 集，永不被静默隐藏（06 §7）。
5. **宿主 import 防护**：本批事故（child 顶层入口被 import → daemon 导入期退出）已根治并落为 scenarios 套件静态检查；mail child 本就无人 import，calendar child 的解析函数拆至 `calendar-ics.mjs`。
6. **既有潜伏缺陷修复**（非本批范围引入，本批首触即修）：/api/budget 的 `budget_accounts.kind` 幽灵列、`currentWindowsAccount` PATH 依赖（D-77 Windows 残留的另一表现）、/api/memory 与 /api/routines 引用 objects 不存在的 `content` 列、execution_jobs trace 查询的 `started_at` 幽灵列。
7. **已知残留**：
   - Steer/编辑重签后的 `expectedRevision` CAS 依赖 `tasks.updated_at`/`objects.version` 单字段快照，与后台并发变更存在理论窄窗（本地单管理员控制台 + 服务端状态 CAS 兜底，风险如实记录）。
   - SSE 流为「有界重放后关闭、客户端按 retry 间隔重连」的轮询式实现（04 §5 的重放/过滤/reset 语义齐备，长连接心跳未做——桌面本地台带宽无压力，如实记录）。
   - 群聊/邮件跨通道隔离的 `thread_key` 复用防扩权沿用第 1 批 router 收紧规则，本批未改。
   - UI 为最小可用实现（桌面优先）；移动端适配与 04 §3 的完整四视图属后续阶段。

## 七、批次边界确认

本批到此为止：**未实施** 5.6 实盘（`evals/phase5/scenarios-real/` 不存在）；未读 `.env`；未 `git push`；D 项公网 webhook 维持关闭；已验收的 Phase 4 仓库分诊闭环与第 1 批 5.1/5.2 能力零回归（全量复跑证据见 §三）。等待独立审计官整批验收后方可进入单元 5.6。
