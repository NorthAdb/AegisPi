# AegisPi Phase 2 独立复审（461c58f）

> 复审协调更正（2026-11-19 17:21 Asia/Hong_Kong）：报告第 2、14 节写「`origin/main` 仍是 `a760611`」不成立。GitHub 上 `NorthAdb/AegisPi` 的 `main` 已复核为 `461c58f968fd96ef9ee3ed752b14f6e879559592`，与被审提交一致。那条观察来自复审机未更新的远程引用，不能用来判断仓库还停在 Phase 1。其余结论仍针对该 SHA，不受影响。


审计身份：独立复审，不是实施者。不采信收口说明、提交说明或 `docs/phase2/reports/phase2-closure.md` 作为完成证据。下列结论来自在检出 `461c58f968fd96ef9ee3ed752b14f6e879559592` 上重跑命令、读生产路径与测试谓词，以及若干不改仓库的旁路测量。

证据记号：

| 记号 | 含义 |
| --- | --- |
| T | 本环境重跑的命令、计数、退出码 |
| R | 当前检出的源码或测试谓词 |
| M | 本审计用锁定 Node 对真实模块做的旁路测量（脚本在 `/tmp`，未改仓库） |
| S | 设计包 v1.4.1 或开工移交里的条款 |
| U | 本环境未能闭合的点 |

本报告没有入库、没有推送、没有开 PR。重跑曾改写 `docs/phase2/evidence/*` 与 `docs/phase1/evidence/contracts-report.json`（套件末尾总会覆写这些文件）；复审结束后已用 `git checkout --` 还原，提交里的实施者证据保持原样。本审计的控制台转录在 `/tmp/audit-logs/`。

---

## 1. 结论

**Phase 2 出口：MET WITH RESIDUAL RISKS（带残留风险通过）。**

没有发现移交文档第 6 节那种必须挡住 Phase 3 的停止条件：恢复后静默丢事件、越权召回、把未知 usage 结成零成本、把 UNKNOWN 当成成功或盲重试、控制台在本机以外无鉴权可访问、本阶段真实外部写。四则根因故事里，当前生产路径是结构性修复，145/20/14/15 与 hono 配对退出码 0 在锁定 Node 上独立复现。

必须继续可见、不得被收口文案盖住的残留：

1. **daemon 进程本身不做 retry_mode 对账。** 启动恢复把 `SUBMITTING` 标成 `UNKNOWN` 后就停。同键重发、LOOKUP 补记是测试进程接着调用 `autoRecoverUnknown` + `dispatchEffect` 做完的。重启 `daemon.mjs` 不会把旗舰窗送进 `SUCCEEDED`。
2. **名为 pre-migration 的 `VACUUM INTO` 发生在 `migrate()` 之后。** 快照库里已经有 `schema_migrations`。收口报告写的「迁移前自动快照」与代码不符。
3. **三处回归网在 Linux 上不够红：** epoch 列没有 `typeof` 断言；Windows 反斜杠 `storage_ref` 的 GC 误删在 Linux 上不会变红；「45 条无权候选」断言的是结果集等于 12 条合法 id，不点数夹具里的 45 条。当前路径经测量是对的，缩夹具或把 `path.join` 写回 Windows 路径不会被现有绿门抓住。

不建议把 1 和 2 升格为 Phase 3 硬阻塞：它们失败方向是保守的（UNKNOWN 保持 UNKNOWN，快照仍是迁移成功后的一致库），也不在移交第 6 节的停止清单里。若主人要求「daemon 重启自身完成旗舰重发」或「06 §9 启动顺序逐字落地」之后才许进 Phase 3，只升格这两条。

---

## 2. 审计对象

| 项 | 观察 |
| --- | --- |
| 仓库 | https://github.com/NorthAdb/AegisPi |
| 被审 HEAD | `461c58f968fd96ef9ee3ed752b14f6e879559592`（detached HEAD，`git rev-parse HEAD`） |
| Phase 1 基线 | `a76061192001186485a284c2ab332ff5fe21bdce` |
| `origin/main` | 仍是 `a760611`。main **没有**走到 461c58f 之后；Phase 2 的 12 个提交在这条检出上，尚未进入 `origin/main` |
| 12 个提交 | `git log --oneline a760611..HEAD` 与移交名单一致，由旧到新：`8c91806`、`4fbef39`、`8a9f42b`、`95a862e`、`6a61524`、`d46b0e4`、`d8778d7`、`c2fbdcd`、`bb789dc`、`d7c4d9b`、`b5476cc`、`461c58f` |
| 相对 Phase 1 的 diff | 51 个文件，`+10148/-18`。`docker/` 无差异。没有新的应用镜像构建 |
| 契约包 | 附件 zip 解到 `/tmp/aegis-pack/aegis-pi-design-pack-v1.4.1`。`schema.sql` SHA-256（原始字节即 LF）=`ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`（M） |
| 产品代码改动 | 无。本审计只新增本文件 |

