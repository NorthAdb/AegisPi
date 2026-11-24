# test:security:unit — 确定性安全门禁（02 §8 第一组）

生成：2026-11-24T13:20:15.874Z；Node v22.23.5；suite `security-unit`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | cp1-valid-signature-passes | HMAC-SHA256 over canonical LF bytes |
| PASS | cp1-tampered-payload-rejected | tampering -> SignatureInvalid |
| PASS | cp1-missing-secret-fails-closed | unconfigured source -> SecretNotConfigured (refuse, never skip) |
| PASS | cp1-stale-timestamp-rejected | 1h-old event -> TimeWindowExceeded |
| PASS | cp1-duplicate-provider-event-collapses | first=false second=true inbox_rows=1 |
| PASS | credential-register-and-resolve | slot resolves from the host env store |
| PASS | credential-unknown-slot-refuses | -> slot no.such.slot is not registered |
| PASS | credential-rotation-points-at-new-value | rotated slot reads the new env name |
| PASS | credential-revocation-fails-closed-at-adapter | resolve.ok=false submit=failed_local (adapter refused: real external write for im.notify has no wi) |
| PASS | credential-values-never-in-audit | leakA=false leakB=false |
| PASS | roles-read-does-not-imply-approve | a read grant never approves anything |
| PASS | console-grant-changes-require-admin-not-approve | approve-only session -> 403 forbidden |
| PASS | console-admin-revocation-takes-effect-immediately | admin revoke -> 200; reader read grant gone=true |
| PASS | routine-list-real-row-200 | status=200 rows=1 |
| PASS | routine-auto-without-review-ref-422 | status=422 body={"code":"invalid_field","message":"switching to auto requires reviewReportRef (a human-approved review record)"} |
| PASS | routine-stale-expected-revision-409 | status=409 body={"code":"conflict","message":"revision moved","currentRevision":1} |
| PASS | routine-observe-to-auto-200 | status=200 body={"routineId":"obj:scp:dm%3Atelegram%3A6101:ef63cd9311daf8cda69d1aaf8624395c01614950db6ab10fb9ae99fe8922f79a","mode":"auto","autoStillApprove |
| PASS | routine-mode-persisted-with-review-ref | {"routineId":"rt-weekly-digest","mode":"auto","policyVersion":"pv1","reviewReportRef":"review:2026-11-22"} |
| PASS | stale-fence-worker-write-refused | fence-1 heartbeat -> fenced write rejected: task tsk:inb%3Atelegram%3Aevt-su-fenc |
| PASS | unknown-usage-never-settles-never-zero | no usage -> MissingUsage; negative -> MissingUsage; still HELD |
| PASS | charged-bound-conservative-not-release | state=CHARGED_BOUND actual=500 |
| PASS | correction-requires-bill-and-actor | without evidence -> correction requires trusted bill evidence and a re; with bill+actor actual=300 |
| PASS | budget-race-leaves-exactly-one-winner | second reserve -> BudgetExceeded; held=400 spent=0 |
| PASS | frozen-refuses-and-raise-requires-approval | frozen -> account acct:tight is frozen; raise -> raising account acct:day:2026-11-24 limit 1000->10 |
| PASS | missing-scope-closure-filters-before-limit | reader leaked=false; owner sees=true |
| PASS | approval-consume-requires-exact-action-hash | wrong hash -> action hash mismatch; right hash accepted=true; effect=READY |
| PASS | cancel-before-dispatch-refuses-dispatch | dispatch after cancel -> refused |
| PASS | sse-replays-with-cursor-and-resets-on-generation-change | replay ids=2 events=inbox_changed,inbox_changed stale-reset=true unauth=401 |
| PASS | sse-filters-to-caller-scopes-until-granted | own-visible=true foreign-before-grant=false foreign-after-grant=true |
| PASS | no-flag-daemon-tick-settles-no-fabricated-usage | daemon exit=0 settlements=0 worker-reservations=0 (nothing is claimed or settled without the declared fixture flag) |
| PASS | fixture-daemon-tick-settlement-is-labeled-fixture | daemon exit=0 settlements=1 fixture-labeled=true |
| PASS | http-transport-carries-bytes-and-maps-outcomes | submit=succeeded(ext-1795526249595) lookup=true/true head=true dead=failed_local slow=unknown wire-seen=4 — dead is failed_local before any byte, hanging is unknown after the deadline |
| PASS | authorized-production-tick-submits-over-real-http-transport | daemon exit=0 effect=SUCCEEDED/ext-1795526254596 local-service-saw=true |
| PASS | unauthorized-production-tick-sends-zero-bytes-through-real-transport | daemon exit=0 effect=FAILED zero-bytes=true adapter-refused-audits=1 |
| PASS | not-yet-due-effect-is-not-dispatched-even-when-authorized | daemon exit=0 effect=READY due-in=54175ms submitting-audits=0 zero-bytes=true (authorization without due time sends nothing) |
| PASS | dispatcher-refuses-before-due-time-and-commits-at-it | early -> effect efx:notify%3Adm%253atelegram%253a6101%3Acase-su-dispa still=READY submitting-audits-before=true due -> SUCCEEDED/SUCCEEDED deliveries=1 |
| PASS | telegram-outbound-transport-fail-closed-and-secret-hygiene | ok=SUCCEEDED(tg:6101:9001) group=SUCCEEDED(tg:-100999:9001) empty=FAILED mismatch=FAILED policyOff=FAILED realBlocked=FAILED revoked=FAILED slow=UNKNOWN remote=FAILED leakFree=true |
| PASS | telegram-outbound-connect-proxy-and-fail-closed | proxy=SUCCEEDED(connects=1) badCfgExit=2 deadProxy=FAILED(local_error: connect ECONNREFUSED 127.0.0.1:61807 ) leakFree=true |
| PASS | telegram-outbound-tls-connect-proxy-and-pre-http-fail-closed | tlsOk=SUCCEEDED ipSan=SUCCEEDED(httpsHits=1,proxyHits=1/5) badCert=FAILED(local_error: self-signed certificate (DEPTH_Z) eof=FAILED(3773ms) p407=FAILED leakFree=true |
| PASS | worker-reserves-before-call-and-settles-real-usage | daemon exit=0 req=SETTLED reservation=SETTLED settled=100 microusd source=pi-ai wire=/chat/completions/deepseek-flash/thinking=enabled ordering[created=1795526370025 at=1795526376261 settled=1795526376393] |
| PASS | worker-no-usage-keeps-reservation-held-never-zero | daemon exit=0 req=HELD reservation=HELD settlements=0 not-settled-audits=1 |
| PASS | worker-unauthorized-price-catalog-keeps-reservation-held | daemon exit=0 req=HELD reservation=HELD settlements=0 price-not-authorized-audits=1 |
| PASS | worker-refuses-unauthorized-endpoint-before-any-call | daemon exit=0 reqRow=absent reservations=0 honest-log=true |
| PASS | worker-unwired-credential-slot-fails-closed-before-http | daemon exit=0 req=EXECUTING reservation=HELD http-hits=0 failed-audits=1 |
| PASS | webhook-without-secret-fails-closed | http=503 inbox-rows=0 (503 webhook_not_configured, zero processing) |
| PASS | webhook-missing-or-wrong-secret-refused-without-processing | missing=403 wrong=403 inbox-rows=0 (the constant-time guard refuses, zero queue writes) |
| PASS | webhook-valid-signature-queues-observe-without-consuming | first=202 redelivery=202 inbox=DONE/OBSERVE dedup=true tasks=0 (recorded as a read-only OBSERVE, never dispatched by the webhook itself — same semantics as the pull path) |
| PASS | webhook-closed-in-read-only-maintenance | http=503 inbox-rows=0 |
| PASS | disk-drill-seam-may-only-tighten-never-loosen | warn 0.001 -> refused; critical 5 -> refused; critical 25 alone -> refused; warn 25 + critical 12 -> accepted |
| PASS | daemon-refuses-to-start-on-loosened-drill-seam | daemon exit=2 line=config: refusing to start — AEGISPI_DISK_DRILL_WARN_GIB may only tighten the watermark (production warn is 20  |
| PASS | disk-watermark-critical-drill-opens-read-only | daemon exit=3 disk-line=disk: level=critical free=443GiB ratio=0.4755 |
| PASS | disk-watermark-alerts-once-per-level-transition | transition-alert=true steady-repeat=false audit-rows=1 stream-events=1 |
| PASS | downloader-ssrf-ip-literal-and-dot-relpath-refused | blocked=5 reasons=refused non-public IP address 169.254.169.254 | refused non-public IP address 10.0.0.1 | refused non-public IP address 127.0.0.1 | refused non-public IP address ::ffff:a9fe:a9fe | refused non-public IP address fe80::1 |
| PASS | 55-page-200-html-and-cross-host-403 | 200 text/html; charset=UTF-8 crossHost=403 |
| PASS | 55-page-no-innerhtml-no-token-no-external-assets | bytes=97329 tokenLeaked=false |
| PASS | 55-session-mint-and-mutation-guard | 200 |
| PASS | 55-bootstrap-token-cannot-mutate | 401 |
| PASS | 55-xss-fact-quarantined-not-activatable | quarantined=hidden_html_or_comment (the API returns JSON; the UI renders via textContent only) |
| PASS | 55-quarantined-activation-refused | 409 |
| PASS | 55-revision-cas-409-then-activate-works | 409/200 status=active |
| PASS | 55-reject-archives-candidate | 200 status=expired |
| PASS | 55-forget-two-phase-with-manifest | 200 status=deleted manifest=true |
| PASS | 55-object-404-uniform-no-existence-oracle | 404/404 |
| PASS | 55-object-paging-bounded | len=100/100 total=3000 |
| PASS | 55-steer-request-grant-then-202-queued | 403/202 inbox=PENDING |
| PASS | 55-budget-bypurpose-arithmetic-matches-ledger | summary=250/250 routerBound=100/100 cache=unmeasured-null |
| PASS | 55-trace-timeline-and-unknown-annotation | stages=4 unconfirmed=true |
| PASS | 55-phase6-501-not-implemented | 501 not_implemented_yet |

合计：68 PASS / 0 FAIL。

数据源：本地 SQLite 与真实模块（HMAC 验签、凭据槽位、预算账本、召回查询、审批 CAS、SSE scope 过滤、daemon tick 夹具隔离、磁盘水位 critical 演练）；无容器、无付费网络。
