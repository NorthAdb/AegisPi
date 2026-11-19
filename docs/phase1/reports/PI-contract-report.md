# Phase 1 · PI-01 至 PI-13 契约核验报告

日期：2026-11-18 初测，2026-11-19 按第一轮审计整改后复测（Asia/Hong_Kong）。执行环境：Windows 11，锁定 Node v22.23.5（显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`，npm 10.9.9；他机复测可用 `AEGISPI_NODE_BIN` 环境变量指向真实 22.23.5 二进制，RPC 探针会校验子进程版本），`@earendil-works/pi-coding-agent` exact 1.5.2（package-lock integrity `sha512-mUWI04rqF1Vd/…lom5yA==`）。全套探针位于 `evals/contracts/`，入口 `npm run test:contracts`（运行器拒绝非 22.23.5 的 Node）。机器判定结果：`docs/phase1/evidence/contracts-report.json`，15/15 PASS。

**修订声明（2026-11-19）**：第一轮外部审计（Linux/Ubuntu 24.04.5，锁定 Node 22.23.5 复跑全绿）指出本报告 v1 有四处结论超出断言或与实测相反，均已整改并复测：PI-02 的 route“单参数全局事实”（实为双路径）、PI-07 的 timeout 时长（机器证据 4 秒，报告误写 8 秒）与“无重放”断言（原为字面量 true，已改为重启复验）、PI-10 的 totalFromProvider“字段不存在”（实为可选布尔，标准路径 false）、多处不可失败的 PASS（已全部改为可失败断言或降级为 note）。逐条映射见 `audit-response.md`。

每个探针的逐条断言（含实际输出摘录）都在 contracts-report.json 的 findings 里，此处只写结论与规范需要的适配决定。

## 逐项结论

| ID | 契约内容 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| PI-01 | exact 1.5.2 导出、资源加载、扩展绑定 | 成立 | 34 个运行时导出 + 18 个类型导出全部实测存在；`VERSION` = 1.5.2；隔离最小运行中内联扩展注册的工具进入 `getActiveToolNames()` |
| PI-02 | route 双注册路径、previous/failed/state、reason | 成立（v1 的“单参数全局事实”已修正为双路径） | **两条注册路径实测**（P1-1 整改）：`ModelRuntime.registerVirtualModel` 的 route 收到**恰好 1 个参数**（model-runtime.js:712 包装 `route:(request)=>definition.route(request)`，第二参 undefined，路由器须闭包捕获 ModelRuntime）；扩展 `pi.registerVirtualModel` 的 route 收到 **(request, ctx)** 且 `ctx.modelRegistry.find('deepseek','deepseek-flash')` 可解析物理模型（loader.js:418 包装 `route:(request)=>model.route(request, runtime.createContext())`；types.d.ts 的 `ExtensionVirtualModel.route(request, ctx)` 与 docs/virtual-models.md 示例对应**扩展路径**）。两条路径的 dispatch 都把物理模型记入助手消息。user/continuation/retry 三种 reason、previous/failed 粘滞、JSON state 跨调用存活实测于 ModelRuntime 路径 |
| PI-03 | before_agent_start 的 user/custom 判别、system prompt 修改 | 成立 | `messageType` 区分 user/custom；返回 `{systemPrompt}` 完整替换到达 provider 请求体（实测 system 消息含覆盖文本）；`systemPromptOptions` 可变。无取消字段——取消点在更早的 input 事件 `{action:"handled"}` |
| PI-04 | tool_call 与 codemode 嵌套工具拦截 | 成立 | block 返回 `{block,reason}` 后 execute 不运行，reason 成为转录 tool result content（下一请求实测含 reason）；`event.input` 原地变异到达 execute；codemode 嵌套 read 调用带 `parentToolCallId` = 父调用 id，走同一 tool_call/tool_result 管道 |
| PI-05 | RPC prompt/steer/follow_up/clear_queue/abort 载荷与响应 | 成立 | disposition 实测 started/queued/handled；id 相关性在并发命令下成立；queue_update 携带 steering/followUp 全量文本；clear_queue 返回被清文本；abort 等 idle 后响应；坏 JSON 产生无 id 的 parse 响应；bash 流事件带命令 id；get_entries 游标；fork 返回原文 |
| PI-06 | 空闲信号、重试、压缩与 abort 关系 | 成立 | agent_end(willRetry) 先于 auto_retry_start/end；agent_settled 是唯一“不再自动继续”信号；手动 compact 在小窗口模型上触发 compaction_start/end 且响应含 summary+usage；abort 后 settled.aborted=true 且 provider 请求停止 |
| PI-07 | UI confirm/select/editor 及重启后恢复 | 成立，三项实测偏差 | 见下节“扩展 UI 三偏差”。宿主必须自持 deadline 与持久停车——与 04 §2 的预期设计一致 |
| PI-08 | Session fork、原目录消失、分支定位 | 成立 | 持久会话目录删除后 RPC `--session` 拒绝启动（exit 非 0）；`--fork <file>` 从新 cwd 建新会话，对话完整保留，header 记 parentSession 指向原文件 |
| PI-09 | provider 注册、base URL、headers、认证、流式错误 | 成立 | models.json 只覆盖 baseUrl 保留目录元数据（contextWindow 1000000 等实测不变）；DEEPSEEK_API_KEY 环境变量与 models.json 字面 apiKey 两条凭据路径实测认证成功；wire 形状 = OpenAI chat/completions（stream:true + stream_options.include_usage + max_tokens）；500 错误以 stopReason=error + errorMessage 呈现；URL/凭据只由宿主侧配置决定 |
| PI-10 | Usage 字段、provider 费用、未知 usage | 成立（v1 的“totalFromProvider 不存在”已修正） | 末块 usage 解析为 input/output/totalTokens；cost 按目录价计算（deepseek-flash 0.3/1.2 USD per M，实测 100/50 token → 0.00003/0.00006）；**`cost.totalFromProvider` 实为可选布尔**（pi-ai types.d.ts:318 `totalFromProvider?: boolean`，标准路径赋 false，仅 OpenRouter 上报费用时 true）——它从来不是数字，账本必须自行求和 input+output+cache；provider 不回 usage 时 Pi 报**零**（usage 与 cost 均为零）而非 unknown——账本必须把“响应存在但 usage 缺失”保守处理为未结算（HELD），不得当零成本 |
| PI-11 | schema/typebox 支持范围、复杂参数校验 | 成立 | typebox 1.3.27（`Type` 为命名空间对象）；Union/嵌套 Object/Optional 模式被 registerTool 接受；缺必填与错枚举的调用在 execute 前被拒，错误成为转录 tool result。宿主业务校验（ACL/预算/目标白名单）仍必须独立存在 |
| PI-12 | Codemode/QuickJS 输出、内存、timeout、tool exposure | 成立 | 沙箱拒绝 Node API（`process` → ReferenceError）；嵌套工具按 `<parent>/<n>` id 暴露且 details.calls 记录状态；`// @options` 行的 max_output_tokens/timeout_ms 生效路径存在；ALL_TOOLS 列 direct 工具、不含 codemode 自身（文档：脚本不能启动其他 codemode 脚本）。256MB/双 worker 限额为文档值，未做 OOM 实测——不作为安全边界（05 原文照办） |
| PI-13 | cacheWarming 及 decision 事件 | 成立，一项默认值冲突 | **Pi 1.5.2 默认 cacheWarming="idle"**（settings-defaults.js 实测 + `inMemory({})` 读取实测），与 AegisPi 规范“保温默认关闭”冲突。缓解**仅到设置层**（如实记录）：`inMemory({cacheWarming:"off"})` 读取路径实测接受 off，`apps/daemon/config/defaults.json` 实测含 off 值；**加载该文件的 daemon 代码属 Phase 2，运行时强制尚未落地**。cache_warming_decision 事件在 types.d.ts/cache-warmer.d.ts 双双声明（静态断言）；deepseek-flash 目录无 promptCache 声明 → 该模型不符合保温条件。启用前须按 purpose=warming 计费验证 |

