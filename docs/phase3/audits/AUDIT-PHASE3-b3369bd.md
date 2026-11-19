# AegisPi Phase 3 独立审计（b3369bd）

审计身份：独立审计，不是实施者，也不是整改。不把收口说明、测试名字、计数、`BLOCKED` 字样或 `docs/phase3/reports/phase3-closure.md` 当作完成证据。下面的结论来自对照生产入口，并在本环境用官方 Node.js 22.23.5 重跑套件、重建三份应用镜像、以及对备份与控制台做可证伪探针。

证据记号：

| 记号 | 含义 |
| --- | --- |
| T | 本环境实际命令、退出码、计数或容器观测 |
| R | 被审树 `b3369bd` 的源码或测试谓词 |
| M | 不改产品代码的旁路或变异：伪造 digest 字符串、同尺寸备份字节替换、对打开端口调用宿主端口探针 |
| S | 设计包 v1.4.1 与 Phase 3 开工移交 |
| U | 本审计没有闭合的点 |

本审计没有改产品代码，没有合并，没有推 `main`。`evals/phase3/cancel-approval/red-proofs.mjs` 会临时改三处源码再按字节还原；跑完后 `git diff` 对产品路径为空。重跑改写过的 `docs/phase*/evidence` 与 `docs/phase3/reports/{image-digest,quota-calibration}.md` 已用 `git checkout --` 还原。独立转录在 `docs/phase3/audits/evidence/`（套件输出为 `.txt`，因为仓库 `.gitignore` 忽略 `*.log`）。

---

## 1. 结论

**Phase 3 出口：NOT MET。**

不依赖容器的宿主门禁在锁定 Node 上成立：审批消费、预算账本的未知用量拒绝、备份恢复待审/待发/Timer、Phase 1/2 回归全绿。容器边界在「挂载对镜像用户可写」时也测到了真隔离：`--network none` 下 DNS 为 `EAI_AGAIN`、直连 HTTP 为 `ENETUNREACH`，退出码 7 由 runner 透传到容器退出码，2 GiB 脏页上限把 3 GiB 分配打成退出码 137。这些没有被证伪成越权完成。

出口仍然不成立，因为阶段验收要求隔离套件跑在**已记录的三份应用镜像 digest**上，并且真实 job 能在该环境执行。本环境观测到：

1. 记录的三份 digest 在本地 registry 上解析为 `not found`。按当前树重建得到的 OCI manifest digest 与记录值不同。`image-gate` 只接受「看起来像 sha256」的字符串。
2. 镜像内用户是 `uid=999(aegis)`。执行器与测试用默认 `umask 022` 创建 `0755` 挂载目录。Linux 上 runner 写 `/job/output/result.json.tmp` 得到 `EACCES`，`test:security:integration` 在任何断言之前以 `ENOENT` 抛出。
3. 把挂载改成可写、并把 digest 换成本次重建值之后，`offline-jobs` 为 10/10，配额为 5/5，逃逸电池的网络与 canary 项通过；acquisition 八项里七项因 Linux 引擎没有 `host.docker.internal` 而失败。路径穿越那一项在 `fetch failed` 时仍被判 PASS。

**可以常开：否。** 移交第 6 节要求真实隔离未通过就不常开。本审计没有观察到越权外发、把未知 usage 结成 0、或无会话审批成功。

**可以开始 Phase 4：否，不能按「Phase 3 已通过」开工。** 真实仓库闭环、真实账单、真实 webhook、付费模型调用是移交明确留给 Phase 4 的授权缺口，不把它们写成 Phase 3 的失败理由。Phase 3 自己的 digest 绑定、Linux 挂载权限、备份字节完整性、acquisition 在 Linux 引擎上的可达性，是实现缺口，要先补上再谈常开或真实写。

---

## 2. 审计对象

