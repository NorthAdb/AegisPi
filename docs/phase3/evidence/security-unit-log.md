# test:security:unit — 确定性安全门禁（02 §8 第一组）

生成：2026-11-19T15:17:18.520Z；Node v22.23.5；suite `security-unit`。

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
| PASS | stale-fence-worker-write-refused | fence-1 heartbeat -> fenced write rejected: task tsk:inb%3Atelegram%3Aevt-su-fenc |
| PASS | unknown-usage-never-settles-never-zero | no usage -> MissingUsage; negative -> MissingUsage; still HELD |
| PASS | charged-bound-conservative-not-release | state=CHARGED_BOUND actual=500 |
| PASS | correction-requires-bill-and-actor | without evidence -> correction requires trusted bill evidence and a re; with bill+actor actual=300 |
| PASS | budget-race-leaves-exactly-one-winner | second reserve -> BudgetExceeded; held=400 spent=0 |
| PASS | frozen-refuses-and-raise-requires-approval | frozen -> account acct:tight is frozen; raise -> raising account acct:day:2026-11-19 limit 1000->10 |
| PASS | missing-scope-closure-filters-before-limit | reader leaked=false; owner sees=true |
| PASS | approval-consume-requires-exact-action-hash | wrong hash -> action hash mismatch; right hash accepted=true; effect=READY |
| PASS | cancel-before-dispatch-refuses-dispatch | dispatch after cancel -> refused |
| PASS | sse-replays-with-cursor-and-resets-on-generation-change | replay ids=2 events=inbox_changed,inbox_changed stale-reset=true unauth=401 |
| PASS | sse-filters-to-caller-scopes-until-granted | own-visible=true foreign-before-grant=false foreign-after-grant=true |
| PASS | no-flag-daemon-tick-settles-no-fabricated-usage | daemon exit=0 settlements=0 worker-reservations=0 (nothing is claimed or settled without the declared fixture flag) |
| PASS | fixture-daemon-tick-settlement-is-labeled-fixture | daemon exit=0 settlements=1 fixture-labeled=true |
| PASS | disk-watermark-critical-drill-opens-read-only | daemon exit=3 disk-line=disk: level=critical free=466GiB ratio=0.5003 |
| PASS | disk-watermark-alerts-once-per-level-transition | transition-alert=true steady-repeat=false audit-rows=1 stream-events=1 |

合计：28 PASS / 0 FAIL。

数据源：本地 SQLite 与真实模块（HMAC 验签、凭据槽位、预算账本、召回查询、审批 CAS、SSE scope 过滤、daemon tick 夹具隔离、磁盘水位 critical 演练）；无容器、无付费网络。