环境：

| 项 | 值 |
| --- | --- |
| 官方 Node | 自 `https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz` 取得。`SHASUMS256.txt` 中该文件为 `cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`，与本地下载一致。`node -v` = `v22.23.5`，`process.versions.sqlite` = `3.54.1`，同目录 npm `10.9.9` |
| 机器自带 Node | `/exec-daemon/node` = `v22.23.4`。仓库锁定是 `22.23.5`，本机没有预装该补丁 |
| 依赖 | 快照里没有 `node_modules`。用锁定 npm 执行 `npm ci`（125 包）。安装后的 `@earendil-works/pi-coding-agent` 为 `1.5.2`。`node_modules/` 在 `.gitignore` 中 |
| Linux 运行所必需的环境变量 | `AEGISPI_SCHEMA_SQL`、`AEGISPI_RECALL_SQL`、`AEGISPI_SPEC_PACK` 指向解包目录；`AEGISPI_NODE_BIN` / `AEGISPI_NPM_BIN` 指向 22.23.5。指针文件 `apps/daemon/config/schema-source.json` 写的是 Windows 路径 `D:\AegisPi\...` |

不设 `AEGISPI_SCHEMA_SQL` 时，22.23.5 上 `evals/phase2/durability/run.mjs` 在第一条检查前抛出 `SchemaSourceError: canonical schema.sql not found at D:\AegisPi\...`，退出码 **1**（T）。这是失败关闭，不是换成另一份 SQL 继续跑。

---

## 3. 重跑结果

