# test:ingress-telegram — 本地确定性 ingress 检查（真实只读验收已拆分至 test:ingress-telegram:real）

生成：2026-11-21T09:00:55.317Z；Node v22.23.5；suite `ingress-telegram`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | pull-adapter-refuses-without-token | -> no Telegram bot token configured; the pull adapter refuses i |
| PASS | revoked-credential-slot-refuses-pull-adapter | resolve before=true after revoke=false (slot im.telegram was revoked at 17952516) |
| PASS | drill-token-never-reaches-audit | audit rows carry slot names only |
| PASS | telegram-update-maps-and-dedups-by-update-id | mappable=true first=false second=true rows=1 |
| PASS | non-message-update-refused-honestly | -> update 88002 carries no mappable message |
| PASS | getUpdates-reads-queue-without-advancing-offset | requests=2 offset-param-present=false same-backlog=true — the queue stays unconsumed; only an explicit, audited advance elsewhere could change that |
| PASS | webhook-guard-verifies-secret-token-header | no-secret->refused true; exact=true wrong=false missing=false (implemented, NOT wired to any public endpoint) |
| NOTE | real-read-acceptance-not-run-here | 本套件只含本地确定性检查；真实只读验收在 test:ingress-telegram:real（缺 token 时 exit 3、明确记未验收），不在本套件内冒充完成 |

合计：7 PASS / 0 FAIL。

数据源：本地 SQLite 与注入 fetch 的确定性用例；零网络调用、零模型调用、零发送。