## RPC LF 分帧（05 §3 复测，探针 FRAMING）

- 输出侧：含 U+2028/U+2029 的助手消息在**单帧**内完整到达（message_update 实测），字节 LF 解析全部成功。
- 输入侧：U+2028/U+2029 在命令字符串内**留在同一帧**（Pi 输入分帧为纯 LF 字节，prompt 接受实测断言）；分片 UTF-8 **在多字节字符中间切开**（切点落在「哈」的 e5 93 88 三字节内部，P1-2 整改：v1 的切点落在 ASCII `}` 上、证明不了跨写缓冲）时跨写缓冲到完整帧才解析；CRLF 被剥除；1.5 MiB 单行被接受（成功以断言记录；宿主适配层的最大帧/累计 buffer/等待超时上限是**规范要求**，以 note 记录而非冒充 Pi 实测）。
- **锁定版本复测结果（现为可失败断言）**：Node 22.23.5 的 readline 与字节 LF 分帧**逐帧一致**（行数相等、0 解析失败，探针断言 `readline-equals-byte-frames-on-locked-node`，若未来 Node 升级改变行为探针变红）；而 v24.17.0 会拆 3 行全失败（复现脚本 `evals/contracts/tools/readline-repro.mjs` 可独立复跑，设计包初始审计在 v24.22.1 观察到的现象只在 v24 系成立）。结论：字节 LF 分帧仍是宿主契约——版本无关、且覆盖 CRLF；readline 不能作为协议读器长期依赖。
- stderr 分离实测：stdout 帧全部可 JSON 解析，stderr 独立（本场景 0 字节诊断）。

