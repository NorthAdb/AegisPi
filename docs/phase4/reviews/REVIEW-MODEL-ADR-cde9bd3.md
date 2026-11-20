# 方案审核：ADR-0001 与受限 Phase 4 开工草案

目标：`origin/main` = `cde9bd372efd300c85aa7f7bcde52bc90bdd844e`（相对 `44b3514` 只有文档）。限定修复保持关闭。未改代码，未跑 real，未读 `.env`。本机先做了一次离线 import，随后用环回探针核对了 baseUrl（见文末修订）：`@earendil-works/pi-coding-agent` 1.5.2 的导出里没有 `complete`/`completeSimple`/`stream`；`@earendil-works/pi-ai/compat` 的 `completeSimple` 与 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModel("deepseek","deepseek-flash")` 可用。模型字段：`id=deepseek-flash`，`baseUrl=https://api.deepseek.com`，`reasoning=true`，`thinkingLevelMap.high="high"`，目录价 input 0.3 / output 1.2 / cacheRead 0.006 / cacheWrite 0。

## 结论

**需改后通过。** 4.1 是可实施候选，本次不授权实施。4.2 首跑表、价格、仓库、通知、D 都不进入阻塞清单。改下面四条原文后，设计契约可以交给实现。

## 必须改

### 1. 四字段按「非负整数 + 是否真有 usage 块」结算，不能要求每字段 ≥1

ADR `0001-model-path-pi-host-execution.md:66-67` 写「input 与 output 必须 ≥1」「任一非正整数 → HELD」。`cacheRead=0` / `cacheWrite=0` 是未命中的正常值；`output=0` 也是解析器的合法结果。按「任一非正整数」会把正常账单全部留在 HELD。

Pi 源码：

- 流开始时的占位 usage 四字段为 0，且 `cost` 上没有 `totalFromProvider`（`pi-ai/dist/api/openai-completions.js:162-169`）。
- 只有 chunk 带 `usage` 才调用 `parseChunkUsage`（同文件 `:349-358`）。`prompt_tokens || 0`、`completion_tokens || 0`、cache 用 `?? 0`（`:1160-1182`）。`reasoning` 来自 `completion_tokens_details.reasoning_tokens`，注释写明 completion 已含 reasoning（`:1175-1182`）。
- `calculateCost` 在解析之后把 `cost.totalFromProvider=false`（`pi-ai/dist/models.js:698`）。这条路径上它是布尔，不是金额。

上面三处只证明锁定的 Pi 1.5.2、`openai-completions` 这条解析（DeepSeek 目录模型走它）。不要写成跨 provider 永远成立。实施验收要加离线夹具：无 usage 块时没有该键；解析到 usage 后该键是布尔；全零不结清。

可执行的最小规则（不改账本函数，只覆盖这条解析）：

- 没有 `cost.totalFromProvider` 这个布尔键：这条解析里还没有 usage 块 → HELD。
- 有该键，但四字段都是 0：空 usage 对象会被解析成全零，和「真零账单」分不开（PI-10，同一文件）→ HELD。
- 有该键，四字段都是 ≥0 的整数，且四字段之和 >0：按各类 token 结算。0 允许。
- `stopReason==="error"` 或 `"aborted"` 且没有上述可结算 usage：保持 HELD，不 release，不重试。
- 价格：某一类 token >0 时，该类目录价必须是非负整数，否则整笔 HELD。token 为 0 的类，价为 null 不挡结清。这与「对应类别缺价则 HELD」一致，没有把「四个价必须先全非 null」放进 4.1。四价仍默认 null；全零 usage 不结清，所以缺价不会被当成免费。

### 2. 崩溃安全要写清 request 状态机和一次事务，不能写成「账本本身保证」

`budget.mjs:199-204` 的 `request_key` 唯一只保证同一预留键不插第二行。`settle` / `chargeBound` / `release` 各自只在本表 `state='HELD'` 时成功（`:376-377`、`:348` 一带）。它们不看见 `model_requests`。两表各写一次，中间宕机，账本单表保证不了「没调用过」或「只调用一次」。

ADR `:74-78` 把取消 release、超时转 `CHARGED_BOUND`、以及「账本规则本身崩溃安全」写在一起。`chargeBound`（`:370-393`）是占满 upper，不是重试，也不是 release。调用一旦可能已经发出，就不能 release。

替换为下面的状态，仍用现有 `withTx`，不新建框架。FAILED 只出现在调用前，不从 EXECUTING 再转到 FAILED：

