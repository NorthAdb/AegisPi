# phase5:scenarios-real — 单元 5.6 许可 2 实盘验收（终局 finalize：自保留工作区只读重推 + 原始运行日志引用）

生成：2026-11-23T13:03:35.335Z；Node v22.23.5；suite `scenarios-real`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | finalize-tg-canary-dm-home-only | kept tg workspace: canary DM payload objects=1, group canary hits=0, canary in ALL object files=1, foreign-scope telegram inbox rows=0 |
| PASS | finalize-tg-group-reader-refused-dm-canary | kept grant state: group-scope walk serves its own payload (objects=1); the same principal walking the DM canary object is refused (objects=0, skipped=1) |
| PASS | finalize-tg-cp4-block-recorded | kept tg workspace: cp4 audit rows=1, im.notify effect rows=0 |
| PASS | finalize-tg-offset-persisted | kept telegram_pull_offset=500045908 |
| PASS | finalize-tg-receipts-clean | kept tg audit: canary=false, token=false |
| NOTE | finalize-tg-flow-cited-from-originating-log | originating-run log .audit/batch3-real-run-4.log: PASS lines 1-18: fail-closed gate probe, flush/window/replay rounds=3 within the permit cap, group admission, zero unauthorized persistence, receipt scan |
| PASS | finalize-mail-inbox-admitted-redacted | kept mail workspace: admitted inbox row present; envelopeFrom=[REDACTED_MAIL_ADDRESS]; redacted subject="[NorthAdb/Piper] Run failed: Upstream su" |
| PASS | finalize-mail-draft-bound-to-action | kept draft evidence: body chars=280, action content_hash matches sha256(bodyText)=true, mail_draft evidence row present (yes); the mail_draft/effect_response rows are hash-bound hollow references by product design — their bytes live in action_json, so the draft text is re-derived from there |
| PASS | finalize-mail-budget-settled | kept reservation SETTLED actual=483u$ (upper 50000u$), budget_settled audit carries the identical actual (483); the four-field TOKEN counts were judged live in the originating log (usage-4field=true, in/out=175/358) |
| PASS | finalize-mail-approval-consumed-via-console-cas | kept approvals: CONSUMED card bound to the mail effect (approver=prn:local:owner), approval_consumed audit rows=1; the console session+CSRF flow is cited in the originating log |
| PASS | finalize-mail-effect-succeeded-external-id-recorded | kept effects: mail.send rows=1 (SUCCEEDED=1, attempts=1); external_id=<5fa4c939a025d8760b773ed7616d77ae66cfdd9a8a8 identical in the effect row and the effect_succeeded audit; effect_response reference row present (yes — hash-bound hollow row by product design, no file bytes) |
| PASS | finalize-mail-task-waiting-effect-attempt-parked | kept task state=WAITING_EFFECT, attempt=PARKED (the park survived; only the daemon's post-effect completion step is not part of this composed acceptance) |
| NOTE | finalize-mail-flow-cited-from-originating-log | originating-run log .audit/batch3-real-run-4.log: PASS lines 19-28: IMAP over TLS pull of 10 messages, envelope-sender admission, DeepSeek draft (reasoning:high), console session+CSRF consume=true (CONSUMED), smtp submits=1 with external_id recorded |
| PASS | finalize-defaults-json-still-fully-fail-closed | repo defaults.json untouched (model / telegram-pull / mail / calendar gates all closed) |

合计：12 PASS / 0 FAIL。

数据源：终局 finalize（--finalize-kept-workspace）：对第 4 次实盘运行（23/23 全 PASS、真实 SMTP 已发恰 1 封）因 Windows 收尾 EBUSY 崩溃未及重写的证据，从保留工作区只读重推全部可由状态验证的断言；零网络/零模型/零 SMTP 调用；全程脱敏；真实 CalDAV 按 D-102 登记 DEFERRED / NOT VERIFIED。
