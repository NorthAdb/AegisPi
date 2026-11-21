# Phase 4 单元 4.1 独立对抗审计报告（对象：`8943a108df5fceb0a98a91771b23464e50c34dfb`）

> **审计日期**：2026-11-21（Asia/Hong_Kong）  
> **待审目标提交**：`8943a108df5fceb0a98a91771b23464e50c34dfb`（`origin/main`，工作树干净）  
> **核查演进链**：`52354a8b2bfd17c6ba836637df1054e0ef0d7b9b`（D-77/D-78 实施任务书基线）→ `9b1d5fda8cc42ff456708f2afe23a90631759a3c`（D-79 首版实施与纪元 3）→ `8943a108df5fceb0a98a91771b23464e50c34dfb`（D-80 三单元 19 项加固与纪元 5）  
> **审计依据**：`docs/phase4/phase4-1-implementation-task-spec.md`（含 D-77/D-78）、`docs/adr/0001-model-path-pi-host-execution.md`（含 `3fd81c6` 澄清）、`docs/phase4/phase4-restricted-kickoff-draft.md`、`docs/phase4/reports/phase4-1-closure.md`、`docs/phase3/reports/image-digest.md`、`docs/phase3/reports/phase3-status-and-remaining.md`、`.audit/decision-trail.tsv`（D-76–D-80）  
> **最终裁定**：**`PASS WITH RESIDUALS`**（`0 P0 / 0 P1 / 4 P2` 非阻断边界观察；按主人裁定的**路线 A** 冻结于 `8943a108df5fceb0a98a91771b23464e50c34dfb` / 纪元 5，不追加非阻断代码提交，4 项 `P2` 观察与 `heartbeat` 时序对齐延后至单元 4.2 许可 1 实施轮统筹处理）

---

## 一、审计纪律与只读自证

