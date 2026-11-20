# ADR-0001 模型链路最小方案：容器提议、宿主复用 Pi 1.5.2 执行

状态：**修订稿，待主人方案确认；未实施**。生成 2026-11-20，基线 `44b35141815bc890873f861ec34590654559faf9`；同日按方案审核 `REVIEW-MODEL-ADR-cde9bd3`（原稿字节归档于 `docs/phase4/reviews/REVIEW-MODEL-ADR-cde9bd3.md`，判定「需改后通过、4.1 为可实施候选、本次不授权实施」）修订四处：§6 usage 结算条件、§7 model_requests 状态机与事务边界、§5 pi-ai 单次推理接口与 baseUrl 根地址语义、§2/§3 宿主目录权限与 requestId 校验。本 ADR 落实主人指令「容器 agent 提出模型请求，宿主复用 Pi 1.5.2 执行」的最小方案，并作为 `docs/phase3/reports/model-path-and-pi.md` §5 缺口 A（容器→宿主提议链路）与缺口 B（宿主客户端形态）**设计归属的定夺载体**（该文 §7.2「归属待复核」的后续即本文状态：主人确认前不称已闭；实施属受限开工草案单元 4.1）。**本文不含任何运行授权**；真实调用前须逐项确认的检查表见 `docs/phase4/phase4-restricted-kickoff-draft.md`。

## 0. 验收基线（两份审计在案，不可偏离）

限定修复验收「下一步」五条（AUDIT-PHASE3-LIMITED-FIXES-44b3514.md L52-60）：宿主复用 Pi 1.5.2 provider 不另写平行 HTTP 客户端；容器只提议、purpose/modelId 走宿主白名单、无 key 无自由 URL、容器保持 PI_OFFLINE；先 reserve 再调用、结清用 input/output/cacheRead/cacheWrite、reasoning 已含在 output、缺 usage 或对应目录价为 null 保持 HELD 禁止把零当免费；任务 $0.80/日 $5 已在 defaults、实际目录价与 token 上限在任何真实调用前由主人核定；本单元不开外部写、不改 CONSOLE_BIND。复核 33d6361 §7 早前已记录同一最小接口（提议字段白名单、宿主内 Pi provider、四字段结清、缺价 HELD、超限按现行事实）与测试要求（未授权提议零调用、reserve 与调用间崩溃保持 HELD、容器镜像无 key、本单元不开外部写/公网 bind）。本 ADR 逐条对应实现。

## 1. 决策（一段话）

容器 agent 不执行任何推理。它在**既有** propose-only 通道上写一个字段封闭的 `model_request` 提议信封（无 URL、无凭据、无自由端点）；宿主 daemon tick 校验白名单与身份后，经**唯一执行核心**调用已捆绑的 Pi 1.5.2 provider（`@earendil-works/pi-coding-agent` exact 1.5.2，`apps/daemon/package.json:5` 既有生产依赖，零新增依赖），先 `ledger.reserve` 后调用，按 Pi 回传 usage × 宿主价格目录结清或保持 HELD，结果经**既有** host-commands 目录写回容器。**不另写平行模型客户端**：现直连 HTTP 子进程 `model-call-child.mjs` 在切换后删除（§8）。**不另写 agent 循环**：容器侧只扩展现有 `serveCommands` 轮询（worker.mjs:154-197），宿主不运行任何 agent 循环，只执行单次推理。

## 2. 通道：容器如何提议、宿主如何返回（衔接现有通道，零新通道）

容器侧现状（`docker/agent/src/worker.mjs`）：挂载契约 `/agent-work/context.json`(ro) + `/agent-work/proposals/`(rw，唯一出站) + `/agent-work/host-commands/`(ro，宿主→容器)；announce 与 command receipt 已用同目录 + tmp-then-rename 原子写（worker.mjs:146-149、188-191），信封自带「propose-only：提议不是授权」语义（worker.mjs:143）。

**提议信封（新增 kind，不改通道本身）**：

```json
{
  "schemaVersion": 1,
  "kind": "model_request",
  "requestId": "<uuid v4，由 worker 生成>",
  "taskId": "…", "attemptId": "…", "fence": 1, "scopeDomainKey": "…",
  "purpose": "worker",
  "modelId": "deepseek/deepseek-flash",
  "messages": [ { "role": "user", "content": "…" } ]
}
```

