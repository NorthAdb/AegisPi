# User-value and verification report

> Generated: 2026-11-22T07:12:17.573Z from verified evidence JSON files

- status: PASS (134 pass / 0 fail / 134 judged)
- configured budgets: task=800000 microUSD (`$0.80`), day=5000000 microUSD (`$5.00`)
- fail-closed defaults intact: true

## Verified suite evidence

| suite | present | passed | failed | judged | scope |
| --- | --- | --- | --- | --- | --- |
| triage | true | 7 | 0 | 7 | Scenario 4 offline baseline/target triage, oracle verdict, and outbox notify |
| repo-observe | true | 7 | 0 | 7 | Read-only repo observe acquisition, KV prefix ordering, and HELD stop |
| model-proposal | true | 15 | 0 | 15 | Agent->Host pi-ai 1.5.2 state machine T1-T10 and empty reply block |
| security-unit | true | 48 | 0 | 48 | Fail-closed credentials, ACL, budget, and Telegram outbound guards |
| offline-jobs | true | 14 | 0 | 14 | Offline container execution, deadlines, cancellation, and oracle gates |
| security-integration | true | 29 | 0 | 29 | Container network, rootfs, symlink, and escape integration matrix |
| repo-observe-real | true | 8 | 0 | 8 | Unit 4.2 live GitHub + DeepSeek acceptance (if present) |
| triage-real | true | 6 | 0 | 6 | Unit 4.5 live GitHub + DeepSeek + container execution + @aegispibot DM acceptance (if present) |

## Recorded real acceptance summary

- repo-observe-real: `docs/phase3/evidence/repo-observe-real-report.json` (2026-11-21T05:28:45.388Z) — 8 pass, 0 fail
- triage-real: `docs/phase3/evidence/triage-real-report.json` (2026-11-21T14:44:08.129Z) — 6 pass, 0 fail
