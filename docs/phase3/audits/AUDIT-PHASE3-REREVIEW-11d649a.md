# Phase 3 独立复审（11d649a）

预定入库路径：`docs/phase3/audits/AUDIT-PHASE3-REREVIEW-11d649a.md`（由实施者稍后归档）。可交付副本：`/opt/cursor/artifacts/AUDIT-PHASE3-REREVIEW-11d649a.md`。本文件写在本地审计分支，未推送。远端 `origin/main` 在落笔前再次 fetch，仍是 `11d649acd2f009be0464bb6a4b8e27a4173a18f3`。不要把本报告当成已经进入 main 的归档。

标记：已测事实（T）、静态判断（R）、未验收（U）。实施者自报只作待核清单，计数以本机命令退出码和报告正文为准。

## 结论

**MET WITH RESIDUAL RISKS。**

上轮四个实现缺口（镜像 context 绑不住已提交树、宿主 oracle 未读、生产 tick 没有 HTTP 传输、模型调用不进预算）在本树上已经有可复现的实现，并用本机命令核对过。F2–F6 保持关闭。F7 缺 token 的真实入口仍是 exit 3，真实只读未跑。F8 的磁盘演练放宽在本轮被启动拒绝挡住。

不宣布常开。不授权 Phase 4。真实模型账单、真实外部写、公网 webhook、真实 Telegram 只读仍是授权待验，环境里没有这些凭据，本轮没有调用。

`test:security:unit` 在本机不是 41/41。两条 HTTP 用例失败，原因是审批把 `next_attempt_at` 设到播种时刻之后 100ms，本机 daemon 在 99ms 内完成第一次 tick，效果行还没到点，所以停在 READY、零请求。把 tick 推迟到 250ms 之后，同一条生产路径（无 `--fake-upstream`）授权则 SUCCEEDED，未授权则零请求并 `adapter_refused`。这是套件时序，不是传输缺席。

## 固定提交与环境

| 项 | 值 |
| --- | --- |
| 被审提交 | `11d649acd2f009be0464bb6a4b8e27a4173a18f3`，detached worktree `/tmp/aegis-11d649a`，不含旧审计分支文档 |
| 远端 | fetch `origin/main` 与该完整 SHA，两者指向同一提交；`11d649a` 是 `origin/main` 的祖先（即它自己） |
| 父提交 | `f413046edecb7b4563556e558a6e543b200877f7` |
| 11d649a 相对 f413046 | 只改 `docs/` 与 `.audit/`。不改 daemon、镜像构建输入、`package-lock.json` |
| Node | 官方 `node-v22.23.5-linux-x64.tar.xz`，对照 `/tmp/SHASUMS256.txt` 为 OK；`process.version` = v22.23.5 |
| Docker | 29.1.3；本地 registry `127.0.0.1:5000` |
| 规范包 | `/tmp/aegis-spec/aegis-pi-design-pack-v1.4.1`，`AEGISPI_SCHEMA_SQL` / `AEGISPI_RECALL_SQL` / `AEGISPI_SPEC_PACK` 指向该包 |
| 凭据 | 工作树无 `.env`；环境变量中无 Telegram / API token。未读任何用户凭据 |

提交链与自报的八个提交一致：`7a5425a` 归档、`49f907d` F1、`ff30376` oracle、`ba14372` HTTP、`8af0966` worker、`5250243` webhook、`f413046` 磁盘、`11d649a` 文档。归档 blob `9e82f30ba1be9f34c78275b0c2be9a2dd6b3de5e` 与上一轮本地报告提交 `c55efe10` 的同一路径 blob 相同（T）。

D48–D55 已读。它们是实施者的决策记录，下面的判定以代码、套件退出码和独立探针为准。

## 镜像（F1）

已提交机器块的 context，在未改写的终树上重算，三台都匹配（T）：

- agent `sha256:0eee2b6fd6f3ff7bc1c2454390b529306e7d113c593854291900f9fdc4bb0d32`
- acquisition `sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012`
- execution `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab`

这三台 manifest 在本机 registry 都是 HTTP 404（agent `1bed0ab1…`、acquisition `3c5b4dba…`、execution `202dfcd4…`）。未改写证据上的 image-gate、红证、offline、security-integration、quota 都因此停住：gate 与三个隔离套件 exit 2，红证 exit 1。这是本机没有他们的镜像字节，不是 context 漂移，也不把 digest 不同当成伪造。