- `RECEIVED`：插入 `model_requests`（主键 requestId）与校验通过，尚未预留。调用前拒绝可以到 `FAILED`，此时没有预留。
- `RESERVED`：同一事务里 `ledger.reserve(requestKey="model:<requestId>")` 成功并记下 reservationId。调用前取消可以 release，然后到 `FAILED`。
- `EXECUTING`：进入子进程之前单独提交。此后不重试、不 release。宕机后预留保持 HELD，只走现有保守超时 → `CHARGED_BOUND`。
- `SETTLED`：usage 可结算时，账本 `settle` 与 request 行落地在同一事务。同一 requestId 再来的 usage 看见非 HELD 就丢弃。
- `HELD`：已进入 EXECUTING 但 usage 不可结算。不调用第二次，不 release。
- `ORPHAN`：任务已终态才写回。不 settle。

重复提议：主键冲突，回读已有状态，不插第二笔预留。迟到 usage 只允许从 `EXECUTING` + HELD 进入一次 `SETTLED`。

### 3. 调用的是 pi-ai，不是 pi-coding-agent 的导出；thinking high 必须显式传入

`apps/daemon/package.json:5` 锁的是 `@earendil-works/pi-coding-agent@1.5.2`。它的 `dist/index.d.ts` 导出 `AgentSession`、`ModelRegistry` 等，不导出单次推理函数。本机 `Object.keys` 确认没有 `complete`/`stream`。

单次调用用已锁定的传递依赖 `@earendil-works/pi-ai@1.5.2`（零新版本）：

- `getBuiltinModel("deepseek", "deepseek-flash")`（`pi-ai/dist/providers/all.d.ts:18`）。wire 上的 `model` 是 `model.id`，即 `deepseek-flash`。信封里的 `deepseek/deepseek-flash` 只是白名单键，不能原样 POST。
- `completeSimple(model, context, { reasoning: "high", apiKey, maxTokens })`（`pi-ai/dist/compat.d.ts:66`，`types.d.ts:243`）。
- DeepSeek 分支：传入 `reasoningEffort` 才发送 `thinking:{type:"enabled"}`，并在 `supportsReasoningEffort` 为真时带上 `thinkingLevelMap.high`（`openai-completions.js:657-667`、`:1264`）。不传时，目录没有 `off` 键，`off !== null` 成立，会发送 `thinking:{type:"disabled"}`（`:661-662`）。绑定要保留，子进程必须传 `reasoning:"high"`。
- `model.baseUrl` 是 SDK 的 baseURL，不是最终 POST 地址。`openai` 7.19.0 `client.js:471-475` 把 baseURL 与 `/chat/completions`（`completions.js:24`）相接；`openai-completions.js:542-544` 把 `model.baseUrl` 原样交给 `new OpenAI({ baseURL })`。目录值 `https://api.deepseek.com` 因此落到 `/chat/completions`。旧宿主那条完整 `https://api.deepseek.com/chat/completions` 若整段写入，会再拼成 `/chat/completions/chat/completions`。本机探针只打 `127.0.0.1`（dummy key，`getBuiltinModel` + `completeSimple`，`reasoning:"high"`，两种 baseUrl 各 1 次，服务端回 400）：根地址收到 `POST /chat/completions`；完整 chat 地址收到 `POST /chat/completions/chat/completions`。两发的 body 都是 `model=deepseek-flash`、`thinking.type=enabled`。宿主覆盖写成无路径的根（目录根，或 `http://127.0.0.1:<port>`）。禁止把旧的完整 chat URL 原样放进 baseUrl。`endpoint=null` 不调用。

不要用 `AgentSession` 来做这次单次推理，那是 agent 循环。

### 4. proposals 的 1777 不能照搬到宿主目录

`container-executor.mjs:138` 的 `mode=1777` 是容器内 tmpfs，让镜像用户可写。ADR `:35` 把它写成宿主 bind 目录 mode。宿主上的 1777 任何本机用户都能丢进 `model_request`。context.json 若在同树可读，伪造者可以抄到真实 fence。

改为：宿主目录只允许 daemon 与容器 uid 999 写；1777 只保留给容器内 tmpfs。`requestId` 在拼 `model-result-<requestId>.json` 之前必须匹配 uuid，禁止把提议字符串直接当路径。身份字段从宿主写的 context.json 抄出（`worker.mjs:67-74` 已要求 fence 为正整数且非容器自选），宿主再用 RUNNING 行的 taskId/attempt/fence/scope 复检（`scheduler.mjs:8-12`）。不匹配则 `FAILED`，零预留。reply 回传正文，哈希不能代替正文。128 KiB 保持为 messages 硬顶。

`serveCommands`（`worker.mjs:154-197`）今天只收 `ping`。它是文件轮询，不是 agent 循环。4.1 只加 `model_request` 写出和 `model_result` 消费。这一点草案写对了，不用改结构。

## 非阻塞

