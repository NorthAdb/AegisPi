# Phase 2 开工检查单执行状态

来源：`D:\AegisPi\PHASE2-KICKOFF-HANDOFF.md` 第 5 节「建议的可观察拆步」，步骤原文保留，逐步附实际命令、退出码与产物路径。skip 行必须带理由。

- [x] 1. 修正 `AUDIT-HANDOFF.md` 第 4、5 节过时措辞，并重跑第 1 节两条最小验收。证据：`node evals/contracts/run-contracts.mjs` 15/15 PASS 退出码 0（2026-11-19 本会话复跑）；`node evals/contracts/tools/verify-hono-oracle-pair.mjs` 退出码 0（含未安装快照 exit 2 两行）；AUDIT-HANDOFF.md 第 4 节 Telegram 条、第 5 节要点与宣称范围三处已按 evidence/07 与 phase1-closure.md 收口事实改写；schema.sql LF 校验和实测 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995` 与移交要求一致。
- [x] 2. 迁移器 + 排他锁 + 连接初始化；用规范 schema 建空库。证据：`node evals/phase2/durability/run.mjs`（锁定 Node）23/23 PASS 退出码 0（2026-11-19 本会话）；canonical checksum ede73eca… 按 LF 校验一致；DDL 形状 27 用户表 + 10 FTS（含 8 shadow）+ 3 触发器与 PI SQLITE 探针一致；WAL/FULL/foreign_keys 实测；readOnly 连接拒绝写；篡改 SQL / 残表 / 撕裂 DDL 三条红门全部 fail-closed；排他锁双持拒绝、崩溃持有者可夺回；键编码转义不碰撞。
- [x] 3. inbox 接收/去重/`dispatch_key`，ACK 必须发生在事务提交之后。证据：durability run 41/41（步骤 2+3 合计）；ADMIT 入库含 payload 对象+自身 scope 闭包+audit+stream 同事务；重复事件返回成功零新增；无供应方 ID 的源按文档化 canonical envelope SHA-256 摘要去重；三个崩溃窗口（before-file / inside-txn / after-commit）真实 SIGKILL 子进程 + 重投递，终态恰好一行持久化，ACK 行仅在提交后打印；事务中崩溃留下的未引用文件由 GC 实测只搬孤儿不搬被引用文件（顺带修掉 Windows 反斜杠 storage_ref 会误判孤儿的真 bug）。
- [x] 4. Task/attempt/lease/fence，含心跳条件与租约过期回收。证据：durability run 68/68；claim 在 BEGIN IMMEDIATE 内一次铸 attempt_no+1 与 fence+1；心跳/步数/结果回写同条件（task+attempt+owner+fence+未过期租约+RUNNING）；错 owner/旧 fence 写实测 StaleWorker；每 scope 单飞；scope epoch 栅栏挡旧纪元 claim；租约过期回收器 LOST 旧 attempt 并重排，重试耗尽 DEAD 留审计；SUCCEEDED 必须带证据对象；重派单靠 UNIQUE(origin_event_id,dispatch_key) 单任务；delivery 检查点 ACK 幂等、异检查点拒绝、DONE 后 inbox 才 DONE、DEAD 发 audit_alert。
- [x] 5. HELD 账本与八种 purpose；补一条「缺 usage 不得 SETTLED 为零」的失败测试。证据：`node evals/phase2/budget/run.mjs` 20/20 退出码 0；规范默认直读 defaults.json 断言（800000/25/900/5000000/保温 off，八 purpose 逐一声明）；条件预留任一账户失败整体回滚实测零残留；request_key 防重；缺 usage 结算拒绝且保持 HELD；CHARGED_BOUND 上界转 spent、修正须可信账单+actor；超支如实记账并冻结账户、新预留被拒；限额下调自由、上调须显式批准；保温 off 不建账户不预留、显式开启才建；workerStep 无预留/异 purpose 预留被拒（绕过门禁）；双进程并发预留恰好一个赢家且输家零残留；durability 68/68 回归不破。
- [x] 6. effect / Outbox / UNKNOWN 与四种 retry_mode（fake 远端）。证据：durability run 109/109（含步骤 2-5 全量）；propose 停车 PARKED 不增 fence；审批单次 CAS 消费、重复回调返回已处理；错 nonce/hash/审批人/过期/撤权全拒；拒绝为正常终态（effect DEAD、task FAILED）；编辑失效旧审批并铸 business_key 新版本；DRAFT→READY 仅限白名单 Routine；dispatcher 事务内复检 hash/epoch/expiry/fence/预算/attempts/预条件后 CAS READY→SUBMITTING；四种 retry_mode 用持久化 fake 远端逐一验证（IDEMPOTENCY 同键去重恰好一次、LOOKUP 强一致未发生才重发/弱一致不重发、AT_MOST_ONCE UNKNOWN 停自动重发、AT_LEAST_ONCE 重复为声明的代价）；UNKNOWN 永不盲重试，人工对账必须记 actor+证据；取消线性化两种顺序（先取消则 dispatcher 拒、先提交则如实报告已承诺待确认）；单任务取消按 scope epoch 栅栏停车同伴；四个崩溃窗口（审批事务中/审批提交后/提交后未调用/远端已成功未记账）真实 SIGKILL + 恢复全部落账。Outbox 行的写入随任务结果同事务（outbox 模块在步骤 7 一并验收）。
- [x] 7. Timer（含到期与回信竞争、错过周期合并一次补跑）。证据：durability run 124/124；一次性触发唯一 occurrence 幂等；条件已满足则 SATISFIED 零事件；回信先提交则到期扫描不触发、到期先提交则 FIRED 且迟回信不能撤销但过时 READY 跟进提醒在提交前被取消（followup notify_reason + 重验扫描）；周期 occurrence 递增保持 SCHEDULED；5 个错过周期合并为一次补跑且 missed_count=4 入审计、无开机无限追赶；任务结论+result 对象+通知 effect+outbox 行同事务（FK 失败注入实测整体回滚、任务留在 RUNNING）；摘要合并 supersede 旧 READY effect 取消不改正文；not_before 静默窗口延迟不丢；通知过期 CANCELLED 带可见原因；timer 触发事务中/提交后两个崩溃窗口真实 SIGKILL + 重跑单事件。附带修复：DRAFT 免审批提案不再误把 RUNNING 任务停车。
- [x] 8. 启动恢复扫完 06 §9 的崩溃矩阵，尤其是 SUBMITTING 后 UNKNOWN。证据：durability run 133/133；startupRecovery 按 06 §9 固定顺序（integrity → schema verify → 对象引用 → scope 配置/撤权版本 → 失联 attempt → 失联 job+杀孤儿 → SUBMITTING→UNKNOWN → 预算校准 → Timer/Outbox/inbox 报告 → 才开放执行），每步留 action log；崩溃窗口全家：ingress 三窗、dispatch 两窗、审批两窗、SUBMITTING 旗舰（含预算 CHARGED_BOUND 校准与恢复幂等）、远端已成功未记账、Timer 两窗、预算中断保守占额、离线 job 孤儿（真实 detached 进程越过被杀 daemon 存活，恢复时被杀、job 置 LOST）、Task 完成后 Outbox 未发（恢复报告 pending、dispatcher 续跑）、入库后调度前（恢复报告 PENDING、router 续跑）、文件落盘后引用前（GC）；对象文件缺失 → 只读模式、执行不开放。
- [x] 9. ACL + FTS 三触发器 + `recall.sql` 的 45 条无权候选测试。证据：`node evals/phase2/acl/run.mjs` 14/14 退出码 0；内嵌 recall.sql 与设计包文件做结构一致性门（漂移即红）；插入/更新/删除三触发器对双 FTS 索引逐一实测；45 条高 BM25 无权候选（25 条外域 scope + 20 条同域但要求未授予的额外 scope）零泄漏、12 条合法全部保留（授权过滤先于 LIMIT 实证）；祖先链/当前会话/闭包缺失/已删除/已过期对象不召回；撤权单事务同时升 acl_version 与全局 authorization_revision；跨域隔离、过期授权失败关闭、A∪C 闭包按授权取交；查询编译器限 8 词、逐词引号封死 FTS 操作符；短中文走有界 LIKE 回退（转义 LIKE 元字符、明确不宣称 RRF 等价）。
- [ ] 10. daemon 入口正式接入 `load-pi-settings.mjs`；加一条「绕过加载器则保温配置读成 idle / 测试变红」的门禁。
- [ ] 11. 最小任务/对账/恢复诊断台（本机）。
- [ ] 12. 收口：`test:durability` / `test:acl` / `test:budget` 三脚本全绿留日志；Phase 1 契约套件与 hono 配对自检回归全绿；按 PRE-READ「阶段交接包」写交付清单（版本/行为/风险/未决项/回归），不写笼统「全绿」。

## 阶段约束（每步执行时对照）

- 唯一状态规范：设计包 06 + schema.sql（SHA ede73eca…，LF）。不另造冲突状态表。
- 时间 Unix 毫秒；金额整数 microUSD；WAL + FULL synchronous + foreign_keys；OS 排他锁防双启动。
- 八种 purpose 全入账；先预留再调用；未知 usage 保持 HELD；超时 CHARGED_BOUND；未对账不释放。
- fake 远端与录制数据；不接真实平台回调；密钥与本地文件不入库（改代码前 `git check-ignore` 复核）。
- 停止条件：静默丢事件、越权召回、预算旁路、UNKNOWN 盲重试、无鉴权控制台、真实外部副作用。
