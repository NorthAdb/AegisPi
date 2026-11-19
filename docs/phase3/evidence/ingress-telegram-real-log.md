# test:ingress-telegram:real — 真实只读 Telegram 验收（getMe/getUpdates；零发送、零 offset 确认）

生成：2026-11-19T15:17:35.018Z；Node v22.23.5；suite `ingress-telegram-real`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | authorized-telegram-identity-readable | bot @aegispibot (id masked) |
| PASS | authorized-telegram-updates-readable-readonly | queue read returned 1 update(s); offset-param-present=false (nothing consumed, nothing confirmed) |
| PASS | real-update-maps-into-durable-ingress-observe-only | update 500045892 mapped; verdict OBSERVE (no automatic action) |

合计：3 PASS / 0 FAIL。

数据源：主人授权 bot token 的只读 api.telegram.org 调用（getMe/getUpdates，无 sendMessage，无 offset 确认），经本机代理出网；输出全程脱敏；无付费模型调用；simulate-no-token=false。
