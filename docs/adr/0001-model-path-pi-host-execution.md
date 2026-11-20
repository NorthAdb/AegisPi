# ADR-0001 模型链路最小方案：容器提议、宿主复用 Pi 1.5.2 执行

状态：**提议，待主人方案审核；未实施**。生成 2026-11-20，基线 `44b35141815bc890873f861ec34590654559faf9`。限定修复已过独立验收（`docs/phase3/audits/AUDIT-PHASE3-LIMITED-FIXES-44b3514.md` 判定「模型链路 ADR 与受限 Phase 4 开工书可以写」）。本 ADR 落实主人指令「容器 agent 提出模型请求，宿主复用 Pi 1.5.2 执行」的最小方案，并以此关闭 `docs/phase3/reports/model-path-and-pi.md` §5 缺口 A（容器→宿主提议链路）与缺口 B（宿主客户端形态）的**设计归属**（该文 §7.2 记录的「归属待复核」由主人 2026-11-20 指令改为本 ADR 定夺；实施属受限开工草案单元 4.1）。**本文不含任何运行授权**；真实调用前须逐项确认的检查表见 `docs/phase4/phase4-restricted-kickoff-draft.md`。

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

**结果回传（新增 host→worker 指令 kind）**：宿主写 `/agent-work/host-commands/model-result-<requestId>.json`，内容 `{kind:"model_result", requestId, ok, reply?, usage?, refusal?}`；`serveCommands` 扩展消费该 kind 并按现有 receipt 模式回执（worker.mjs:180-193）。reply 落库前按现行纪律截 4000 字符入 scope-ACL 证据对象（daemon.mjs:474-503 现行为）。

**生产挂载形态**：per-attempt 宿主目录 `<stateDir>/agent-work/<safe(taskId)>/<attemptNo>/`，三个子目录 bind mount——proposals（容器可写/宿主可读，目录 mode 1777，与现 tmpfs mode 一致）、host-commands（宿主写/容器 ro）、context.json（ro）；沿用 executor 挂载纪律（container-executor.mjs:133-143：tmpfs noexec、ro bind、rootfs 只读），`--network none`、无 socket。security-integration 现以 tmpfs 形态验证容器侧边界（run.mjs:539-577）；实现轮补一例 bind-mount 生产形态断言（proposals 可写、host-commands ro、rootfs ro、无网络）。生产 attempt 启动器（agent 镜像经与 `--execution-image` 平行的镜像解析启动 worker 容器）属受限开工草案单元 4.1 的实现范围；套件可先以 docker run 驱动同一通道契约完成全链测试。

## 3. 白名单与隔离不变量（不放宽）

- **purpose**：必须同时命中账本 purpose 白名单（budget.mjs:42-44 `PURPOSES`：router/worker/summary/classify/rsi/replay/warming/watchdog）与宿主新配置 `model.allowedPurposes`（实现轮加入 defaults.json `model` 节；缺省空数组 = 全拒，失败关闭）。
- **modelId**：必须命中 `model.allowedModelIds`。Phase 1 绑定为唯一在册项 `deepseek/deepseek-flash`（`docs/phase1/reports/model-binding.md` 绑定表：provider `deepseek`、thinking high、Pi 1.5.2 内置目录真值文件 `node_modules/@earendil-works/pi-ai@1.5.2/dist/providers/data/deepseek.json`；目录仅两个 chat 模型，不引入第二个模型）。
- **容器不变量全部维持**：`PI_OFFLINE=1`、凭据环境 denylist（worker.mjs:41-52：DEEPSEEK_API_KEY/GITHUB_TOKEN/AEGISPI_* 等十项）、无 docker.sock、无 `~/.pi`、镜像构建输入不含任何密钥；cacheWarming=off 仍必须经唯一映射加载器 `apps/daemon/config/load-pi-settings.mjs`（PI-13：文件直读 = idle 危险，断言在案）。
- 端点授权不变：`model.endpoint=null` → 提议停留 pending 并如实记录（镜像「QUEUED jobs 无 execution image」的诚实模式，daemon.mjs:614-616 同款）；环回端点 = 本地验证缝；非环回须 `allowRealModelCalls=true`（主人授权项）。