字段集封闭：**没有 endpoint 字段、没有凭据字段、没有 URL**。URL 与凭据只存在于宿主（`config.model.endpoint` + 宿主凭据服务槽 `model`，即 daemon.mjs:416-423 现行模式；模型永不拼接 URL，02 §4）。宿主按 `parseContext` 同款严格校验（worker.mjs:54-76 的模式）：未知字段、类型不符、messages 总字节超 128 KiB 硬上限 → 拒绝并写审计行 `model_request_refused`，不进预算。worker 生成 requestId，同一 attempt 内不可重用。

**结果回传（新增 host→worker 指令 kind）**：宿主写 `/agent-work/host-commands/model-result-<requestId>.json`，内容 `{kind:"model_result", requestId, ok, reply?, usage?, refusal?}`——**requestId 先经 uuid 校验才进入文件名**，禁止把提议字符串直接当路径成分；**reply 回传正文本身**（哈希不能代替正文）。`serveCommands` 扩展消费该 kind 并按现有 receipt 模式回执（worker.mjs:180-193）。reply 落库前按现行纪律截 4000 字符入 scope-ACL 证据对象（daemon.mjs:474-503 现行为）。身份四元组（taskId/attemptId/fence/scopeDomainKey）本就从**宿主写入的** context.json 抄出（worker.mjs:67-74，fence 为宿主铸造的正整数、非容器自选），宿主仍以 RUNNING 领取行复检（scheduler.mjs:8-12 的 lease_owner/fence 纪律），不信任容器自述。

**生产挂载形态**：per-attempt 宿主目录 `<stateDir>/agent-work/<safe(taskId)>/<attemptNo>/`，三个子目录 bind mount——proposals（容器可写/宿主可读；**宿主目录仅 daemon 进程与容器 uid 999 可写**，`mode=1777` 只属于容器内 tmpfs（container-executor.mjs:138），不照搬到宿主 bind 目录——宿主 1777 会让任何本机用户都能丢进伪造的 `model_request`，且 context.json 同树可读时伪造者可抄到真实 fence）、host-commands（宿主写/容器 ro）、context.json（ro，宿主写入）；沿用 executor 挂载纪律（container-executor.mjs:133-143：tmpfs noexec、ro bind、rootfs 只读），`--network none`、无 socket。security-integration 现以 tmpfs 形态验证容器侧边界（run.mjs:539-577）；实现轮补一例 bind-mount 生产形态断言（proposals 可写、host-commands ro、rootfs ro、无网络、宿主目录权限非 1777）。生产 attempt 启动器（agent 镜像经与 `--execution-image` 平行的镜像解析启动 worker 容器）属受限开工草案单元 4.1 的实现范围；套件可先以 docker run 驱动同一通道契约完成全链测试。

## 3. 白名单与隔离不变量（不放宽）

- **purpose**：必须同时命中账本 purpose 白名单（budget.mjs:42-44 `PURPOSES`：router/worker/summary/classify/rsi/replay/warming/watchdog）与宿主新配置 `model.allowedPurposes`（实现轮加入 defaults.json `model` 节；缺省空数组 = 全拒，失败关闭）。
- **modelId**：必须命中 `model.allowedModelIds`。Phase 1 绑定为唯一在册项 `deepseek/deepseek-flash`（`docs/phase1/reports/model-binding.md` 绑定表：provider `deepseek`、thinking high、Pi 1.5.2 内置目录真值文件 `node_modules/@earendil-works/pi-ai@1.5.2/dist/providers/data/deepseek.json`；目录仅两个 chat 模型，不引入第二个模型）。白名单键 `deepseek/deepseek-flash` 只用于宿主校验；wire 上的 model 是 `model.id` 即 `deepseek-flash`（§5），不得把白名单键原样 POST。
- **容器不变量全部维持**：`PI_OFFLINE=1`、凭据环境 denylist（worker.mjs:41-52：DEEPSEEK_API_KEY/GITHUB_TOKEN/AEGISPI_* 等十项）、无 docker.sock、无 `~/.pi`、镜像构建输入不含任何密钥；cacheWarming=off 仍必须经唯一映射加载器 `apps/daemon/config/load-pi-settings.mjs`（PI-13：文件直读 = idle 危险，断言在案）。
- 端点授权不变：`model.endpoint=null` → 提议停留 pending 并如实记录（镜像「QUEUED jobs 无 execution image」的诚实模式，daemon.mjs:614-616 同款）；环回端点 = 本地验证缝；非环回须 `allowRealModelCalls=true`（主人授权项）。

