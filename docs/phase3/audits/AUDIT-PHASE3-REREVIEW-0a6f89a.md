# AegisPi Phase 3 独立复审（0a6f89a）

复审对象是远端 `main` 的完整提交 `0a6f89ab8e8155fc00538a6f501bc0a20a2c941a`（2026-11-20 00:38:25 +0800，父提交 `dd80987ae096ccd9eda366f8fdd346dc58c7af21`）。本次在复审开始和落笔前两次 `git fetch origin main`，两次 `origin/main` 都是这个 SHA。旧审计分支 `cursor/phase3-audit-b3369bd-ef3e`（`5e31230603c5ca0953fd1cf28f998dbb1c5075d0`）没有并进这棵树。被审代码以该 SHA 的独立 worktree 为准。

这是复审，不是整改。没有改产品文件。跑套件改写过的证据已在 worktree 里 `git checkout -- docs` 还原。回应报告 `docs/phase3/reports/audit-response-b3369bd.md` 只当作实施者陈述，下面的结论来自源码、锁定 Node 和本机 Docker。

证据记号：T 本环境命令与退出码；R 被审树源码；M 不改产品代码的旁路；S 设计包 v1.4.1 与 Phase 3 开工移交；U 本环境没有闭合。

## 1. 三个结论

**A. F1–F8：F2、F3、F4、F5、F6 的原缺陷关闭；F1、F8 部分关闭；F7 的「无 token 仍 exit 0」关闭，真实只读未验收。** 关闭不等于 Phase 3 出口成立。

**B. Phase 3 全阶段出口：NOT MET。**

**C. 可以常开：否。可以进入 Phase 4：否。**

仍挡住出口的是实现缺口，不是把 Phase 4 的仓库业务闭环提前算进来：

| 级别 | 项 | 依据 |
| --- | --- | --- |
| P1 | 已提交的 v2 镜像证据在这棵 Linux 树上过不了 `image-gate`。隔离套件只在临时重建、改写证据之后才跑通 | T。见 F1 |
| P1 | 宿主不比较 oracle。容器退出码 0 就把 `execution_jobs` 记成 `SUCCEEDED` | R/S。02 §5 要求宿主校验，不是允许缺席 |
| P1 | 真实 HTTP 提交器没有实现。无 `--fake-upstream` 时 READY 效果不派发 | R。04 Phase 3 与移交第 2 步要求宿主提交器。失败关闭只说明没有字节外发 |
| P1 | 真实模型 worker 没有接线。无旗标 tick 零预留、零结清 | R/T。预算账本本身在。缺付费授权只限制账单实测，不解释这条路径没写 |

普通残留和授权缺失分列在第 4、5 节，不升成上面的 P1。

## 2. 对上一份审计的勘误

上一份报告 `docs/phase3/audits/AUDIT-PHASE3-b3369bd.md` 的正文没有改。`ccfcfe5d7d386ed9f1b7783d9d57b237526e5f7b` 归档的就是该文件，blob `528199d1fea12e72b1c9e8420592dc5eca0a4eb3`，与审计提交 `5e31230` 里的同一路径逐字节相同。该归档提交没有带上 PR #1 的 20 份证据转录。PR #1 仍是 open，head `5e31230603c5ca0953fd1cf28f998dbb1c5075d0`，base `b3369bd05e2c8b65e05dd21574a6c148eb5959e8`，`mergedAt` 为空。本次不更新它。

### 2.1 阶段范围写宽了

上一份结论把「真实账单、真实 webhook、付费模型调用」写成移交留给 Phase 4 的授权缺口（该报告第 33 行附近）。这个归类不准确。

开工移交写的是：Phase 3 实现安全边界与首次常开门槛；宿主代理、审批与提交器要接到真实宿主路径；预算继续先预留再调用；真实 ingress 做事件验签，未授权必须失败关闭。Phase 4 是第一个真实仓库闭环，不对真实同事或公开仓库写，不做场景四。04 的 Phase 3 任务同样包括宿主代理/审批/提交器、预算硬门禁和平台沙盒适配器。02 §5 把离线执行的宿主验证写进安全边界，不是写成后一阶段才许做的功能。

