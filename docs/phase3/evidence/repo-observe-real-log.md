# phase4:repo-observe-real — Phase 4.2 许可 2 广度真实仓库 Observe 与 DeepSeek 实测验收

生成：2026-11-21T05:28:45.388Z；Node v22.23.5；suite `repo-observe-real`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | real-aegispi-302-codeload-and-chinese-summary | exit=0 task=SUCCEEDED req=SETTLED actual=1088u$(offPeak~544u$) in=141 out=817 cache=10880 totalFromProvider=false replyLen=304 |
| PASS | real-hono-v4-13-19-third-party-tar-observe | exit=0 task=SUCCEEDED actual=930u$(offPeak~465u$) in=229 out=675 cache=8448 |
| PASS | real-pi-agent-north-monorepo-and-sequential-ledger | call1=1798u$(in=249,out=1409,cache=5376) call2=559u$(in=242,out=378,cache=5376) daySpent=1178u$ taskSum=1179u$ |
| PASS | real-openpi-input-cap-truncation-settles-cleanly | exit=0 truncated=true actual=2515u$ in=145 out=2048 replyLen=3672 |
| PASS | real-hermes-and-piper-single-file-observe | hermes=501u$(in=221,out=350) piper=6557u$(in=249,out=5395) |
| PASS | real-failclosed-redirect-and-oversize-tar-stop-before-model | redir=FAILED/acquisition_failed(req=none) hermesBig=FAILED/acquisition_failed(req=none) |
| PASS | real-missing-price-keeps-held-and-stops-observe-task | req=HELD res=HELD task=FAILED/settlement_held_uncompleted heldAudit=1 |
| PASS | defaults-untouched-fail-closed-and-zero-key-leakage | defaultsClosed=true telemetryLeak=false |

合计：8 PASS / 0 FAIL。

数据源：真实公网 GitHub 目标（NorthAdb/AegisPi、honojs/hono、NorthAdb/pi-agent-north、NorthAdb/openpi、NorthAdb/hermes-agent、NorthAdb/Piper）经 Epoch 6 acquisition 容器拉取 + 真实 https://api.deepseek.com（deepseek-flash, reasoning:high）+ 本地 .env 临时读取（不入库、defaults.json 保持失败关闭）。
