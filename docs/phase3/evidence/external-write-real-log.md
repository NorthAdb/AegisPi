# test:external-write:real — 真实外部写验收 B（可丢弃端点单次 POST；未授权对照零字节）

生成：2026-11-20T09:03:52.804Z；Node v22.23.5；suite `external-write-real`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | authorized-single-post-succeeded-with-real-external-id | daemon exit=0 effect=SUCCEEDED external_id=ext-b-acceptance-001 businessKey=notify:dm%3atelegram%3a6101:case-external-write-real-b submitting-audits=1 (for this effect 1) failed-audits=0 — exactly one POST, terminal SUCCEEDED, no second attempt |
| FAIL | approval-chain-proposed-cas-submitting-succeeded-on-record | effect_proposed=1 effect_draft_to_ready=0 approval_consumed=1 effect_submitting=1 effect_succeeded=1 — proposal -> CAS approval -> SUBMITTING -> SUCCEEDED, one row each for the single dispatch |
| FAIL | unauthorized-control-refuses-before-any-byte | daemon exit=0 control-effect=FAILED adapter-refused-audits=1 submitting-audits=1 — policy closed refuses at the gate, no submit ever started, zero bytes to the endpoint |

合计：1 PASS / 2 FAIL。

数据源：主人 2026-11-20 书面授权「仅限本次」：向 https://webhook.site/7b38d120-9947-4427-8d1e-86434713190a 恰 1 次 POST（AT_MOST_ONCE，无重试、无改址、无平台 API、载荷无凭据）；端点已由主人配置为 200/application/json 响应 {"externalId":"ext-b-acceptance-001"}。授权链经真实宿主路径（事件→任务→领取→proposal→CAS 审批→生产 tick 派发），仓库 defaults.json 全程未改，开关只存在于本次临时 test-config（gitignored，随工作区废弃）；未授权对照（policy=false）在适配器门拒绝、零字节。端点侧恰 1 份载荷由主人在 webhook.site 页面人工核对。。