下列命令的工作目录都是仓库根。Node 二进制是上一节的 22.23.5，环境变量按上一节设置。`npm ci` 已完成。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `node evals/phase2/durability/run.mjs` | `145 pass, 0 fail, 145 judged` | **0** |
| `node evals/phase2/budget/run.mjs` | `20 pass, 0 fail, 20 judged` | **0** |
| `node evals/phase2/acl/run.mjs` | `14 pass, 0 fail, 14 judged` | **0** |
| `node evals/contracts/run-contracts.mjs` | 15 个探针全部 PASS（PI-01…PI-13、FRAMING、SQLITE）。SQLITE 摘要写明 Node v22.23.5、SQLite 3.54.1 | **0** |
| `node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 csrf/cors 退出 0/0；4.12.24 退出 1/1；两个未安装快照的 csrf/cors 均为退出 2；解析路径落在目标目录内。lockfile sha256：`e5d0c57e…ba5e`、`db2bb134…dad4` | **0** |

同一套入口在 `/exec-daemon/node`（v22.23.4）上：durability、budget、contracts 都打印 `Refusing to run: process.version=v22.23.4, locked Node is v22.23.5`，退出码 **2**（T）。版本门是硬的。

实施者声称的 145/20/14/15 与 hono 退出码 0 **经独立重跑成立**，条件是锁定 Node 22.23.5 加上设计包路径环境变量。用本机 22.23.4 或空的 schema 路径不能得到这些绿。

计数如何变红（T/R）：`evals/phase2/lib/harness.mjs` 的 `check()` 要求 `cond === true`；`NOTE` 不计入 pass；`fail > 0` 或 judged 为 0 时 `suiteExit` 返回 1。Phase 2 套件里没有把字面量 `true` 直接传给 `suite.check`，也没有 SKIP 状态。契约运行器对 FAIL、SKIP、无 PASS 判据、`--only` 零命中返回 1。删掉一个真实谓词或让子进程退出码变成 0（崩溃点没杀掉进程）都会把对应检查打成 FAIL。

---

## 4. 假绿狩

### 4.1 校验和 pin 不能被环境变量绕过

`loadCanonicalSchema` 允许 `AEGISPI_SCHEMA_SQL` 只替换路径；`expectedSha256Lf` 仍来自 `schema-source.json`，哈希不符抛 `SchemaSourceError`（R，`apps/daemon/src/db/migrate.mjs`）。durability 检查 `checksum-gate-fails-closed-on-tampered-sql` 把规范 SQL 追加 `-- tampered` 后加载，本重跑为 PASS（T）。该门变红的方式：删掉哈希比较，篡改副本会被应用。

`git log` 里 migrator 只有 `4fbef39` 一版，提交进去的代码已经带 pin。D-17 所说「首轮实现曾让 env 旁路 pin」没有留下可 diff 的坏提交（U：坏版本若只存在于提交前工作区，本审计看不到）。当前树上的门是结构性的。

### 4.2 epoch / policy_version 列错位

`d46b0e4` 把 `ensureScope` 的 VALUES 从 `?,?,?,?,?,?,?,?,1,1,0` 改成 `?,?,?,?,?,?,?, 1, 1, ?, 0`，第八个绑定从 epoch 挪到 `policy_version`（R，`git show d46b0e4 -- apps/daemon/src/ingress.mjs`）。这是列位修复，不是多加一条字符串相等断言。

M：真实 `receiveEvent` 之后 `SELECT epoch, typeof(epoch), policy_version, typeof(policy_version)` 得到 `epoch=1/integer`，`policy_version=pv1/text`。

M：把旧的 8 占位符 INSERT 再执行一次，SQLite 仍接受，读出 `epoch` 类型为 text、值为 `pv1`，`policy_version` 为 text `1`。JavaScript 里 `epoch + 1` 得到字符串 `pv11`。SQL `epoch=epoch+1` 则把 `'pv1'` 收成整数 1。

因此：当前写入路径是对的；套件**没有** `typeof(epoch)='integer'` 断言。`dispatcher-refuses-stale-epoch` 在错位数据上仍会因为 SQL 加一之后 `1 !== 'pv1'` 而拒绝，所以「dispatcher 纪元测试变红」并不是这条错位的充分回归网。D-22 写「测试里断言数值类型」，在 `evals/phase2` 里找不到这种断言（R）。

### 4.3 Windows 反斜杠与 GC

`objectRelPath` 用 `["objects", aa, bb, hash].join("/")`，文件路径再用 `split("/")` + `path.join`（R，`objects.mjs`，自 `8a9f42b` 引入时即如此）。GC 只对**目录遍历得到的相对路径**做 `replace(/\\/g, "/")`，不规范化数据库里的 `storage_ref`。

M：写入器给出的 ref 不含反斜杠。把同一文件的 ref 改成反斜杠写入 `objects.storage_ref` 后再跑 `gcUnreferencedContent`，结果 `trashed=1`，被引用文件被搬走。也就是说，写路径一旦再产出反斜杠，GC 仍会删掉被引用文件。

U：本机 `path.join` 使用 `/`，durability 的 `gc-moves-unreferenced-keeps-referenced` 在 Linux 上对 `path.join` 回归保持绿色。Windows 误删是结构性写路径修复，不是被 Linux 套件锁死的红门。

### 4.4 DRAFT 不再把 RUNNING 任务停车

`d8778d7` 把停车包进 `if (requiresApproval && task.state === "RUNNING")`（R，`effects.mjs`）。免审批提案保持 `DRAFT`，只有 `draftToReady` 在白名单 routine 上把它改成 `READY`。需要审批的提案仍把 attempt 置 `PARKED`、任务置 `WAITING_APPROVAL`、fence 不增加。重跑中 `propose-parks-attempt-creates-waiting-approval-fence-unchanged` 与 `task-conclusion-notification-outbox-one-transaction` 均为 PASS（T）。后者在免审批提案之后仍能按活租约收口成 SUCCEEDED；若再无条件停车，条件更新对不上 RUNNING 租约，这条会红。

### 4.5 崩溃不是 mock 恢复函数

`crashpoint()` 在命中 `AEGISPI_CRASH_POINT` 时执行 `process.kill(process.pid, "SIGKILL")`（R，`testing/crashpoints.mjs`）。父进程用 `child.kill("SIGKILL")`（`killHard`）处理孤儿 job 与控制台 daemon。崩溃点插在生产函数里：`ingress.mjs`、`router.mjs`、`approvals.mjs`、`effects.mjs`、`timers.mjs`，不是单独的假恢复模块。

本重跑里带 `signal=` 的行全部是 `signal=SIGKILL` 且 `exit=null`（T，ingress 三窗、dispatch 两窗）。审批、effect、timer、outbox 窗的谓词写的是 `done.code !== 0`，日志里的实测值是 `exit=null`。在 Node 里，信号死亡的 `code` 为 `null`，未捕获异常的 `code` 为 1。`exit=null` 与自毁 SIGKILL 一致。谓词本身偏宽：退出码 1 也能满足 `!== 0`。它变红的方式是崩溃点被拿掉之后子进程退出码 0，或死亡时的行状态与窗口期望不符。

`node:sqlite` 的 `StatementSync.run()` 返回对象。M：`typeof run() === "object"`，键为 `changes` 与 `lastInsertRowid`。生产路径读的是 `.changes`，并与 `!== 1` 比较（R）。若改回把返回值本身和 `1` 比较，CAS 会一律失败，相关检查变红。

stdout 成功不被当成 ACK：ingress 场景在提交之后才打印 `ACK`。三窗的 `ack-line=false`，重投后 `after-commit` 为 `duplicate=true` 且 inbox 仍为 1 行（T）。

---

## 5. 06 §9 崩溃窗与启动

S：06 §9 的矩阵与启动顺序（排他锁、完整性、迁移前备份、验证 schema 与对象引用、恢复 scope/撤权、失联 attempt/job、SUBMITTING→UNKNOWN、校准预算、恢复 Timer/Outbox/inbox、最后才开放执行；失败只开只读诊断）。

本重跑对得上的窗口（T，均来自 `/tmp/audit-logs/durability.txt`）：

| 窗口 | 本重跑记录 |
| --- | --- |
| 入库前 / 事务中 / 提交后未 ACK | 三窗 `SIGKILL`；事务中 inbox=0 且 GC 看到 1 个未引用文件；提交后 inbox=1；重投终态都是 1 行。提交后重投 stdout 含 `duplicate=true` |
| 入库后、派单前 | `recovery-reports-pending-inbox-router-resumes`：`pending/routed=1/0`，随后 `dispatchEventToTask` 建出任务 |
| 计划后、派单事务前 / 事务中 | 两窗 `SIGKILL`、tasks=0；重算后 tasks=1、inbox=`ROUTED` |
| 离线 job 运行中 | `job-orphan-outlived-killed-daemon`：父进程被 `killHard` 之后孤儿 pid 3864 仍存活；`startupRecovery` 把它 SIGKILL 并把 job 置 `LOST` |
| Task 完成、Outbox 发送前 | 子进程 `exit=null`，stdout 含 `FINALIZED` 且不含 `UNREACHABLE`；恢复报告 `ready_outbox=1`，随后 dispatcher 把通知送到 `SUCCEEDED` |
| 审批事务中 / 提交后 | 事务中回滚后同一 nonce 仍可批准到 READY；提交后重放返回 `already CONSUMED` |
| READY→SUBMITTING，调用前 | `exit=null`，effect=`SUBMITTING`，fake remote 投递 0 次；`markSubmittingEffectsUnknown` 后为 `UNKNOWN`；同键重发后 `SUCCEEDED ext-0001`，`appliedCount=1` |
| 远端已成功、本地未记账 | 远程已有 `ext-0001` 而行仍是 `SUBMITTING`；LOOKUP 补记，`appliedCount` 仍为 1 |
| Timer 事务中 / 提交后 | 事务中事件数 0、状态 `SCHEDULED`，重跑后恰好 1 条且 `FIRED`；提交后重跑 `fired=0` |
| 预算中断的保守占额 | 恢复把超时 HELD `res:recovery:stale-held` 打成 `CHARGED_BOUND`；再跑一次 `effect_unknown_after_restart` 审计行仍为 1 |
| 对象文件缺失 | `missing-object-file-opens-readonly`：`mode=read-only`，`failedStep=object-references`，没有 `open-execution` 步 |
| 控制台只读 | `readonly-mode-serves-diagnostics-only`：recovery HTTP 200，`failedStep=object-references`；snapshot 503 `read_only_maintenance`；stdout 不含 `daemon: open` |

旗舰序列在套件里是真的：真实子进程 SIGKILL、持久 fake remote、恢复函数、同键一次成功。它变红的方式：崩溃点移到 CAS 之前（行不会停在 SUBMITTING）、恢复把行写成 SUCCEEDED、或重发换了 idempotency key 使 `appliedCount` 变成 2。

**daemon 接线与套件拼接不是同一条路径（R）。** `startupRecovery` 只调用 `markSubmittingEffectsUnknown`。全仓库对 `autoRecoverUnknown` 的调用只在 `effects.mjs` 的定义和 `evals/phase2/durability/run.mjs`。`daemon.mjs` 的 tick 只派发 `READY`。因此：

- 重启 daemon：SUBMITTING 变成 UNKNOWN，执行环可以开，效果停在 UNKNOWN。
- 套件日志里的「UNKNOWN → 同键重发 → SUCCEEDED」是测试进程继续调用库函数。

这与收口第 3 节「未对账 effect 仍在」一致，也与第 2.1 节表格把整段序列写成「恢复行为（实测）」不完全一致。表格描述的是套件拼接，不是 `daemon.mjs` 的启动副作用。UNKNOWN 没有被标成成功，也没有被盲重试。缺口是「按 retry_mode 对账」没有接进 daemon。

delivery / RPC 那一行不是进程杀死。`delivery-ack-checkpoint-idempotent-and-foreign-checkpoint-refused` 在同一进程里测检查点幂等和异检查点拒绝（T/R）。Phase 2 没有真实 Pi RPC，这条覆盖的是宿主检查点语义。预算「请求中断」也不是杀死 reserve 事务中的子进程，而是种一条已超时的 HELD 再跑恢复校准。收口标题「12/12 全部真实 SIGKILL」覆盖过宽。

启动顺序与备份（R/M）：`daemon.mjs` 的顺序是锁 → 完整性检查 → **`migrate()`** → 若本次应用了迁移或迁移前没有 `schema_migrations`，再 `VACUUM INTO backups/pre-migration-<ts>.db` → `startupRecovery` → 控制台 → 仅当 `mode==="open"` 才进入循环。注释和 D-26 写的是「迁移前备份」。M：`--check` 退出码 0，stdout 末行 `check: mode=open steps=10 GREEN`，控制台行是 `console: 127.0.0.1:4310`。备份文件与活库的 `schema_migrations` 行数都是 1。这份文件是迁移成功之后的快照。SQLite 的 DDL 包在 `BEGIN IMMEDIATE` 里，迁移中途失败会回滚到空库；它没有提供「迁移前」的回滚点。Phase 3 的 restore 不能按文件名把这份库当成迁移前状态。

恢复硬失败不开放执行：见上表最后两行，以及 `daemon.mjs` 在 `recovery.mode !== "open"` 时打印 `daemon loop not started` 并停在只读控制台（R/T）。

---

## 6. HELD 账本与八种 purpose

S：八种 purpose 都要入账；缺 usage 不得当零成本结清；未知 usage 保持 HELD，超时走 `CHARGED_BOUND`，未对账不得释放；并发预留任一账户失败整体回滚；默认 800000 / 5000000 microUSD；时区 `Asia/Hong_Kong`；保温默认关。

重跑（T）：

- `missing-usage-cannot-settle-as-zero`：`settle` 传入 `usage: null` 抛 `MissingUsage`，行保持 `HELD`。
- `charged-bound-conservative-then-trusted-bill-corrects`：上界转入 spent，无 evidence/actor 的修正被拒，带账单与 actor 后 `actualMicrousd=300`，状态仍是 `CHARGED_BOUND`（R：`correctChargedBound` 不把状态改成 `SETTLED`）。
- `seven-purposes-reserve-and-settle`：router、worker、summary、classify、rsi、replay、watchdog 都结算。`warming-off-no-account-no-reserve`：保温关闭时拒绝预留且 `acct:warming-day:%` 行数为 0。`warming-enabled-creates-account-and-reserves`：显式 `warmingEnabled: true` 后账户创建且预留为 HELD。八种 purpose 都有账，保温默认不建账。
- `concurrent-reservations-exactly-one-wins-no-residue`：两个子进程，退出码 4 与 0。退出码 4 是 `budget-race.mjs` 在捕获 `BudgetExceeded` 后的约定失败码，不是崩溃。HELD 赢家 1，task/day `held_microusd` 都是 60000。
- `settle-releases-held-adds-actual-spent`：1407 microUSD 拆成 task 704 + day 703。整数，无浮点门禁。
- `accounts-created-with-spec-defaults`：任务上限 800000，日上限 5000000。`day-key-uses-hong-kong-midnight` 与 `dayKeyFor` 的默认时区 `Asia/Hong_Kong` 一致。
- `chargeable-step-refuses-without-live-reservation` 与异 purpose 拒绝：`workerStep` 调用 `assertLiveReservation`（R）。

`settle` 在 `usage` 缺失或 `actualMicrousd` 不是非负整数时抛 `MissingUsage`，事务不把行改成 SETTLED（R）。这条变红的方式：让 `settle({ usage: null })` 写成 `actual_microusd=0, state='SETTLED'`。

收口把「未对账 effect」和「未知 usage = CHARGED_BOUND，不是账单」列为残留，与代码一致：没有把未知 usage 结成 0，也没有在生产路径里宣称 provider 账单已接通。daemon 的 `--once` 冒烟用的是写死的 `usage: { actualMicrousd: 300 }`，那是 fake worker，不是未知 usage。

---

## 7. D-11：必须经过 load-pi-settings.mjs

`config.mjs` 是 daemon 读 `defaults.json` 的入口，并调用 `piSettingsFromDefaults`（R）。`daemon.mjs` 只 `import { loadDaemonConfig }`，源码中不出现 `defaults.json`。`defaults.json` 的 `cacheWarming` 在 `budget` 下，顶层没有该键。

M（调用安装好的 Pi 1.5.2，与 PI-13 同一 API，没有新造方法名）：

- `SettingsManager.inMemory(JSON.parse(defaults.json)).getCacheWarmingMode()` = **`idle`**
- `SettingsManager.inMemory(piSettingsFromDefaults(raw)).getCacheWarmingMode()` = **`off`**
- `loadDaemonConfig().piSettings.cacheWarming` = `off`，`warmingEnabled` = false，`timezone` = `Asia/Hong_Kong`

durability 四条门本重跑均为 PASS（T）：`daemon-config-flows-through-the-loader`、`raw-defaults-have-no-top-level-cachewarming`、`loader-is-what-makes-off-survive`、`daemon-entry-uses-config-module-not-raw-file`。

变红方式：`loadDaemonConfig` 若把原始 JSON 当成 `piSettings`，第一条 `=== "off"` 失败；`config.mjs` 若不再 import `load-pi-settings.mjs`，源码绊线失败。`loader-is-what-makes-off-survive` 在测试里手造 `{ cacheWarming: raw.cacheWarming }`，它自己不调用 `SettingsManager`；真正的 idle/off 测量在 PI-13，本轮契约套件已通过。绕过加载器这条红门是成立的，但「手造空对象」那一条不是 SettingsManager 实测。

---

## 8. ACL / FTS

`recall.mjs` 内嵌的 SQL 与包内 `recall.sql` 在去掉注释和行首空白后逐行一致（R，并与包文件对照）。`allowed` CTE 在两个 `LIMIT 40` 和最终 `LIMIT 12` 之前过滤 scope、状态、过期、祖先谱系、自身闭包和授权。acl 重跑第一条即 `recall-sql-matches-pack-structure`，路径为本审计解包的 recall.sql（T）。

FTS：schema 含 `trg_msg_ai` / `trg_msg_ad` / `trg_msg_au`（S/R）。重跑：插入后 lex=1 tri=1；更新后旧词 0、新词 1；删除后两边都是 0（T）。

45 条门：重跑文案为 recalled 12 rows，12/12 legal，0 leaked from 25 foreign-scope + 20 ungranted-closure（T）。源码循环是 25+20，另外排除祖先、当前会话、缺闭包、deleted、expired（R）。撤权后召回 0 行，`authorization_revision` 1→2，`acl_version` 1→2（T）。过期授权、跨 scope、A∪C 闭包交集、查询编译器 8 词引号、两字中文 LIKE 回退且声明非 RRF，均为 PASS。

变红方式：把 `LIMIT` 移进 `allowed` 之前，或删掉闭包 `NOT EXISTS`，12 条合法 id 会被挤掉或混入，`rows.length === 12 && leaked === 0 && legalFound === 12` 失败。残留：该断言不 `COUNT` 夹具中的无权行。把两个循环改成 0 条，只要 12 条合法仍在，检查仍绿。当前文件确实种了 45 条。

---

## 9. 四种 retry_mode

持久 fake remote 写入 `fake-remote.json`，进程死亡后仍能读到已应用动作（R，`testing/fake-remote.mjs`）。本重跑（T）：

| 检查 | 记录 |
| --- | --- |
| `at-most-once-unknown-stops-automatic-resend` | 超时记为 UNKNOWN，不是成功 |
| `unknown-never-blind-retried` | AT_MOST_ONCE 停止自动重发；dispatcher 拒绝 UNKNOWN 状态 |
| `idempotency-key-resends-same-key-dedup-remote` | apply-then-die → UNKNOWN → 同键重发 → SUCCEEDED `ext-0001`，远端 1 次 |
| `lookup-then-retry-strong-notfound-resends` | 强一致未找到才重发 |
| `weak-lookup-never-triggers-resend` | 弱一致 not-found 不重发；强一致能看见 `ext-0001` |
| `at-least-once-resend-may-duplicate-declared` | 远端 delivered **2** 次 |

`autoRecoverUnknown` 对未知 `retry_mode` 抛 `UnknownNotReconcilable`，没有默认重发分支（R）。`business_key` 注释与 06 §1.1/§6 一致：本地意图去重。AT_LEAST_ONCE 的 2 次投递说明套件没有把「一次成功」推广成普遍 exactly-once。变红方式：让 AT_MOST_ONCE 的 UNKNOWN 调用 `upstream.submit`，或让弱一致 not-found 走重发。

---

## 10. 最小控制台

`serveConsole` 使用 `server.listen(port, "127.0.0.1")`（R，`CONSOLE_BIND`）。本重跑要求 stdout 含 `console: 127.0.0.1:4390` 才算 ready（R/T）。

实测（T）：无 token 与错误 token 的 snapshot 为 401；`Origin: http://evil.example` 为 403；`POST /api/approvals/x/decide` 为 501 `not_implemented_in_phase2`；只读模式 snapshot 为 503，执行环未打印 `daemon: open`。带本地 bearer 的 health/snapshot/tasks/detail/checkpoints/notifications/recovery 在 open 模式为 200。