| 项 | 观察 |
| --- | --- |
| 仓库 | https://github.com/NorthAdb/AegisPi |
| 被审提交 | `b3369bd05e2c8b65e05dd21574a6c148eb5959e8` |
| 开工基线 | `6f9c93fe789b891174389b4220ea29bd5953fe1d` |
| GitHub `main` | 与被审提交相同。来源是 GitHub API `get_commit(ref=main)`，以及随后的 `git fetch origin main`。取回前，本机 `origin/main` 仍停在 `6f9c93f`，那是过期引用，不当作 GitHub 事实 |
| 六个提交（旧到新） | `96c8c93fb3b77ec1917a0c9c5d58beb3285b9ecc`、`12e6beab9d08b48e9d4366544209f47a3b88301b`、`cb436efdf76d4ef5427098d0c964c878edbd2750`、`3408505df43acc34443d2c9805b827a53537ac0f`、`d721c4b80697efbae43d1edc35848361a5c2b506`、`b3369bd05e2c8b65e05dd21574a6c148eb5959e8` |
| 规范包 | 附件解包到 `/tmp/aegis-spec/aegis-pi-design-pack-v1.4.1`。`schema.sql` LF SHA-256 为 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`，与 `apps/daemon/config/schema-source.json` 的 `expectedSha256Lf` 一致（T） |
| 锁定 Node | 官方 `v22.23.5`，`SHASUMS256.txt` 中 `node-v22.23.5-linux-x64.tar.xz` = `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`，`sha256sum -c` 为 OK。`nodejs.org/dist/index.json` 的 latest-v22.x 仍是 `v22.23.5`（2026-11-11，LTS Jod）。环境自带 Node 是 `v22.23.4`，套件没有用它 |
| 容器 | Ubuntu 24.04.5，Docker 29.1.3，一次 `sudo dockerd` 成功。cgroup v2，overlayfs。实施者记录的是 Docker 29.9.2 |
| 未使用 | 无 `.env`，无 Telegram token，无模型 API，无真实仓库写，无付费调用 |

`c650f4b` 复审第 5 节的三处缺口（崩溃谓词、`--once` 退出码、`LOOKUP_THEN_RETRY` 的 daemon 重启验收）在本树上仍然为绿，不带入：durability 日志中 `crash-predicate-accepts-armed-crashpoint-kill`（SIGKILL）、`daemon-restart-lookup-then-retry-records-hit-no-resend`、`daemon-once-no-upstream-unknown-exit-reflects-state`（daemon 退出码 4）均为 PASS（T）。durability 合计 **164 pass, 0 fail**。

---

## 3. 独立重跑

工作目录为仓库根。`PATH` 把官方 22.23.5 放在前面。`AEGISPI_SCHEMA_SQL` 与 `AEGISPI_RECALL_SQL` 指向解包后的规范文件。`AEGISPI_NODE_BIN` / `AEGISPI_NPM_BIN` 指向同一套二进制。`npm ci --ignore-scripts` 安装 125 个包；`@earendil-works/pi-coding-agent` 为 1.5.2。node:sqlite 报告 SQLite **3.54.1**。

### 3.1 不依赖 Docker 的套件（T）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node evals/phase3/security-unit/run.mjs` | 23 pass, 0 fail, 23 judged | 0 |
| `node evals/phase3/cancel-approval/run.mjs` | 16 pass, 0 fail, 16 judged | 0 |
| `node evals/phase3/cancel-approval/red-proofs.mjs` | M1/M2/M3 清洁树退出 0，变异后退出 1，源码按字节还原 | 0 |
| `node evals/phase3/restore/run.mjs` | 9 pass, 0 fail, 9 judged | 0 |
| `node evals/phase3/ingress-telegram/run.mjs` | **5 pass, 0 fail, 5 judged**，另有 NOTE `real-telegram-read-skipped` | 0 |
| `node evals/phase2/budget/run.mjs` | 20 pass, 0 fail, 20 judged | 0 |
| `node evals/phase2/acl/run.mjs` | 15 pass, 0 fail, 15 judged | 0 |
| `node evals/phase2/durability/run.mjs` | 164 pass, 0 fail, 164 judged | 0 |
| `node evals/contracts/run-contracts.mjs` | 15 个探针全部 PASS | 0 |
| `node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 退出 0/0；4.12.24 退出 1/1；两个未安装快照的 csrf/cors 均为退出 2 | 0 |

收口声明的 ingress **8/8** 在本环境不成立。缺 token 时真实 `getMe`/`getUpdates` 不跑，套件仍退出 0（`evals/phase3/ingress-telegram/run.mjs:143-144`）。本审计没有、也不会配置真实 bot token（U：真实只读连通性）。

### 3.2 容器套件（T）

记录 digest 的拉取：

```text
sudo docker pull 127.0.0.1:5000/aegispi/execution@sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8
# Error: ... not found
```

按 `b3369bd` 的 Dockerfile 与构建上下文重建，并推到本机 `127.0.0.1:5000` 后，registry 的 `Docker-Content-Digest`（OCI manifest，`application/vnd.oci.image.manifest.v1+json`）与 config blob 如下。

| 镜像 | 收口记录 | 本次 OCI manifest | 本次 config blob |
| --- | --- | --- | --- |
| agent | `sha256:5355348ad93e1e9be4380531ab78265fac8a77fed89a2dc6181de98062bc1bf5` | `sha256:42d363fd161f7de99bbfc52099f574ed9043ad0aed68e36bc7e3dc62d638ceac` | `sha256:0ebb4a636d1baaa2db9412447af3872fbafbaeb4f23597f936915b0009d0b2a7` |
| acquisition | `sha256:e045e9670a804e9f3ab97b48e69e9c09047b1c05f0877bdaf72b39588f756c97` | `sha256:b8c50ab61161999256258b87e5867eb8efc199c00879bd9c566d831de134017e` | `sha256:c01d9ad0a3ac7899b7dd0e941c5f592c14a9c61a404c12ea8cb635cd651c49be` |
| execution | `sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8` | `sha256:a43c59903ec71e6b8673137c06316403fe81ccf3b920e82de5ab18049fea4a85` | `sha256:650b1f675dc8dd5295ddb843a79b3d2a64c976f4c2340320721258b504d19901` |

基础镜像 `node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee` 可以拉取，与 Phase 1 记录一致（T）。

把机器块临时换成上表的本次 manifest digest 之后（跑完已还原）：

| 跑法 | 结果 | 退出码 |
| --- | --- | --- |
| `umask 022` 的 `security-integration` | 读 `stdout.txt` 时 `ENOENT`，没有进入 21 条断言 | 1 |
| `umask 000` 的 `security-integration` | **13 pass, 8 fail, 21 judged** | 1 |
| `umask 000` 的 `offline-jobs` | **10 pass, 0 fail, 10 judged** | 0 |
| `umask 000` 的 `quota-calibration` | **5 pass, 0 fail, 5 judged**。CPU 比值 1.82（628 ms / 346 ms）；1.5 GiB 脏页退出 0；3 GiB 脏页退出 137；pids 风暴 249；tmpfs 512 MiB 触发 `ENOSPC` | 0 |

`umask 000` 只让新建目录变为 `0777`，用来区分「挂载不可写」和「断言本身」。产品代码没有做这个 chmod。

---

## 4. 沿生产入口的九项

### 4.1 三份镜像 digest

构建脚本 `tools/build-app-images.mjs:126-141` 在 push 之后读 `RepoDigests`。在本机 Docker 29.1.3 上，这个值等于 registry 返回的 OCI manifest digest，并且不等于 config blob（T，上表）。方法记录的是 manifest digest，不是本地 config/image ID。

记录值本身没有在本环境解析成功（T）。`execution` 与 `acquisition` 的 `docker/` 源码自 `96c8c93` 之后没有变化，重建 digest 仍然不同：Docker 29.9.2 与 29.1.3 的镜像字节并不保证相同，因此不能把「数字不同」单独写成「当时造了假 digest」（U：那三个字符串是否曾是他们机器上的 manifest）。可以写成：它们不是本树在本环境的 manifest，门禁也不核验它们。

agent 镜像把 `apps/daemon` 拷进构建上下文（`docker/agent/Dockerfile:21-24`）。`96c8c93..b3369bd` 之间这些路径增加了 2326 行，`docs/phase3/reports/image-digest.md` 没有再改（R）。收口文说 digest 与收口树一致。文件没有在后续提交里更新，门禁也不比对源码树。

`evals/phase3/lib/image-gate.mjs:31-32` 只匹配 `sha256:` 加 64 位十六进制。把三行换成任意合法十六进制后，`parseAppImageDigests` 接受（M）。同一函数对值位的 `PIN_REQUIRED` 抛 `ImageGateError`（M）。`requireAppImageDigests` 在拒绝时 `process.exit(2)`（`:56-62`）。占位拒绝是真的；任意 sha256 也能通过这道门。套件随后 `docker run 127.0.0.1:5000/aegispi/<name>@<digest>`。digest 在 registry 里不存在时，运行失败，不会变成绿。存在一份攻击者自己 push 的镜像时，套件跑的就是那份镜像，因为断言读的是容器写出来的 stdout，不核对层与 git 树（R）。

### 4.2 宿主 / Agent / acquisition / job 边界

执行器启动参数在 `apps/daemon/src/container-executor.mjs:81-104`：`--network none`、`--init`、`--memory-swap` 等于 `--memory`、`--read-only`、`--cap-drop ALL`、`no-new-privileges`、有界 tmpfs，不挂 docker socket。这是生产启动路径（R）。

在本次 execution 镜像上（T）：

- `--network none`：`dns.lookup('example.com')` → `EAI_AGAIN`；`http://192.0.2.1` → `ENETUNREACH`；`http://169.254.169.254` → `ENETUNREACH`。
- 去掉 `--network none`、改用 bridge：同一 DNS 得到 `BRIDGE_LEAK:172.66.147.243`。DNS 探针因此能被证伪。
- bridge 下访问 `192.0.2.1` 得到 `ETIMEDOUT`。逃逸电池把该地址的**任何**错误都打印成 `BLOCKED:`（`evals/phase3/security-integration/run.mjs:89-90`），断言只测 `/BLOCKED/`（`:215-218`）。有网容器打到 TEST-NET 也会被这条断言接受。真正把「有网」打红的是 DNS 项，不是这条 HTTP 项。
- `host.docker.internal` 在本引擎上是 `ENOTFOUND`。acquisition 用例的 URL 用这个名字（`:421`），`docker run` 没有 `--add-host`（`:433-440`）。`umask 000` 下八项 acquisition 的原因都是 `unexpected: fetch failed`。
- 加上 `--add-host=host.docker.internal:host-gateway` 且目录对 uid 999 可写时，好归档解出 `hello.txt`，退出码 0（T）。下载器在挂载可写时能工作。
- `fetchTo` 对任意 http 重定向都跟随（`docker/acquisition/src/downloader.mjs:103-122`）。本机两个端口的探针：源站 302 到另一个端口，函数取回了 `secret-bytes`（T）。方案变化和重定向环有拒绝；换主机没有拒绝。

