# Phase 1 · PI-01 至 PI-13 契约核验报告

日期：2026-11-18（Asia/Hong_Kong）。执行环境：Windows 11，锁定 Node v22.23.5（显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`，npm 10.9.9），`@earendil-works/pi-coding-agent` exact 1.5.2（package-lock integrity `sha512-mUWI04rqF1Vd/…lom5yA==`）。全套探针位于 `evals/contracts/`，入口 `npm run test:contracts`（映射 `node evals/contracts/run-contracts.mjs`，运行器拒绝非 22.23.5 的 Node）。机器判定结果：`docs/phase1/evidence/contracts-report.json`，15/15 PASS。

每个探针的逐条断言（含实际输出摘录）都在 contracts-report.json 的 findings 里，此处只写结论与规范需要的适配决定。

## 逐项结论

| ID | 契约内容 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| PI-01 | exact 1.5.2 导出、资源加载、扩展绑定 | 成立 | 34 个运行时导出 + 18 个类型导出全部实测存在；`VERSION` = 1.5.2；隔离最小运行中内联扩展注册的工具进入 `getActiveToolNames()` |
| PI-02 | route(request)、previous/failed/state、reason | 成立（有一处文档偏差） | user/continuation/retry 三种 reason 实测捕获；continuation 携带 previous（deepseek-flash/high）；retry 携带 failed.stopReason="error"；JSON state 跨调用存活；助手消息记录物理模型。**偏差**：`dist/core/virtual-models.d.ts` 声明 `route(request)` 单参数，而 docs/virtual-models.md 示例写 `route(request, ctx)` 并用 `ctx.modelRegistry`——类型为准，宿主路由器用闭包捕获 ModelRuntime 取物理模型 |
| PI-03 | before_agent_start 的 user/custom 判别、system prompt 修改 | 成立 | `messageType` 区分 user/custom；返回 `{systemPrompt}` 完整替换到达 provider 请求体（实测 system 消息含覆盖文本）；`systemPromptOptions` 可变。无取消字段——取消点在更早的 input 事件 `{action:"handled"}` |
| PI-04 | tool_call 与 codemode 嵌套工具拦截 | 成立 | block 返回 `{block,reason}` 后 execute 不运行，reason 成为转录 tool result content（下一请求实测含 reason）；`event.input` 原地变异到达 execute；codemode 嵌套 read 调用带 `parentToolCallId` = 父调用 id，走同一 tool_call/tool_result 管道 |
| PI-05 | RPC prompt/steer/follow_up/clear_queue/abort 载荷与响应 | 成立 | disposition 实测 started/queued/handled；id 相关性在并发命令下成立；queue_update 携带 steering/followUp 全量文本；clear_queue 返回被清文本；abort 等 idle 后响应；坏 JSON 产生无 id 的 parse 响应；bash 流事件带命令 id；get_entries 游标；fork 返回原文 |
| PI-06 | 空闲信号、重试、压缩与 abort 关系 | 成立 | agent_end(willRetry) 先于 auto_retry_start/end；agent_settled 是唯一“不再自动继续”信号；手动 compact 在小窗口模型上触发 compaction_start/end 且响应含 summary+usage；abort 后 settled.aborted=true 且 provider 请求停止 |
| PI-07 | UI confirm/select/editor 及重启后恢复 | 成立，三项实测偏差 | 见下节“扩展 UI 三偏差”。宿主必须自持 deadline 与持久停车——与 04 §2 的预期设计一致 |
| PI-08 | Session fork、原目录消失、分支定位 | 成立 | 持久会话目录删除后 RPC `--session` 拒绝启动（exit 非 0）；`--fork <file>` 从新 cwd 建新会话，对话完整保留，header 记 parentSession 指向原文件 |
| PI-09 | provider 注册、base URL、headers、认证、流式错误 | 成立 | models.json 只覆盖 baseUrl 保留目录元数据（contextWindow 1000000 等实测不变）；DEEPSEEK_API_KEY 环境变量与 models.json 字面 apiKey 两条凭据路径实测认证成功；wire 形状 = OpenAI chat/completions（stream:true + stream_options.include_usage + max_tokens）；500 错误以 stopReason=error + errorMessage 呈现；URL/凭据只由宿主侧配置决定 |
| PI-10 | Usage 字段、provider 费用、未知 usage | 成立 | 末块 usage 解析为 input/output/totalTokens；cost 按目录价计算（deepseek-flash 0.3/1.2 USD per M，实测 100/50 token → 0.00003/0.00006）；provider 不回 usage 时 Pi 报**零**而非 unknown——账本必须把“响应存在但 usage 缺失”保守处理为未结算（HELD），不得当零成本 |
| PI-11 | schema/typebox 支持范围、复杂参数校验 | 成立 | typebox 1.3.27（`Type` 为命名空间对象）；Union/嵌套 Object/Optional 模式被 registerTool 接受；缺必填与错枚举的调用在 execute 前被拒，错误成为转录 tool result。宿主业务校验（ACL/预算/目标白名单）仍必须独立存在 |
| PI-12 | Codemode/QuickJS 输出、内存、timeout、tool exposure | 成立 | 沙箱拒绝 Node API（`process` → ReferenceError）；嵌套工具按 `<parent>/<n>` id 暴露且 details.calls 记录状态；`// @options` 行的 max_output_tokens/timeout_ms 生效路径存在；ALL_TOOLS 列 direct 工具、不含 codemode 自身（文档：脚本不能启动其他 codemode 脚本）。256MB/双 worker 限额为文档值，未做 OOM 实测——不作为安全边界（05 原文照办） |
| PI-13 | cacheWarming 及 decision 事件 | 成立，一项默认值冲突 | **Pi 1.5.2 默认 cacheWarming="idle"**（settings-defaults.js 实测），与 AegisPi 规范“保温默认关闭”冲突——宿主配置必须显式 off（`apps/daemon/config/defaults.json` 已写）。cache_warming_decision 扩展事件可否决；deepseek-flash 目录无 promptCache 声明 → 该模型不符合保温条件。启用前须按 purpose=warming 计费验证 |