token 写在数据目录 `console/token`，不进 Git（`workspace-state/` 已忽略）。这是本机共享用户下的文件权限问题，不是公网无鉴权服务。审批卡、预算台、四大终态视图没有用假数据冒充完成。

---

## 11. 键编码

R/T：

- `dispatchKeyFromProviderId("telegram","E1")` 得到 `telegram:e1`（小写、`source:provider_event_id`）。无供应方 id 时用文档化 canonical envelope 的 SHA-256，重跑 `no-provider-id-source-dedups-on-envelope-digest` 为 PASS，两条不同 payload 得到两个 64 位十六进制 id。
- `businessKey` 形状 `{effect_type}:{domain_key}:{natural_key}`，分隔符百分号转义。`business-key-escaping-separates-objects`：`notify:user%3a123:k1` 与 `notify:user%3a1%3a23:k1` 不同。
- `domain_key` 形状校验在 `kindForDomainKey`；五个构造函数在 `keys.mjs`。ingress 接收调用方已经拼好的 `domainKey`，套件没有单独调用 `ownerUserDomainKey` / `repoDomainKey` 等。形状错误会在 `ensureScope` 抛错。`business_key` 不作为远端 exactly-once 使用，见第 9 节的 2 次投递。

---

## 12. 四项根因：是结构性修复