`host_ports` 探针先把返回值写成 `BLOCKED`，再发起连接，不等待结果（`:99-103`）。对一个正在监听的本机端口，它立刻返回 `BLOCKED`（M）。21 条断言里没有读取 `host_ports`。metadata 与 TOCTOU 只出现在文件头注释，没有对应探针（R）。

`git_c_execution` 在本次电池里是 `IN_SANDBOX=false`，断言仍 PASS（`:251-254`）。slim 镜像里这次没有产生 pager/alias 文件。断言不要求副作用发生，也不检查宿主路径。

`absolute_paths` 的断言只要求 docker socket 那一段是 `BLOCKED`（`:225-229`）。同一次输出里 `/proc/1/cmdline:42`，容器内的 pid 1 命令行是读得到的。`/etc/shadow` 这次是 `EACCES`。断言不要求后者。

镜像用户（T）：`docker run --entrypoint id` → `uid=999(aegis)`。执行器 `mkdirSync` 使用进程 umask（`container-executor.mjs:76-77`）。`umask 022` 得到 `0755` 且属主为宿主用户。runner 写结果时 `EACCES`（`docker/execution/src/runner.mjs:106`）。默认 umask 下集成套件因此在 `:206` 抛 `ENOENT`。这是失败关闭，不是逃出容器；「job 可执行并留下结果」在这种 Linux 主机上不成立。

