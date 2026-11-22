# Phase 2 test:durability — 迁移器/排他锁/连接初始化/键编码（步骤 2）

生成：2026-11-22T17:10:31.019Z；Node v22.23.5；suite `durability`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | canonical-schema-checksum-matches-pinned | checksum ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995 from D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\reference\schema.sql |
| PASS | fresh-migrate-applies-version-1 | applied [{"version":1,"checksum":"ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995","appliedAt":1795367376005}] |
| PASS | reference-ddl-shape-27-user-2-fts-8-shadow | sqlite_master: 37 tables (27 user + 10 fts incl. 8 shadow per PI SQLITE probe), 3 trg_msg_* triggers |
| PASS | system-state-seeds-present | system_state rows: [{"key":"schema_version","value":"140"},{"key":"authorization_revision","value":"1"}] |
| PASS | migrate-is-idempotent | second run applied 0 migration(s) |
| PASS | verify-schema-ok-after-migrate | schema_migrations version 1 matches canonical checksum |
| PASS | integrity-ok-on-fresh-db | integrity_check ok, foreign_key_check empty |
| PASS | sqlite-library-floor | sqlite_version()=3.54.1 |
| PASS | connection-pragmas-wal-full-fk | journal=wal synchronous=2 foreign_keys=1 |
| PASS | readonly-connection-refuses-writes | readOnly connection write attempt threw |
| PASS | checksum-gate-fails-closed-on-tampered-sql | SchemaSourceError raised on mismatch |
| PASS | partial-schema-refused-fail-closed | SchemaDriftError raised (no guessing on stray tables) |
| PASS | torn-ddl-rolls-back-to-empty | apply threw=true, leftover tables=0 |
| PASS | lock-first-acquire-ok | pid 14488 holds D:\AegisPi\aegis-pi\workspace-state\phase2\durability-lock\daemon.lock |
| PASS | lock-second-acquire-refused | second acquire refused, heldBy=14488 |
| PASS | dead-pid-probe-says-dead | isPidAlive(400000000)=false |
| PASS | lock-stolen-after-crash-holder | stolen, new pid 14488 |
| PASS | lock-released-and-reacquired | released=true, reacquired=true |
| PASS | canonical-json-key-order-stable | {"a":{"y":[3,2],"z":"x"},"b":1} |
| PASS | canonical-json-rejects-nan | NaN throws |
| PASS | business-key-escaping-separates-objects | notify:user%3a123:k1 != notify:user%3a1%3a23:k1 |
| PASS | dispatch-key-shape-and-lowercase | dispatch_key=telegram:e1 |
| PASS | sha256-lf-normalization | digest 015abd7f5cc57a2d… |
| PASS | admit-persists-inbox-pending | inbox row inb:telegram:evt-100 state=PENDING |
| PASS | payload-object-row-and-own-scope-closure | object obj:scp:dm%3Atelegram%3A1001:464990b1ec477d387405ab57d467b2c7ed0c4fc4a835651d0fcfed8acc58cec4 closure=[{"scope_id":"scp:dm%3Atelegram%3A1001"}] file=true |
| PASS | admit-audit-and-stream-in-same-transaction | audit=["ingress_received"] stream=1 |
| PASS | duplicate-event-returns-success-no-new-rows | duplicate=true inbox 1→1 objects 1→1 |
| PASS | drop-and-observe-go-straight-to-done | DROP inbox inb:telegram:evt-200 state=DONE |
| PASS | no-provider-id-source-dedups-on-envelope-digest | webhook dedup ids: 3cd282a7, 97aa1802 |
| PASS | gc-detects-unreferenced-file | dryRun gc: scanned=4 trashed=1 |
| PASS | gc-moves-unreferenced-keeps-referenced | gc moved 1 file(s), referenced payload still on disk |
| PASS | crash-ingress-before-file-child-died-before-ack | exit=1 signal=null marker=ingress:before-file ack-line=false |
| PASS | crash-ingress-before-file-durable-state-matches-window | inbox rows after kill: 0 (expected 0) |
| PASS | crash-ingress-before-file-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=false state=PENDING", inbox=1 |
| PASS | crash-ingress-inside-txn-child-died-before-ack | exit=1 signal=null marker=ingress:inside-txn ack-line=false |
| PASS | crash-ingress-inside-txn-durable-state-matches-window | inbox rows after kill: 0 (expected 0) |
| PASS | crash-inside-txn-leaves-unreferenced-file-for-gc | unreferenced files: 1 (payload written, activation rolled back) |
| PASS | crash-ingress-inside-txn-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=false state=PENDING", inbox=1 |
| PASS | crash-ingress-after-commit-child-died-before-ack | exit=1 signal=null marker=ingress:after-commit ack-line=false |
| PASS | crash-ingress-after-commit-durable-state-matches-window | inbox rows after kill: 1 (expected 1) |
| PASS | crash-ingress-after-commit-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=true state=PENDING", inbox=1 |
| PASS | dispatch-creates-task-delivery-subscription-routes-inbox | task tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1 state=QUEUED, delivery=PENDING, inbox=ROUTED |
| PASS | recomputed-plan-reuses-same-task | second dispatch created=false, tasks for event=1 |
| PASS | claim-mints-fence-and-active-attempt | claimed task=tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1 attempt=1 fence=1 owner=wkr:14488:1795100010000 |
| PASS | attempt-row-active-with-lease-window | attempt att:tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1:1 state=ACTIVE |
| PASS | one-running-agent-per-scope | claim while scope-1 RUNNING picked other-scope task tsk:inb%3Atelegram%3Aevt-life-2-3:telegram%3Aevt-life-2-3, not tsk:inb%3Atelegram%3Aevt-life-1-2:telegram%3Aevt-life-1-2 |
| PASS | scope-epoch-fence-blocks-claim | task with stale scope_epoch is not claimed |
| PASS | heartbeat-extends-lease | extended to 1795100065000 |
| PASS | wrong-lease-owner-rejected | StaleWorker on foreign lease_owner |
| PASS | stale-fence-write-rejected | StaleWorker on stale fence |
| PASS | worker-step-increments | step_count=1 |
| PASS | step-budget-refuses-beyond-max | ClaimRefused when step_count==max_steps (3/3) |
| PASS | retry-wait-fails-old-attempt-sets-backoff | state=RETRY_WAIT available_at=1795100036000 old attempt=FAILED |
| PASS | retry-claim-mints-new-fence | re-claim attempt=2 fence=2 |
| PASS | success-without-evidence-refused | SUCCEEDED without result_object_id throws |
| PASS | complete-closes-task-and-attempt-with-evidence | task=SUCCEEDED/unaffected attempt=SUCCEEDED |
| PASS | reaper-losts-attempt-and-requeues | reaped=[{"taskId":"tsk:inb%3Atelegram%3Aevt-life-4-5:telegram%3Aevt-life-4-5","attemptNo":1,"finalState":"QUEUED"}] task=QUEUED attempt=LOST |
| PASS | expired-lease-old-worker-cannot-renew-or-submit | old worker heartbeat after reaper: StaleWorker |
| PASS | requeued-task-claims-with-new-fence | re-claim attempt=2 fence=2 |
| PASS | retry-exhaustion-goes-dead-not-loop | final task state=DEAD after attempt 3 |
| PASS | dead-task-records-reason | audit task_dead_retries_exhausted present |
| PASS | delivery-ack-checkpoint-idempotent-and-foreign-checkpoint-refused | ack=ACKED redeliver=duplicate:true different-checkpoint-refused=true |
| PASS | inbox-done-only-when-all-deliveries-terminal | inbox state after single delivery DONE: DONE |
| PASS | dead-delivery-streams-alert-and-closes-inbox | audit_alert rows=1, inbox=DONE |
| PASS | crash-dispatch-pre-txn-died-before-dispatch-commit | exit=1 signal=null marker=router:pre-txn tasks=0 |
| PASS | crash-dispatch-pre-txn-recomputed-plan-single-task | redelivery exit=0, tasks=1, inbox=ROUTED |
| PASS | crash-dispatch-inside-txn-died-before-dispatch-commit | exit=1 signal=null marker=router:inside-txn tasks=0 |
| PASS | crash-dispatch-inside-txn-recomputed-plan-single-task | redelivery exit=0, tasks=1, inbox=ROUTED |
| PASS | propose-parks-attempt-creates-waiting-approval-fence-unchanged | task=WAITING_APPROVAL attempt=PARKED approval=WAITING fence=1 |
| PASS | approval-consume-cas-single-consume | first=true second={"accepted":false,"reason":"already CONSUMED","state":"CONSUMED"} |
| PASS | approval-verification-refuses-wrong-nonce-hash-approver | nonce=nonce mismatch hash=action hash mismatch approver=callback is not the designated approver; approval still WAITING |
| PASS | approval-expiry-refuses-late-callback | late callback: expired |
| PASS | revoked-approver-cannot-consume | revoked approver: approver has no live approve grant |
| PASS | dispatch-succeeds-after-approved-cas | effect SUCCEEDED external=ext-0001 |
| PASS | succeeded-effect-never-resubmits | second dispatch refused; remote applied once for notify:dm%3atelegram%3a60:v1 |
| PASS | rejection-is-normal-terminal-outcome | approval=REJECTED effect=DEAD task=FAILED |
| PASS | edit-invalidates-old-and-mints-new-business-key-version | old notify:dm%3atelegram%3a61:v1 CANCELLED; new notify:dm%3atelegram%3a61:v2-edited-body |
| PASS | draft-to-ready-requires-allowlisted-routine | unlisted routine refused; status-ping promoted to READY |
| PASS | human-approval-effect-cannot-skip-approval | WAITING_APPROVAL effect refuses draftToReady |
| PASS | dispatcher-refuses-stale-epoch | scope epoch bump blocks the CAS |
| PASS | dispatcher-refuses-expired-effect | expiry re-checked inside the CAS transaction |
| PASS | dispatcher-refuses-failed-target-precondition | target resource precondition re-checked inside the CAS |
| PASS | approved-effect-dispatches-after-prechecks-pass | state=SUCCEEDED |
| PASS | at-most-once-unknown-stops-automatic-resend | timeout outcome recorded as UNKNOWN, never success |
| PASS | unknown-never-blind-retried | AT_MOST_ONCE policy=AT_MOST_ONCE: UNKNOWN stops automatic resend; a human may mint a new action; dispatcher refuses UNKNOWN |
| PASS | manual-reconciliation-records-actor-and-evidence | CONFIRMED_NOT_SENT recorded; success claim without evidence/actor refused |
| PASS | idempotency-key-resends-same-key-dedup-remote | apply-then-die -> UNKNOWN -> same-key resend -> SUCCEEDED ext-0001; remote applied exactly once |
| PASS | lookup-then-retry-strong-notfound-resends | strong lookup not-found -> definite resend -> SUCCEEDED |
| PASS | weak-lookup-never-triggers-resend | eventual lookup says not-found while strong says found (ext-0001); the resend decision uses strong only |
| PASS | lookup-recorded-success-from-strong-hit | auto recovery recorded SUCCEEDED ext-0001 from upstream lookup |
| PASS | at-least-once-resend-may-duplicate-declared | apply-then-die -> requeued -> resend SUCCEEDED; remote delivered 2x (mode allows) |
| PASS | zero-byte-local-failure-requeues-and-recover | local error FAILED -> READY -> SUCCEEDED on retry |
| PASS | remote-rejection-never-auto-requeues | known-terminated failure stays terminal; a new action needs a new intent |
| PASS | cancel-before-dispatch-fences-everything | cancel committed first: uncommitted task CANCELLED, READY effect CANCELLED, dispatcher refuses (the consumed approval stays CONSUMED; only WAITING approvals invalidate) |
| PASS | dispatch-committed-first-cancel-reports-committed-pending | cancel after commitment: task stays WAITING_EFFECT, effect retained for reconciliation |
| PASS | single-task-cancel-parks-scope-under-new-epoch | target CANCELLED; peer parked QUEUED at new epoch 2, old attempt closed |
| PASS | parked-peer-reclaims-under-new-epoch | peer reclaimed as attempt 1 |
| PASS | reaper-never-touches-parked-approvals | WAITING_APPROVAL attempts stay PARKED across lease sweeps |
| PASS | crash-approval-inside-txn-durable-state | exit=1 signal=null marker=approvals:inside-txn effect=WAITING_APPROVAL approval=WAITING task=WAITING_APPROVAL |
| PASS | crash-approval-inside-txn-cas-rolled-back-clean-retry | killed CAS rolled back; the approver's card still decides: effect READY |
| PASS | crash-approval-after-commit-durable-state | exit=1 signal=null marker=approvals:after-commit effect=READY approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-approval-after-commit-retry-idempotent | double-click after crash: already CONSUMED |
| PASS | crash-submitting-before-call-durable-state | exit=1 signal=null marker=effects:after-cas-before-call effect=SUBMITTING approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-submitting-no-remote-bytes | fake remote delivered 0 times while the effect sits SUBMITTING |
| PASS | crash-submitting-recovery-marks-unknown | recovery marked 1 SUBMITTING effect(s) UNKNOWN |
| PASS | crash-submitting-idempotent-reconcile-lands-success | UNKNOWN -> same-key resend -> SUCCEEDED ext-0001; remote applied exactly once |
| PASS | crash-remote-success-unrecorded-durable-state | exit=1 signal=null marker=effects:after-call-before-record effect=SUBMITTING approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-remote-success-applied-before-record | remote really holds the action (ext-0001) while the effect row is SUBMITTING |
| PASS | crash-remote-success-recovery-records-no-resend | recovery recorded SUCCEEDED ext-0001 from the lookup; remote still holds exactly one delivery |
| PASS | one-shot-timer-fires-once-idempotent | FIRED occurrence=1, inbox event tmr:one-1:1 PENDING, re-run fired 0 |
| PASS | satisfied-condition-produces-no-event | due scan saw the committed reply: SATISFIED, 0 timer events |
| PASS | reply-first-wins-no-fire | reply committed first: timer SATISFIED, due scan fired 0 |
| PASS | due-first-wins-stale-reminder-cancelled | fire won (1 event, timer FIRED); late reply cannot un-fire; the READY follow-up reminder was cancelled before submission |
| PASS | periodic-timer-advances-occurrences | 2 occurrences, still SCHEDULED, next due 1795800121000 |
| PASS | missed-periods-merge-into-one-catchup | 5 late periods -> 1 catch-up event, missed_count=4 recorded, next due starts fresh |
| PASS | task-conclusion-notification-outbox-one-transaction | task SUCCEEDED, effect READY, outbox row enqueued atomically |
| PASS | finalize-composition-atomic-rollback | missing notification effect FK rolled the whole finalize back: task still RUNNING, attempt still ACTIVE, no half-conclusion |
| PASS | digest-merge-cancels-old-ready-and-links | old READY effect CANCELLED (body never edited), new outbox row supersedes |
| PASS | quiet-window-delays-not-drops | digest row queued behind not_before=1795800002000, delivered only after |
| PASS | expired-notification-cancelled-with-visible-reason | notification expired inside its quiet window: CANCELLED with reason "notification expired before its quiet window opened" |
| PASS | crash-timer-inside-fire-txn-durable-state | exit=1 signal=null marker=timers:inside-fire-txn timer events=0 timer=SCHEDULED |
| PASS | crash-timer-inside-fire-txn-recovery-single-event | reprocess fired=1; final timer events=1, FIRED occurrence=1 |
| PASS | crash-timer-after-fire-commit-durable-state | exit=1 signal=null marker=timers:after-fire-commit timer events=1 timer=FIRED |
| PASS | crash-timer-after-fire-commit-recovery-single-event | reprocess fired=0; final timer events=1, FIRED occurrence=1 |
| PASS | recovery-flagship-submitting-unknown-and-budget-calibrated | exit=1 signal=null marker=effects:after-cas-before-call; mode=open; efx:notify%3Adm%253atelegram%253a5001%3Av1 -> UNKNOWN (per retry_mode or human); res:recovery:stale-held -> CHARGED_BOUND; stale reservation=CHARGED_BOUND |
| PASS | recovery-idempotent-on-rerun | second recovery run open; unknown-marking audited once (1) |
| PASS | job-orphan-outlived-killed-daemon | fake job pid 22704 alive after daemon kill |
| PASS | recovery-kills-orphan-and-losts-job | job LOST, orphan killed=true; job:crash-sim:1->LOST (orphan pid 22704 killed) |
| PASS | outbox-crash-child-died-before-send | exit=1 signal=null marker=scenario:outbox-before-send; finalize committed, send never ran |
| PASS | recovery-resumes-pending-notification | recovery reported due_timers=0 ready_outbox=1 inbox pending/routed=0/1 held_reservations=0; dispatcher completed the notification |
| PASS | recovery-reports-pending-inbox-router-resumes | recovery reported due_timers=0 ready_outbox=0 inbox pending/routed=1/0 held_reservations=0; router created the task from the durable row |
| PASS | missing-object-file-opens-readonly | failedStep=object-references; execution never opened |
| PASS | healthy-database-recovers-open | mode=open, 12 steps all ok |
| PASS | daemon-config-flows-through-the-loader | mapped piSettings.cacheWarming=off; warmingEnabled=false; spec budgets intact |
| PASS | raw-defaults-have-no-top-level-cachewarming | JSON.parse(defaults.json).cacheWarming is undefined — handing raw to SettingsManager would silently read 'idle' |
| PASS | loader-is-what-makes-off-survive | bypass shape={} (Pi would default to idle); loader shape={"cacheWarming":"off"} |
| PASS | daemon-entry-uses-config-module-not-raw-file | config.mjs imports the loader; daemon.mjs imports loadDaemonConfig and never touches defaults.json |
| PASS | daemon-check-boot-green | exit=0; check: mode=open steps=12 disk=ok GREEN |
| PASS | daemon-first-instance-opens | first daemon reached open (pid line: daemon: open (pid 46556) on D:\AegisPi\aegis-pi\workspace-state\phase2\daemon-double-start\db\aegis.db; fake upstream=false; loop every 10000ms) |
| PASS | daemon-second-instance-refuses-lock-exits | second exit=1: another daemon (pid 46556) holds D:\AegisPi\aegis-pi\workspace-state\phase2\daemon-double-start\daemon.lock; refusing to start |
| PASS | daemon-once-smoke-timer-to-settled-task | exit=0; timer=FIRED task=SUCCEEDED/not_applicable delivery=DONE reservation=SETTLED |
| PASS | console-serves-authenticated-local-surface | health=200 snapshot tasks SUCCEEDED=1, task detail attempts=1, recovery mode=open |
| PASS | console-refuses-unauthenticated-and-cross-origin | no token=401, wrong token=401, cross origin=403 |
| PASS | later-phase-endpoints-answer-explicit-not-implemented | replay jobs (a later-phase surface) -> 501 not_implemented_yet; no fake data |
| PASS | readonly-mode-serves-diagnostics-only | recovery 200 (failedStep=object-references); snapshot 503 read_only_maintenance; execution loop never started |
| PASS | pre-migration-backup-holds-pre-apply-state | backups=1, snapshot state=pre-apply (no schema_migrations), integrity=true |
| PASS | no-backup-when-no-migration-pending | restart on a current schema: backups 1->1 |
| PASS | torn-migration-leaves-usable-pre-state-snapshot | apply threw=true; snapshot usable=true with 0 user tables; live db rolled back to 0 tables |
| PASS | snapshot-stays-pre-apply-after-successful-migration | snapshot holds 0 user tables, schema_migrations rows=0; live db has 27 user tables (plus FTS) |
| PASS | daemon-restart-reconciles-idempotency-to-succeeded | exit=1 signal=null marker=effects:after-cas-before-call; daemon --once exit=0; effect=SUCCEEDED external=ext-0001; remote applied exactly once |
| PASS | daemon-restart-stdout-shows-reconcile-action | the daemon log records the reconciliation it performed itself |
| PASS | daemon-restart-idempotency-clears-unknown-exit-zero | daemon --once exit=0 with 0 UNKNOWN row(s) left in the database |
| PASS | daemon-restart-lookup-then-retry-records-hit-no-resend | exit=1 signal=null marker=effects:after-call-before-record; daemon --once exit=0; effect=SUCCEEDED external=ext-0001 (lookup holds ext-0001); remote applied exactly once, no resend |
| PASS | daemon-restart-lookup-reconcile-in-daemon-log | the daemon's own log carries the lookup reconciliation it performed |
| PASS | daemon-restart-at-most-once-stays-unknown | exit=1 signal=null marker=effects:after-call-before-record; daemon --once exit=4; remote really holds the action (ext-0001) yet the daemon keeps UNKNOWN — the mode forbids automatic resend; delivered 1x, no second application |
| PASS | at-most-once-exits-only-through-recorded-human-reconciliation | reconciliation without an actor refused; with actor+evidence the row lands SUCCEEDED ext-0001 |
| PASS | daemon-once-no-upstream-unknown-exit-reflects-state | exit=1 signal=null marker=effects:after-call-before-record; daemon --once exit=4; effect UNKNOWN in the database, remote delivered 1x, log says UNKNOWN stays UNKNOWN without an upstream |
| PASS | scope-epoch-stored-integer-with-numeric-semantics | epoch=1/integer, policy_version=pv1/text, epoch+0=1/integer |
| PASS | misbound-insert-shape-is-exactly-what-the-gate-catches | the old 8-placeholder binding stores typeof=text value=pv1 — the gate above goes red the day that shape returns |
| PASS | writer-refuses-backslash-storage-ref | insertObjectRow rejects a Windows-separator ref at the boundary |
| PASS | gc-keeps-file-referenced-by-legacy-backslash-row | dry-run trashed=0 (legacy backslash ref counts as referenced after normalization); real sweep trashed=0, file still on disk |
| PASS | crash-predicate-accepts-armed-crashpoint-kill | exit=1 signal=null marker=probe:crashpoint — this platform's real SIGKILL self-kill shape |
| PASS | crash-predicate-rejects-uncaught-exception-death | exit=1 signal=null marker=none — same exit shape as the kill, no marker, rejected |
| PASS | crash-predicate-rejects-clean-exit | clean exit 0 while armed is not a crash |

合计：164 PASS / 0 FAIL。

数据源：fake 远端与本地 SQLite（无真实外部连接）（fake 远端与录制数据，无真实外部连接）。
