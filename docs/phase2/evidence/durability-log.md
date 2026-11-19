# Phase 2 test:durability — 迁移器/排他锁/连接初始化/键编码（步骤 2）

生成：2026-11-19T08:26:48.411Z；Node v22.23.5；suite `durability`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | canonical-schema-checksum-matches-pinned | checksum ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995 from D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\reference\schema.sql |
| PASS | fresh-migrate-applies-version-1 | applied [{"version":1,"checksum":"ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995","appliedAt":1795076788662}] |
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
| PASS | lock-first-acquire-ok | pid 24828 holds D:\AegisPi\aegis-pi\workspace-state\phase2\durability-lock\daemon.lock |
| PASS | lock-second-acquire-refused | second acquire refused, heldBy=24828 |
| PASS | dead-pid-probe-says-dead | isPidAlive(400000000)=false |
| PASS | lock-stolen-after-crash-holder | stolen, new pid 24828 |
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
| PASS | crash-ingress-before-file-child-died-before-ack | exit=1 signal=null ack-line=false |
| PASS | crash-ingress-before-file-durable-state-matches-window | inbox rows after kill: 0 (expected 0) |
| PASS | crash-ingress-before-file-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=false state=PENDING", inbox=1 |
| PASS | crash-ingress-inside-txn-child-died-before-ack | exit=1 signal=null ack-line=false |
| PASS | crash-ingress-inside-txn-durable-state-matches-window | inbox rows after kill: 0 (expected 0) |
| PASS | crash-inside-txn-leaves-unreferenced-file-for-gc | unreferenced files: 1 (payload written, activation rolled back) |
| PASS | crash-ingress-inside-txn-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=false state=PENDING", inbox=1 |
| PASS | crash-ingress-after-commit-child-died-before-ack | exit=1 signal=null ack-line=false |
| PASS | crash-ingress-after-commit-durable-state-matches-window | inbox rows after kill: 1 (expected 1) |
| PASS | crash-ingress-after-commit-redelivery-single-durable-row | redelivery exit=0, stdout="ACK inb:telegram:evt-0001 duplicate=true state=PENDING", inbox=1 |
| PASS | dispatch-creates-task-delivery-subscription-routes-inbox | task tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1 state=QUEUED, delivery=PENDING, inbox=ROUTED |
| PASS | recomputed-plan-reuses-same-task | second dispatch created=false, tasks for event=1 |
| PASS | claim-mints-fence-and-active-attempt | claimed task=tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1 attempt=1 fence=1 owner=wkr:24828:1795100010000 |
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
| PASS | crash-dispatch-pre-txn-died-before-dispatch-commit | exit=1 signal=null tasks=0 |
| PASS | crash-dispatch-pre-txn-recomputed-plan-single-task | redelivery exit=0, tasks=1, inbox=ROUTED |
| PASS | crash-dispatch-inside-txn-died-before-dispatch-commit | exit=1 signal=null tasks=0 |
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
| PASS | crash-approval-inside-txn-durable-state | exit=1 effect=WAITING_APPROVAL approval=WAITING task=WAITING_APPROVAL |
| PASS | crash-approval-inside-txn-cas-rolled-back-clean-retry | killed CAS rolled back; the approver's card still decides: effect READY |
| PASS | crash-approval-after-commit-durable-state | exit=1 effect=READY approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-approval-after-commit-retry-idempotent | double-click after crash: already CONSUMED |
| PASS | crash-submitting-before-call-durable-state | exit=1 effect=SUBMITTING approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-submitting-no-remote-bytes | fake remote delivered 0 times while the effect sits SUBMITTING |
| PASS | crash-submitting-recovery-marks-unknown | recovery marked 1 SUBMITTING effect(s) UNKNOWN |
| PASS | crash-submitting-idempotent-reconcile-lands-success | UNKNOWN -> same-key resend -> SUCCEEDED ext-0001; remote applied exactly once |
| PASS | crash-remote-success-unrecorded-durable-state | exit=1 effect=SUBMITTING approval=CONSUMED task=WAITING_EFFECT |
| PASS | crash-remote-success-applied-before-record | remote really holds the action (ext-0001) while the effect row is SUBMITTING |
| PASS | crash-remote-success-recovery-records-no-resend | recovery recorded SUCCEEDED ext-0001 from the lookup; remote still holds exactly one delivery |

合计：109 PASS / 0 FAIL。

数据源：fake 远端与本地 SQLite（无真实外部连接）（fake 远端与录制数据，无真实外部连接）。
