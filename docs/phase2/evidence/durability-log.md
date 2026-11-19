# Phase 2 test:durability — 迁移器/排他锁/连接初始化/键编码（步骤 2）

生成：2026-11-19T07:57:31.946Z；Node v22.23.5；suite `durability`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | canonical-schema-checksum-matches-pinned | checksum ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995 from D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\reference\schema.sql |
| PASS | fresh-migrate-applies-version-1 | applied [{"version":1,"checksum":"ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995","appliedAt":1795075044856}] |
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
| PASS | lock-first-acquire-ok | pid 15700 holds D:\AegisPi\aegis-pi\workspace-state\phase2\durability-lock\daemon.lock |
| PASS | lock-second-acquire-refused | second acquire refused, heldBy=15700 |
| PASS | dead-pid-probe-says-dead | isPidAlive(400000000)=false |
| PASS | lock-stolen-after-crash-holder | stolen, new pid 15700 |
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
| PASS | claim-mints-fence-and-active-attempt | claimed task=tsk:inb%3Atelegram%3Aevt-life-1-1:telegram%3Aevt-life-1-1 attempt=1 fence=1 owner=wkr:15700:1795100010000 |
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

合计：68 PASS / 0 FAIL。

数据源：fake 远端与本地 SQLite（无真实外部连接）（fake 远端与录制数据，无真实外部连接）。