## 4. 宿主检查与预算（先 reserve 再调用）

宿主 tick 对每条 pending 提议依次执行（全部为既有机制，顺序照抄 daemon.mjs:355-522 的 worker 纪律）：

1. **身份与状态**：taskId/attemptId/fence 必须匹配当前 RUNNING 领取行（与 scheduler 的 lease_owner/fence 条件同款纪律，scheduler.mjs:117、216 的 WHERE 形状）；scopeDomainKey 必须匹配任务 scope。不匹配 → `model_request_refused`，零调用零预留。
2. **幂等**：`model_requests` 表以 requestId 为主键先插（状态 RECEIVED）；重复 requestId → 幂等拒绝回执，不二次调用、不二次预留。该表是本方案唯一新增持久结构（§9）；状态机与事务边界见 §7。
3. **预算**：`ledger.reserve`（requestKey=`model:<requestId>`，purpose=提议的白名单 purpose，upperMicrousd=`config.model.callUpperMicrousd`，任务/日双账户拆分）。reserve 是条件 UPDATE：账户 frozen=0 且 spent+held+new ≤ limit（budget.mjs:210-241），超额/冻结 → BudgetExceeded/AccountFrozen 拒绝。**预留成功先于任何 provider 调用**（security-unit 已实测 ordering 断言模式，本方案沿用为测试要求）。
4. **执行**：唯一执行核心（§5）。失败 → `model_call_failed` 审计，预留保持 HELD 走保守超时路径（daemon.mjs:424-433 现行为）。
5. **结算或保持**（§6），随后结果写回容器；任务收尾沿用 completeTask 纪律。

## 5. 唯一执行核心：宿主复用 Pi 1.5.2（不写平行客户端）

`apps/daemon/src/model-call.mjs` 重写为驱动**已锁定传递依赖 pi-ai 1.5.2** 的单次推理链路，**导出面保持**（`callModelOnce`/`isLoopbackModelEndpoint`），内部：

- 子进程 import `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModel("deepseek","deepseek-flash")`（providers/all.d.ts:18）与 `@earendil-works/pi-ai/compat` 的 `completeSimple(model, context, options)`（compat.d.ts:66）。这是**已锁定的传递依赖 `@earendil-works/pi-ai@1.5.2`，零新增包版本**；**不是** `@earendil-works/pi-coding-agent` 的导出（其 dist/index.d.ts 只导出 AgentSession/ModelRegistry 等，无 complete/completeSimple/stream），**不使用 AgentSession**——那是 agent 循环，本方案只执行单次推理。调用选项必须含 `reasoning:"high"`：DeepSeek 分支仅在传入 reasoningEffort 时发送 `thinking:{type:"enabled"}` 并按 `thinkingLevelMap.high="high"` 映射（openai-completions.js:657-667、:1264）；不传会发送 `thinking:{type:"disabled"}`（:661-662），绑定失效。**wire 上的 `model` 是 `model.id` 即 `deepseek-flash`**；信封里的 `deepseek/deepseek-flash` 只是宿主白名单键，不得原样 POST。
- **短命子进程模式保留**（tick 保持同步；model-call.mjs:11-15 现注释语义）。**`model.baseUrl` 是 SDK 根地址语义，不是最终 POST 地址**：本模型目录值 `https://api.deepseek.com`，OpenAI SDK（openai 7.19.0，pi-ai 传递依赖）自行把 baseURL 与固定路径 `/chat/completions` 相接（client.js:471-475、completions.js:24；openai-completions.js:542-544 把 `model.baseUrl` 原样交给 `new OpenAI({ baseURL })`）。宿主配置只写**无路径的根**（目录根，或环回 `http://127.0.0.1:<port>`）；**禁止把旧的完整 `https://api.deepseek.com/chat/completions` 整段写入 baseUrl**（会拼成 `/chat/completions/chat/completions`——复核环回探针双发实测验证）。`baseUrl=null`（默认）不调用，失败关闭不因此启用真实端点。凭据由宿主凭据服务槽 `model` 解析后注入短命子进程；环回根地址 = 本地验证缝（`isLoopbackModelEndpoint` 的 hostname 判定语义保留）。
- `adapters.mjs:34-41` 的 `model.inference` 注册条目（chargeable、requiresReservation）分派指向**同一核心**——tick worker 分支与 effect 形态两入口共享一个执行核心，兑现 model-path-and-pi.md §5 形态备注「两路应合一，避免双入口语义分叉」。无预留的 chargeable 提交拒绝语义不变（adapters.mjs:200-203）。