配额（T，本次重建镜像，`--entrypoint node` 或执行器）：cgroup 是硬限制。1.5 GiB 脏页完成，3 GiB 退出 137；pids 风暴停在 249（断言写成 `<= 260`，`evals/phase3/quota-calibration/run.mjs:104-107`，比 256 宽）；512 MiB tmpfs 触发 `ENOSPC`。4 GiB 全量写没有做，与收口声明一致，本审计也没有做（U 作为全量磁盘画像，T 作为同一 tmpfs 机制）。CPU 比值 1.82，收口写的是 2.11；两边都高于测试门槛 1.3，数字随机器变化。

`package.json` 没有 `test:quota-calibration` 脚本。配额套件要直接跑 `evals/phase3/quota-calibration/run.mjs`。

### 4.3 审批绑定

`decideApproval` 在一个事务里核对审批人、`action_hash`、nonce、过期、fence、epoch、policy、ACL revision，再用 `WAITING` 状态做 CAS（`apps/daemon/src/approvals.mjs:77-167`）。控制台 `POST /api/approvals/:id/decide` 要求会话主体、JSON、以及调用方提交的 `actionHash` 与 `nonce`（`apps/daemon/src/console/api.mjs:361-383`）。返回 501 的是后面阶段的兜底路由（`:644-650`），不是审批。

