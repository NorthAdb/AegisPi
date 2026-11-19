# test:ingress-telegram — 只读真实源接入与凭据生命周期（失败关闭默认）

生成：2026-11-19T13:25:05.001Z；Node v22.23.5；suite `ingress-telegram`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | pull-adapter-refuses-without-token | -> no Telegram bot token configured; the pull adapter refuses i |
| PASS | revoked-credential-slot-refuses-pull-adapter | resolve before=true after revoke=false (slot im.telegram was revoked at 17950946) |
| PASS | drill-token-never-reaches-audit | audit rows carry slot names only |
| PASS | telegram-update-maps-and-dedups-by-update-id | mappable=true first=false second=true rows=1 |
| PASS | non-message-update-refused-honestly | -> update 88002 carries no mappable message |
| PASS | authorized-telegram-identity-readable | bot @aegispibot (id masked) |
| PASS | authorized-telegram-updates-readable-readonly | queue read returned 1 update(s), nothing consumed |
| PASS | real-update-maps-into-durable-ingress-observe-only | update 500045892 mapped; verdict OBSERVE (no automatic action) |

合计：8 PASS / 0 FAIL。

数据源：确定性用例为本地 SQLite；真实用例经主人授权的 bot token 只读调用 api.telegram.org（getMe/getUpdates，无 sendMessage，无 offset 确认），输出全程脱敏；无付费模型调用。