## 6. 结算映射（Pi usage → 账本；reasoning 不另计；零不当免费）

usage 形状扩展为四字段 `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`；`microusdForUsage` 硬化（替换 model-call.mjs:99-105 两字段版）：

1. **可信判据（仅覆盖锁定的 Pi 1.5.2 openai-completions 解析路径——DeepSeek 目录模型走它；不写成跨 provider 永真契约）**：usage 块是否存在，看 `cost.totalFromProvider` 是否已被 `calculateCost` 写成**布尔**（pi-ai dist/models.js:698——它是布尔不是账单金额；流开始的占位 usage 四字段为 0 且 cost 上无该键，openai-completions.js:162-169；只有 chunk 带 usage 才调用 parseChunkUsage，:349-358）。**没有该键，或四字段均为 0：HELD**（空 usage 对象与真零账单分不开，PI-10 同文件实测口径）。**四字段均为 ≥0 的整数且总和 >0：可结算；cache 未命中（0）与 output=0 都合法**。`stopReason` 为 error/aborted 且无可结算 usage：保持 HELD，不 release、不重试。保持 HELD 时照写 `model_usage_not_settled`（daemon.mjs:456-469 现行为）。**实施验收用离线夹具核对三态**：无 usage 块时没有该键；解析到 usage 后该键是布尔；全零不结清。
2. **逐类价格规则**：某一类 token >0 时，该类目录价必须为非负整数，否则整笔 HELD；该类 token 为 0 时价为 null 不挡结清。目录价字段扩为 `priceCatalog.{inputPerMTokMicrousd, outputPerMTokMicrousd, cacheReadPerMTokMicrousd, cacheWritePerMTokMicrousd}`（前两项现存在且为 null；后两项实现轮新增、缺省 null；四价**全部由主人核定后才可非 null**。在案参考：Pi 目录价 DeepSeek input 0.3 / output 1.2 / cacheRead 0.006 / **cacheWrite 0** USD/M——0 是非负整数，合法价）。
3. **账本自求和**：cost = ⌈(input×input价 + output×output价 + cacheRead×cacheRead价 + cacheWrite×cacheWrite价)/1M⌉ microUSD。PI-10：`cost.totalFromProvider` 是布尔非数字（仅 OpenRouter 为 true，DeepSeek 恒 false）——Pi 不代算总额，宿主必须自算。
4. **reasoning 含于 output，不另计**：thinking 级别随请求发出并正常完成（绑定实测 wire `thinking:{type:"enabled"}`），reasoning token 已计入 output 单一计数；**禁止任何独立 reasoning 计费行**（复核 §7 与验收 §54-58 同款要求）。
5. **超限**：结算额超 upperMicrousd → 仍 SETTLED + 冻结账户 + `budget_overcharge_frozen`（budget.mjs:319-323 现行为；无金额硬拒绝，按现行事实入 ADR）。只有 HELD 可结清（budget.mjs:294-295）；CHARGED_BOUND 校正仅凭可信账单（budget.mjs:397-433）。**`callUpperMicrousd` 只限制预留占用，不是输出 token 硬顶**（token 上限在开工草案检查表第 4 项）。

## 7. 取消、超时、崩溃、重复提议与迟到结果：model_requests 状态机与事务边界

**先说清边界**：`budget.mjs:199-204` 的 request_key 唯一只保证同一预留键不插第二行；`settle`/`release`/`chargeBound` 各自只看**账本表自身**的 HELD 状态（budget.mjs:294-295、348-358、370-393），看不见 `model_requests`。两表各写一次、中间宕机，**账本单表保证不了「没调用过」或「只调用一次」**——崩溃安全由下面的 request 状态机与同事务边界保证，不写成「账本本身保证」。request 状态与账本状态分开记账；全部状态转换沿用现有 `withTx`，不新建框架。FAILED 只出现在调用前，不从 EXECUTING 转入。

