# Phase 5 Unit 5.2 — Telegram 路线 1 拉取入站与跨通道 9 环节 Canary 隔离

生成：2026-11-24T13:30:43.912Z；Node v22.23.5；suite `cross-channel`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | pull-admits-whitelisted-and-persists-cursor | pass 1: two whitelisted updates admitted (dm+group), cursor 0->8004, unauthorized text persisted nowhere |
| PASS | pull-unauthorized-chat-zero-persistence-masked-audit | the unauthorized chat produced exactly one masked audit row and zero payload objects/inbox rows |
| PASS | pull-traverses-local-connect-proxy | the pull child reached the Bot-API stand-in through the CONNECT tunnel (1 CONNECT entries) |
| PASS | pull-token-never-logged | the Bot-API log lines carry the token REDACTED only |
| PASS | pull-persisted-cursor-prevents-refetch | pass 2 with the persisted cursor 8004: the stand-in serves nothing (pulled=0), zero inbox churn — the crash-window re-fetch case is covered by the scenario below |
| PASS | pull-crashpoint-killed-in-the-cursor-window | the scenario child died by the armed crashpoint (marker fresh, exit {"code":1,"signal":null}) |
| PASS | pull-crash-committed-events-cursor-untouched | after the crash the two receiveEvents are committed (2 rows) and the cursor is still 0 |
| PASS | pull-restart-replay-zero-duplicate-tasks | the restart re-pulled the same update_ids: 2 duplicates absorbed, cursor advanced 0->8003, exactly 2 tasks (zero duplicates) |
| PASS | control-stop-executes-deterministically-and-instantly | /stop cancelled the DM task (CANCELLED) in 267ms with zero model requests while the group lane kept its RUNNING slot (RUNNING) |
| PASS | control-refuses-unauthorized-principal | a principal with no live grant cannot /pause; the scope stays unpaused (0) |
| PASS | canary-links-1-5-zero-hits | router history / worker context / L0 export / L1 graph / L2 FTS+LIKE all zero across the four foreign scopes (①groupA=0, ②groupA=0, ③groupA=0, ④groupA=0, ⑤groupA=0, ①groupB=0, ②groupB=0, ③groupB=0, ④groupB=0, ⑤groupB=0, ①repo=0, ②repo=0, ③repo=0, ④repo=0, ⑤repo=0, ①service=0, ②service=0, ③service=0, ④service=0, ⑤service=0) |
| PASS | canary-links-6-8-zero-hits | scope-local summaries carry no canary and the DM spill + fork checkpoint are denied to every foreign principal (⑥groupA=0, ⑦groupA=denied:true, ⑧groupA=denied:true, ⑥groupB=0, ⑦groupB=denied:true, ⑧groupB=denied:true, ⑥repo=0, ⑦repo=denied:true, ⑧repo=denied:true, ⑥service=0, ⑦service=denied:true, ⑧service=denied:true) |
| PASS | canary-link9-dispatcher-blocks-cross-group-send | the DM-canary summary toward group A is blocked at proposal (blocked=true) AND killed at dispatch even when adapters.allowedRecipients includes the group (state=DEAD, audits=2): CP4 blocked: effect efx:notify%3Adm%253atelegram%253a6101%3Acanary-leak-probe may not flow to its target — cross-scope d |
| PASS | canary-link9-adapter-allowlist-blocks-group-zero-bytes | the adapter refuses the group target with zero bytes (not in adapters.allowedRecipients) while the same-scope DM control send delivers; the service log has no sendMessage to the group |
| PASS | canary-owner-summarize-request-double-blocked | the owner's group-A request is durably pending; the canary exists in exactly its home FTS row (1) and no foreign surface ever saw it |
| PASS | revoke-group-session-stale-immediately | revoking the group-A read grant bumps the revision (1 < 2); the in-flight group session must be abandoned |
| PASS | fairness-aging-lifts-low-priority-within-bounded-rounds | the priority-1 repo task won a claim after 7 aging rounds (effective 1+4*7 vs the flood's 5) — no starvation |
| PASS | fairness-consecutive-turn-limit-steps-aside | with group B holding 3 consecutive turns at the limit, the equal-priority claim goes to the repo lane (repo) |
| PASS | rework-batch-merge-rejects-ungranted-cross-thread-oversized-and-structured | batch slice(1) refused all 4 ineligible events (stranger, cross-thread, 45KB CJK > 32KB cap, structured repo_triage); only anchor attached (1) |
| PASS | rework-direct-deliver-refuses-waiting-approval-task | directDeliverToThreadTask refused WAITING_APPROVAL task (no attachable live thread task (task is WAITING_APPROVAL; a new task takes the event)) |
| PASS | rework-model-failure-returns-all-batch-deliveries | failed batch task returned ALL 2 deliveries (RETURNED,RETURNED) with zero stranded PENDING |
| PASS | rework-pull-gate-proxy-idempotent-control-and-refused-closure | loopback allowRealPull=false skipped (calls=0); env proxy resolved (127.0.0.1:7897); duplicate /pause did not re-pause (paused=0); refused /stop closed (DONE) |
| PASS | rework-fairness-no-dual-group-starvation-and-stop-cleans-deliveries | low-priority repo claimed in 9 turns despite dual-group saturation; /stop without active subscription closed delivery (DEAD) & inbox (DONE) |
| PASS | f6-cross-scope-reply-never-satisfies-timer | scope A timer=FIRED fired=1 foreign-evidence=false (the scope B same-thread reply must not satisfy) |
| PASS | f6-control-same-scope-reply-still-satisfies | same-scope timer=SATISFIED evidence=inb:f6-same-a |

合计：25 PASS / 0 FAIL。

数据源：本地环回 Bot-API 夹具与本地 CONNECT 代理（零真实外联、零模型调用、零真实 Telegram）。
