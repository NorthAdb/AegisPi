# Phase 5 Batch 2 scenarios (5.3 mail + 5.4 timers/calendar/dreaming, loopback TLS fixtures)

生成：2026-11-24T13:31:04.086Z；Node v22.23.5；suite `scenarios`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | child-entries-never-imported-by-host | all 58 host modules import none of the 6 child entry scripts (static single/double-quote, re-export and dynamic import) |
| PASS | 5.3-0a pull-fails-closed-without-flag | mail.allowRealMailRead is false; zero IMAP calls |
| PASS | 5.3-0b pull-fails-closed-without-host | mail.imapHost is null; zero IMAP calls (fail closed) |
| PASS | 5.3-0c loopback-pull-fetches-over-tls | fetched=2 |
| PASS | 5.3-0d attachment-sha256-computed | afa27b44d43b02a9fea41d13cedc2e4016cfcf87c5dbf990e593669aa8ce286d |
| PASS | 5.3-1a display-name-forgery-refused | {"admitted":false,"reason":"sender not allowed"} |
| PASS | 5.3-1b no-principal-created-for-refused-mail | zero persistence for refused sender |
| PASS | 5.3-2a scope-is-dm-mail-account | scp:dm%3Amail%3Aowner@example.com |
| PASS | 5.3-2b thread-key-from-references-root | mail:<thread-root@example.com> |
| PASS | 5.3-2c payload-redacts-secrets-and-keeps-sha256 | summary-redacted=true sha=afa27b44d4… |
| PASS | 5.3-2d display-name-never-principal | contact:erin@example.com |
| PASS | 5.3-3a proposal-parks-task-and-attempt | task=WAITING_APPROVAL attempt=PARKED lease=null |
| PASS | 5.3-3b fence-not-bumped-on-park | fence=1 before=1 |
| PASS | 5.3-3c effect-waiting-with-approval-card | state=WAITING_APPROVAL approval=apr:efx:mail%3Adm%253amail%253aowner@example.com%3Areply-2ae81a77a095-1068de82abd8 |
| PASS | 5.3-3d at-most-once-retry-mode | AT_MOST_ONCE |
| PASS | 5.3-4a park-survives-restart | {"attempt_state":"PARKED","task_state":"WAITING_APPROVAL"} |
| PASS | 5.3-5a first-approve-consumes | {"accepted":true,"state":"CONSUMED","effectState":"READY","taskState":"WAITING_EFFECT"} |
| PASS | 5.3-5b double-approve-idempotent | {"accepted":false,"reason":"already CONSUMED","state":"CONSUMED"} |
| PASS | 5.3-6a dispatch-succeeded | {"state":"SUCCEEDED","externalId":"<1f837eafd5706f9f46c8721da114e89f6d6c4c36d0ceaf05604f51e9d299d552@aegispi.local>"} |
| PASS | 5.3-6b smtp-sent-exactly-one | messages=1 before=0 |
| PASS | 5.3-6c external-id-recorded | {"external_id":"<1f837eafd5706f9f46c8721da114e89f6d6c4c36d0ceaf05604f51e9d299d552@aegispi.local>","state":"SUCCEEDED"} |
| PASS | 5.3-7a cp4-blocks-cross-scope-mail-payload | proposal refused with cp4_recipient_scope_leak gate |
| PASS | 5.3-7b unauthorized-recipient-refused-pre-row | ["recipient stranger@example.org is not on mail.allowedRecipients"] |
| PASS | 5.3-7c sending-identity-is-fixed | ["sending identity spoof@elsewhere.example is not the configured fixed identity aegispi@local"] |
| PASS | 5.3-7d malformed-attachment-hash-refused | ["attachment x.pdf has no SHA-256"] |
| PASS | 5.3-8a group-task-cannot-read-mail-thread | group principal read on mail scope=false |
| PASS | 5.3-9a revise-mints-new-card | new=apr:efx:mail%3Adm%253amail%253aowner@example.com%3Areply-2ae81a77a095-5a41d32a92ee~rev1 |
| PASS | 5.3-9b old-approval-dead-after-revise | {"accepted":false,"state":"INVALIDATED","reason":"already INVALIDATED"} |
| PASS | 5.3-9c edited-body-sent | state=SUCCEEDED messages=2 |
| PASS | 5.3-9d edit-receipt-recorded | edited send receipt recorded |
| PASS | 5.3-10a reject-ends-task-no-retry | effect=DEAD task=FAILED |
| PASS | 5.3-10b four-hour-ttl-expires | approval=EXPIRED effect=CANCELLED |
| PASS | 5.3-10c zero-sends-after-reject-or-expiry | messages=2 |
| PASS | 5.3-11a data-break-lands-unknown | UNKNOWN |
| PASS | 5.3-11b at-most-once-never-auto-resends | {"action":"none","reason":"AT_MOST_ONCE: UNKNOWN stops automatic resend; a human may mint a new action"} |
| PASS | 5.3-11c daemon-tick-keeps-unknown-durable | messages=3 |
| PASS | 5.3-11d confirmed-success-needs-external-id | CONFIRMED_SUCCESS requires the external id from the evidence |
| PASS | 5.3-11e human-reconcile-resolves | {"effectId":"efx:mail%3Adm%253amail%253aowner@example.com%3Areply-2ae81a77a095-eb24ae8d9b6d","resolution":"CONFIRMED_SUCCESS","state":"SUCCEEDED"} |
| PASS | 5.3-11f pre-data-auth-refusal-fails-without-send | definitive server refusal (no message bytes of consequence; not requeueable): AUTH refused (535/500) |
| PASS | 5.3-12a data-granted-then-silent-drop-lands-unknown | dispatch=UNKNOWN err= |
| PASS | 5.3-12b at-most-once-zero-auto-resend-after-354-drop | recover=[none,none] messages=4 after-dispatch=4 (zero resends beyond the single delivered attempt) |
| PASS | 5.4-1a bot-self-bounce-never-satisfy | {"satisfied":false,"evidence":null} |
| PASS | 5.4-1b real-contact-reply-satisfies | {"satisfied":true,"evidence":"inb:mail:<real-1>"} |
| PASS | 5.4-1c wrong-sender-does-not-satisfy | {"satisfied":false,"evidence":null} |
| PASS | 5.4-2a timer-satisfied-not-fired | satisfied=1 fired=0 |
| PASS | 5.4-3a five-period-restart-merges-once | fired=1 missed=4 |
| PASS | 5.4-3b next-due-back-on-wall-clock | 2026-11-26T08:00:00 |
| PASS | 5.4-4a dst-jump-keeps-wall-clock | nextDue=1805115600000 wall=2027-03-15T09:00:00 (EDT=13:00Z) |
| PASS | 5.4-5a read-revocation-cascades-cancel | CANCELLED |
| PASS | 5.4-5b scope-pause-cascades-cancel | CANCELLED |
| PASS | 5.4-6a briefing-carries-structured-sections | events=0 approvals=0 timers=0 alerts=0 |
| PASS | 5.4-6b briefing-excludes-foreign-scope-approvals-and-alerts | leaked approvals=0 leaked alerts=0 |
| PASS | 5.4-7a calendar-pull-fails-closed-without-flag | calendar.allowRealCalendarRead is false; zero CalDAV calls |
| PASS | 5.4-7b calendar-pull-stores-events-with-etag | {"fetched":1,"stored":1,"scopeId":"scp:dm%3Acalendar%3Apersonal"} |
| PASS | 5.4-7c event-meta-carries-tzid-summary-attendee | {"summary":"Design review","tz":"Asia/Hong_Kong","attendee":"erin@example.com","etag":"4ad9ad65b339b1f7"} |
| PASS | 5.4-7d tzid-anchored-to-hkt-wall-clock | 2026-11-23T10:00:00 |
| PASS | 5.4-8a write-proposal-pins-etag | state=WAITING_APPROVAL |
| PASS | 5.4-8b if-match-write-succeeds | {"state":"SUCCEEDED"} |
| PASS | 5.4-8c server-required-if-match | {"putCount":1,"putWithoutIfMatch":0,"fourTwelves":0} |
| PASS | 5.4-9a remote-edit-changes-etag | new=8a64d0c8b477697d |
| PASS | 5.4-9b head-mismatch-refused-before-send | AdapterRefused(head_changed) |
| PASS | 5.4-9c zero-silent-overwrite | fourTwelves=0 remoteIntact=true |
| PASS | 5.4-9d head-change-mints-fresh-card | new=apr:efx:calendar%3Adm%253acalendar%253apersonal%3Aevt-1-move-2~rev1 pinned=8a64d0c8b477697d |
| PASS | 5.4-9e reapproved-write-succeeds-on-fresh-etag | {"state":"SUCCEEDED"} |
| PASS | 5.4-10a server-412-lands-failed-head-changed | {"state":"FAILED","last_error":"head_changed: server returned 412 Precondition Failed; the remote calendar changed under the approved action"} |
| PASS | 5.4-10b 412-counted-remote-untouched-by-that-put | {"putCount":3,"putWithoutIfMatch":0,"fourTwelves":1} |
| PASS | 5.4-10c 412-repropose-mints-fresh-card | {"newApprovalId":"apr:efx:calendar%3Adm%253acalendar%253apersonal%3Aevt-1-move-3~head2","pinnedHead":"6deb756f53d0d27b","taskReparked":true} |
| PASS | 5.4-11a dreaming-skips-outside-quiet-hours | outside quiet hours; the dreaming loop runs only inside the window |
| PASS | 5.4-11b dreaming-runs-inside-quiet-hours | {"expired":["obj:scp:dm%3Atelegram%3A701:d744c0fe05a1abda4e0326151097d3b06056577ff358210c6b4b8463df5993c8"],"mergeSuggestions":["obj:scp:dm%3Atelegram%3A701:31e |
| PASS | 5.4-11c expired-fact-archived | expired |
| PASS | 5.4-11d merge-suggestion-proposed-same-scope | [{"scope":"scp:dm%3Atelegram%3A701","type":"merge_candidates"}] |
| PASS | 5.4-11e forbidden-category-never-touched | identity category untouched |
| PASS | 5.4-11f stale-conflict-alerted | alerts=2 |
| PASS | 5.4-11g dreaming-never-auto-activates | candidate |
| PASS | 5.4-11h cross-scope-never-mixed | scopeB suggestions=0 mixed=false |
| PASS | 5.4-12a independent-summary-budget-reserved-and-settled | {"purpose":"summary","state":"SETTLED","actual_microusd":0} |
| PASS | 5.4-12b frozen-budget-refuses-pass | summary-purpose reservation refused (account acct:day:2026-11-22 is frozen); the pass runs only under its independent bu |
| PASS | 5.4-12c no-ledger-pass-refused-and-audited | skipped=no budget ledger; the dreaming pass runs only under its independent summary-purp refused-audits=2 |
| PASS | 5.4-12d expired-suggestion-never-re-proposed | rerun suggestions=0 merge_audits=1->1 |
| PASS | F-1 mail-defaults-fail-closed | {"imapHost":null,"imapPort":993,"imapTls":true,"smtpHost":null,"smtpPort":465,"smtpTls":true,"allowRealMailRead":false,"allowRealMailSend":false,"allowedFolders":["INBOX"],"allowedSenders":[],"allowedRecipients":[],"pullIntervalMs":15000,"autoDraftReplies":false,"approvalTtlMs":14400000,"maxAttachmentBytes":4194304} |
| PASS | F-2 calendar-defaults-fail-closed | {"caldavUrl":null,"allowRealCalendarRead":false,"allowRealCalendarWrite":false,"allowedCalendars":[],"pullIntervalMs":30000,"defaultTimezone":"Asia/Hong_Kong","quietHours":{"start":"23:00","end":"07:00","timezone":"Asia/Hong_Kong"}} |
| PASS | F-3 budgets-unchanged | {"taskLimitMicrousd":800000,"taskMaxSteps":25,"taskMaxWallClockMs":900000,"dayLimitMicrousd":5000000,"purposes":["router","worker","summary","classify","rsi","replay","warming","watchdog"],"cacheWarming":"off","warmingEnabled":false} |
| PASS | F-4 policy-external-writes-still-closed | false |
| PASS | F3-1 daemon-pull-lands-inbox-payloads-tasks | exit=0 mail_rows=3 no-id-key=true payloads=4 tasks=5 |
| PASS | F3-2 no-message-id-mail-deterministic-key | mail:no-id-1431d20024f3902a8f7bec2a |
| PASS | F3-3 fired-followup-timer-becomes-ready-reminder-outbox | exit=0 outbox=obx:efx:notify%3Adm%25253amail%25253aowner@example.com%3Afollowup%253atmr%253adaemon-f6 effect=CANCELLED (the in-run reply may already have triggered the stale cancellation) |
| PASS | F3-4 fired-briefing-timer-becomes-ready-digest-outbox | exit=0 outbox=obx:efx:notify%3Adm%25253amail%25253aowner@example.com%3Abriefing%253atmr%253adaemon-brief%253abeat1 effect=READY digest_payloads=2 |
| PASS | F3-5 re-pull-dedups-no-id-mail | exit=0 mail_rows=3 (the re-fetched no-ID mail must dedup on its fallback key) |
| PASS | F3-6 reply-lands-stale-reminder-cancelled | exit=0 effect=CANCELLED err=follow-up condition satisfied; stale reminder cancelled audits=1 |

合计：89 PASS / 0 FAIL。

数据源：本地环回 TLS SMTP/IMAP/CalDAV 夹具（独立 helper 进程）；零真实邮箱/日历/模型/Telegram 调用。