因此：缺 token、缺付费授权，只使对应实测记为未验收。提交器、模型 worker、webhook 端点若在树里不存在，就是实现缺口，不能用「还没授权」解释成没写代码。真实仓库业务闭环仍然不是 Phase 3 的交付，这次也没有把它算成失败理由。

### 2.2 旧三值不是本次能证明的伪造

收口原文记录的三值是：

- agent `sha256:5355348ad93e1e9be4380531ab78265fac8a77fed89a2dc6181de98062bc1bf5`
- acquisition `sha256:e045e9670a804e9f3ab97b48e69e9c09047b1c05f0877bdaf72b39588f756c97`
- execution `sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8`

`b3369bd` 的 `tools/build-app-images.mjs` 调用 `docker build`，没有 `--provenance=false`。BuildKit 开 provenance 时，推送后 `RepoDigests` 可以是带 attestation 的 index digest，而不是平台 manifest。这个机制和实施者「旧值是 index，不是编造字符串」的解释相容（R）。本次没有他们那台 registry，取不回这三份字节（U）。本机解析失败，以及另一次构建得到不同 digest，本身不能证明那三值是伪造，也不能单独证明「没有绑定」：构建含浮动 apt 层，digest 本来就可以不同。

上一份审计里仍然成立的部分是：当时的门禁只认 `sha256:` 加 64 位十六进制，伪造块可以通过。这个行为被 v2 的 registry 解析改掉了。本次对「上下文哈希匹配、manifest 摘要全是 `ab`」的草稿证据，门禁拒绝，HTTP 404（T/M）。

回应报告 §1 写的终树 agent 三元组是 `e21ce351` / `d40bd37d` / `a91d97dd`。已提交机器块是 `87e8c195` / `d360dd5a` / `be0273e1`。`dd80987` 的说明与机器块的 agent manifest 一致。门禁只读机器块。回应正文的 agent 一行是过期数字，不是另一套证据。

### 2.3 02 §5 与 result.json

02 §5 原文：恶意代码可控制全部自身 stdout 和文件，因此宿主只把它们当证据输入，不当授权或自动成功标记。feature list / oracle 由宿主保存为只读版本对象。任意脚本能篡改自己的副本，但不能修改宿主验收定义。`passes` 只由可信验证器根据绑定 manifest 的测试结果更新。

这是在说容器输出不可信，所以宿主必须自己验证。它不是在批准「宿主比较可以先不接」。整改回应把「同容器可伪造 result.json」写成规范已经承认的残留，并把「oracle 的宿主侧比较仍未接线」留在剩余风险里。后半句是事实，前半句的规范读法不成立。

生产入口仍是 `pollOnce`：`finishJob` 用 Docker 看到的容器退出码，0 即 `SUCCEEDED`（`apps/daemon/src/container-executor.mjs` 约 338–339 行）。`submitJob` 写入的 oracle 默认是 `verdict: "exit-code-evidence-only"`（约 180–190 行）。全库没有第二处读取 `job_oracle` 来否决这个终态（R）。`result.json` 的 `timedOut` / `cancelled` / `signal` 仍会改写终态（约 302–336 行）；伪造的 `exitCode` 字段不会把非 0 的容器退出收成成功。runner 在子进程结束后写结果并传播子进程退出码（`docker/execution/src/runner.mjs` 203–216 行）。offline-jobs 的 NOTE 现在如实写了「宿主侧比较尚未接线」。这条不再被收口措辞盖住，但缺口还在，而且属于 Phase 3 的安全边界，不是 Phase 4 才开始的仓库闭环。

## 3. 环境