- `RECEIVED`：`model_requests` 插入（主键 requestId）且校验通过，尚未预留。调用前拒绝可到 `FAILED`（此时没有预留）。
- `RESERVED`：与 `ledger.reserve(requestKey="model:<requestId>")` 在**同一事务**里成功并记下 reservationId。调用前取消可以 release（budget.mjs:348-358，仅 HELD 可 release），随后到 `FAILED`。
- `EXECUTING`：进入子进程**之前单独提交**。此后不重试、不 release、不到 FAILED——调用一旦可能已发出就不能 release；`chargeBound`（budget.mjs:370-393）是占满 upper 的保守处理，不是重试也不是 release。宕机后预留保持 HELD，只走现有保守超时 → `CHARGED_BOUND`。**测试要求**：注入 kill 点（复用 testing/crashpoints.mjs）断言 reserve 与调用间崩溃保持 HELD、EXECUTING 提交后宕机不重放不 release。
- `SETTLED`：usage 可结算时，账本 `settle` 与 request 行落地在**同一事务**。同一 requestId 再来的 usage 看见预留非 HELD 即丢弃——只结清一次。
- `HELD`：已进入 EXECUTING 但 usage 不可结算（§6 规则）。不第二次调用，不 release。
- `ORPHAN`：任务已终态才写回结果时进入。不 settle。

**超时**：`callTimeoutMs` 子进程硬上限（model-call.mjs:56-59 现模式）→ `model_call_failed`，request 停在 EXECUTING/HELD → 保守超时转 CHARGED_BOUND。

**重复提议**：主键冲突即回读已有状态，不插第二笔预留、不第二次调用。

**迟到 usage**：只允许从 `EXECUTING` + 账本 HELD 进入一次 `SETTLED`；其余一律丢弃并审计。

**任务已终态**：宿主写回前复查 RUNNING 领取行，已终态 → 结果落 scope-ACL 证据对象 + `model_result_orphan` 审计，request 转 `ORPHAN`。**结果不再投递，不等于已发生的费用可以不处理**：调用若已发出，其预留照常走 settle / 保持 HELD / 保守超时 CHARGED_BOUND，账本不因容器消失或任务终态豁免。

## 8. 迁移步骤（退役 HTTP 客户端，不长期保留两套路径）

现直连客户端 = model-call.mjs 的 OpenAI 形状子进程 `model-call-child.mjs`（messages/choices/usage 子集，model-path-and-pi.md §4 第 3 条）。三步同轮完成，不留双路径过渡期：

1. **替换内核**：model-call.mjs 内部改驱动 pi-ai（getBuiltinModel + completeSimple，§5），usage 升级四字段；配置键从旧 `model.endpoint`（完整请求 URL）迁移为 `model.baseUrl`（SDK 根地址，缺省 null；环回写 `http://127.0.0.1:<port>`）；环回夹具断言请求路径恰为单段 `/chat/completions` 且 body 带 `thinking.type=enabled`（`reasoning:"high"` 已传）。
2. **切换两入口**：daemon worker 分支（daemon.mjs:355-522）与 `model.inference` 分派同指新核心；`evals/phase3/model-real` 验收入口改测新核心。
3. **删除旧路径**：删除 `model-call-child.mjs`；两字段 usage 断言全部更新；验收含 `git grep model-call-child` 为空。

实现轮先以 `appImageContextHash` 复算三镜像 context（image-bind.mjs:79-90：`apps/daemon/src` 与 `docker/agent/src/worker.mjs` 均在 agent 清单，二者一改 agent 必漂；acquisition/execution 清单不含宿主源码），**只重建已漂移的名字**（预期 agent，`tools/build-app-images.mjs --only=agent`，携带核验后沿用未漂者），**复算之前不构建**；提交新证据。

## 9. 最小改动文件（实现轮清单；本轮零改动）