## RPC LF 分帧（05 §3 复测，探针 FRAMING）

- 输出侧：含 U+2028/U+2029 的助手消息在**单帧**内完整到达（message_update 实测），字节 LF 解析全部成功。
- 输入侧：U+2028/U+2029 在命令字符串内**留在同一帧**（Pi 输入分帧为纯 LF 字节）；分片 UTF-8 跨写缓冲到完整帧才解析；CRLF 被剥除；1.5 MiB 单行被接受（宿主适配层仍须自设最大帧/累计 buffer/等待超时）。
- **锁定版本复测结果**：Node 22.23.5 的 readline **不会**在 U+2028/U+2029 处分帧（1 行 0 解析失败），而 v24.17.0 会拆成 3 行全失败（复现脚本 `evals/contracts/tools/readline-repro.mjs`，设计包初始审计在 v24.22.1 观察到的现象只在 v24 系成立）。结论：字节 LF 分帧仍是宿主契约——版本无关、且覆盖 CRLF；readline 不能作为协议读器长期依赖（Node 升级即破）。
- stderr 分离实测：stdout 帧全部可 JSON 解析，stderr 独立（本场景 0 字节诊断）。

## 扩展 UI 三偏差（PI-07）

1. **wire 形状嵌套**：`extension_ui_request` 把整个 options 对象嵌在首字段名下（`title:{title,message,timeout}`、notify 的 `message:{message:"…"}`），docs/rpc-extension-ui.md 的扁平形状不属实。宿主适配层按嵌套形状读。
2. **dialog timeout 不生效**：文档称客户端不响应时 agent 侧按 timeout 自动 resolve；实测 confirm(timeout:1500) 在 RPC 模式 8 秒后仍 pending、无任何完成通知。宿主必须自实现 dialog deadline。
3. **无跨重启持久化**：dialog pending 时 SIGKILL 子进程，请求随进程消失，1.5.2 无重放/重排队机制。**宿主持久停车是硬要求**（04 §2 预期设计：保存状态→停车→重启→重新询问），本探针以实测证实其必要性。

## ADR 状态

零 ADR。以上偏差均不触及安全边界、数据模型或阶段依赖（PRE-READ Phase1 模板的报批线）；全部落在“宿主适配层实现细节”区间，已在本报告与探针 findings 中记录实测事实。若后续阶段采纳不同方案改变边界，再按 ADR-template 报批。

## 复现

```
npm run test:contracts          # = node evals/contracts/run-contracts.mjs（锁定 Node 下）
node evals/contracts/tools/readline-repro.mjs   # 双版本 readline 行为对照
```

未决项见 `docs/phase1/reports/phase1-open-items.md`。