| 项 | 值 |
| --- | --- |
| Node | 官方 `v22.23.5`。`node-v22.23.5-linux-x64.tar.xz` 对官方 `SHASUMS256.txt` 为 OK，摘要 `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`。实际执行的 `bin/node` 与包内二进制同摘要 `2f822d544601dfff107f57d945b649d15c5bf6302595735a6bd9cdc7ee9669bd` |
| 规范 SQL | 解包包 `schema.sql` 的 LF SHA-256 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`，与 `schema-source.json` 的 pin 一致。宿主套件设置了 `AEGISPI_SCHEMA_SQL`、`AEGISPI_RECALL_SQL`、`AEGISPI_SPEC_PACK`、`AEGISPI_NODE_BIN`、`AEGISPI_NPM_BIN`。不设 schema 路径时 durability 等在第一条迁移前失败关闭（T，退出码 1），那一轮不计入下面的绿计数 |
| Docker | 服务端 29.1.3。最初的 `docker build` 是 legacy builder，官方脚本的 `--provenance=false` 直接 `unknown flag`，构建退出码 1。为跑官方脚本，本环境安装了 `docker-buildx` 0.30.1。之后 `tools/build-app-images.mjs` 退出码 0 |
| 凭据 | 进程环境无 token 类变量，仓库无 `.env`。没有调用 Telegram、模型 API，没有向真实仓库或平台发送 |

三块证据要分开：

- **原机器块**（`0a6f89a` 提交的 `docs/phase3/reports/image-digest.md`）：agent manifest `87e8c195145fdff304d1c3409396876ee49556855f9a1727e1f8617fc52d79b6`，acquisition `3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658`，execution `202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050`。构建说明写的是 Docker Desktop 29.9.2。本机 registry 没有这些 manifest。
- **本树源码上下文**（Linux `path.join`）：agent `32532e4525c9785814aa24cb5409e4e82728fd48a3d8bf43dffeef6c120d5364`，acquisition `8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012`，execution `8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab`。与原机器块的 context 三值都不相等（T）。
- **临时重建块**（本机 buildx，跑完已还原产品文件）：agent `f1c47c08158c04d1345ae24f79ec08a0eb7601fd08d73c732080234ad4662808` / config `af96102b…` / context `32532e45…`；acquisition `7bbf414da8395a578c7d759cc85596b96e15e9f59e7a8d7e97c9e23e36c2c55e` / `3e5acf6e…` / `8abae275…`；execution `ee512211174ee1e61d83654fbb61c1efb7b478ca44a9d7400147c70040b9cadf` / `c1a353a6…` / `8183df14…`。registry 返回的是 `application/vnd.docker.distribution.manifest.v2+json`，没有 index 的 `manifests` 数组；config blob 为 `linux/amd64`，User `aegis`（T）。manifest 与原机器块不同，这只说明两次构建的镜像字节不同，不单独构成「未绑定」。

## 4. F1–F8

### F1 部分关闭

门禁逻辑比 v1 严：格式、上下文比较、registry 取回字节再哈希、manifest 内 `config.digest` 与记录值比较，都在 `evals/phase3/lib/image-gate.mjs`。index（带 `manifests` 数组）会被 `image-bind.mjs` 拒绝（约 134–137 行）。伪造 digest 在上下文能对上时被 404 拒绝（T/M）。临时重建块上 `image-gate/red-proofs.mjs` 退出码 0，M1/M2/M3 都是变异后变红、还原后变绿（T）。

已提交证据在这棵树上不成立（T）：

`parseAppImageDigests` 对提交的 `image-digest.md` 抛错：agent 记录 context `be0273e1…`，本树 `32532e45…`。`probe-evidence-holds` 退出码 1。`image-gate/red-proofs.mjs` 在这份证据上退出码 1。`offline-jobs`、`security-integration`、`quota-calibration` 都在断言前被门禁以退出码 2 拒绝。

原因有两层。

1. 上下文哈希把 `path.join` 的结果写进摘要（`image-bind.mjs` 约 53–71 行）。注释写 engine-independent，但 Windows 的 `path.join` 用反斜杠。用 `path.win32.join` 重放本树字节：acquisition 的记录值 `810d2b3c…` 与 execution 的 `8071bb11…` 逐位相同；Linux 分隔符下的值就是上面的 `8abae275…` 与 `8183df14…`。同一批已提交字节，换操作系统就过不了自己的门禁。
2. agent 的记录值 `be0273e1…` 对不上 Linux 分隔符，也对不上上述 Windows 模拟（模拟结果 `60a3b5af…`）。agent 上下文 40 个文件都没有 CRLF。所以 agent 的 context 字段不能由 `0a6f89a` 的已提交字节重算出来。

`stage()` 与 `appImageContextFiles` 共用一份清单（R）。清单外的文件不进镜像，改它们不该让门禁变红，这不是遗漏绕过。门禁不读 config blob，也不核对 `os`/`architecture`（R）。临时重建的三份 config 恰好是 `linux/amd64`（T），这是构建结果，不是门禁强制的。

最小修复：摘要里的 staged 路径固定用 `/`；agent 的 context 用与清单相同的函数在提交前重算并写入机器块；门禁至少拒绝非 `linux/amd64` 的 config blob。跨引擎的 manifest 不同可以保留，但提交里的 context 必须能在干净检出上重算通过。

### F2 关闭

执行镜像预建 `/job/input`、`/job/work`、`/job/output` 并 `chown` 给 uid 999（`docker/execution/Dockerfile`）。执行器把输出挂到 named volume，tmpfs 写明 `mode=1777`（`container-executor.mjs` 约 125–135 行）。源码和测试里没有对宿主目录 `chmod 777`。

本机 `umask 022` 下，用临时重建的 execution digest 起容器：`/job/output` 为 `755`、属主 `999:999`，`touch result.json.tmp` 成功；`/job/work` 为 `1777`，可写（T）。integration 的 `execution-image-owns-its-output-mount` 为 `uid=999 writable=true`（T）。`1777` 是容器内 tmpfs 的挂载契约，不是宿主目录的 777。

`docker cp` 取回的仍是容器写的文件，可信度和 02 §5 的证据输入相同，不能当成宿主验收。取消、超时、LOST 路径上有 `volume rm`（R）。offline-jobs 覆盖了执行、超时、取消、孤儿和坏 manifest，11/11 退出码 0（T，临时重建块）。没有再单独制造「`docker run` 成功、sidecar 写入前进程崩溃」的窗口（U，普通残留）。

### F3 关闭

`restoreFromBackup` 在打开库之前计算 `dbSha256`，等长改一字节被拒绝；去掉 `dbSha256` 的 v1 信封被拒绝；库文件头是 `SQLite format 3`（T/M，`backup-window.mjs` 约 265–279 行）。`test:restore` 11/11，退出码 0，含等长篡改拒绝和保留期清理（T）。`retentionDays: 0` 抛错（T）。明文库是实现和文档共同承认的范围，不是「整库已加密」。

哈希用 `readFileSync`，随后 `copyFileSync` 再读同一路径（约 275 行与 287 行）。通过检查的字节不是被打开的那一次读取（R）。这要备份目录上有并发写入才碰得到，容器挂不到该目录。记为普通残留，不把 F3 重新打开。

### F4 关闭

`fetchTo` 默认只允许原主机名（任意端口）和计划里的 `allowedRedirectHosts`；用户信息、非 http(s) scheme 拒绝（`downloader.mjs` 约 127–149 行）。本机探针（T/M）：

- 同主机换端口：跟随，取回 13 字节
- `127.0.0.1` 重定向到 `localhost`：拒绝
- 计划把 `localhost` 列入允许集：跟随
- 重定向到 `169.254.169.254`：拒绝，且没有去连它
- 重定向带 `user:pass`：拒绝
- `file:`：拒绝
- 同主机 `http`→`https` 与 `https`→`http`：都跟随
- `127.0.0.1:9`：`ok: false`，原因 `fetch failed`

integration 在临时重建上 29/29。穿越等用例要求原因匹配且不是 `fetch failed`；死源单独成条，必须是 `fetch failed`，并且文案写明不算安全拒绝（T）。跨主机拒绝、计划放行后跟随，都有对应 PASS。运行参数含 `--add-host=host.docker.internal:host-gateway`（R）。

同主机任意端口、以及 http 与 https 互跳，是规范 02 §4「尽可能不跟随重定向、每次重定向都校验」下面仍然放行的部分。计划由宿主生成，容器侧计划挂载是只读。这是普通残留，不是 F4 原来的「任意跨主机 302」或「死源刷绿」。

### F5 关闭

临时重建的 integration 读的是探针输出，不是恒定的 `BLOCKED` 字样（T）：

- `--network none`：direct HTTP / 改环境 `BLOCKED:EAI_AGAIN`，metadata `BLOCKED:ENETUNREACH`，宿主端口 `BLOCKED:EAI_AGAIN`，`/etc/shadow` `EACCES`，TOCTOU `EROFS`
- git：`EXECUTED_IN_SANDBOX alias=true`。`GIT_ABSENT` 会使这条失败（套件文案与结果一致）
- 对照容器只改成 bridge：`direct=CONNECTED:200`，端口 `CONNECTED`，DNS `RESOLVED:172.17.0.1`

对照容器证明这些探针看得见泄漏。pids 风暴 241，限额 256。没有再发现「对照容器仍报 BLOCKED」的旧断言。

### F6 关闭（仅限假结清）

无 `--fake-upstream` 的 `daemon --once`：退出码 0，settlements=0，worker 预留=0（T，`security-unit`）。有该旗标时恰好一笔，`usage.source` 为 `fake-worker-fixture`（T）。对应代码在 `daemon.mjs` 约 242–322 行，claim/reserve/settle 整段只在旗标内。

这只关掉「无旗标用常量 300 冒充用量」。真实调用路径见第 5 节，不因为这条绿就当成预算硬门禁已经接在生产 tick 上。

### F7 原缺陷关闭；真实只读未验收

本地 `test:ingress-telegram` 7/7，退出码 0。其中包括 `getUpdates` 请求不含 offset 参数，以及 webhook guard 的单测；NOTE 写明真实验收不在本套件（T）。

`test:ingress-telegram:real` 无 `.env` 时退出码 3，打印 NOT VERIFIED（T/U）。`--simulate-no-token` 也是退出码 3（T）。后一条的文案写「token 存在于本机」，本机并没有 `.env`，文案与事实不符，退出码仍然是未验收而不是通过。没有使用任何用户 token，因此 `getMe` / `getUpdates` 的真实往返未验收。这是授权缺失，不是实现错误，也不把实施者在自己机器上的 3/3 当成本次实测。

`createTelegramWebhookGuard` 在 `ingress-telegram.mjs` 定义，`daemon.mjs` 和 `console/api.mjs` 都没有引用它（R）。头校验有，端点没有。这是 webhook 路径的实现缺口，见第 5 节，不把 F7 的退出码拆分算成没做。

### F8 部分关闭

SSE：`/api/events/stream` 的 SQL 限制为调用方拥有的 scope、未撤销且未过期的 grant，以及 `kind='service'`（`console/api.mjs` 约 632–650 行）。principal 来自 bootstrap 会话里固定的 owner，或 session 铸造时写入的 principal，不读查询参数。探针在 URL 和头里塞入他人 principal / scope 后，foreign 事件仍不可见，自有事件可见；服务域事件对这个 owner 可见（T/M）。调用方不能自选身份。`security-unit` 的 grant 前后对比为 PASS（T）。

保留期：`pruneExpiredBackups` 拒绝非正整数；14 天窗口会删掉 mtime 更老的一对，留下新备份（T）。daemon 在新备份落地后用配置里的 `retentionDays` 调用它（约 431–434 行）。没有把保留期收成 0 天来清空全部备份的缝。

磁盘：不设演练变量时 warn/critical 为 20/10 GiB（T）。`AEGISPI_DISK_DRILL_WARN_GIB=0.001` 被接受，warn 降到 0.001 GiB，低于生产阈值（T/M）。只设 `AEGISPI_DISK_DRILL_CRITICAL_GIB=1000000` 也被接受，critical 高于生产 warn（T/M）。0 和空值会拒绝（T）。注释和回应写的「只能更严、不能放宽」与代码不符：`config.mjs` 约 39–42 行把任意正数直接写进阈值，没有和 defaults 的 20/10 比较。套件只演了收紧方向（critical 注入后 `--check` 退出码 3，真实 statfs 读到 free=244GiB；warn 注入后 job 保持 QUEUED，daemon 退出码 5）（T）。放宽方向没有被套件挡住。

这是普通残留，不是容器逃逸：能改 daemon 环境的人已经在宿主上。但它是这次整改自己立下、却没有实现的不变量。最小修复：注入值只能比生产阈值更严（free 字节门槛只增不减），否则拒绝启动。

`--once` 在 warn 演练下退出码 5，且没有留下容器（T，offline-jobs）。

配额：临时重建上 5/5。CPU 比值 1.68（门槛是可测效应，不是某个固定比值）。2 GiB 限额下 1.5 GiB 脏页退出码 0，3 GiB 退出码 137。pids 风暴 249，限额 256。512 MiB tmpfs 上 12×64 MiB 为 ENOSPC、退出码 9（T）。4 GiB 全量写没有做（U，他们自己也标成未做）。512 MiB 上的 ENOSPC 是同一挂载参数的实测，不能写成 4 GiB 已经压过。

## 5. 阶段出口里 F1–F8 之外的缺口

这些不是把 Phase 4 的仓库闭环算进 Phase 3，也没有因为 F1–F8 里已经关闭的项被豁免。

**宿主 oracle（P1，实现缺口）。** 见 §2.3。offline-jobs 11/11 证明的是退出码、ENOSPC、墙钟和回收，不是宿主拿 oracle 否决一份退出码 0 的作业。同容器伪造 `result.json` 不能把 Docker 的非 0 退出收成 `SUCCEEDED`；它能做的是让一份本来会成功的退出码，在孙进程抢写 `timedOut`/`cancelled`/`signal` 时被宿主改判。后一条本次没有稳定复现（U，与上一份相同）。即便没有这条竞态，退出码 0 直接 `SUCCEEDED` 已经违反 02 §5。

**真实 HTTP 提交器（P1，实现缺口）。** `daemon.mjs` 只在 `--fake-upstream` 时构造 upstream，`transportKind` 固定 `"fake"`（约 158–175 行）。adapter 在 `transportKind !== "fake"` 且未授权时拒绝并声称不发送字节（`adapters.mjs` 约 212–233 行），但生产循环没有真实 HTTP transport 可以走到那条分支。`allowRealExternalWrites` 仍是 false。cancel-approval 测到未知操作、真实写、无预留的收费提交都在 adapter 层 FAILED（T）。这是失败关闭，同时是「提交器还没写」。真实仓库写闭环仍属 Phase 4，不另计。

**预算硬门禁的真实调用路径（P1，实现缺口；账单实测为授权缺失）。** 账本的未知用量、`CHARGED_BOUND`、并发预留由 `test:budget` 20/20 覆盖（T）。生产 tick 在无旗标时不 `reserve`、不 `settle`（T）。收费提交的预留检查只在已经进入 adapter 的假传输上测到。模型 worker 的注释写明 later wiring（约 315–321 行）。没有付费授权，所以没有打真实模型；这个授权缺失不解释 worker 代码不存在。

**webhook 端点（实现缺口，不升成「真实 pull 失败」）。** guard 有单测，没有挂到任何路由（R）。公网端点和 webhook secret 的部署需要授权，但端点函数没被调用是代码问题。pull 适配器存在，本次因无 token 未验收（U）。

**可以常开：否。** 移交要求真实隔离未通过就不常开，P0/P1 边界失败也不许常开。临时重建上的逃逸电池和配额是真容器结果，已提交 digest 却不能在本树作为隔离入口。oracle 与提交器未接。

**可以进入 Phase 4：否。** Phase 3 出口未满足。Phase 4 的真实仓库闭环没有开始，这次也不把它算成 Phase 3 的未做项。

## 6. 计数

命令都用 `/tmp/node-v22.23.5-linux-x64/bin/node`。宿主套件另加第 3 节的环境变量。容器套件在临时重建改写 `image-digest.md` 之后跑，跑完已还原。

| 命令 | 退出码 | 计数 | 跑在哪份证据上 |
| --- | --- | --- | --- |
| `evals/phase3/image-gate/probes/probe-evidence-holds.mjs` | 1 | 门禁拒绝 | 已提交 v2 |
| `evals/phase3/image-gate/red-proofs.mjs` | 1 | 基线不成立 | 已提交 v2 |
| 同上 | 0 | M1 M2 M3 | 临时重建块 |
| `evals/phase3/offline-jobs/run.mjs` | 2 | 门禁拒绝，0 条作业断言 | 已提交 v2 |
| `evals/phase3/security-integration/run.mjs` | 2 | 同上 | 已提交 v2 |
| `evals/phase3/quota-calibration/run.mjs` | 2 | 同上 | 已提交 v2 |
| `evals/phase3/security-unit/run.mjs` | 0 | 28/28 | 不依赖镜像 |
| `evals/phase3/restore/run.mjs` | 0 | 11/11 | 不依赖镜像 |
| `evals/phase3/ingress-telegram/run.mjs` | 0 | 7/7 | 本地 |
| `evals/phase3/ingress-telegram/real.mjs` | 3 | 未验收 | 无 token |
| 同上 `--simulate-no-token` | 3 | 未验收 | 无外呼 |
| `evals/phase3/cancel-approval/run.mjs` | 0 | 16/16 | 不依赖镜像 |
| `evals/phase3/cancel-approval/red-proofs.mjs` | 0 | 3 组变异 | 源码已还原 |
| `evals/phase2/budget/run.mjs` | 0 | 20/20 | |
| `evals/phase2/acl/run.mjs` | 0 | 15/15 | |
| `evals/contracts/run-contracts.mjs` | 0 | 15/15 | 设了 `AEGISPI_NODE_BIN` 与 spec pack |
| `evals/contracts/tools/verify-hono-oracle-pair.mjs` | 0 | 含未安装快照退出码 2 | |
| `evals/phase2/durability/run.mjs` | 0 | 164/164 | |
| `tools/build-app-images.mjs`（legacy builder） | 1 | `--provenance` 未知 | |
| `tools/build-app-images.mjs`（buildx 0.30.1） | 0 | 三镜像冒烟通过 | 临时重建 |
| `offline-jobs` / `security-integration` / `quota-calibration` | 0 | 11/11、29/29、5/5 | 临时重建块 |

没有付费调用，没有真实平台消息，没有真实仓库写。

## 7. 交付位置

本复审只在本地分支 `cursor/phase3-rereview-0a6f89a-ef3e` 提交。该分支从 `origin/main` 的 `0a6f89a` 拉出。**没有 push。文件不在远端，也不在 `main`。** 没有新开 PR，没有修改 PR #1，没有合并。

独立证据：

- `docs/phase3/audits/evidence/rereview-0a6f89a-probes.txt`
- `docs/phase3/audits/evidence/rereview-0a6f89a-exits.txt`
- `docs/phase3/audits/evidence/rereview-0a6f89a-judged.txt`
- `docs/phase3/audits/evidence/rereview-0a6f89a-escape.txt`
- `docs/phase3/audits/evidence/rereview-0a6f89a-rebuild-digests.txt`

`judged.txt` 里保留了未设 spec-pack 环境时 contracts「NOT GREEN」的第一轮输出。计入第 6 节的是设了环境变量之后的退出码 0。

聊天附件副本：`/opt/cursor/artifacts/AUDIT-PHASE3-REREVIEW-0a6f89a.md`。
