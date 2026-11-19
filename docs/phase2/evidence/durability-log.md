# Phase 2 test:durability — 迁移器/排他锁/连接初始化/键编码（步骤 2）

生成：2026-11-19T07:41:43.199Z；Node v22.23.5；suite `durability`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | canonical-schema-checksum-matches-pinned | checksum ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995 from D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\reference\schema.sql |
| PASS | fresh-migrate-applies-version-1 | applied [{"version":1,"checksum":"ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995","appliedAt":1795074102675}] |
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
| PASS | lock-first-acquire-ok | pid 26500 holds D:\AegisPi\aegis-pi\workspace-state\phase2\durability-lock\daemon.lock |
| PASS | lock-second-acquire-refused | second acquire refused, heldBy=26500 |
| PASS | dead-pid-probe-says-dead | isPidAlive(400000000)=false |
| PASS | lock-stolen-after-crash-holder | stolen, new pid 26500 |
| PASS | lock-released-and-reacquired | released=true, reacquired=true |
| PASS | canonical-json-key-order-stable | {"a":{"y":[3,2],"z":"x"},"b":1} |
| PASS | canonical-json-rejects-nan | NaN throws |
| PASS | business-key-escaping-separates-objects | notify:user%3a123:k1 != notify:user%3a1%3a23:k1 |
| PASS | dispatch-key-shape-and-lowercase | dispatch_key=telegram:e1 |
| PASS | sha256-lf-normalization | digest 015abd7f5cc57a2d… |

合计：23 PASS / 0 FAIL。

数据源：fake 远端与本地 SQLite（无真实外部连接）（fake 远端与录制数据，无真实外部连接）。