| 故事 | 代码 | 本审计判断 |
| --- | --- | --- |
| env 绕过 schema 校验和 | `migrate.mjs` 在覆盖路径之后仍比较 `expectedSha256Lf`；篡改副本测试 PASS | 当前树是结构性门。提交史只见修好的版本 |
| Windows 反斜杠 GC | 写路径强制 `/`；GC 只规范化遍历侧 | 写路径是结构性修复。Linux 套件锁不住回退；数据库里的反斜杠 ref 仍会被 GC 当孤儿（M） |
| scope INSERT 列错位 | `d46b0e4` 改 VALUES 列位。现路径 `epoch` 为 integer 1、`policy_version` 为 `pv1`（M） | 修复是结构性的。回归断言没有锁 `typeof`，旧 INSERT 在 SQLite 里仍能静默写入 |
| DRAFT 把 RUNNING 停车 | 停车条件改为 `requiresApproval && state==='RUNNING'` | 结构性修复。免审批后的收口测试会在停车回归时变红 |

---

## 13. 文档是否诚实

开工移交要求把 `docs/phase1/AUDIT-HANDOFF.md` 第 4、5 节从「getChat 失败、标注待确认、不宣称收口」改成收口事实。当前第 4 节写 Telegram 复测退出码 0、`startConfirmed=true`；第 5 节写标注终态 39/36/0。这两节的 Phase 1 事实已经对齐 evidence/07 与 phase1-closure 的口径（R）。