本次 16 条里包括：双击第二次 409 `already CONSUMED`；编辑后旧卡 `INVALIDATED`、旧 effect `CANCELLED`、新 business key `~rev1`、旧卡再 decide 被拒；HEAD 从 head1 到 head2 时旧动作 `CANCELLED`、旧投递 0、新投递 1；旧 fence 拒绝且审批保持 `WAITING`；先取消则 `cancelledBeforeCommit` 且派发拒绝；先进入 `UNKNOWN` 则 `committedEffectsPending` 保留。红证三条在关掉失效、HEAD 比较、会话守卫后探针变红（T）。

`verifyContext` 比较的是 task fence 与 effect 的 `proposal_fence`，没有再读 `approvals.attempt_id`（`:96-111`）。fence 随 attempt 增加，本次「旧 attempt」探针走的是 fence。仓库白名单在 `allowedRepos.length > 0` 时才收紧（`adapters.mjs:158-164`）。`defaults.json` 里这个数组是空的，注释写明空数组不做额外白名单。`allowRealExternalWrites` 为 false（`defaults.json:35`）。daemon 只在 `--fake-upstream` 时构造 adapter，且 `transportKind` 固定为 `fake`（`daemon.mjs:157-174`、`:299-301`）。没有这个标志时，READY effect 留在库里并打印未接线（`:361-362`）。真实 HTTP 提交器不在这条路径上（实现缺口，同时真实写也没有授权）。

邮件收件人循环没有 `length > 0` 短路（`adapters.mjs:152-155`）。空名单会拒绝每一个收件人。这和 defaults 注释「空数组不做额外限制」不一致，方向是拒绝。

### 4.4 结果与 oracle

runner 在子进程退出后重写 `result.json`，并把子进程退出码作为容器退出码（`docker/execution/src/runner.mjs:200-213`）。文件头 `:15-17` 仍写「退出码不传播」，与函数体相反。

挂载可写时（T）：`process.exit(7)` 的容器退出码是 7，`result.json` 的 `exitCode` 是 7。子进程先写入 `exitCode:0, timedOut:true` 再 `process.exit(7)` 之后，runner 覆盖了该文件，容器退出码仍是 7，`timedOut` 为 false。

宿主 `pollOnce` 把容器退出码和 `result.json` 的 `timedOut` / `cancelled` 用或连接起来（`container-executor.mjs:261-266`）。子进程抢在 runner 落盘前伪造，会被覆盖。runner 落盘之后若仍有孙进程改写该文件，宿主会按伪造的 `timedOut`/`cancelled` 改作业状态。这次没有稳定复现这条竞态（U）。即便发生，`SUCCEEDED` 仍要求容器退出码 0（`:297-298`），伪造的 `exitCode` 字段不会把非 0 容器收成成功。

oracle 在 `submitJob` 里写成对象（`:147-158`），`pollOnce` 不读取它。作业终态来自容器退出码和上述标志。收口说的「Task 结论归 oracle」没有对应的宿主比较（R）。

### 4.5 备份

`consistencyBackup` 把 SQLite `VACUUM INTO` 成明文 `.db`，只对旁边的 manifest JSON 做 AES-256-GCM（`backup-window.mjs:182-223`）。本次备份文件头是 `SQLite format 3`，manifest 含 `aes-256-gcm`，不含明文标记（T）。错误密钥解密失败；改掉信封里的 `plaintextSha256` 会被拒绝（T）。GCM 对 manifest 密文有效。

恢复只比较镜像**字节长度**（`:251-254`），不比较数据库内容哈希，也不核对 `tableCounts`。把库内 `AUDITTOKEN-AAAA` 换成等长的 `AUDITTOKEN-BBBB` 后，长度不变，`restoreFromBackup` 接受，恢复出的库含新字符串（M/T）。删除清单因此只保护「清单里点到的对象 id」，不保护整库没被换成另一份同尺寸、能过 `integrity_check` 与 schema 校验的数据库。

删除条目写入时用 `object_id`（`:82`），恢复时读 `entry.object_id`（`:287`），字段是对齐的。restore 套件 9/9 里「遗忘对象保持删除」为 PASS（T）。`retentionDays` 只出现在 `config.mjs:75`，没有清理实现（R）。与收口第 3 节的自述一致。

恢复后的待审卡可以被测试显式 `decide`，待发 effect 被交给 **fake** upstream 后变成 `SUCCEEDED`（`evals/phase3/restore/run.mjs:241-268`）。Timer 只是把 inbox 行变成 `FIRED`。没有真实传输时，daemon 不会把这些 READY 行发出去（`daemon.mjs:361-362`）。「恢复后误向真实系统外发」在当前代码里没有通道。接上真实 upstream 之后，恢复出来的 READY 行会进入派发，这是持久化语义，不是这次测到的误发。

