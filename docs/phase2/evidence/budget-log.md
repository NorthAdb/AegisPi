# Phase 2 test:budget — HELD 账本、八种 purpose、并发预留与结算（06 §8）

生成：2026-11-21T04:48:44.089Z；Node v22.23.5；suite `budget`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | spec-defaults-not-overridden | task=800000 steps=25 wall=900s day=5000000 warming=off |
| PASS | eight-purposes-declared | purposes=router,worker,summary,classify,rsi,replay,warming,watchdog |
| PASS | accounts-created-with-spec-defaults | task account limit=800000, day limit=5000000 |
| PASS | day-key-uses-hong-kong-midnight | account acct:day:2026-11-21 for dayKey 2026-11-21 |
| PASS | account-ensure-idempotent | second ensure reuses the row |
| PASS | reserve-holds-on-every-account | HELD task+1000 day+1000, reservation_accounts=2 |
| PASS | request-key-prevents-double-hold | duplicate=true, held still 1000 |
| PASS | any-account-failure-rolls-back-everything | reservation rows for req:b2=0, task held=1000, day held=1000 |
| PASS | missing-usage-cannot-settle-as-zero | settle without usage refused, reservation stays HELD |
| PASS | settle-releases-held-adds-actual-spent | task spent=704 day spent=703 held both 0 |
| PASS | release-only-when-definitely-not-sent | RELEASED on held-only reservation; SETTLED reservation refuses release |
| PASS | charged-bound-conservative-then-trusted-bill-corrects | CHARGED_BOUND upper->spent, correction refused without evidence, corrected to 300 |
| PASS | overcharge-records-honestly-freezes-stops-new | actual 250 over bound 100 recorded, day account frozen, new reserve refused |
| PASS | limit-lower-free-raise-needs-approval | lower ok; raise refused without approval, accepted with |
| PASS | seven-purposes-reserve-and-settle | router=settled, worker=settled, summary=settled, classify=settled, rsi=settled, replay=settled, watchdog=settled |
| PASS | warming-off-no-account-no-reserve | warming reserve refused, account refused, rows=0 |
| PASS | warming-enabled-creates-account-and-reserves | warming account acct:warming-day:2026-11-21 created, reservation HELD |
| PASS | chargeable-step-refuses-without-live-reservation | workerStep without a reservation: BudgetError |
| PASS | step-runs-with-reservation-and-refuses-foreign-purpose | step ok with worker reservation; router reservation refused for a worker step |
| PASS | concurrent-reservations-exactly-one-wins-no-residue | slots exit 0/4, HELD winners=1, task held=60000, day held=60000 (loser left nothing) |

合计：20 PASS / 0 FAIL。

数据源：fake 远端与本地 SQLite（无真实外部连接）（fake 远端与录制数据，无真实外部连接）。