同一文件第 0、5、7 节仍写「Phase 2 未开工」「加载器无产品入口」「未写 daemon 入口」。相对 461c58f 这是过时的。读 AUDIT-HANDOFF 不能判断 Phase 2。Phase 2 的记录在 `docs/phase2/reports/phase2-closure.md`。

收口报告没有写服务常开、已被监控或普遍 exactly-once。第 4 节明确不做这些，并把真实隔离、镜像 digest、真实审批回调、配额校准、备份演练、磁盘告警留在 Phase 3。这些项在代码里也没有被绿门偷偷完成：`docker/` 无 Phase 2 diff；控制台对审批决定返回 501；dispatcher 默认没有真实上游（R）。

收口报告里两处与代码不符，应保持可见：

- 第 2.1 节标题把矩阵说成全部真实 SIGKILL。delivery 检查点与预算超时校准不是杀进程。
- 第 3 节「迁移前自动 VACUUM INTO」。测量到的快照在 `migrate()` 之后，且已含 `schema_migrations`。

`defaults.json` 顶部注释仍写「运行时预算门禁在 Phase 2/3 实现」「最小推理契约待执行」。账本与加载器已经在本树里；注释落后于代码。模型 id 仍是 `deepseek` / `deepseek-flash`，本审计没有重放付费推理，也没有发 Telegram。