## 4. 宿主检查与预算（先 reserve 再调用）

宿主 tick 对每条 pending 提议依次执行（全部为既有机制，顺序照抄 daemon.mjs:355-522 的 worker 纪律）：

1. **身份与状态**：taskId/attemptId/fence 必须匹配当前 RUNNING 领取行（与 scheduler 的 lease_owner/fence 条件同款纪律，scheduler.mjs:117、216 的 WHERE 形状）；scopeDomainKey 必须匹配任务 scope。不匹配 → `model_request_refused`，零调用零预留。
2. **幂等**：`model_requests` 表以 requestId 为主键先插（状态 RECEIVED）；重复 requestId → 幂等拒绝回执，不二次调用、不二次预留。该表是本方案唯一新增持久结构（§9）。
3. **预算**：`ledger.reserve`（requestKey=`model:<requestId>`，purpose=提议的白名单 purpose，upperMicrousd=`config.model.callUpperMicrousd`，任务/日双账户拆分）。reserve 是条件 UPDATE：账户 frozen=0 且 spent+held+new ≤ limit（budget.mjs:210-241），超额/冻结 → BudgetExceeded/AccountFrozen 拒绝。**预留成功先于任何 provider 调用**（security-unit 已实测 ordering 断言模式，本方案沿用为测试要求）。
4. **执行**：唯一执行核心（§5）。失败 → `model_call_failed` 审计，预留保持 HELD 走保守超时路径（daemon.mjs:424-433 现行为）。
5. **结算或保持**（§6），随后结果写回容器；任务收尾沿用 completeTask 纪律。

## 5. 唯一执行核心：宿主复用 Pi 1.5.2（不写平行客户端）

`apps/daemon/src/model-call.mjs` 重写为驱动 Pi 的 provider 链路，**导出面保持**（`callModelOnce`/`isLoopbackModelEndpoint`），内部：

- Pi 侧配置沿 Phase 1 已验证形态：models.json 只覆盖 baseUrl、保留目录元数据（PI-09）；凭据由宿主凭据服务槽 `model` 解析后按 Pi 的环境凭据路径注入短命子进程（`DEEPSEEK_API_KEY` 路径，PI-09 实测行）。环回端点照旧 = 本地验证缝（model-call.mjs:28-36 语义保留）。
- **短命子进程模式保留**（tick 保持同步；model-call.mjs:11-15 现注释语义）：子进程内经 Pi 完成一次 chat/completions（wire 形状即 PI-09 实测：stream + include_usage），末块 usage 解析为 input/output/totalTokens（PI-10）。
- `adapters.mjs:34-41` 的 `model.inference` 注册条目（chargeable、requiresReservation）分派指向**同一核心**——tick worker 分支与 effect 形态两入口共享一个执行核心，兑现 model-path-and-pi.md §5 形态备注「两路应合一，避免双入口语义分叉」。无预留的 chargeable 提交拒绝语义不变（adapters.mjs:200-203）。

## 6. 结算映射（Pi usage → 账本；reasoning 不另计；零不当免费）

usage 形状扩展为四字段 `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`；`microusdForUsage` 硬化（替换 model-call.mjs:99-105 两字段版）：