## 扩展 UI 三偏差（PI-07）

1. **wire 形状嵌套**：`extension_ui_request` 把整个 options 对象嵌在首字段名下（`title:{title,message,timeout}`、notify 的 `message:{message:"…"}`），docs/rpc-extension-ui.md 的扁平形状不属实。宿主适配层按嵌套形状读。
2. **dialog timeout 不生效**：文档称客户端不响应时 agent 侧按 timeout 自动 resolve；实测 confirm(timeout:1500) 在 RPC 模式 **4 秒后**（>2.5× timeout）仍 pending、无任何完成通知（v1 报告误写 8 秒，机器证据为 4 秒——P1-2 整改）。宿主必须自实现 dialog deadline。
3. **无跨重启持久化（现为可失败断言）**：dialog pending 时 SIGKILL 子进程后，**在同一 agent 目录重启全新进程**：扩展本身重新加载（get_commands 列出 probe_ui，证明重启有效），但 4 秒内**零**未请求的 extension_ui_request、被杀进程的 dialog id 无一复现——1.5.2 无重放/重排队机制。**宿主持久停车是硬要求**（04 §2 预期设计：保存状态→停车→重启→重新询问），探针以重启复验证实；若未来版本加入重放机制，该断言变红并推动重审。

## ADR 状态

零 ADR。以上偏差（含 2026-11-19 整改后的双路径结论）均不触及安全边界、数据模型或阶段依赖（PRE-READ Phase1 模板的报批线）；全部落在“宿主适配层实现细节”区间，已在本报告与探针 findings 中记录实测事实。若后续阶段采纳不同方案改变边界，再按 ADR-template 报批。

## 复现

```
npm run test:contracts          # = node evals/contracts/run-contracts.mjs（锁定 Node 下；Linux 用 AEGISPI_NODE_BIN 指向 22.23.5 二进制）
node evals/contracts/tools/readline-repro.mjs   # 双版本 readline 行为对照
```

整改的逐条映射（第一轮审计 P1/P2 → 修复 → 证据）见 `audit-response.md`。未决项见 `docs/phase1/reports/phase1-open-items.md`。
