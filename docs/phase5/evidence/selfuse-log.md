# Selfuse behavior end-to-end

生成：2026-11-24T03:19:20.384Z；Node v22.23.5；suite `selfuse`。

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
| PASS | selfuse-cli-init-idempotent-no-secret-leak | {"s1":0,"s2":0,"slots":["im","mail","model"],"grantsOk":true,"timerState":"SCHEDULED","recurrence":{"type":"daily_wall_clock","timeOfDay":"08:30","timezone":"Asia/Hong_Kong"},"leakedCount":0,"run2Out":"init: ok db=D:\\AegisPi\\aegis-pi\\workspace-state\\phase5\\selfuse-cli\\data\\db\\aegis.db slots=model->DEEPSEEK_API_KEY,im->TELEGRAM_BOT_TOKEN,mail->AEGISPI_MAIL_CREDENTIAL scopes=3 grantsAdded=0\ninit: briefingTimer=tmr:selfuse-morning-briefing created=false dueAt=1795566600000"} |

合计：14 PASS / 0 FAIL。

数据源：Offline loopback SMTP/DB/HTTP fixtures with example.test data only。
