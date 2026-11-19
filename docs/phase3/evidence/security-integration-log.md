# test:security:integration — 真实容器隔离与逃逸矩阵（02 §8 第二组）

生成：2026-11-19T13:23:16.390Z；Node v22.23.5；suite `security-integration`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | escape-battery-direct-http-and-env-manipulation-blocked | direct_http=BLOCKED:ENETUNREACH env_manipulation=BLOCKED:ENETUNREACH |
| PASS | escape-battery-no-egress-dns-blocked | dns_ipv6=BLOCKED:EAI_AGAIN |
| PASS | escape-battery-host-paths-and-socket-absent | absolute_paths=/etc/shadow:BLOCKED:EACCES|/var/run/docker.sock:BLOCKED:ENOENT|/proc/1/cmdline:42|/host:BLOCKED:ENOENT|/workspace:BLOCKE socket=BLOCKED:absent |
| PASS | escape-battery-no-secret-env-in-sandbox | env_secrets=CLEAN |
| PASS | escape-battery-symlink-stays-container-local | symlink_escape=CONTAINER_LOCAL(.dockerenv,app,bin,boot,dev,etc,home,job,lib,lib64,media,mnt,opt |
| PASS | escape-battery-host-canary-and-acceptance-unreachable | host_canary=BLOCKED:ENOENT acceptance_file=BLOCKED:EROFS |
| PASS | escape-battery-pids-limit-bounds-the-fork-storm | pids_exhaust=spawned=241 |
| PASS | escape-battery-git-c-executes-only-in-sandbox | git_c_execution=IN_SANDBOX=false |
| PASS | escape-battery-completed-with-evidence | battery exit=0 run-exit=0 |
| PASS | host-canary-and-oracle-untouched-after-battery | canary intact=true; oracle intact=true |
| PASS | agent-container-rootfs-readonly-proposals-only-no-network | rootfs=BLOCKED:EROFS proposals=OK dns=BLOCKED:EAI_AGAIN socket=absent |
| PASS | acquisition-good-archive-extracts | exit=0 failures=0 extracted=true |
| PASS | acquisition-refuses-path-traversal-members | exit=1 reason=tar extract failed (exit 2): tar: Archive contains escape-file-present=false |
| PASS | acquisition-refuses-escaping-symlinks | exit=1 reason=extracted tree rejected: symlink /downloads/s.tar.gz/link-ou |
| PASS | acquisition-refuses-device-members | exit=1 reason=tar extract failed (exit 2): tar: dev-kmem: Cannot mknod: Op dev-node-present=false |
| PASS | acquisition-bounds-gzip-bombs-at-decompressed-size | exit=1 reason=decompressed size cap exceeded: >8388608 bytes |
| PASS | acquisition-enforces-download-size-cap | exit=1 reason=size cap exceeded: >1048576 bytes |
| PASS | acquisition-refuses-scheme-changing-redirects | exit=1 reason=redirect changed scheme to file: |
| PASS | acquisition-refuses-redirect-loops | exit=1 reason=more than 5 redirects |
| PASS | acquisition-follows-same-scheme-http-redirects | exit=0 failures=0 |
| PASS | offline-jobs-suite-green-under-integration-gate | exit=0 (node:28948) ExperimentalWarning: SQLite is an experimental feature and might change at any time | (Use `node --trace-wa |

合计：21 PASS / 0 FAIL。

数据源：真实 docker 容器（execution/agent/acquisition 按记录 digest 运行）+ 本机一次性 HTTP 源（host.docker.internal，仅本机回环网关）；无模型调用、无真实外部写、无凭据入容器。
