# Phase 5 Unit 5.1 — 分层记忆生命周期（L0–L3 / 13 类注入 / 墓碑遗忘 / 技能与 Spill）

生成：2026-11-24T03:18:32.221Z；Node v22.23.5；suite `memory-lifecycle`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | l0-usermd-confined-to-owner-dm | USER.md exported only for owner_dm (dm=true, group=null, repo=null, service=null) |
| PASS | l0-export-files-per-scope-dir | MEMORY.md exists per scope; USER.md exists only under the dm scope dir (scp-dm-3Atelegram-3A6101-36ac2d11) |
| PASS | l0-dm-facts-never-leak-into-group-export | group MEMORY.md contains only group facts; the dm private note is absent |
| PASS | l0-usermd-read-denied-outside-dm-closure | group-only principal reading the USER.md object: denied=true; owner: denied=false |
| PASS | l0-prefix-frozen-within-run | the open run's frozen L0 is byte-identical to its start (hash dc7662ef…) and excludes the mid-run fact |
| PASS | l0-mid-run-fact-visible-next-run | next run hashes a different prefix (dc7662ef… -> 2ebab022…) — the mid-run fact is only visible to it |
| PASS | closure-45-fixture-accounting | the fixture really holds 25 foreign + 20 ungranted-closure + 12 legal rows before any recall claim |
| PASS | closure-45-unauthorized-cannot-crowd-out-legal | recall returned exactly the 12 authorized legal rows (12 rows, all legal ids present) |
| PASS | closure-45-short-cjk-fallback-bounded | 2-char CJK term served by the bounded LIKE fallback (2 rows, foreign row absent) |
| PASS | closure-summary-requires-union-of-parent-scopes | summary closure = {A,B} (got scp:dm%3Aweb%3Aa,scp:dm%3Aweb%3Ab); A-only reader denied=true, A+B reader denied=false |
| PASS | closure-l1-expansion-skips-unreadable-objects | L1 walk from an A root stays inside A for this reader (2 objects, 0 skipped) |
| PASS | injection-13-classes-quarantined-at-candidate | all 13 payload classes quarantined in candidate with their class code and never_activatable |
| PASS | injection-quarantined-facts-can-never-activate | activating a quarantined candidate is refused by the host gate |
| PASS | conflict-mutually-exclusive-values-both-preserved | both versions of 'shipping-address' live as conflicted (conflicted/conflicted); no last-text-wins |
| PASS | forbidden-policy-capture-facts-refused-before-insert | approval-exemption and recipient-whitelist claims throw MemoryFactForbidden with zero rows (15->15) and 2 audited refusals |
| PASS | identity-category-facts-never-activatable | identity-category candidate stays candidate and activation is refused regardless of who asks |
| PASS | revoke-session-fresh-before-revocation | pre-revoke: session fresh and recall sees the granted object (1 row) |
| PASS | revoke-stale-session-detected-before-next-request | after revoke the session is stale (rev 1 < 2) and must be abandoned |
| PASS | revoke-clean-context-excludes-object | the revoked principal cannot re-open a session (refused); recall and L1 no longer see the revoked object (0 rows, 0 graph objects) |
| PASS | forget-fixture-has-fts-export-summary-spill | source fact live in FTS (rows=1), spill captured=true, summary=obj:scp:dm%3…, export=obj:scp:dm%3… |
| PASS | forget-pre-forget-consistency-backup-taken | consistency backup recorded before the forget (image 339968 bytes, 0 deletion-ledger entries — nothing was forgotten yet) |
| PASS | forget-phase1-cascade-deletes-derived-closure | source + export + summary + spill all status=deleted (deleted,deleted,deleted,deleted); every FTS row for them is gone (5 objects) |
| PASS | forget-phase2-removes-files-and-l0-export | the L0 export file and the source content blob are physically removed (5 blobs, 2 export files) |
| PASS | forget-tombstone-manifest-appended-with-chain | tombstone chain holds 5 entries covering every cascade member |
| PASS | forget-restore-replays-tombstones-no-resurrection | restoring the old backup replayed 5 tombstones: the forgotten fact is deleted again (deleted), its FTS row is gone (0), db seq caught up |
| PASS | forget-restored-db-opens-clean | startup recovery on the restored db opens (deletion-manifest step in sync) |
| PASS | forget-rollback-manifest-refuses-execution | a manifest rolled back behind the db seq (6) fails the invariant and recovery stops read-only at 'deletion-manifest' |
| PASS | forget-rollback-manifest-refuses-restore | restoring the post-forget backup against the rolled-back manifest throws DeletionManifestStale (image db seq 6 > manifest seq 5) |
| PASS | forget-manifest-bak-fallback-repairs-lost-main | with a stale main file removed, the .bak copy (seq 6) verifies, takes over, and the invariant recovers |
| PASS | forget-corrupt-manifest-refuses-execution | a chain-broken manifest (main and .bak) fails verification and recovery stays read-only |
| PASS | skills-running-task-keeps-frozen-hash | activating v2 changes the set hash (86f4215d… -> 060bd5f6…) while the running task keeps its frozen 86f4215d… |
| PASS | skills-progressive-disclosure-levels | level 2 body reads behind the ACL (owner yes, stranger denied); level 3 exposes the reviewed hash only, never script text |
| PASS | spill-50kb-boundary-and-redaction | under-bound output is not spilled; the >50KB output becomes a spill object with a bounded view and the credential shape redacted on disk |
| PASS | spill-paged-read-acl-gated | cross-scope principal requesting the spillObjectId is denied; the owner reads 10 paged lines, never a host path |
| PASS | spill-json-quoted-secret-redacted-parsably | the JSON member secret collapses to a quoted placeholder (parseable=true), the raw value never reaches disk |
| PASS | spill-paged-read-refuses-expired-and-quarantined | an expired row (denied=true) and a quarantined candidate summary (denied=true) never serve through the paged view |
| PASS | skills-frozen-hash-locks-version-and-review-marks | the hash-frozen task reads v1 while the live set serves v2; the promoted script reports humanReviewed=true and an unauthorized principal is denied |
| PASS | closure-fact-inherits-parent-scopes-and-stays-out-of-single-scope-l0 | the cross-derived fact carries closure {dm,group} (2 scopes) and the single-scope group L0 never renders it |
| PASS | objects-reinsert-merges-wider-closure-and-parent-edges | re-inserting identical content merges the new scope (scp:dm%3Aweb%3Acf,scp:group%3Aweb%3Acf) and the parent edge instead of silently dropping them |
| PASS | objects-tombstoned-content-never-fake-reactivates | re-proposing forgotten content refuses (refused), the row stays deleted, the refusal is audited (1) |
| PASS | cp4-every-target-shape-refused-at-proposal | group / bare / dm / legacy-dm / repo-write targets with a cross-scope closure all refuse at proposal with durable audits (all refused) |
| PASS | cp4-same-scope-target-with-external-closure-blocked | a group task whose payload cites dm content cannot deliver even to its OWN group (CP4 blocked at proposal: im.notify to "group:telegram:-100777" — cross-scope disclosure to) |
| PASS | cp4-closure-depth-exceeds-bound-fails-closed | a 9-deep ancestor chain refuses instead of silently dropping the ancestors (object obj:scp:dm%3Aweb%3Achain8:75f1f8be488043d3aa0e727f18835f74ce2f8288c1c9b3c) |
| PASS | cp4-dispatch-gate-re-checks-approved-effect-after-allowlist-removal | removing the disclosure record kills the already-approved effect at dispatch (state=DEAD, one new block audit) |
| PASS | manifest-read-picks-higher-verified-seq | a stale main (seq 1) with a verified .bak (seq 2) resolves to the .bak chain (manifest.bak, seq 2) |
| PASS | manifest-corrupt-bak-missing-main-refuses | dbSeq 0 with a corrupt .bak and no main is a damaged deletion record, not a fresh install (deletion manifest unreadable while deletions may exist: manifest: missing; manifest.bak: manifest.bak is not valid JSON) |
| PASS | recovery-replays-manifest-before-object-references-no-deadlock | the pre-forget image over deleted files opens clean (mode=open, fact=deleted, fts=0) — the manifest step repaired the image before the reference scan could deadlock it |

合计：47 PASS / 0 FAIL。

数据源：本地 SQLite + 本地文件系统与设计包 schema.sql/recall.sql（零真实外联、零模型调用）。
