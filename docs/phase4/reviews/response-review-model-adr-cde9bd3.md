# 回应：方案审核 REVIEW-MODEL-ADR-cde9bd3（ADR-0001 与开工草案修订记录）

生成：2026-11-20。对象：`docs/phase4/reviews/REVIEW-MODEL-ADR-cde9bd3.md`（原稿**字节归档**，SHA-256 `685192d7e6e775339c5e11bc2604a98106f9ca4eab1c7cbd69de2d2c8adc189c`，12667 字节，一字未改；其文末「修订（baseUrl 探针）」节按原文保留）。判定「需改后通过」的四项已全部落实，仅改文档：ADR-0001、受限开工草案、状态清单；不改任何代码、配置或构建输入。

## 四项更正的落点

| # | 审核要求 | 落实位置 |
| --- | --- | --- |
| 1 | 四字段按「非负整数 + 是否真有 usage 块」结算；`output=0` 与 cache 未命中合法；缺 usage/全零 HELD；`totalFromProvider` 是布尔、只作锁定路径的解析标记并入离线夹具验收；逐类价格（token>0 类需非负整数价） | ADR §6.1–6.2 全替换（含 pi-ai models.js:698、openai-completions.js:162-169/349-358 行引用与夹具三态要求）；§6.5 补 `callUpperMicrousd` 只限预留占用、非 token 硬顶；§10.4/10.5 测试项同步 |
| 2 | 不能声称 request_key/账本防重复调用；写清 `model_requests` 状态机与事务边界（RESERVED 与 reserve 同事务、EXECUTING 调用前提交后不重放不 release、settle 与状态同事务、调用前取消才可 release）；区分 request/账本状态；重复、迟到 usage、任务终态、CHARGED_BOUND 处理；结果不投递 ≠ 费用不处理 | ADR §7 全节替换（先写「账本单表保证不了」的边界声明，引 budget.mjs:199-204/294-295/348-358/370-393；再列 RECEIVED/RESERVED/EXECUTING/SETTLED/HELD/ORPHAN/FAILED 七态与超时/重复/迟到/终态四款；「ORPHAN 不 settle，但已发出调用的费用照走」明文；FAILED 只出现在调用前）；§4.2 指针与 §10.2/10.3/10.6 同步 |
| 3 | 单次推理用 pi-ai 1.5.2（providers/all 的 `getBuiltinModel` + compat 的 `completeSimple`），非 pi-coding-agent 导出、不用 AgentSession；显式 `reasoning:"high"`；白名单键与 wire model 区分；`baseUrl` 是 SDK 根地址（目录 `https://api.deepseek.com`，SDK 自接 `/chat/completions`），禁止搬旧完整 URL；默认 null 仍拒绝调用 | ADR §5 前两子弹全替换（引 providers/all.d.ts:18、compat.d.ts:66、openai-completions.js:657-667/1264/542-544、openai client.js:471-475，及复核环回探针双发结论：根地址→`POST /chat/completions`，完整地址→`/chat/completions/chat/completions`）；§3 modelId 补白名单键/wire 区分；§8.1 迁移步骤与 §9 配置行改 `model.baseUrl`（替换旧 `model.endpoint` 键语义）；开工草案 4.1 产物、a 步与检查表第 6 项同步 |
| 4 | 1777 只属容器内 tmpfs；宿主 proposals 目录仅 daemon 与容器 uid 999 可写；requestId 经 uuid 校验才进文件名；身份从宿主写的 context.json 抄出并以 RUNNING 行复检；reply 回传正文 | ADR §2 挂载句与结果回传段替换（引 container-executor.mjs:138、worker.mjs:67-74、scheduler.mjs:8-12）；§10.7 测试项同步；开工草案 4.1 c 步同步 |

## 独立核实（本机，只读，零网络）

修订前对锁定包复核了审核的技术断言：`@earendil-works/pi-ai@1.5.2` 在位（package.json version 1.5.2，exports 含 `./compat` 与 `./providers/*`）；`getBuiltinModel` 见 providers/all.d.ts:18，`completeSimple` 见 compat.d.ts:66；目录真值 `deepseek.json`：`baseUrl="https://api.deepseek.com"`（根地址）、`thinkingLevelMap.high="high"`、cost input 0.3 / output 1.2 / cacheRead 0.006 / **cacheWrite 0**。未启动任何调用；审核文末的环回探针结论按其原文采信，未复跑（避免任何不必要的网络行为）。

## 同步与矛盾消除

- 状态清单 §4 与 §7 第 4 条统一为「**归属定夺载体为 ADR-0001（修订稿，待主人方案确认；确认前保持开放不称已闭）**」，消除「归属待复核」与「设计归属已闭」并存的矛盾。`model-path-and-pi.md` §7.2 历史正文不动（其「由主人/ADR 决定」与本轮口径相容，后续状态以 ADR 状态为准）。
- 开工草案头部加修订记录；D 项补「**不作为全部 Phase 4 的前置条件**」（4.1 与 4.2 的模型/仓库部分不等 D）；4.1 的纪元 3 改为「先 `appImageContextHash` 复算、只重建已漂名字、复算前不构建」。

## 边界遵守

本轮零代码/配置/构建输入改动；未重建镜像、未跑任何 real 入口（含 simulate）、未读 `.env`、未做任何网络调用；`defaults.json` 保持失败关闭（git diff 0 行）；Phase 3 限定修复保持关闭；A/B/C 缺证不追补；$0.80/$5 不重开。ADR 修订稿与开工草案仍**不含任何运行授权**，等待主人方案确认后按单元 4.1 另行申报实施。
