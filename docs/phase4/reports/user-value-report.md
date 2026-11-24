# User-value and verification report

> Generated: 2026-11-24T03:33:18.165Z from verified evidence JSON files; unmeasured quantities stay null / 未测

- status: PASS (327 pass / 0 fail / 327 judged)
- configured budgets: task=800000 microUSD (`$0.80`), day=5000000 microUSD (`$5.00`)
- fail-closed defaults intact (Phase 3 + Phase 5 keys): true
- zero-secret pattern scan: clean over 12 evidence file(s)

## Verified suite evidence

| suite | present | passed | failed | judged | scope |
| --- | --- | --- | --- | --- | --- |
| triage | true | 7 | 0 | 7 | Scenario 4 offline baseline/target triage, oracle verdict, and outbox notify |
| repo-observe | true | 7 | 0 | 7 | Read-only repo observe acquisition, KV prefix ordering, and HELD stop |
| model-proposal | true | 15 | 0 | 15 | Agent->Host pi-ai 1.5.2 state machine T1-T10 and empty reply block |
| security-unit | true | 68 | 0 | 68 | Fail-closed credentials, ACL, budget, console, and Telegram outbound guards |
| offline-jobs | true | 14 | 0 | 14 | Offline container execution, deadlines, cancellation, and oracle gates |
| security-integration | true | 29 | 0 | 29 | Container network, rootfs, symlink, and escape integration matrix |
| memory-lifecycle | true | 47 | 0 | 47 | Memory lifecycle: L0 domains, L1/L2 recall, candidates, forgetting, spill |
| cross-channel | true | 25 | 0 | 25 | Telegram pull cursor, multi-channel canary isolation, control bypass |
| scenarios | true | 89 | 0 | 89 | Scenario 1 mail + Scenario 2 briefing/calendar/timer matrix over loopback TLS fixtures |
| repo-observe-real | true | 8 | 0 | 8 | Unit 4.2 live GitHub + DeepSeek acceptance (if present) |
| triage-real | true | 6 | 0 | 6 | Unit 4.5 live GitHub + DeepSeek + container execution + @aegispibot DM acceptance (if present) |
| scenarios-real | true | 12 | 0 | 12 | Unit 5.6 permit-2 live acceptance: Telegram pull isolation + real mailbox draft/approve/send + CalDAV boundary (if present) |

## Per-scenario user value (no averaging across scenarios)

### scenario1-mail

- benefit: 收件箱只读拉取后自动分诊并停在草稿审批：伪造显示名拒之门外、收件人/附件被篡改即拦截、审批一次点击后才发恰 1 封、DATA 后断流绝不自动重发
- judged evidence: 40 pass / 0 fail / 40 judged, of which interception-type assertions 12
- live (unit 5.6): status=VERIFIED (finalized from kept workspace; originating log cited) draftChars=280 smtpSends=1
- approval path: console-api 127.0.0.1:4310 (session+CSRF CAS) (consumed=true)

### scenario2-briefing-calendar-timer

- benefit: 带时区条件跟进 Timer 只在真联系人回信未到时提醒一次；晨报合并静默时段；日历写入必须带 If-Match ETag，远端已改即 412 转重审、绝不覆盖
- judged evidence: 38 pass / 0 fail / 38 judged, of which interception-type assertions 5
- live (unit 5.6): calendarStatus=DEFERRED / NOT VERIFIED
- calendar boundary: CALDAV_* 未配置；主人裁定（D-102）：真实日历实盘延后，不阻塞 Phase 5；场景二闭环已由 Permit 1 环回 TLS 夹具（eval:scenarios）验收在案

### scenario3-cross-channel-isolation

- benefit: 群聊任务永远读不到私聊内容：Canary 在 9 个派生环节零命中，跨群外发在建行与分发两层都被 CP4 击杀，/stop 秒级直达
- judged evidence: 25 pass / 0 fail / 25 judged, of which interception-type assertions 13
- live (unit 5.6): status=VERIFIED (finalized from kept workspace; originating log cited) offsetAfter=500045908 canary=dm-home-only

### scenario4-repo-triage

- benefit: 依赖公告进私聊即自动出裁定卡：真实容器双跑对比、四类裁定全由宿主事实决定、结论直达 @aegispibot 私聊
- judged evidence: 7 pass / 0 fail / 7 judged, of which interception-type assertions 2
- live (unit 4.5): cases=5 settledPeakMicrousd=12225

### memory-lifecycle

- benefit: 跨域记忆互不串读、候选/冲突留人裁决、撤权即时失效、遗忘级联清干净且备份恢复不复活、超限输出进受 ACL 的 Spill
- judged evidence: 47 pass / 0 fail / 47 judged, of which interception-type assertions 24
- live: 不适用（记忆生命周期属本机离线能力，无外部通道）

## Per-purpose cost attribution (untested purposes stay 未测/null)

| purpose | tested | requests | settledMicrousd | upperMicrousd | cacheReadTokens | cacheWriteTokens |
| --- | --- | --- | --- | --- | --- | --- |
| worker | measured | 6 | 12708 | 50000 | 0 | 0 |
| router | 未测 | null | null | null | null | null |
| summary | 未测 | null | null | null | null | null |
| classify | 未测 | null | null | null | null | null |

## Live acceptance record (unit 5.6, permit 2)

- scenarios-real evidence: generated 2026-11-23T13:03:35.335Z (docs/phase5/evidence/scenarios-real-report.json)
- telegram: status=VERIFIED (finalized from kept workspace; originating log cited) offsetAfter=500045908 canary=dm-home-only
- mail: status=VERIFIED (finalized from kept workspace; originating log cited)
- calendar: status=DEFERRED / NOT VERIFIED