1. **可信判据**：input 与 output 必须为 ≥1 的整数。PI-10 实测：usage 缺失时 Pi 解析为**全零**且 cost 上无 `totalFromProvider` 键——全零不可区分「provider 未上报」，**不得当免费**；真实完成必有 ≥1 输入与 ≥1 输出 token（实测口径：A 项 40/13；Phase 1 最小推理 461/2）。任一非正整数 → 视为无 usage → 预留保持 HELD + `model_usage_not_settled`（daemon.mjs:456-469 现行为）。
2. **cache 价**：cacheRead/cacheWrite tokens 为整数（缺失按 0，仅当 usage 本身可信）；对应目录价任一为 null 而该 token 数 >0 → HELD（复核 §7「缺 cache 价保持 HELD」）。目录价字段扩为 `priceCatalog.{inputPerMTokMicrousd, outputPerMTokMicrousd, cacheReadPerMTokMicrousd, cacheWritePerMTokMicrousd}`（前两项现存在且为 null；后两项实现轮新增、缺省 null；四价**全部由主人核定后才可非 null**——Phase 1 记录价 DeepSeek 0.3/1.2/0.006 USD/M 仅为在案参考）。
3. **账本自求和**：cost = ⌈(input×input价 + output×output价 + cacheRead×cacheRead价 + cacheWrite×cacheWrite价)/1M⌉ microUSD。PI-10：`cost.totalFromProvider` 是布尔非数字（仅 OpenRouter 为 true，DeepSeek 恒 false）——Pi 不代算总额，宿主必须自算。
4. **reasoning 含于 output，不另计**：thinking 级别随请求发出并正常完成（绑定实测 wire `thinking:{type:"enabled"}`），reasoning token 已计入 output 单一计数；**禁止任何独立 reasoning 计费行**（复核 §7 与验收 §54-58 同款要求）。
5. **超限**：结算额超 upperMicrousd → 仍 SETTLED + 冻结账户 + `budget_overcharge_frozen`（budget.mjs:319-323 现行为；无金额硬拒绝，按现行事实入 ADR）。只有 HELD 可结清（budget.mjs:294-295）；CHARGED_BOUND 校正仅凭可信账单（budget.mjs:397-433）。

## 7. 取消、超时、进程崩溃、重复提议与迟到结果

- **取消**：任务取消走现行取消/stop 文件路径（worker.mjs:163-165 的 stop 轮询）；宿主在每次执行前复查领取行，已取消/不匹配 → 拒绝执行；已建未用的预留 → release（budget.mjs:348-358，仅 HELD 可 release）。
- **超时**：`callTimeoutMs` 子进程硬上限（model-call.mjs:56-59 现模式）→ `model_call_failed`；预留 HELD → 保守超时转 CHARGED_BOUND（budget.mjs:376-393）。
- **宿主崩溃（reserve 与调用之间/调用中）**：`model_requests` 行停留 RESERVED/EXECUTING，预留保持 HELD——结清只可能发生在持有该 HELD 预留的同一 tick（§6 只有 HELD 可结清是硬门），账本规则本身崩溃安全；恢复后走现行 HELD 保守超时路径。**测试要求**（复核 §7）：注入 kill 点（复用 testing/crashpoints.mjs）断言 reserve 与调用间崩溃保持 HELD。
- **重复提议**：requestId 主键幂等（§4.2）；重复回执拒绝，不重复调用不重复预留。
- **迟到结果**：结果只由宿主产生并一次性写回。「迟到」仅两形态：容器消费晚（无结清后果）；领取行已终态时宿主写回前复查发现 → 结果落为 scope-ACL 证据对象 + `model_result_orphan` 审计，不 settle、不改终态。同一 requestId 不存在二次 settle 窗口。

## 8. 迁移步骤（退役 HTTP 客户端，不长期保留两套路径）

现直连客户端 = model-call.mjs 的 OpenAI 形状子进程 `model-call-child.mjs`（messages/choices/usage 子集，model-path-and-pi.md §4 第 3 条）。三步同轮完成，不留双路径过渡期：

1. **替换内核**：model-call.mjs 内部改驱动 Pi（导出面不变），usage 升级四字段；环回夹具经 models.json baseUrl 重定向验证（PI-09 同缝）。
2. **切换两入口**：daemon worker 分支（daemon.mjs:355-522）与 `model.inference` 分派同指新核心；`evals/phase3/model-real` 验收入口改测新核心。
3. **删除旧路径**：删除 `model-call-child.mjs`；两字段 usage 断言全部更新；验收含 `git grep model-call-child` 为空。

实现轮必然使 agent 镜像 context 漂移（`apps/daemon/src` 与 `docker/agent/src/worker.mjs` 均在 agent 上下文清单，image-bind.mjs:79-90）→ 按已确立流程开**纪元 3**（`tools/build-app-images.mjs --only=agent`，携带核验后沿用 acquisition/execution），提交新证据。

