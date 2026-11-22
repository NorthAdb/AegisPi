# test:cancel-approval — 审批/取消线性化（生产路径，fake 远端）

生成：2026-11-22T09:40:55.043Z；Node v22.23.5；suite `cancel-approval`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | double-click-consumes-exactly-once | first=200 second=409(already CONSUMED) effect=READY consumed_audits=1 |
| PASS | edit-mints-new-action-and-kills-old-card | revise=200 old=INVALIDATED/CANCELLED newbk=am%3a6101:case-edit~rev1 decideOld=409(already INVALIDATED) decideNew=200 newEffect=READY |
| PASS | head-change-forces-reapproval-never-submits-stale | refused=head_changed: target repo://github.com/x/y is at head2, acti old=CANCELLED reparked=true newHead=head2 decide=200 final=SUCCEEDED oldDelivered=0 newDelivered=1 |
| PASS | old-attempt-card-refused-by-fence-context | decide=false(task fence moved to 2; action was proposed under 1) approval=WAITING effect=WAITING_APPROVAL stale_audits=1 |
| PASS | cancel-before-commit-cancels-everything-uncommitted | outcome=cancelledBeforeCommit effect=CANCELLED approval=INVALIDATED task=CANCELLED dispatch=refused |
| PASS | cancel-after-commit-retains-unknown-honestly | submit=UNKNOWN outcome=committedEffectsPending retained=1 effectAfter=UNKNOWN task=WAITING_EFFECT |
| PASS | session-principal-cannot-decide-someone-elses-card | decide=409(callback is not the designated approver) verification_failed_audits=1 |
| PASS | revoked-approve-grant-fails-closed-at-decide | decide=409(approver has no live approve grant) |
| PASS | bootstrap-token-alone-cannot-approve | decide with bootstrap token -> 401 unauthenticated |
| PASS | missing-csrf-refused | -> 403 csrf_mismatch |
| PASS | non-json-mutation-refused | -> 415 unsupported_media_type |
| PASS | anonymous-mutation-refused | -> 401 unauthenticated |
| PASS | malicious-origin-and-host-cannot-operate | origin=403 host=403 |
| PASS | session-mint-requires-the-bootstrap-token | mint with guessed token -> 401 |
| PASS | revise-requires-live-approve-grant | revise=403(revising requires a live approve grant on the action's scope) old approval untouched=WAITING |
| PASS | adapter-registry-gates-unknown-real-and-chargeable | unknown->FAILED(local_error: adapter refused: operation ) realwrite->FAILED(local_error: adapter refused: real external write for pr.cre) chargeable->FAILED(local_error: adapter refused: chargeable operation) |

合计：16 PASS / 0 FAIL。

数据源：本地 SQLite 工作区 + fake 远端（唯一传输缝）；审批/取消/编辑全部经控制台会话（session+CSRF+JSON）生产端点驱动；无真实外部调用，无模型调用。