- 纪元 3：`image-bind.mjs:79-90` 的 agent 清单含整个 `apps/daemon/src` 和 `worker.mjs`，这两处一改，agent context 必漂。acquisition/execution 清单不含宿主源码。实现时先 `appImageContextHash`，只重建已漂的名字；草案写 `--only=agent` 与这份清单相符，但不要在复算之前就构建。
- `callUpperMicrousd` 只限制预留占用。结算超过 upper 仍 SETTLED 并冻结（`budget.mjs:318-323`，ADR `:70` 已写明）。这不是输出 token 硬顶。token 上限留在 4.2 检查表第 4 项。
- 开工草案 `:9-20` 已把 4.1 放在许可 1、4.2 放在检查表之后。检查表七项不阻塞设计。D 仍延期（草案 `:5`）。状态清单 §4 仍写「缺口 A/B 归属待复核」，§7 已写「设计归属已闭」；实现前把 §4 改成指向 ADR 即可，不挡本结论。
- 44b3514 两项修复不重开。A 账单、B 正文、C 历史、原 tar 不追。

## 可转给 GLM 的修订提示（只改 ADR 原文，不改代码）

把 `docs/adr/0001-model-path-pi-host-execution.md` 四处换成下面的句子，其余不动：

1. 替换 §6 第 1 条（现 `:66-67`）：「在锁定的 Pi 1.5.2 openai-completions 解析下（不是跨 provider 永真契约），usage 块是否存在看 `cost.totalFromProvider` 是否已被 `calculateCost` 写成布尔（`models.js:698`）。没有该键，或四字段均为 0：HELD。四字段均为 ≥0 的整数且总和 >0：可结算；cache 未命中与 output 0 都合法。`stopReason` 为 error/aborted 且不满足可结算：HELD，不 release、不重试。某一类 token>0 而该类目录价不是非负整数：整笔 HELD；该类 token 为 0 时价为 null 不挡结清。实施验收用离线夹具核对：无 usage 块时没有该键，解析后该键为布尔，全零不结清。」
2. 替换 §7 崩溃与取消两句（现 `:74-78`）：「调用前 RECEIVED 可到 FAILED（尚无预留）；RESERVED 与 `ledger.reserve(requestKey=model:<requestId>)` 同一 `withTx`，调用前取消可以 release 再到 FAILED。EXECUTING 在子进程之前提交；此后不重试、不 release，不到 FAILED。宕机保持 HELD，只走现有 `chargeBound`。可结算时账本 `settle` 与 request 行同一事务落到 SETTLED，同一 requestId 只结清一次。不可结算保持 HELD。」
3. 替换 §5 前两子弹（现 `:58-59`）：「子进程 import `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModel("deepseek","deepseek-flash")` 与 `@earendil-works/pi-ai/compat` 的 `completeSimple`。这是已锁定的 pi-ai 1.5.2，不是 pi-coding-agent 的导出，不新增包版本，不使用 AgentSession。调用选项含 `reasoning:"high"`，否则 DeepSeek 分支会发送 `thinking:{type:"disabled"}`。wire model 用 `model.id`（deepseek-flash）。`model.baseUrl` 只放无路径的根：目录值 `https://api.deepseek.com`，或环回 `http://127.0.0.1:<port>`。OpenAI SDK 会自己 POST `/chat/completions`。禁止把旧的完整 `https://api.deepseek.com/chat/completions` 写入 baseUrl，否则路径变成 `/chat/completions/chat/completions`。`endpoint=null` 不调用。」
4. 替换 §2 挂载句中的 mode 1777（现 `:35`）：「proposals 宿主目录仅 daemon 与容器 uid 999 可写；1777 只用于容器内 tmpfs。requestId 经 uuid 校验后才进入文件名。身份从宿主写入的 context.json 抄出，并与 RUNNING 行的 fence 复检。」

## 修订（baseUrl 探针）

先前「把宿主 endpoint 整段写入 `model.baseUrl` 且不追加路径」不准确，已改 §3 与 GLM 第 3 句。四项结论不变。

探针：`getBuiltinModel("deepseek","deepseek-flash")` 后只改 `baseUrl`，`completeSimple(..., { apiKey: "dummy-loopback", reasoning: "high", maxTokens: 8, maxRetries: 0 })`。服务只听 `127.0.0.1`，回 400。fetch 拒绝非该地址。无 DeepSeek 出网。每种 baseUrl 恰好 1 次 POST。

| 写入的 baseUrl | 实际收到的 path | body |
| --- | --- | --- |
| `http://127.0.0.1:37829` | `POST /chat/completions` | `model=deepseek-flash`，`thinking.type=enabled` |
| `http://127.0.0.1:37829/chat/completions` | `POST /chat/completions/chat/completions` | 同上 |

两发 `stopReason` 都是 `error`，信息为 `400`。源码对应 `openai/client.js:475` 的字符串相接，以及 `openai/resources/chat/completions/completions.js:24` 的固定路径 `/chat/completions`。