LF 规范化（T + R）：`contextFileBytes` 把 `\r\n` 换成 `\n` 再参与哈希；`tools/build-app-images.mjs` 的 `stage()` 把同一函数的输出写进构建上下文。本检出 49 个 context 文件全部是 LF、合法 UTF-8，规范化字节等于提交字节。单独试验：只含 CRLF 差异的文件哈希相同；多一个内容字符则哈希不同。无效 UTF-8 会被替换（3 字节变成 7 字节）。当前清单里没有这种文件。CRLF 差异不会在镜像里留下另一份字节，因为暂存和哈希走同一份规范化结果。

`5250243` 的 agent context 是 `sha256:6ac4f3dc…`，机器块里的 `0eee2b6f` 是 f413046 改过 `daemon.mjs` / `config.mjs` 之后的树（T）。人读行仍写「源码提交：52502432d21f」。门禁读的是机器块，机器块的 context 与终树一致。人读提交号落后于字节，记为文档偏差，不重开 F1。

临时重建（构建工具改写了 `image-digest.md`，跑完已 `git checkout -- docs` 还原）得到另一组 manifest，context 与机器块相同：agent `f5977991…`、acquisition `7bbf414d…`、execution `ee512211…`。acquisition / execution 与上一轮在本引擎上对同一 context 的重建一致。红证 M1–M4 在这组证据上 exit 0：关掉 registry、context、config 交叉、linux/amd64 任一检查，对应探针变红，源码逐字节还原后恢复。隔离套件跑的是这组本机 digest，不是他们机器上的 `1bed0ab1` / `3c5b4dba` / `202dfcd4`。他们的镜像字节在本机未执行（U，registry 不可用）。

## 宿主 oracle

`evaluateJobOracle` 的输入是 daemon 从 `docker inspect` 得到的退出码，以及宿主收上来的 `stdout.txt` 字节；`requiredOutputHash` 由宿主对这两样计算。`result.json` 不进入这个函数（R，`job-oracle.mjs`、`container-executor.mjs` 的 `pollOnce`）。

临时重建上的真实容器（T，`offline-jobs` 2026-11-20T04:18:38Z）：

- 无 oracle：拒绝，作业行不存在，没有残留容器。
- 容器 exit 0 且 stdout 与绑定哈希矛盾：`FAILED(oracle_mismatch)`，行 `FAILED/0`，审计一条。
- 容器停止后 `docker cp` 植入 `timedOut` / `cancelled` / `signal`：三份伪造都进了宿主证据，终态仍是 `SUCCEEDED/0`。

孙进程改写 `stdout.txt` 的窗口，套件自己记为未稳定复现。本轮没有把它复现出来，按普通残留保留，不升成新的缺陷。

## HTTP 提交

生产 tick 在配置了 `upstream.submitUrl` 且没有 `--fake-upstream` 时，走 `createHttpUpstream`，再包进 `createAdapterUpstream`，`transportKind` 为 `real`（R）。默认 `allowRealExternalWrites` 为 false。

套件两条生产 tick 在本机失败（T，见上）。独立探针把服务放在另一个进程里，躲开 `spawnSync` 堵住本进程事件循环的问题（T）：

- 到点之后的授权 tick：exit 0，效果 `SUCCEEDED`，`externalId=ext-probe`，服务只收到一次 submit，body 是适配器字段 `{operation:im.notify, targetResource, expectedHead:null}`。
- 未授权：exit 0，效果 `FAILED`，错误文本是 adapter refused、real external writes are not authorized，服务收到 0 个请求，审计有 `adapter_refused`。
- 未审批：停在 `WAITING_APPROVAL`，0 个请求。
- `timeoutMs=400` 打一个 8 秒才应答的路径，`retry_mode=AT_MOST_ONCE`：第一次 tick exit 4，状态 `UNKNOWN`，错误 `This operation was aborted`；第二次 tick 仍是 UNKNOWN、exit 4，submit 总数保持 1。

审批哈希不符、取消先于派发，在同一次 `security-unit` 里是 PASS（T）。真实平台（GitHub / 邮件 / Telegram 发送）没有写。这条路径是宿主配置的一个 HTTP 端点，载荷是内部 operation，不是平台 API 客户端。默认策略下字节出不去。真实端点部署仍是授权项（U）。

## 模型 worker