| 文件 | 改动 |
| --- | --- |
| `apps/daemon/src/model-call.mjs` | 内核改驱动 Pi；usage 四字段；`microusdForUsage` 硬化 |
| `apps/daemon/src/model-call-child.mjs` | **删除**（§8 第 3 步） |
| `apps/daemon/src/model-call-pi-child.mjs`（新） | 短命子进程内经 pi-ai `getBuiltinModel` + `completeSimple` 执行单次推理（必传 `reasoning:"high"`） |
| `apps/daemon/src/daemon.mjs` | worker 分支改读提议→校验→幂等插入→reserve→执行→结算→写回；agent attempt 启动接线 |
| `apps/daemon/src/model-requests.mjs`（新）或并入现有模块 | `model_requests` 表幂等插入与状态机（RECEIVED→RESERVED→EXECUTING→SETTLED/HELD/FAILED/ORPHAN） |
| `apps/daemon/src/db/migrate.mjs` | `model_requests` 表 DDL |
| `apps/daemon/src/adapters.mjs` | `model.inference` 分派指向同一核心（门禁语义不变） |
| `apps/daemon/src/config.mjs` + `apps/daemon/config/defaults.json` | `model.allowedPurposes`、`model.allowedModelIds`（缺省空=全拒）、`model.baseUrl`（SDK 根地址语义，缺省 null=拒绝调用；**替换**旧 `endpoint` 完整 URL 键）、`priceCatalog` 增 cacheRead/cacheWrite 价位（保持 null）；`allowRealModelCalls` 保持失败关闭 |
| `docker/agent/src/worker.mjs` | `model_request` 信封写入（tmp+rename 现模式）+ `model_result` 指令消费（receipt 循环现模式） |
| `apps/daemon/src/container-executor.mjs` | agent attempt 生产挂载（§2 三目录 bind 形态，沿用挂载纪律） |
| `evals/phase3/…`（新 model-proposal 套件 + 既有套件用例） | §10 全部行为测试 |

不动：budget.mjs 语义、scheduler.mjs 租约语义、credentials.mjs、`CONSOLE_BIND`/allowedHosts、policy.allowRealExternalWrites、Pi 版本锁定。

## 10. 行为测试与验收标准（本地可测，零真实调用）

1. 未授权提议零调用零预留：白名单外 purpose、白名单外 modelId、scope 不匹配、fence/attempt 不匹配、信封带未知字段、messages 超 128 KiB——各断言 reservations=0、`model_request_refused` 审计在场。
2. 幂等：同 requestId 重放恰一次调用、恰一次预留；主键冲突回读已有状态。
3. 状态机事务边界（crashpoints 注入）：RESERVED 与 `ledger.reserve` 同一事务；EXECUTING 在子进程前提交，宕机后不重放、不 release、不到 FAILED；settle 与 request 行同一事务，只结清一次；迟到 usage 只从 EXECUTING+HELD 一次进入 SETTLED，其余丢弃并审计。
4. 结算条件三态（离线夹具，§6.1 规则）：无 usage 块（无 `totalFromProvider` 键）→ HELD；全零 → HELD；四字段 ≥0 整数且总和 >0（含 output=0、cache 未命中 0）→ 可结算。逐类价格：token>0 类缺价（非非负整数）→ 整笔 HELD；token=0 类价 null 不挡。`stopReason` error/aborted 无可结算 usage → HELD，不 release 不重试。
5. 结清：夹具 usage 40/13 × 300000/1200000 microUSD/M → 28 microUSD（对齐 A 项实测口径）；reasoning 无独立计费行。wire 断言：`model=deepseek-flash`、`thinking.type=enabled`（`reasoning:"high"` 已传）且请求路径恰为单段 `/chat/completions`（根地址写入，非旧完整 URL）。
6. 超时 → CHARGED_BOUND 保守占额；超额结算 → SETTLED + 冻结 + `budget_overcharge_frozen`；任务终态 → ORPHAN 不 settle，但已发出调用的费用照走（§7）。
7. 隔离不变量：容器 denylist/PI_OFFLINE/无 socket 断言沿用（worker selfCheck）；bind-mount 生产形态用例（proposals 可写、host-commands ro、rootfs ro、无网络、无 URL 字段到达宿主配置层）；宿主 proposals 目录仅 daemon/uid 999 可写（非 1777）；requestId 非 uuid 拒绝入文件名；宿主以 RUNNING 行复检身份四元组。
8. 全套件绿（含三 docker 套件）+ 纪元 3 证据 + `git grep model-call-child` 为空 + defaults 失败关闭不变。

**真实侧验收不在本 ADR 授权内**：官方现价/上限/端点授权逐项确认（开工草案首跑检查表）后单发一次经 Pi 的真实调用、usage×核定目录价结清；供应商账单核对另行（A 项同口径）。

## 11. 显式不做

不写第二个 agent 循环（容器循环=现有 serveCommands 扩展，宿主只执行单次推理）；不做流式透传（结果一次性回传）；不开外部写（不动 `allowRealExternalWrites` 与 `CONSOLE_BIND`）；不引入第二个模型；不改预算与租约纪律；不重开 $0.80/$5 预算讨论；本轮零实现。