`package.json` 的 `engines.node` 是 `22.23.5`；`package-lock.json` 根上的 engines 仍是 `>=22.19.0 <23`。真正拒绝 22.23.4 的是运行器，不是 lockfile 的 engines 字段。

---

## 14. 后来的阶段不要据此相信的事

- 不要相信 `origin/main` 已经包含 Phase 2。它还在 `a760611`。
- 不要相信本机 Node 22.23.4 能跑出 145/20/14/15。它退出码 2。
- 不要相信 145 次 PASS 等于 06 §9 每一行都是一次 SIGKILL。
- 不要相信重启 daemon 会把 READY→SUBMITTING 的崩溃自动重发到 SUCCEEDED。它会标 UNKNOWN 并停在那里，除非另有调用方执行 `autoRecoverUnknown`。
- 不要相信 `backups/pre-migration-*.db` 是迁移前的库。
- 不要相信 Linux 上的 GC 绿门锁住了 Windows 反斜杠回归，或 epoch 测试会在列错位复现时变红。
- 不要相信普遍 exactly-once、常开、监控、真实隔离、真实审批回调、镜像 digest 已在本阶段取得，或配额已经按真实负载校准。
- 不要相信 AUDIT-HANDOFF 第 0/7 节对「Phase 2 未开工」的描述仍是 461c58f 的现状。
- 不要把本报告的通过理解成产品已可对外写或已可常驻。数据源是 fake remote 与本地 SQLite。

