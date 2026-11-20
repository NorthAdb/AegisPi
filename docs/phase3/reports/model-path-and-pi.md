# 模型路径与 Pi 的关系（复审 11d649a 收口项 4）

生成：2026-11-20。本报告回应复审的判定：「本地服务证明的是宿主路径和失败关闭，不是 Pi SDK 的 provider 对象」；「不要只凭 Pi 自检绿就声称 Pi 端到端已完成」。结论先行：**当前已实现并验证的是宿主授权推理路径（固定端点 + 预算预留/结清 + 失败关闭），它满足 02 §4「模型」适配器行的字面要求；尚未实现的是容器内 Pi agent 循环经提议通道驱动的推理（「Agent 提出模型和 purpose」），以及任何真实 provider 调用。两项均列为缺口，不因自检绿而改称完成。**

## 1. 设计要求（规范原文）

- **02 §4 适配器表「模型」行**：「Agent提出模型和purpose，宿主检查数据处理授权、价格与预留后发固定provider endpoint。全部响应计费和限制输出」。拆开是四条宿主义务：授权检查、价格检查、预留检查、固定端点；外加全部响应计费与输出限制。
- **00 §架构（Agent 工作容器）**：「Agent工作容器即使被模型控制也没有生产写凭据…离线job没有LLM请求，模型推理在宿主授权路径继续」。
- **00 §事件流**：「调度按域claim Task…模型提议读取或job；宿主执行并存证据」。
- **00 §技术选型（Pi 行）**：Pi exact 1.5.2，Phase 1 交付「精确导出/类型、RPC、扩展、UI与provider契约报告」——即 Pi 以**契约核验对象**进入本项目，模型 ID 绑定「在 Phase 1 对照 Pi 1.5.2 实际可用列表」完成。
- **设计包 AGENTS §4**：「所有收费请求预留预算…未知usage保守占额」。
- **04 任务书 Phase 3 交付**：「实现宿主代理/审批/提交器…预算硬门禁」；入口条件「准备明确授权的受限provider」。四场景与受控 RSI 归 Phase 5/6（04 §六阶段表）。

## 2. 实际调用链（已实现，本机可复核）

宿主 tick 的生产推理路径（`apps/daemon/src/daemon.mjs`）：

1. 授权检查（daemon.mjs ~367）：`isLoopbackModelEndpoint(config.model.endpoint) || config.model.allowRealModelCalls`；非环回且未授权 → **零领取、零预留**，日志写明 not authorized（security-unit 实测 reservations=0、任务保持 QUEUED）。
2. 领取与预留（~378-397）：claim → heartbeat → `ledger.reserve`（purpose `worker`，上限 `model.callUpperMicrousd`，按任务/日双账户拆分）→ `workerStep`。**预留先于调用**（security-unit 实测 ordering：created_at ≤ 服务收到时刻 ≤ settled_at）。
3. 端点与凭据（~416-423）：`config.model.endpoint`（宿主配置，非模型拼接）；bearer 来自凭据服务槽 `model`；`callModelOnce`（`apps/daemon/src/model-call.mjs`）经短命子进程 POST `{model, messages}` 到固定端点，读 `choices[0].message.content` 与 `usage.prompt_tokens/completion_tokens`。
4. 结算（~439-468）：`microusdForUsage(usage, config.model.priceCatalog)` 有值 → `ledger.settle`（source `model-http-transport`）；缺 usage 或价格目录为 null → 预留保持 **HELD** + `model_usage_not_settled` 审计。调用失败 → 预留走保守超时路径（CHARGED_BOUND）。
5. 证据与收尾（~474-503）：回复截断 4000 字符连同 usage/结算额写入 scope-ACL 对象（`task_result`），`completeTask`，delivery 结清。

容器侧（`docker/agent/src/worker.mjs`）：`PI_OFFLINE=1`，启动自检强制凭据环境 denylist、Pi exact 1.5.2、loader 映射 cacheWarming=off、无 docker.sock、无 `~/.pi`；对外仅有 propose-only 通道（announce + command receipt）。

## 3. 该路径如何满足预定架构（逐条对照）

| 02 §4「模型」行要求 | 实现位置 | 状态 |
| --- | --- | --- |
| 宿主检查数据处理授权 | daemon.mjs 授权分支；环回为本地验证缝，其余需 `allowRealModelCalls` | 已实现，实测失败关闭 |
| 价格检查 | `microusdForUsage` 拒绝 null 目录；未授权价格不结清 | 已实现，HELD 实测 |
| 预留检查 | 调用前 `ledger.reserve`；chargeable 无预留即拒绝（budget/adapters 双门） | 已实现，ordering 实测 |
| 固定 provider endpoint | `config.model.endpoint` 宿主配置；模型永不拼接 URL（02 §4「不由模型拼接」） | 已实现 |
| 全部响应计费 | settle by usage；缺 usage HELD；超时 CHARGED_BOUND 保守占额 | 已实现 |
| 限制输出 | 回复截断 4000 入库为带 ACL 的对象 | 已实现 |

