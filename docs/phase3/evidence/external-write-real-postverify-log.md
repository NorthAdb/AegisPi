# test:external-write:postverify — 真实外部写 B 只读复核（同一对 scratch 库；零网络；修正断言词汇后重核五项通过标准）

生成：2026-11-20T09:06:43.067Z；Node v22.23.5；suite `external-write-real-postverify`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | authorized-effect-succeeded-real-external-id-one-submit-terminal | effect=SUCCEEDED external_id=ext-b-acceptance-001 businessKey=notify:dm%3atelegram%3a6101:case-external-write-real-b idempotencyKey=- attempt_count=1 submitting=1 failed(local/remote/unknown)=0/0/0 — one POST, terminal SUCCEEDED, no second attempt |
| PASS | approval-chain-proposed-cas-consumed-submitting-succeeded | effect_proposed=1 approval_consumed=1 effect_submitting=1 effect_succeeded=1 effect_draft_to_ready=0（人工审批效果从不走窄例程码，0 是预期形状）— 链 = proposal → CAS 审批 → SUBMITTING → SUCCEEDED；审计顺序=ingress_received > task_dispatched > task_claimed > acl_granted > task_parked_for_approval > effect_proposed > approval_consumed > effect_submitting > effect_succeeded |
| PASS | control-adapter-refused-zero-bytes-recorded-in-audit | effect=FAILED adapter_refused=1 effect_failed_local=1（details.bytes_sent=0，代码以 bytes_sent:0 记零字节）submitting=1（提交承诺先行，字节从未离开）succeeded=0 — policy 关闭在适配器门拒绝，零字节；审计顺序=ingress_received > task_dispatched > task_claimed > acl_granted > task_parked_for_approval > effect_proposed > approval_consumed > effect_submitting > adapter_refused > effect_failed_local |

合计：3 PASS / 0 FAIL。

数据源：对已执行的真实外部写验收（external-write-real，恰 1 次 POST 已消耗）做只读复核：不重跑守护进程、不播种、零网络、零新外部字节；两个 scratch 数据库保持原样供独立复核。断言词汇按代码事实修正——effect_draft_to_ready 仅属预批准窄例程（人工审批效果预期为 0）；控制组的零字节证据在 effect_failed_local 审计行的 details.bytes_sent=0（SUBMITTING 提交承诺先于适配器门，字节从未离开本机）。原始证据文件 external-write-real-report.json/-log.md 保持一字未改。。