## 9. 最小改动文件（实现轮清单；本轮零改动）

| 文件 | 改动 |
| --- | --- |
| `apps/daemon/src/model-call.mjs` | 内核改驱动 Pi；usage 四字段；`microusdForUsage` 硬化 |
| `apps/daemon/src/model-call-child.mjs` | **删除**（§8 第 3 步） |
| `apps/daemon/src/model-call-pi-child.mjs`（新） | 短命子进程内经 Pi 执行单次推理 |
| `apps/daemon/src/daemon.mjs` | worker 分支改读提议→校验→幂等插入→reserve→执行→结算→写回；agent attempt 启动接线 |
| `apps/daemon/src/model-requests.mjs`（新）或并入现有模块 | `model_requests` 表幂等插入与状态机（RECEIVED→RESERVED→EXECUTING→SETTLED/HELD/FAILED/ORPHAN） |
| `apps/daemon/src/db/migrate.mjs` | `model_requests` 表 DDL |
| `apps/daemon/src/adapters.mjs` | `model.inference` 分派指向同一核心（门禁语义不变） |
| `apps/daemon/src/config.mjs` + `apps/daemon/config/defaults.json` | `model.allowedPurposes`、`model.allowedModelIds`（缺省空=全拒）、`priceCatalog` 增 cacheRead/cacheWrite 价位（保持 null）；`endpoint`/`allowRealModelCalls` 保持失败关闭 |
| `docker/agent/src/worker.mjs` | `model_request` 信封写入（tmp+rename 现模式）+ `model_result` 指令消费（receipt 循环现模式） |
| `apps/daemon/src/container-executor.mjs` | agent attempt 生产挂载（§2 三目录 bind 形态，沿用挂载纪律） |
| `evals/phase3/…`（新 model-proposal 套件 + 既有套件用例） | §10 全部行为测试 |

不动：budget.mjs 语义、scheduler.mjs 租约语义、credentials.mjs、`CONSOLE_BIND`/allowedHosts、policy.allowRealExternalWrites、Pi 版本锁定。

## 10. 行为测试与验收标准（本地可测，零真实调用）

1. 未授权提议零调用零预留：白名单外 purpose、白名单外 modelId、scope 不匹配、fence/attempt 不匹配、信封带未知字段、messages 超 128 KiB——各断言 reservations=0、`model_request_refused` 审计在场。
2. 幂等：同 requestId 重放恰一次调用、恰一次预留。
3. reserve 与调用间崩溃（crashpoints 注入）→ 预留保持 HELD 不结清。
4. 缺 usage（夹具回 Pi 全零形状，PI-10 实测形状）→ HELD；目录价 null → HELD；cache 价缺而 cacheRead>0 → HELD。
5. 结清：夹具 usage 40/13 × 300000/1200000 microUSD/M → 28 microUSD（对齐 A 项实测口径）；reasoning 无独立计费行。
6. 超时 → CHARGED_BOUND 保守占额；超额结算 → SETTLED + 冻结 + `budget_overcharge_frozen`。
7. 隔离不变量：容器 denylist/PI_OFFLINE/无 socket 断言沿用（worker selfCheck）；bind-mount 生产形态用例（proposals 可写、host-commands ro、rootfs ro、无网络、无 URL 字段到达宿主配置层）。
8. 全套件绿（含三 docker 套件）+ 纪元 3 证据 + `git grep model-call-child` 为空 + defaults 失败关闭不变。

**真实侧验收不在本 ADR 授权内**：官方现价/上限/端点授权逐项确认（开工草案首跑检查表）后单发一次经 Pi 的真实调用、usage×核定目录价结清；供应商账单核对另行（A 项同口径）。

## 11. 显式不做

不写第二个 agent 循环（容器循环=现有 serveCommands 扩展，宿主只执行单次推理）；不做流式透传（结果一次性回传）；不开外部写（不动 `allowRealExternalWrites` 与 `CONSOLE_BIND`）；不引入第二个模型；不改预算与租约纪律；不重开 $0.80/$5 预算讨论；本轮零实现。
