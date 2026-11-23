# test:model-proposal — Phase 4.1 模型提议链路全量本地闭环与 T1–T10 矩阵

生成：2026-11-23T13:13:25.231Z；Node v22.23.5；suite `model-proposal`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | core-root-baseurl-and-usage-three-states | badRootRejected=true noUsageKey=false zeroPriced=null okPriced=28 |
| PASS | anchor-e2e-t1-container-daemon-pi-ledger-receipt | props=1 daemon=0 aclOk=true hits=1(/chat/completions/deepseek-flash/thinking=enabled) req=SETTLED res=SETTLED/28u$ task=SUCCEEDED evReplyLen=4000 receipt=true/replyMatch=true |
| PASS | production-agent-launcher-acl-and-bind-isolation | daemon=0 task=SUCCEEDED req=SETTLED res=SETTLED/28 attemptAcl=true aclOk=true iso="rootfs=RO:EROFS cmds=RO:EROFS ctx=RO:EROFS prop=RW" nonUuidRejected=true |
| PASS | t2-refused-inputs-and-budget-rejection | triggers=bad-purpose:refused,bad-modelId:refused,bad-scope:refused,bad-fence:refused,unknown-field:refused,oversize-128kib:refused rows6=0 budgetReq=FAILED res=0 calls=0 |
| PASS | t3-duplicate-request-idempotent-single-call-single-reserve | first=settled second=duplicate(SETTLED) reqCount=1 resCount=1 dupAudits=1 calls=1 |
| PASS | t4-pre-call-cancel-releases-held-zero-fee-zero-calls | req=FAILED res=RELEASED taskHeld=0 dayHeld=0 releaseAudit=1 calls=0 |
| PASS | t5-crash-between-reserve-and-executing-keeps-held-never-charged-bound-releases-on-abandon | marker=true restart=RESERVED/HELD abandoned=FAILED/RELEASED spent=0 calls=0 |
| PASS | t6-crash-after-executing-stays-executing-then-charged-bound-1000 | preTimeout=EXECUTING/HELD postTimeout=EXECUTING/CHARGED_BOUND(1000u$) taskSpent=500 releaseBlocked=true postCallHits=1/1 postReplayDup=true |
| PASS | t7-late-usage-pure-ledger-settles-once-zero-second-call | hitsAfterCrash=1 totalHits=1 before=EXECUTING/HELD after=SETTLED/SETTLED(28u$) lateAudits=1 dropped=1 |
| PASS | t8-missing-and-zero-usage-both-namespaces-held | missing=HELD/HELD zero=HELD/HELD dupLate=dropped notSettled=2 calls=2 |
| PASS | t9-legal-zero-output-settles-3-and-missing-category-rate-held | sub1=SETTLED/SETTLED(3u$) sub2=HELD/HELD calls=2 |
| PASS | t10-terminal-task-orphan-delivery-with-normal-billing | sub1=ORPHAN/SETTLED(28u$) sub2=ORPHAN/CHARGED_BOUND(1000u$) orphanAudits=2 deliveredFiles=0 |
| PASS | remaining-boundaries-timeout-overcharge-and-adapter-unified-core | timeout=EXECUTING/CHARGED_BOUND(1000) overchargeFrozen=1/2 adapter=succeeded/deepseek-flash//chat/completions |
| PASS | adversarial-hardening-invariants | revoked=call_failed warm=warming_disabled upper=invalid_request_id leaseExp=ORPHAN/SETTLED(28) compsUnique=true explicitAclCleaned=true workerOverwriteGuarded=true |
| PASS | empty-reply-settles-ledger-and-refuses-succeeded | len=FAILED/model_output_truncated_empty/SETTLED(28) ws=FAILED/model_empty_reply |

合计：15 PASS / 0 FAIL。

数据源：digest 钉住 agent 容器（--network none / PI_OFFLINE=1 / 只读 rootfs / 宿主 ACL 锁定 proposals）+ 真实 daemon tick + pi-ai 1.5.2 子进程 + 本地 OpenAI SSE 环回服务 + 真实 SQLite 账本与 crashpoint 注入；零真实推理服务调用，未读 .env。