---

## 15. 阻塞与残留（给 Phase 3 入口）

**阻塞（必须先修才能开始 Phase 3）：无。** 移交第 6 节的六条停止条件在本检出上没有被打破。

**允许留下、但必须继续写在交接里的残留：**

1. daemon 不执行 retry_mode 对账；旗舰「同键重发恰好一次」是套件拼接，不是进程重启的行为。
2. 启动备份在迁移之后，文件名与 06 §9「迁移前备份」不一致。备份演练、加密 manifest、删除清单仍属 Phase 3 `test:restore`。
3. 未知 usage 的诚实状态是 HELD，超时后是 CHARGED_BOUND；没有真实 provider 账单。未对账 effect 停在 UNKNOWN，直到人工 `reconcileUnknown`（要 actor 与证据）或测试里的 fake 策略。
4. epoch `typeof`、Windows `storage_ref`、45 条夹具计数这三张网在 Linux 绿跑下可以不红。当前实现经 M/R 是对的。
5. lockfile+PID 锁的 PID 复用窗口（D-18）仍在。本重跑覆盖了死 PID 夺锁与第二实例退出码 1，没有证明 PID 复用安全。
6. 心跳 10s / 租约 45s / 容器配额仍是 06 的占位，未按真实工具时长校准。磁盘水位告警未做。
7. `receiveEvent` 接收的是已映射主体与 scope，不是平台签名验证。真实 ingress 是后续工作。

Phase 3 可以开始的前提，与 04 的入口一致：本阶段恢复与 ACL 测试在锁定 Node 上通过，并且三个应用镜像的真实 digest 仍是 Phase 3 自己的入口条件，不是本树已经具备的事实。
