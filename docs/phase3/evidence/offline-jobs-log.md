# test:offline-jobs — 真实无网络 job 执行/超时/取消与配额强制（真实容器，digest 固定）

生成：2026-11-21T09:07:23.756Z；Node v22.23.5；suite `offline-jobs`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | real-no-network-job-executes | event=SUCCEEDED row=SUCCEEDED/0 result.exit=0 stdout="offline ok" |
| PASS | failing-job-records-exit-code-as-evidence | row=FAILED/7 evidence.exit=7 |
| PASS | job-namespace-has-no-network-dns-and-http-blocked | stdout="DNS_BLOCKED HTTP_BLOCKED" |
| PASS | host-enforced-deadline-times-out-and-reaps-container | event=TIMED_OUT row=TIMED_OUT containers-left="" |
| PASS | running-job-cancels-and-container-dies | cancel=CANCELLED row=CANCELLED containers-left="" |
| PASS | agent-and-offline-job-carry-different-real-cgroup-limits | agent memory.max=1073741824 execution memory.max=2147483648 pids.max=256 |
| PASS | memory-and-disk-quotas-are-enforced-not-advisory | oom=FAILED(FAILED) disk=FAILED/9 stdout="DISK_BOUND_HIT:ENOSPC" — the tmpfs SIZE bound must be the killer (EACCES or any other code means the mount contract broke, not the quota) |
| PASS | startup-recovery-kills-orphan-container-and-marks-lost | reaped=[{"jobId":"job:oj:recover:1:orphan","container":"4dcd1220bc22da8b5ccea44dbe152f0fc86e1c14d2699f39bab7f417a591878a","killedOrphan":true}] row=LOST containers-left="" |
| PASS | invalid-manifest-refused-nothing-executed | row=FAILED/126 refused=true reason="deadlineMs must be a positive integer of at most one hour" |
| PASS | daemon-tick-launches-and-reaps-queued-container-job | daemon exit=0 job=SUCCEEDED/0 containers="" job-stdout-seen=true daemon-event-seen=true scene=D:\AegisPi\aegis-pi\workspace-state\phase3\oj-daemon\daemon-tick-scene.txt |
| PASS | disk-warn-drill-blocks-new-job-launches | daemon exit=5 job=QUEUED warn-line=true containers="" — the watermark read a REAL (healthy) disk and the injected threshold tripped the drill scene=D:\AegisPi\aegis-pi\workspace-state\phase3\oj-disk-warn\daemon-diskwarn-scene.txt |
| PASS | job-without-oracle-refused-nothing-executed | refused="job job:oj:nooracle:1:refused has no oracle: an offline job requires a host-auth" row=absent containers="" |
| PASS | exit0-with-contradicting-oracle-is-not-success | event=FAILED(oracle_mismatch) row=FAILED/0 mismatch-audits=1 — exit 0 is evidence, the bound oracle decides |
| PASS | tampered-result-json-cannot-rewrite-terminal-state | timedout: state=SUCCEEDED row=SUCCEEDED/0 tamper-landed=true | cancelled: state=SUCCEEDED row=SUCCEEDED/0 tamper-landed=true | signal: state=SUCCEEDED row=SUCCEEDED/0 tamper-landed=true — the forged fields reached the host as evidence and changed nothing |
| NOTE | residual-risk-recorded | 容器级退出码与 result.json 是证据输入（02 §5）：宿主已按绑定 oracle 比较后才记 SUCCEEDED，伪造 result.json 的 timedOut/cancelled/signal 不再改写终态（本套件第 14 例为证）。仍如实保留的窗口：孙进程在 runner 写完证据、容器退出前的微秒级竞态理论上可改写 stdout.txt 首字节集合（同容器同 uid），该竞态与上一轮审计记录一致、未稳定复现；runner 退出码约定与宿主墙钟/取消记录不受影响。 |

合计：14 PASS / 0 FAIL。

数据源：真实 docker 容器（execution/agent 镜像按记录 digest 运行，--network none，cgroup 限额）+ 本地 SQLite；无模型调用、无外部写、无凭据入容器。
