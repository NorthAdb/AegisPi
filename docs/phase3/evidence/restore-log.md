# test:restore — 一致性备份维护窗口 + 加密 manifest + 删除清单 + 恢复演练

生成：2026-11-19T13:24:51.236Z；Node v22.23.5；suite `restore`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | consistency-backup-seals-manifest-with-ledger | image=workspace-state\phase3\restore-drill\backups\consistency-1795094688694.db entries=1 |
| PASS | manifest-is-encrypted-at-rest | alg=aes-256-gcm; plaintext fields absent=true |
| PASS | backup-outside-window-refused | -> OutsideMaintenanceWindow |
| PASS | backup-without-manifest-key-refused | -> ManifestKeyMissing |
| PASS | manifest-rejects-wrong-key | -> Unsupported state or unable to authenticate data |
| PASS | restore-reports-pending-ready-timer-work | approvals=1 ready=1 timers=1 |
| PASS | restore-applies-deletion-ledger-forgotten-stays-forgotten | applied deletions=["obj:scp:dm%3Atelegram%3A6101:089bf8e6a9b4be200625fa24a023dc6f5a09cdb4910f9b9b0b65b45cea835202"] |
| PASS | restored-work-is-actionable-again | decide=true effect=READY dispatch=SUCCEEDED/SUCCEEDED timers fired=1 inbox_events=1 |
| PASS | restored-db-migration-idempotent | schema_migrations rows=1 (a restored database is not re-applied) |

合计：9 PASS / 0 FAIL。

数据源：本地 SQLite 与真实备份/恢复路径（VACUUM INTO + AES-256-GCM manifest）；无外部连接。