无 `--fake-upstream`、配置了 loopback 端点时，tick 的顺序是 claim、heartbeat、`ledger.reserve`、`workerStep`、`callModelOnce`、再按目录结清（R，`daemon.mjs`）。`security-unit` 对该路径的测量（T）：预留 `created_at=1795147938341`，服务收到 `1795147938400`，结清 `1795147938407`；500000 / 250000 token、目录 100 与 200 microUSD/百万 token，结清 100 microUSD，`source=model-http-transport`。缺 usage 保持 HELD。价格目录为 null 保持 HELD。非 loopback 且 `allowRealModelCalls` 不为 true：零预留，任务保持 QUEUED，日志写明未授权。

独立计算 `microusdForUsage` 得到同一个 100；缺 completion token 或目录一侧为 null 时返回 null（T）。

宿主客户端是 `fetch` 一个配置好的 URL，body 为 `{model, messages}`，读取 `choices[0].message.content` 与 `usage.prompt_tokens` / `completion_tokens`（R）。daemon 源码不引用 `@earendil-works/pi-coding-agent`。容器 worker 写明 `PI_OFFLINE=1`、密钥不进镜像，模型调用由宿主代理。本轮临时重建的 agent 冒烟是 `self-check: green (pi 1.5.2)`（T）。这条路径接的是宿主预算门和 OpenAI chat 形状的最小子集，不是 Pi SDK 的 provider 对象。本地服务证明的是这条宿主路径和失败关闭，不是一张真实账单（U）。未把「未打付费接口」记成代码缺席。

## Webhook 与磁盘

路由 `POST /ingress/telegram/webhook` 在 `/api/*` 之外，不要求 console bearer，也不走 `/api` 的 CSRF。全路由中间件仍检查 Host 与 Origin；进程只 `listen` 在 `127.0.0.1`（R）。

本机测量（T）：无 secret 为 503 且 inbox 0；缺头或错头为 403 且 inbox 0；合法头 202，inbox `DONE/OBSERVE`，重复 `update_id` 仍是一行，tasks 0；只读模式 503。错误 Host、错误 Origin 都是 403，合法头的那次才入队。短于 16 字符的 secret 在 `createTelegramWebhookGuard` 抛 `TelegramWebhookSecretMissing`，进程 exit 1，没有打印 console 监听行。公网 Telegram 投递未做（U）。当前白名单只有 `127.0.0.1:port` 和 `localhost:port`，公网 Host 会被这道门拒绝，直到主人改绑定并配置 secret。

磁盘（T）：`AEGISPI_DISK_DRILL_WARN_GIB=0.001`、`CRITICAL=5`、单独 `CRITICAL=25` 都被 `ConfigError` 拒绝；`WARN=25` 且 `CRITICAL=12` 接受。daemon `--check` 在 0.001 上 exit 2，输出含 refusing to start 与 tighten。`WARN=2000000` 与 `CRITICAL=1000000` 一起抬高后，`--check` exit 3，真实 statfs，`level=critical`，free=243GiB。低于生产或倒序的注入不再被当成一次成功的演练。

## 套件

前置：锁定 Node，规范包 SQL 路径已设。隔离类在临时重建 digest 上跑；未改写终树的那一轮是 exit 2，见证据。不计 setup 失败。

| 命令 | 退出码 | 计数 |
| --- | --- | --- |
| image-gate（未改写证据） | 2 | registry 404，context 匹配 |
| image-gate 红证（未改写） | 1 | 干净门过不了 404 |
| image-gate 红证（临时重建） | 0 | M1–M4 |
| offline-jobs | 0 | 14 PASS / 0 FAIL |
| security-integration | 0 | 29 PASS / 0 FAIL |
| quota-calibration | 0 | 5 PASS / 0 FAIL |
| security-unit | 1 | 39 pass / 2 fail / 41 judged |
| restore | 0 | 11 / 11 |
| ingress-telegram | 0 | 7 / 7 |
| ingress-telegram real | 3 | NOT VERIFIED，token 未配置 |
| ingress-telegram `--simulate-no-token` | 3 | 退出码对；文案写「token 存在于本机」，本机并没有 |
| cancel-approval | 0 | 16 / 16 |
| cancel-approval 红证 | 0 | 三组变异 |
| budget | 0 | 20 / 20 |
| acl | 0 | 15 / 15 |
| contracts | 0 | 15 / 15 |
| verify-hono-oracle-pair | 0 | hono 4.13.19 配对通过 |
| durability | 0 | 164 / 164 |

## 关闭矩阵

