# Selfuse behavior end-to-end

生成：2026-11-24T13:31:21.758Z；Node v22.23.5；suite `selfuse`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | config-recipient-normalization | {"mailSenders":["alice@example.test","DM:Telegram:123"],"mailRecipients":["bob@example.test"],"adapterRecipients":["carol@example.test","dm:telegram:999","group:telegram:-100123"]} |
| PASS | config-owner-destination-valid | {"ownerDestination":"dm:telegram:123","mailPull":1000,"calPull":600000} |
| PASS | config-owner-destination-invalid | expected ConfigError for config-owner-destination-invalid |
| PASS | config-mail-pull-interval-too-low | expected ConfigError for config-mail-pull-interval-too-low |
| PASS | config-calendar-pull-interval-non-int | expected ConfigError for config-calendar-pull-interval-non-int |
| PASS | adapter-mixed-case-validate-intent | {"vOk":{"ok":true,"spec":{"category":"external_write","transport":"real"}},"vBad":{"ok":false,"reason":"recipient Mallory@Example.Test is not on the authorized recipient list"}} |
| PASS | mail-mixed-case-loopback-smtp-dispatch | {"approved":true,"state":"SUCCEEDED","beforeCount":0,"afterCount":1} |
| PASS | followup-evidence-hash-and-destination | {"len":1,"target":"dm:telegram:12345","obxDest":"dm:telegram:12345","manifest":"74a816ec944cbf28b5633fa5485d21dcf224410b362f7a2cefab8a4e49307db6","objHash":"74a816ec944cbf28b5633fa5485d21dcf224410b362f7a2cefab8a4e49307db6"} |
| PASS | followup-non-supersedeable-no-double-push | [{"timerId":"tmr:followup-case-1","skipped":"reminder already live in a non-supersedeable state"}] |
| PASS | selfuse-translate-telegram-commands | {"obsPayload":{"kind":"repo_observe","targetId":"repo1","question":"why?"},"triagePayload":{"kind":"repo_triage","presetId":"preset1","notifyChannel":"dm:telegram:12345","question":"check"},"plainSame":true} |
| PASS | selfuse-format-general-user-prompt | {"tgPrompt":"Summarize status","nonTgPrompt":"{\"kind\":\"mail\",\"text\":\"keep raw\"}"} |
| PASS | selfuse-telegram-auto-reply | {"disabled":{"enqueued":false,"reason":"disabled"},"refusedScope":{"enqueued":false,"reason":"scope_not_eligible"},"enabled":{"enqueued":true,"effectId":"efx:notify%3Adm%253atelegram%253a12345%3Atg-reply%253atsk%253ainb%25253atelegram%25253atg-upd-100%253atg-reply-test","outboxId":"obx:efx:notify%3Adm%253atelegram%253a12345%3Atg-reply%253atsk%253ainb%25253atelegram%25253atg-upd-100%253atg-reply-test"},"repeat":{"enqueued":false,"reason":"already_enqueued"},"verified":{"ok":true,"text":"Task finished cleanly."}} |
| PASS | console-draft-preview-approve-roundtrip | {"sessStatus":200,"detailStatus":200,"extraSubject":"Re: Quarterly status","extraBody":"Thanks, looks good.","decideStatus":200,"effState":"READY","hasResultObjCol":true} |
| PASS | selfuse-cli-init-idempotent-no-secret-leak | {"s1":0,"s2":0,"slots":["im","mail","model"],"grantsOk":true,"timerState":"SCHEDULED","recurrence":{"type":"daily_wall_clock","timeOfDay":"08:30","timezone":"Asia/Hong_Kong"},"leakedCount":0,"run2Out":"init: ok db=D:\\AegisPi\\aegis-pi\\workspace-state\\phase5\\selfuse-cli\\data\\db\\aegis.db slots=model->DEEPSEEK_API_KEY,im->TELEGRAM_BOT_TOKEN,mail->AEGISPI_MAIL_CREDENTIAL scopes=4 grantsAdded=0\ninit: briefingTimer=tmr:selfuse-morning-briefing created=false dueAt=1795566600000"} |
| PASS | scoped-history-chronological-and-isolation | [{"role":"user","content":"First web question"},{"role":"assistant","content":"First web answer"},{"role":"user","content":"Second tg follow-up"},{"role":"assistant","content":"Second tg answer"},{"role":"user","content":"Third recent question"},{"role":"assistant","content":"Third recent answer"},{"role":"user","content":"Current prompt"}] |
| PASS | scoped-history-byte-cap | {"capped":[{"role":"user","content":"Third recent question"},{"role":"assistant","content":"Third recent answer"},{"role":"user","content":"Current prompt"}],"tinyCapped":[{"role":"user","content":"Current prompt"}]} |
| PASS | scoped-history-immediate-drop-on-read-revoke | [{"role":"user","content":"After revoke"}] |
| PASS | console-html-chat-approval-ui-zero-innerhtml-and-favicon | {"faviconStatus":204,"htmlStatus":200,"hasInnerHtml":false} |
| PASS | console-web-chat-roundtrip-and-status-control | {"postStatus":202,"getStatus":200,"chatMsg":{"inboxId":"inb:console-chat:chat-1795527079218-d5ef71bdcc52","source":"console-chat","scopeId":"scp:dm%3Alocal%3Aowner","threadKey":"web:main","receivedAt":1795527079218,"inboxState":"ROUTED","taskId":"tsk:inb%3Aconsole-chat%3Achat-1795527079218-d5ef71bdcc52:web-chat-1","taskState":"SUCCEEDED","resultClass":"affected","userText":"Hello from web chat","replyText":"Hello back from assistant","approval":null},"statusCtrl":{"code":"control_executed","outcome":{"command":"/status","running":0,"queued":0,"waitingApprovals":0,"pendingInbox":0,"paused":false},"scopeId":"scp:dm%3Alocal%3Aowner","threadKey":"web:main"},"inboxDelta":0} |
| PASS | console-approvals-summary-and-redaction | {"listedCard":{"id":"apr:efx:mail%3Adm%253amail%253aowner@example.test%3Areply-9a75f9126749-cfe7d524e570","effect_id":"efx:mail%3Adm%253amail%253aowner@example.test%3Areply-9a75f9126749-cfe7d524e570","state":"WAITING","approver_id":"prn:local:owner","expires_at":1795530679172,"created_at":1795527079172,"actionHashShort":"b32c19f94611","task_id":"tsk:inb%3Amail%3A<redact-1@example.test>:mail-redact","scope_id":"scp:dm%3Amail%3Aowner@example.test","operation":"mail.send","targetResource":"mail:alice@example.test","subject":"Re: Redaction check","bodyPreview":"Approved summary text.","sendingIdentity":"aegispi@local"},"bootstrapDM":null} |
| PASS | console-group-scope-task-steer | {"conflictStatus":409,"okStatus":202,"steerOk":{"code":"queued","inboxId":"inb:console-steer:steer-tsk%3Ainb%253Atelegram%253Atg-group-555%3Agroup-steer-target-716ecf242232","note":"the steer is queued as a durable inbox event; it does not interrupt an in-flight tool call"},"steerInbox":{"scope_id":"scp:group%3Atelegram%3A-100555","source":"console-steer","thread_key":"task:tsk:inb%3Atelegram%3Atg-group-555:group-steer-target"}} |
| PASS | bootstrap-upsert-dotenv-keys | {"rejectedDisallowed":true,"rejectedCtrl":true,"parsedKeys":["UNRELATED_KEEP","DEEPSEEK_API_KEY","TELEGRAM_BOT_TOKEN"],"preservedComment":true} |
| PASS | bootstrap-synthesize-env-vars | {"parsedCred":{"user":"owner@example.test","password":"mail-pass-fake-001"},"clearedPass":true,"clearedUser":true} |
| PASS | bootstrap-ensure-local-config-file | {"firstCreated":true,"failClosed":true,"secondCreated":false} |
| PASS | bootstrap-sync-selfuse-database | {"slots":["im","mail","model"],"sync2Grants":0,"updatedRec":{"type":"daily_wall_clock","timeOfDay":"09:15","timezone":"Asia/Hong_Kong"},"cancelledState":"CANCELLED"} |
| PASS | settings-api-get-auth-and-redaction | {"unauth":401,"bootstrap":401,"badOrigin":403,"owner":200,"secretValuesAllBool":true,"leakedInGet":[]} |
| PASS | settings-api-post-422-validation-no-disk-mutation | {"badStatuses":[422,422,422,422,422],"filesUntouched":true} |
| PASS | settings-api-post-atomic-save-sync-and-reload | {"status":200,"reloadCount":1,"briefing":"07:45","auditCodes":["host_settings_updated","host_secrets_updated"],"auditLeaked":[],"tgScopeGrant":4} |
| PASS | settings-api-connectivity-test-loopback-and-scrubbing | {"modelOk":true,"model401":"auth_failed","tgOk":true,"tg401":"auth_failed","mailOk":true,"imapPassCommands":["LOGIN","SELECT","LOGOUT"],"mailFail":"auth_failed","testScrubOk":true} |
| PASS | selfuse-cold-start-check-and-daemon-check | {"checkMissingStatus":1,"helpStatus":0,"daemonCheckStatus":0,"daemonStdout":"check: mode=open steps=12 disk=ok GREEN"} |
| PASS | console-ui-settings-tab-setup-banner-and-valid-js | {"hasSettingsTab":true,"hasSettingsLabel":true,"hasSetupBanner":true,"hasForbiddenSink":false,"jsValid":true,"jsErr":null} |

合计：31 PASS / 0 FAIL。

数据源：Offline loopback SMTP/IMAP/HTTP/DB fixtures with example.test data only。