### 4.6 预算

账本拒绝缺用量与负用量，保持 `HELD`；超时走 `CHARGED_BOUND`；校正要求账单与 actor（security-unit 第 15–17 条，T；`budget.mjs:286-288`、`:372-393`）。收费提交没有 reservation id 时 adapter 拒绝（cancel-approval 最后一条，T；`adapters.mjs:198-210`）。

daemon 的常驻 tick 仍是 Phase 2 的 fake worker：预留之后用常量 `actualMicrousd: 300` 结清（`daemon.mjs:240-262`）。这不是未知用量，也不是供应商账单。真实模型调用没有接线，本审计付费调用次数为 0（授权缺口，U 作为真实账单校正）。生产循环没有走「未知则继续 HELD」那条账本路径。

### 4.7 Ingress

`verifyFeedEvent` 在没有密钥时抛 `SecretNotConfigured`，签名用 HMAC-SHA256，时间窗 ±5 分钟，比较是常量时间（`ingress-verify.mjs:49-82`）。security-unit 前四条覆盖了合法、篡改、缺密钥、过期（T）。这是通用 HMAC，不是 Telegram webhook 的 `X-Telegram-Bot-Api-Secret-Token` 头比较。注释把二者写成同一件事（`ingress-telegram.mjs:8-9`）。webhook 没有接到 daemon。

pull adapter 只有 `getMe` 与 `getUpdates`，`getUpdates` 不传 `offset`（`:50-53`）。没有 `sendMessage`。缺 token 在发请求前抛错（`:21-24`）。真实调用在本环境被跳过（U）。跳过不使套件失败（T，5 judged，退出码 0）。测试在调用成功时只检查返回值是数组，detail 字符串里的「nothing consumed」是写死的文案（`ingress-telegram/run.mjs:269-272`），不检查请求 URL 是否带了 `offset`。

### 4.8 控制台

`serveConsole` 只听 `127.0.0.1`（`api.mjs:30`、`:669-696`）。Host 允许 `127.0.0.1:port` 与 `localhost:port`（`:60-63`）。Origin 缺省时放行；带 Origin 时必须落在同一允许集（`:96-101`）。变更路由要求会话、`application/json`、以及 `x-csrf-token`（`:142-160`）。bootstrap token 只能读。

本次除了套件里的 `app.fetch`，还对真实 TCP 做了探针（T，端口 4317）：

- 无 `Authorization` 的 `GET /api/health` → 401
- 带 bootstrap token 的 GET → 200
- 带 bootstrap token 的 `POST /api/approvals/x/decide` → 401，正文为 mutations require a console session
- `Origin: http://evil.example` → 403

会话在进程内存里，重启即失效（`:65-66`）。CSRF 比较是普通字符串比较（`:157`），不是 `timingSafeEqual`。

`GET /api/events/stream` 的 SQL 没有 scope 条件（`:617-620`）。注释写着 scope-filtered。任何持有 bootstrap token 或会话的调用方拿到窗口内最多 500 条全部 scope 的事件。generation 不一致时会发 `reset`（`:623-626`）。响应是一次有限正文，不是常驻 SSE。这与收口「本阶段为有界重放」一致。

### 4.9 资源与未测项

磁盘水位读的是真实 `statfs`（`disk-water.mjs:18-29`）。daemon 启动时 critical 只开只读诊断（`daemon.mjs:93-104`），tick 里 warn 停止新 job（`:208-210`、`:373-374`）。阈值是 20 GiB / 10 GiB（`config.mjs:68-70`）。本机空闲约 247 GiB，没有触发告警（U：实盘触警演练）。函数本身不是模拟计数器。

下面分开写。

已测到的硬限制：cgroup memory / pids / cpu / tmpfs，见 4.2。swap 与 memory 设成相同值，见执行器。

未测、且不把它们写成安全边界已被攻破：

- 记录的三份 digest 作为可拉取对象（解析失败，不是逃逸成功）
- 真实 Telegram `getMe`/`getUpdates` 是否推进 offset（无 token；代码不传 offset）
- 真实模型账单校正与真实 webhook
- 4 GiB tmpfs 全量写
- 本机磁盘真正降到 20 GiB / 10 GiB
- 孙进程在 runner 退出后改写 `result.json` 的稳定竞态
- 备份文件被换成另一份同尺寸合法库之后，业务状态会被恢复成什么（字节替换已被接受；没有继续构造一份带伪造 READY effect 的同尺寸库）

