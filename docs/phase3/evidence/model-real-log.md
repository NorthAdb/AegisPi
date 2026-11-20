# test:model:real — 真实模型验收（DeepSeek 官方端点；单次调用；先预留后请求；目录价结清）

生成：2026-11-20T05:31:19.306Z；Node v22.23.5；suite `model-real`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | real-model-call-reserved-then-settled-no-overcharge | daemon exit=0 reservation=SETTLED actual=28microusd source=model-http-transport overcharge-audits=0 call-failed=0 not-settled=0 — one call, reserve before, settle after; first log lines: recovery ok  scope-config: scopes=1 paused=0 revoked_grants=0 authorization_revision=1 |
| PASS | usage-priced-exactly-by-host-catalog | usage prompt=40 completion=13 catalog-price=28 microusd settled=28 upper=1000 (within bound: no freeze) |
| PASS | task-succeeded-with-real-evidence-object | task=SUCCEEDED reply="OK" model=deepseek-flash endpoint=api.deepseek.com settledMicrousd=28 |

合计：3 PASS / 0 FAIL。

数据源：主人 2026-11-20 授权的真实调用：完整 URL https://api.deepseek.com/chat/completions，供应商模型名 deepseek-flash（Phase 1 契约已实测接受），本次恰 1 次调用（授权上限 ≤5）；先 ledger.reserve 后 callModelOnce，按宿主目录价结清；不经 Pi SDK、不构成 Pi 端到端证据；输出全程脱敏；凭据值仅经本机 .env 与短命子进程环境。
