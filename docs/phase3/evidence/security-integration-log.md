# test:security:integration — 真实容器隔离与逃逸矩阵（02 §8 第二组；探针经 bridge 对照证伪）

生成：2026-11-24T13:44:29.807Z；Node v22.23.5；suite `security-integration`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | execution-image-owns-its-output-mount | uid=999 writable=true (a fresh volume at /job/output initializes from the image's uid-999 directory; the host umask never decides) |
| PASS | escape-battery-direct-http-and-env-manipulation-blocked | direct_http=BLOCKED:EAI_AGAIN env_manipulation=BLOCKED:EAI_AGAIN |
| PASS | escape-battery-no-egress-dns-blocked | dns_ipv6=BLOCKED:EAI_AGAIN |
| PASS | escape-battery-host-ports-unreachable | host_ports=BLOCKED:EAI_AGAIN (verdict from a real TCP connect to this suite's own listening source) |
| PASS | escape-battery-metadata-endpoint-unreachable | metadata=BLOCKED:ENETUNREACH |
| PASS | escape-battery-host-paths-and-socket-absent | absolute_paths=/etc/shadow:BLOCKED:EACCES|/var/run/docker.sock:BLOCKED:ENOENT|/proc/1/cmdline:42|/host:BLOCKED:ENOENT|/workspace:BLOCKE socket=BLOCKED:absent |
| PASS | escape-battery-toctou-input-readonly | toctou_input=BLOCKED:EROFS (the runner's manifest mount refuses a post-read rewrite) |
| PASS | escape-battery-no-secret-env-in-sandbox | env_secrets=CLEAN |
| PASS | escape-battery-symlink-stays-container-local | symlink_escape=CONTAINER_LOCAL(.dockerenv,app,bin,boot,dev,etc,home,job,lib,lib64,media,mnt,opt |
| PASS | escape-battery-host-canary-and-acceptance-unreachable | host_canary=BLOCKED:ENOENT acceptance_file=BLOCKED:EROFS |
| PASS | escape-battery-git-c-executes-and-stays-in-sandbox | git_c_execution=EXECUTED_IN_SANDBOX alias=true run=0 (git genuinely present and executed; GIT_ABSENT would fail this check) |
| PASS | escape-battery-pids-limit-bounds-the-fork-storm | pids_exhaust=spawned=241 (limit 256; the few processes above the storm count are the runner and its reaper) |
| PASS | escape-battery-completed-with-evidence | battery exit=0 run-exit=0 |
| PASS | host-canary-and-oracle-untouched-after-battery | canary intact=true; oracle intact=true |
| PASS | escape-probes-detect-reachability-under-bridge-control | direct=CONNECTED:200 ports=CONNECTED dns=RESOLVED:192.168.65.254 — the probes can see a leak, so the BLOCKED verdicts above are falsifiable, not tautologies |
| PASS | agent-container-rootfs-readonly-proposals-only-no-network | rootfs=BLOCKED:EROFS proposals=OK dns=BLOCKED:EAI_AGAIN socket=absent |
| PASS | acquisition-good-archive-extracts | exit=0 failures=0 extracted=true |
| PASS | acquisition-refuses-path-traversal-members | exit=1 reason=tar extract failed (exit 2): tar: Archive contains '00000000 escape-file-present=false |
| PASS | acquisition-refuses-escaping-symlinks | exit=1 reason=extracted tree rejected: symlink /downloads/s.tar.gz/link-ou |
| PASS | acquisition-refuses-device-members | exit=1 reason=tar extract failed (exit 2): tar: dev-kmem: Cannot mknod: Op dev-node-present=false |
| PASS | acquisition-bounds-gzip-bombs-at-decompressed-size | exit=1 reason=decompressed size cap exceeded: >8388608 bytes |
| PASS | acquisition-enforces-download-size-cap | exit=1 reason=size cap exceeded: >1048576 bytes |
| PASS | acquisition-refuses-scheme-changing-redirects | exit=1 reason=redirect changed scheme to file: |
| PASS | acquisition-refuses-redirect-loops | exit=1 reason=more than 5 redirects |
| PASS | acquisition-refuses-cross-host-redirects | exit=1 reason=redirect host allowlist-demo.host-gateway.local:56520 is not in the al |
| PASS | acquisition-follows-plan-allowlisted-redirect-hosts | exit=0 failures=0 extracted=true (allowlist-demo.host-gateway.local explicitly allowlisted by the host-generated plan) |
| PASS | acquisition-follows-same-host-http-redirects | exit=0 failures=0 |
| PASS | acquisition-dead-source-is-not-a-security-refusal | exit=1 reason=fetch failed (ECONNREFUSED) — recorded as DEAD SOURCE, never counted as traversal/redirect/limit refusal above |
| PASS | offline-jobs-suite-green-under-integration-gate | exit=0 (node:33080) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-wa |

合计：29 PASS / 0 FAIL。

数据源：真实 docker 容器（execution/agent/acquisition 按记录 manifest digest 运行）+ 本机一次性 HTTP 源（host.docker.internal 经 host-gateway，仅本机回环网关）+ bridge 对照容器（同镜像仅网络不同，证探针可见泄漏）；无模型调用、无真实外部写、无凭据入容器。