---

## 5. 发现

严重度按「能否在声明已通过的门禁下形成错误结论，或能否在 Linux 宿主上让执行/备份契约失效」排序。每条都给出最小修复，不改本次产品代码。

### F1 高 — digest 门禁不绑定源码，记录值在本环境不可运行

- 路径：`evals/phase3/lib/image-gate.mjs:31-53`；`docs/phase3/reports/image-digest.md:17-22`；`docker/agent/Dockerfile:21-24`
- 观测：任意 `sha256` + 64 hex 被接受（M）。记录的 execution digest 拉取结果为 `not found`（T）。HEAD 重建的 OCI manifest 见第 3.2 节，与记录值不同，且与 config digest 不同（T）。
- 风险：隔离套件可以对着一份与被审源码无关的镜像变绿；收口声明的三份 digest 不能在新环境复跑。
- 最小修复：门禁除了格式，还要解析 registry manifest，并核对一份提交进 git 的「构建上下文文件清单哈希」。agent 上下文在 `96c8c93` 之后变过，就要重新构建并提交新 digest。

### F2 高 — Linux 默认 umask 下作业与下载器写不了宿主挂载

- 路径：`apps/daemon/src/container-executor.mjs:76-77`；`docker/execution/Dockerfile:11-12`；`docker/execution/src/runner.mjs:104-107`；`evals/phase3/security-integration/run.mjs:206`
- 观测：镜像用户 `uid=999(aegis)`。`0755` 目录上 runner 报 `EACCES`，容器退出码 1，没有 `result.json`（T）。`umask 022` 的集成套件在断言前 `ENOENT` 退出 1（T）。目录 `0777` 时同一镜像退出码 7 与 `result.json` 一致，`offline-jobs` 10/10（T）。
- 风险：声明的「真实无网络 job 可执行」依赖 Docker Desktop 那种对容器用户可写的挂载。普通 Linux 宿主上作业失败关闭，套件直接崩溃，看起来像环境坏了，而不是权限契约没写明。
- 最小修复：执行器创建 output 后 `chown` 到镜像 uid，或在 `docker run` 上显式 `--user` 与可写挂载的所有权。测试在 Linux 上用同一规则，不要依赖 umask。

### F3 高 — 备份不认证数据库字节；AES-256-GCM 只封 manifest

- 路径：`apps/daemon/src/db/backup-window.mjs:206-223`、`:247-254`
- 观测：`.db` 是 `SQLite format 3` 明文。等长替换 `system_state` 中的 canary 后恢复成功，新字符串在恢复库里（M/T）。错误密钥与被改的 `plaintextSha256` 会被拒绝（T）。
- 风险：能改备份文件的人可以换成另一份同尺寸、能过完整性检查和 schema 校验的库。删除清单只按 manifest 里的 id 再标删除，盖不住库内其他行被换掉。
- 最小修复：manifest 明文写入数据库文件的 SHA-256，恢复时先比对再打开。若威胁模型包括备份目录泄露，再把 `.db` 一并做认证加密。

### F4 高 — acquisition 集成在 Linux 引擎上不成立，且一条断言会被 fetch 失败刷绿

- 路径：`evals/phase3/security-integration/run.mjs:421-440`、`:467-470`；`docker/acquisition/src/downloader.mjs:103-122`
- 观测：`umask 000` 且使用本次重建 digest 时，该项为 13 pass / 8 fail。穿越项 PASS，detail 为 `reason=unexpected: fetch failed`（T）。其余七项因同一 fetch 失败而 FAIL。`host.docker.internal` 为 `ENOTFOUND`（T）。另：重定向不限制目标主机（T，见 4.2）。
- 风险：把「下载失败」计成「路径穿越已被拒绝」。Linux CI 会红在别的项上，穿越项仍然绿。恶意下载源可以把请求重定向到别的 http(s) 主机。
- 最小修复：断言必须匹配穿越原因，且逃逸文件不存在。Linux 上为测试源添加 `host-gateway`。重定向的下一跳主机必须落在计划允许的主机集合里。

### F5 中 — 逃逸电池里有三项不能按名字理解