预算纪律（设计包 AGENTS §4）由 Phase 2 账本 + 本轮 worker 接线共同满足；budget 套件 20/20、security-unit 实测 100 microUSD 结清与两种 HELD。

「模型提议读取或job」（00 事件流）中的**宿主执行**一侧已具备；提议一侧见缺口 A。

## 4. Pi 在本项目中的角色（三件事，不得混称）

1. **契约对象（Phase 1 已交付）**：`docs/phase1/reports/PI-contract-report.md` 逐项核验 Pi 1.5.2 的 route 双路径、provider 注册、usage/cost 语义（PI-09/PI-10）；`docs/phase1/reports/model-binding.md` 把「DeepSeek Flash High」绑定为 Pi 目录真实 ID `deepseek/deepseek-flash`（thinking high，价 0.3/1.2/0.006 USD/M），并经 Pi SDK 完成**一次**真实最小推理（usage 461+2，目录价 $0.0001407）。这证明 Pi SDK 的 provider 链路对真实端点成立——是契约知识，不是生产接线。
2. **agent 运行时（容器内，离线）**：agent 镜像内置 Pi exact 1.5.2，`PI_OFFLINE=1`，永不持密钥（02/00 边界）。自检绿（`self-check: green (pi 1.5.2)`）只证明边界不变量：版本、denylist、离线、loader 映射。**它不构成 Pi 端到端完成的证据**——容器内 Pi 目前没有接任何推理来源，agent 循环（多步推理、工具调用、compact）尚未运行过哪怕一轮模型往返。
3. **宿主推理客户端（Phase 3 新增，最小 OpenAI 形状）**：`model-call.mjs` 是宿主自己的最小 chat/completions 客户端（messages/choices/usage 子集），与 PI-09 对 deepseek 实测的 wire 形状同族。**daemon 生产代码不 import `@earendil-works/pi-coding-agent`**（复审已核）。设计未要求宿主调用走 Pi SDK——02 §4 只约束端点固定、宿主门禁与计费——自写最小客户端是合法的宿主适配器；但它意味着 Pi 契约知识（流式、thinking、重试、pi-ai 目录计价）当前未进入生产路径。

## 5. 缺口清单（设计要求尚未实现，如实列出不关闭）

- **缺口 A：容器→宿主的模型调用提议链路未接。** 02 §4「模型」行以「Agent提出模型和purpose」开头；00 事件流是「模型提议读取或job」。当前容器 worker 的提议通道只承载 announce 与 command receipt（worker.mjs `serveCommands` 仅接受 `ping`），没有模型调用提议信封；宿主直接以任务事件 payload 作为调用输入（daemon.mjs ~400-415）。即：推理的**宿主侧**已备好并验证，**提议侧**（容器内 agent 依 02 §3/§4 语义发起、宿主校验 purpose/预算后执行）尚未实现。按 04 任务书，四场景与 RSI 在 Phase 5/6，此缺口不阻塞 Phase 3 出口，但属于设计终态要求，不得宣称完成。
- **缺口 B：Pi SDK 形态的宿主调用未接（现为最小直连客户端）。** 后果：生产路径不发 thinking 级别、不读流式 usage、不走 pi-ai 目录计价（宿主用自配 priceCatalog）。Phase 1 已证明 Pi SDK 路径可行；是否把宿主客户端换成 Pi ModelRuntime/provider 或保持最小客户端并由 ADR 定夺，属后续阶段设计决策，本轮不擅改。
- **缺口 C：真实 provider 调用未发生。** 本轮仅环回端点；真实 DeepSeek 端点、`DEEPSEEK_API_KEY` 槽、真实价格目录与单次上限是授权待验项（Phase 3 入口条件「准备明确授权的受限provider」的验证半边），见 `docs/phase3/reports/real-acceptance-plan.md`。
- **形态备注（非缺口）**：`adapters.mjs` 的 `model.inference` 注册条目（chargeable、requiresReservation）供 effect 形态的模型调用（cancel-approval 套件以夹具实测其门禁）；生产 worker 走直连 `callModelOnce` + 自有 reserve/settle。两种形态共享同一预算账本与 HELD 纪律；若缺口 A 落地时模型调用改为 agent 提议→effect 派发，两路应合一，避免双入口语义分叉。

## 6. 边界重申

不因本报告把已验证部分写清楚就扩大宣称：宿主路径的凭证是环回服务，不是真实账单；容器自检绿不是 Pi 端到端；缺口 A/B/C 保持开放直至对应阶段与授权完成。
