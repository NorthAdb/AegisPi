# test:offline-jobs — 真实无网络 job 执行/超时/取消与配额强制（真实容器，digest 固定）

生成：2026-11-19T13:23:16.379Z；Node v22.23.5；suite `offline-jobs`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | real-no-network-job-executes | event=SUCCEEDED row=SUCCEEDED/0 result.exit=0 stdout="offline ok" |
| PASS | failing-job-records-exit-code-as-evidence | row=FAILED/7 evidence.exit=7 |
| PASS | job-namespace-has-no-network-dns-and-http-blocked | stdout="DNS_BLOCKED HTTP_BLOCKED" |
| PASS | host-enforced-deadline-times-out-and-reaps-container | event=TIMED_OUT row=TIMED_OUT containers-left="" |
| PASS | running-job-cancels-and-container-dies | cancel=CANCELLED row=CANCELLED containers-left="" |
| PASS | agent-and-offline-job-carry-different-real-cgroup-limits | agent memory.max=1073741824 execution memory.max=2147483648 pids.max=256 |
| PASS | memory-and-disk-quotas-are-enforced-not-advisory | oom=FAILED(FAILED) disk=FAILED/9 stdout="DISK_ENOSPC:ENOSPC" |
| PASS | startup-recovery-kills-orphan-container-and-marks-lost | reaped=[{"jobId":"job:oj:recover:1:orphan","container":"261843471df3d1bdd302daa99f9ca435e19f573168d48eeb4c074390e9e1e50b","killedOrphan":true}] row=LOST containers-left="" |
| PASS | invalid-manifest-refused-nothing-executed | row=FAILED/126 refused=true reason="deadlineMs must be a positive integer of at most one hour" |
| PASS | daemon-tick-launches-and-reaps-queued-container-job | daemon exit=0 job=SUCCEEDED/0 containers="" job-stdout-seen=true daemon-event-seen=true |
| NOTE | residual-risk-recorded | 容器级退出码与 result.json 是证据输入：同容器的恶意 job 可以伪造自己的 result.json（02 §5 明文承认）；Task 结论始终由可信 oracle 判定，job 的自述不作授权或成功标记。宿主墙钟 deadline 与容器回收不受影响。 |

合计：10 PASS / 0 FAIL。

数据源：真实 docker 容器（execution/agent 镜像按记录 digest 运行，--network none，cgroup 限额）+ 本地 SQLite；无模型调用、无外部写、无凭据入容器。