| 项 | 上轮 | 本轮 |
| --- | --- | --- |
| F1 context / 平台 | 部分：Linux 重算对不上已提交块 | 关闭。终树 context 与机器块一致；linux/amd64 红证在临时重建上通过。他们的 manifest 字节本机 404（U） |
| F2 输出目录所有权 | 关闭 | 保持。integration 首条：新 volume 上 uid 999 可写 |
| F3 备份等长篡改 / 明文 | 等长拒绝已关闭；明文是残留 | 保持。restore 11/11，含等长拒绝与保留期。明文仍是残留 |
| F4 重定向 | 关闭 | 保持。integration 含跨主机拒绝、同主机跟随、死源不算安全拒绝 |
| F5 逃逸探针 | 关闭 | 保持。integration 29/29，含 bridge 对照 |
| F6 无旗标伪造结清 | 关闭 | 保持。无旗标 tick 零结清零预留；夹具结清带 `fake-worker-fixture` |
| F7 缺 token 冒充通过 | exit 3 已关闭；真实只读 U | 保持。无 token 的 real 入口 exit 3，文案承认未配置。真实 getMe/getUpdates 未跑（U） |
| F8 SSE / 保留期 / 磁盘放宽 | SSE 与保留期关闭；演练可放宽 | 演练放宽关闭。低于生产或倒序 exit 2；收紧对仍能把真实 statfs 打到 critical |
| 宿主 oracle | 未接线 | 关闭。exit 0 对不上绑定哈希则 FAILED；伪造 result.json 不改终态 |
| 真实 HTTP | 无传输 | 关闭。生产 tick 在到点后把适配器字段送到本机服务；未授权零请求。真实平台未写（U） |
| 模型 worker | 无调用 | 关闭「tick 不预留不结清」。同钟预留在调用前，100 microUSD 来自目录，缺 usage 或未授权价格保持 HELD。真实账单 U。宿主客户端不是 Pi SDK 对象，见上节 |
| webhook 未挂到路由 | 缺口 | 关闭挂载缺口。本地阶梯与 Host/Origin 拒绝已测。真实 webhook 源 U |

## 普通残留

这些不挡本轮「实现已经在、本地路径测过」的判断，也不是常开条件已经满足。

- 备份库是明文 SQLite，密封的是 manifest。
- 同主机重定向允许换端口；跨主机默认拒绝。
- 备份先哈希再复制，两次读之间的替换窗口还在。
- 4 GiB 全量写没有做。本轮 quota 用的是套件里的有界脏页 / tmpfs 用例，5/5 通过。
- PID 复用窗口仍在恢复逻辑的已知边界里。
- stdout 微秒竞态未稳定复现。
- `image-digest.md` 人读提交号是 `52502432d21f`，context 哈希是其后那次源码改动的树。
- `--simulate-no-token` 在没有 `.env`、没有 token 环境变量时仍打印「token 存在于本机」。无旗标的 real 入口文案是对的，退出码都是 3。
- 短 webhook secret 是未捕获异常 exit 1，端点没有打开。
- `security-unit` 把审批时间写成 `now+100`，快机器上第一次 `--once` 会赶在 `next_attempt_at` 之前，两条用例变红。推迟 tick 后行为成立。
- 模型调用的 bearer 放在短命子进程 argv 里。

## 授权待验

- 真实模型端点、密钥槽、价格目录和单次上限。本轮只打了 loopback。
- `allowRealExternalWrites=true` 指向真实平台。本轮授权用例只打 `127.0.0.1`。
- 公网 webhook 的 Host 绑定和真实 secret。当前只接受本机 Host。
- Telegram `getMe` / `getUpdates`。本机无 token，real 入口 exit 3。
- 他们构建机上的三枚 manifest 字节。本机 registry 没有，行为证据来自同一 context 的临时重建。

## 出口

Phase 3 规范出口按本轮测量是 **MET WITH RESIDUAL RISKS**：隔离、审批、预算、恢复、宿主 oracle、HTTP 传输和模型结清都有本机退出码，失败方向是拒绝而不是记成成功。常开：否。Phase 4（真实仓库业务闭环）：否。上面的授权清单没有一项因为「还没授权」被写成代码不存在。

## 证据

- `docs/phase3/audits/evidence/rereview-11d649a-exits.txt`
- `docs/phase3/audits/evidence/rereview-11d649a-probes.txt`
- 原始输出留在审计机 `/tmp/aegis-audit-11d649a/`（gate、红证、security-unit、探针）。套件改写过的 `docs/**/evidence` 与 `image-digest.md` 已按被审提交还原，不进入本报告的提交。