- 路径：`evals/phase3/security-integration/run.mjs:87-103`、`:141-151`、`:215-254`
- 观测：`host_ports` 对正在监听的端口立刻返回 `BLOCKED`（M），且没有断言。`git_c_execution=IN_SANDBOX=false` 仍 PASS（T）。直 HTTP 的目标是 `192.0.2.1`，bridge 下超时也会打印 `BLOCKED:`（T）。同一次电池里 DNS 在 `--network none` 下是 `EAI_AGAIN`，在 bridge 下解析成功（T）。canary 文件在宿主侧未被改写（T）。
- 风险：去掉 `--network none` 时，HTTP 项与端口项仍可能绿；DNS 项会红。端口、metadata、TOCTOU 没有被这套断言覆盖。
- 最小修复：端口探针要读连接结果；HTTP 探针打宿主上本次测试自己监听的地址；`git -c` 要断言副作用只出现在 tmpfs，并且镜像里真有 git，否则该项应失败而不是 `IN_SANDBOX=false` 通过。

### F6 中 — 生产 tick 用常量 300 microUSD 结清 fake worker

- 路径：`apps/daemon/src/daemon.mjs:240-262`
- 观测：账本 API 拒绝未知用量（T）。tick 在预留后始终 `settle({ actualMicrousd: 300 })`（R）。
- 风险：唯一的常驻 worker 路径不保留 HELD，也不等待可信账单。真实调用未接上时，这是一笔虚构用量。
- 最小修复：fake worker 的结清要标明是夹具，并且不要作为「未知用量保守占额」的生产例证。真实调用接上之前，这条路径保持 HELD 或干脆不结清。

### F7 中 — ingress 真实只读没有复现，缺 token 仍算套件通过

- 路径：`evals/phase3/ingress-telegram/run.mjs:143-144`、`:256-272`；`apps/daemon/src/ingress-telegram.mjs:50-53`
- 观测：5 pass + 1 NOTE，退出码 0（T）。`getUpdates` 的参数没有 `offset`（R）。本环境无 token（U）。
- 风险：收口的 8/8 含真实 `getMe`/`getUpdates`。没有 `.env` 的重跑会少 3 条检查并仍然退出 0。
- 最小修复：把「真实只读」做成单独套件，缺授权时退出码与本地 5 条区分开。断言要检查发出的 query 不含 `offset`，并且响应后队列偏移不变。

### F8 低 — SSE 查询没有按 scope 过滤；磁盘与保留期仍是接线未演练

- 路径：`apps/daemon/src/console/api.mjs:611-620`；`apps/daemon/src/config.mjs:75`；`apps/daemon/src/db/disk-water.mjs:18-29`
- 观测：SSE SQL 只有 `seq>?`。`retentionDays` 无引用。水位函数使用真实 `statfs`，本机未降到阈值（U）。
- 风险：本地单主人控制台下，bootstrap token 能读到窗口内所有 scope 的事件。保留期不会自动删备份。
- 最小修复：SSE 按调用方 scope 过滤。保留期要么实现，要么从 defaults 里去掉「会清理」的读法。常开前用临时小盘或注入阈值做一次真实触警。

---

## 6. 授权缺口与实现缺口

授权缺口（移交已经排除在 Phase 3 之外，本审计保持关闭）：

- 真实仓库写、真实同事或公开仓库消息
- 付费模型调用与真实账单校正
- 真实 Telegram webhook 与持续入站
- 常开

实现缺口（Phase 3 范围内，本环境没有通过）：

- 三份应用镜像 digest 与被审源码、以及可复现的 OCI manifest 之间没有门禁绑定
- 执行器/测试没有保证镜像 uid 能写输出挂载
- 备份 manifest 没有绑定数据库字节
- acquisition 集成依赖 Docker Desktop 才有的 `host.docker.internal`，穿越断言过宽
- 逃逸电池的端口、git、直 HTTP 断言弱于标题
- daemon tick 用虚构 300 microUSD 结清
- ingress 套件把未执行的真实只读算进可绿的退出码

Phase 2 的三处已补缺口经本次 durability 164 确认仍在，不重新打开。

---

## 7. 环境限制

- 官方 Node 22.23.5 与 SHA256 已核对。GPG 签名文件有下载，本报告以 `SHASUMS256.txt` 的校验和为准。
- Docker 由本次 `sudo dockerd` 拉起，不是作者机器上的 Docker Desktop 29.9.2。镜像字节因此不能逐位复现他们的 digest。
- 没有用户凭据，真实 Telegram 与真实模型调用记为 U。
- 4 GiB 全量写与真实磁盘水位触警没有做。512 MiB tmpfs 与 `statfs` 函数已测。