1. **只读代码与证据审计**：未改写任何源码、历史审计原稿或冻结证据（`git diff 52354a8..8943a10 --name-only -- docs/phase1/audits docs/phase2/audits docs/phase3/audits docs/phase4/reviews docs/phase3/evidence/model-real* docs/phase3/evidence/external-write-real* docs/phase3/evidence/ingress-telegram-real*` 输出为空）。
2. **零真实外部调用**：未读取 `.env`，未运行 `test:model:real`、`test:external-write:real`、`test:ingress-telegram:real`（含模拟或无 key 模式）。
3. **本机只读复核（锁定 Node `v22.23.5`）**：
   - `evals/contracts/tools/verify-hono-oracle-pair.mjs`：退出码 `0`（4.13.19 baseline、4.12.24 target、两未安装快照均精确匹配）。
   - `parseAppImageDigests()`（`evals/phase3/lib/image-gate.mjs`）：`IMAGE_GATE_VERIFIED`（纪元 5 `agent` 与携带的 `acquisition`/`execution` 在本地 `127.0.0.1:5000` registry 与本树 context 零漂移）。
   - `loadCanonicalSchema()`（`apps/daemon/src/db/migrate.mjs`）：`ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995` 校验通过。
   - 生产树 `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：退出码 `1`（0 命中）；`docs/` 与 `.audit/` 历史提及共 25 处保持原样。
   - 只读内存探针：`assertValidModelBaseUrl` 拒绝 `/chat/completions`、`/v1`、query、hash 与非 http(s) 协议；`process.env.DEEPSEEK_API_KEY` 存在时 `bearer: null` 与 `bearer: "   "` 均在 `spawn` 前以 `kind: "local"` 失败关闭；`timeoutMs: 2147000001` 被拒绝；`microusdForUsage` 缺 `totalFromProvider` 键、非布尔值、全零均返回 `null`，`rate === 0` 返回 `0`；内存 SQLite 调用 `ensureModelRequestsTable(db)` 前后 `schema_migrations = 1` 不变、用户表 `27 -> 28`；`reserveInTx` / `settleInTx` 分别触发 `WarmingDisabled` 与 `MissingUsage`；系统临时目录 `lockHostProposalsDir` + `inspectHostProposalsAcl` 实测 `aclOk: true`、`safeTaskDirComponent` 输出上界 41 字符。

---

## 二、五项重点核查清单结果

### 1. 范围锁定与失败关闭核对（`apps/daemon/config/defaults.json`、`apps/daemon/src/config.mjs`）

- **`defaults.json`（VERIFIED）**：`budget.taskMicroUsd = 800000`（L5）、`budget.dayMicroUsd = 5000000`（L8）、`budget.cacheWarming = "off"`（L9，顶层无 `cacheWarming`）；`model.baseUrl = null`（L29，替换旧 `endpoint`）、`model.allowedPurposes = []`（L30）、`model.allowedModelIds = []`（L31）、`model.allowRealModelCalls = false`（L32）、`model.callUpperMicrousd = 1000`（L33）、`model.callTimeoutMs = 60000`（L34）、四项 `model.priceCatalog.* = null`（L37–L40）；`policy.allowRealExternalWrites = false`（L49）；`upstream.submitUrl = null`（L53）；`credentials.{mail,repo,im} = null`（L58–L60）。`git diff 9b1d5fd..8943a10 -- apps/daemon/config/defaults.json` 为 0 行。
- **`config.mjs`（VERIFIED）**：L76 保持通过 `piSettingsFromDefaults(defaults)` 映射（D-11）；L80–L98 对非空 `model.baseUrl` 调用 `assertValidModelBaseUrl` 并校验 `callUpperMicrousd`（非负安全整数）与 `callTimeoutMs`（`1..2_147_000_000`），违例抛 `ConfigError`（`daemon.mjs:71-74` 以 `exit 2` 拒绝启动）；L128–L131 以 `const { endpoint: _removed, ...rest } = modelRaw;` 显式剥离旧 `endpoint` 键。
- **`model-call-child.mjs` 删除（VERIFIED）**：文件已删除，生产树 `git grep` 零命中，`docs/` 与 `.audit/` 历史提及字节未动。

### 2. 执行核心与凭据隔离（`model-call.mjs`、`model-call-pi-child.mjs`、`adapters.mjs`）

- **`@earendil-works/pi-ai@1.5.2` 单一核心（VERIFIED）**：`model-call-pi-child.mjs:7-8, 79, 93, 100-109` 仅导入并使用锁定传递依赖 `@earendil-works/pi-ai@1.5.2` 的 `getBuiltinModel` 与 `completeSimple`（无新依赖、无 `AgentSession` 循环），调用选项必传 `reasoning: "high"`、`env: {}`、`maxRetries: 0`、`timeoutMs`、`signal`、`apiKey`；`parseModelWhitelistKey`（`model-call.mjs:118-127`）区分白名单键 `deepseek/deepseek-flash` 与 wire `model.id = "deepseek-flash"`。
- **根 `baseUrl` 校验（VERIFIED）**：`assertValidModelBaseUrl`（`model-call.mjs:95-114`）拒绝非 `http(s)`、非空/`/` pathname、query 与 hash，传入 `url.origin` 至子进程（L163），由 OpenAI SDK 拼接单段 `/chat/completions`，wire 断言 `model="deepseek-flash"` 与 `thinking.type="enabled"`。
- **凭据与环境隔离（VERIFIED）**：`buildSafeChildEnv`（`model-call.mjs:21-51`）仅保留 20 个 OS/TLS/locale 白名单环境变量，阻断 `pi-ai` 在 `options.env={}` 时回落读取子进程 `process.env.DEEPSEEK_API_KEY`；`apiKey` 仅经 `stdin` JSON 传递；`bearer` 为空/全空白在 `spawn` 前（`model-call.mjs:146-156`）及子进程入口（`model-call-pi-child.mjs:72-75`）均 fail closed（`kind: "local"`）；`adapters.mjs:281-286` 已移除 `credentials.model` 旁路，仅解析 `createCredentialService(db).resolve("model")`。
- **`microusdForUsage` 与 `timeoutMs`（VERIFIED）**：`extractUsage`（`model-call-pi-child.mjs:39-55`）与 `microusdForUsage`（`model-call.mjs:285-318`）验证 `totalFromProvider` 自有布尔属性、四字段非负整数及总和 `> 0`、逐类价格非负整数（`0` 合法、`tokens > 0` 缺价返回 `null`、`tokens === 0` 允许 `null`）、`BigInt` ceil 求和；三层强制 `timeoutMs <= 2_147_000_000`。

### 3. 扩展表、账本 `InTx` 与七态状态机（`db/migrate.mjs`、`budget.mjs`、`recovery.mjs`、`model-requests.mjs`）

- **D-78 冲突 1（VERIFIED）**：`ensureModelRequestsTable(db)`（`migrate.mjs:161-180`）独立导出，按需在 `daemon.mjs:178` 与需要该表的 3 个套件中调用，不写入 `schema_migrations`；canonical `schema.sql`、`schema-source.json`（`ede73ecaa...`）及 `sqlite-node.mjs:90`、`durability/run.mjs:61,93,103,116,2692`、`migrate.mjs:147`、`restore/run.mjs:278` 全部 27 表锁死断言保持原样。
- **建行前校验与 `InTx`（VERIFIED）**：`validateAndAuthorizeModelProposal`（`model-requests.mjs:461-521`）与 `checkRunningClaimIdentity`（L129-L160, L574-L588）及 `MAX_PROPOSAL_FILE_BYTES`（L957-L970）将 6 类拒绝触发、无路径根校验、未授权非环回端点与 `warming_disabled` 全部拦截在 `INSERT INTO model_requests` 之前（0 行 0 预留）；`admitAndReserveModelRequestTx`（L523-L651）在单事务 + `SAVEPOINT reserve_sp` 内完成 `RECEIVED` 建行与 `ledger.reserveInTx`（预算拒绝时回滚预留副作用并将请求行置 `FAILED`）；`budget.mjs:177-393` 已将 `WarmingDisabled`/`PURPOSES`/整数边界/`accounts`/`MissingUsage` 校验及 `SAVEPOINT` 下沉至 `*InTx`。
- **七态状态机与边界（VERIFIED）**：
  - `T4/T5`（pre-call 窗口）：`crashpoint("model_requests:after-reserve-before-executing")`（L708）之后、`EXECUTING` 提交（L729）之前再次复检 `checkRunningClaimIdentity`（覆盖 `DEAD`/`LOST`/租约过期）并通过 `cancelPreCallModelRequest`（L833-L868）释放预留；`recovery.mjs:109-127` 第 8 步清理卡在 `RECEIVED` 的残留行，并在 `staleHeld` 查询中排除 `mr.state = 'RESERVED'`，确保 T5 越过 15 分钟超时仍保持 `RESERVED`/`HELD`、绝不进入 `CHARGED_BOUND`。
  - `T6`（post-`EXECUTING`）：`commitExecutingTransition`（L653-L662）单独提交后不可 release（L839），超时进入 `CHARGED_BOUND(1000)`。
  - `T7`（迟到 usage）：`settleLateModelUsage`（L872-L897）仅在 `request=EXECUTING && ledger=HELD`（L304）时纯账本一次结清，重放丢弃。
  - `T8/T9`：usage 缺失/全零/缺价时请求行落 `HELD`、账本保持 `HELD`，两命名空间清晰分离；`10/0 -> 3 µ$` 合法结清。
  - `T10` 与租约过期（`leaseSeconds=45 < callTimeoutMs=60000`）：`processModelRequestAsync`（L801-L814）在等待期间每 `Math.floor(leaseMs / 3)` 续租 `heartbeat`；写回阶段 `isClaimExpiredOrTerminal`（L196-L208）识别终态/租约过期后照常执行 `ledger.settleInTx`（`SETTLED`），请求行转 `ORPHAN` 存证，跳过会抛 `StaleWorker` 的 `completeTaskInTx`（L402）与结果投递（L448）。

### 4. 容器沙盒、宿主 ACL 与 Daemon 生命周期（`docker/agent/src/worker.mjs`、`container-executor.mjs`、`daemon.mjs`）

- **`worker.mjs`（VERIFIED）**：闭字段 10 键信封（L184-L195）、小写 `UUID_V4_RE`（L40）与同 attempt `usedRequestIds` 防重用（L170-L175, L318）、128 KiB 字节上限（L179-L182）、`.tmp`+`rename` 原子写（L197-L199）、`serveCommands` 忽略 `:ro` 目录 `rmSync` `EROFS`（L278-L282）并拒收 `null`/非对象 JSON 指令（L234-L238）。
- **D-78 冲突 2（VERIFIED）**：`safeTaskDirComponent`（`container-executor.mjs:491-499`）截断前 28 字符加 `_` 加 12 位 SHA-256（总长 `<= 41` 字符）；`agentWorkAttemptDir`（L501-L512）防穿越与正整数 `attemptNo` 校验；`launchAttempt`（L638-L641）先锁定父 `attemptDir` 再锁定 `proposalsDir`；Windows 下 `lockHostProposalsDir`（L546-L578）剥离继承并移除非当前 daemon 账号显式 ACE，授予账号独占 `(OI)(CI)F`；`inspectHostProposalsAcl`（L583-L613）严格拒收 `(N)`/`DENY`/`(D,`/`,D)` 与异主体。
- **`daemon.mjs`（VERIFIED）**：`ensureModelRequestsTable(db)` 置于 L178（`--check` L153 与 `!openMode` L160 之后，dry-run exit 3 不写库）；启动按标签清理孤儿容器（L265-L267）；未配 `upstream.submitUrl` 时 `adapterUpstream` 仅处理 `operation='model.inference'`（L542, L555）；连续模式 `reclaimFinishedAgentContainers`（L269-L321）含心跳续租、失败提案收口与 1500ms 回执等待窗；`--once` 经 `try/finally` 收口清停容器（L743-L746）。

### 5. 镜像纪元 5 与验证覆盖面（`docs/phase3/reports/image-digest.md`、`evals/phase3/model-proposal/run.mjs`）

- **纪元 5（VERIFIED）**：`agent` 镜像（manifest `sha256:5be3082db79d4d0f20163bce8bf452c37cfc041c621b6a467727fdebe13e8bde`、config `sha256:68478dea9ceac793c857b58e8d33c3bac0253bccb368ec16f29f2ceeaf1738fe`、context `sha256:c4ded878e5b3a2da407ce799f3745e527e65a56df589b03043a81caf1dde03df`）与携带的 `acquisition` / `execution` 经 `parseAppImageDigests()` 复核零漂移通过；`phase4-1-closure.md:91` 将构建期 `npm ci` 供应链网行为与零真实模型调用清晰分列。
- **测试覆盖面（VERIFIED）**：`evals/phase3/model-proposal/run.mjs` 全部 14 项检查与 `evals/phase3/security-unit/run.mjs` 5 项模型检查均为可证伪实测，无假绿、无跳过、无篡改既定断言。

---

## 三、分级发现汇总

- **`P0`**：0 项。
- **`P1`**：0 项。
- **`P2`（4 项非阻断边界观察；路线 A 下延后至单元 4.2 许可 1 统筹处理）**：
  1. `[P2-1]` 连续模式下 `activeAgentContainers` 已记录 `deadlineAt`（`daemon.mjs:512`），但 `reclaimFinishedAgentContainers()`（`daemon.mjs:269-321`）未检查超期强杀（`--once` 模式已有 `waitDeadline` + `finally` 兜底）。
  2. `[P2-2]` `inspectHostProposalsAcl`（`container-executor.mjs:583-586`）在非 `win32` 平台直接返回 `ok: true`，未实检 POSIX `statSync` 权限位（当前 Windows 11 宿主机走 `win32` 严格路径，切换至 Linux 时需补齐）。
  3. `[P2-3]` `proposeModelRequest`（`worker.mjs:165-200`）若被外部直接调用且省略 `usedRequestIds`，未检查磁盘同名文件是否已存在，且 `usedRequestIds.add` 位于 `messages` 校验前（容器入口 `main()` 已传入 `new Set()`）。
  4. `[P2-4]` `model-proposal/run.mjs` Check 8（T6）崩溃注入在 `after-executing-before-call`（1 次调用后崩溃覆盖于 Check 9 / T7）；`model-call.mjs:287-290` 存在一处仅含注释的空 `if` 块。

---

## 四、三项已知残留与时序评估

1. **`test:model:real` 无一次性代码守卫（D-77）**：维持 4.1 登记现状；建议在进入 4.2 向 `.env` 填入真实 `DEEPSEEK_API_KEY` 前补充显式环境变量门禁（如 `AEGISPI_ALLOW_REAL_MODEL_ACCEPTANCE=1`）。
2. **`model_requests` 在 `schema_migrations` 之外（D-78 冲突 1）**：维持按需扩展建表现状，保护 `ede73ecaa...` 指纹门与全部 27 用户表锁死断言；待未来规范包升版时再统一纳入 canonical DDL。
3. **Windows 账号级 `proposals` ACL（D-78 冲突 2）**：`phase4-1-closure.md:154-156` 登记忠实；一旦切换至 Linux/非 Windows 常开宿主机或变更代理身份模型，须触发停止条件重开裁量并实现双身份隔离。
4. **`leaseSeconds=45` vs `callTimeoutMs=60000`**：4.1 离线场景下由异步 `heartbeat` + 写回期 `ORPHAN/SETTLED` 降级充分兜底；进入 4.2 真实模型调用前建议对齐呼叫前即时 `heartbeat` 与 `10s` 心跳间隔（或校准配置租约）。

---

## 五、授权边界重申

本审计裁定（`PASS WITH RESIDUALS`，路线 A 冻结）**仅确认单元 4.1 在「许可 1」范围内的离线与容器闭环成立**，**不构成**对单元 4.2（真实仓库 Observe）、任何真实模型调用、外部写、Telegram 入/出站、D 项公网 webhook 或常开运行的任何授权。单元 4.2 首次真实运行仍严格阻塞于 `docs/phase4/phase4-restricted-kickoff-draft.md` 许可 2 首跑检查表七项逐项书面确认。
