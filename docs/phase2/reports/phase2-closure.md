# Phase 2 收口报告：持久化只读链路与恢复（2026-11-19）

实施会话（OpenCode / GLM）按 `D:\AegisPi\PHASE2-KICKOFF-HANDOFF.md` 授权开工，按其第 5 节拆步逐格交付。本文按 PRE-READ「阶段交接包」列已做与未做，不写笼统「全绿」。状态/字段/事务/恢复的唯一规范仍是本机设计包 06 + schema.sql（D-01，包不随库分发）。

## 1. 版本

| 项 | 值 | 证据 |
| --- | --- | --- |
| 收口源码 | b5476cc（步骤 11）+ 本收口提交 | git log；每步一个可验证单元提交 |
| Node | 22.23.5（显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`，PATH 上 v24 仅开发） | 三个套件守卫拒绝非锁定 Node（exit 2） |
| Pi / hono / SQLite | Pi exact 1.5.2（未动）；hono 4.13.19（lockfile sha256 e5d0c57e…）；node:sqlite 3.54.1 | apps/daemon/package.json；配对自检输出 |
| 规范 schema | schema.sql SHA-256（LF）`ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`，迁移器指针 `apps/daemon/config/schema-source.json` + 哈希门（篡改即红） | durability-report |
| 政策/默认值 | `apps/daemon/config/defaults.json`（06 §4/§8：单任务 800000 microUSD、25 步、15 分钟、日 5000000 microUSD、保温 off、心跳 10s/租约 45s）；daemon 经 `config.mjs → piSettingsFromDefaults` 读取（D-11 接线义务落地，绕过即红） | durability-report 步骤 10 四检查 |
| recall 查询 | `apps/daemon/src/recall.mjs` 内嵌，与包内 recall.sql 结构一致门（漂移即红） | acl-report 第一检查 |

## 2. 行为（命令、退出码、日志）

锁定 Node 显式路径执行，全部实测退出码 0：

```
node evals/phase2/durability/run.mjs  → 145/145 PASS, EXIT=0   （含全部崩溃窗口）
node evals/phase2/budget/run.mjs      → 20/20  PASS, EXIT=0
node evals/phase2/acl/run.mjs         → 14/14  PASS, EXIT=0
node evals/contracts/run-contracts.mjs          → 15/15 PASS, EXIT=0（Phase 1 回归）
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0（含未安装快照 exit 2 两行）
```

- 机器报告：`docs/phase2/evidence/{durability,budget,acl}-report.json`；人读日志：同名 `-log.md`；收口时点完整控制台转录：`docs/phase2/evidence/final-{durability,budget,acl}-console.txt`。
- **数据源全部为 fake/录制**：fake 远端状态持久化于 `workspace-state/<case>/fake-remote.json`（进程崩溃后恢复仍见同一远端状态）；无任何真实外部调用（DeepSeek 单发授权已用尽不重放，Telegram 只读复测不重发）。`--once --fake-upstream` 冒烟的 worker 是 phase2-fake，结果对象如实标注。

### 2.1 崩溃窗口矩阵（全部真实 SIGKILL 子进程 + 恢复验证）

| 06 §9 窗口 | 恢复行为（实测） |
| --- | --- |
| 入库前 / 事务中 / 提交后未 ACK | 事务中回滚零残留、提交后重投返回 duplicate；终态恰好一行持久化；ACK 行仅在提交后打印 |
| 入库后、通知调度前 | 恢复报告 inbox PENDING；router 从持久行补派单 |
| 模型计划后、派单事务前 | dispatch_key 唯一约束防重建；重算计划复用同一任务 |
| delivery 写入后 / RPC 前后 | command_id 检查点幂等重投；异检查点拒绝（不重复附加） |
| 离线 job 运行中 | 真实 detached 孤儿进程越过被杀 daemon 存活，恢复杀之、job 置 LOST |
| Task 完成、Outbox 发送前 | 恢复报告 ready_outbox；dispatcher 从持久对续跑送达 |
| 审批消费前（事务中） | CAS 回滚干净，审批人手中卡片（nonce）重决成功 |
| 审批消费后（提交后） | 重复回调返回 already CONSUMED，无二次消费 |
| **READY→SUBMITTING 后（旗舰）** | 提交后未调用：恢复置 UNKNOWN → IDEMPOTENCY_KEY 同键重发 → SUCCEEDED，远端恰好一次 |
| 远端已成功、本地未记账 | LOOKUP 强一致补记 external_id，零重发 |
| Timer 触发事务中 / 提交后 | 事务中回滚重跑单事件；提交后 occurrence 唯一约束幂等 |
| budget 请求中断 | 保守 HELD 不释放；恢复校准超时置 CHARGED_BOUND（可信账单+actor 才可修正） |
| 文件落盘与 DB 激活之间 | 未引用文件 GC 只搬孤儿；恢复校验对象引用，缺失即只读 |

### 2.2 停止条件相关的不变量（实测）

- 旧 fence / 假 owner / 过期租约的 worker 写全部 StaleWorker 拒绝；fence 只由 DB 铸造。
- UNKNOWN 不盲重试：AT_MOST_ONCE 停自动重发、LOOKUP 弱一致未找到不重发、人工对账必须 actor+证据。不宣称普遍 exactly-once（IDEMPOTENCY_KEY 的「恰好一次」是对该 fake 远端同键幂等的实测，非普适承诺）。
- 并发预算预留：双进程竞争恰好一个赢家、输家零残留；任一账户失败整体回滚。
- 45 条无权候选（25 外域 + 20 未授予闭包）零泄漏，12 条合法全部保留；撤权单事务升 acl_version + authorization_revision。
- 控制台仅本机：无 token 401、跨源 403、后阶段端点 501 不造假数据、只读模式仅诊断。
- 取消线性化两顺序：先取消则 dispatcher 拒；先提交则如实报「已承诺、可能已生效、确认中」。

## 3. 风险与如实边界（不随收口消失）

- **未对账 effect**：UNKNOWN 的自动策略按 retry_mode 分流，但真正结清需要上游对账凭据或人工 reconciliation；Phase 2 只用 fake 远端演练，未发生真实未对账积压。
- **未知 usage**：CHARGED_BOUND 是保守占额不是账单；修正依赖可信账单（第二层保护），本阶段未接真实 provider 账单。
- **备份**：迁移前自动 `VACUUM INTO` 快照落 `workspace-state/<dir>/backups/`；**一致性备份的维护窗口流程、加密 manifest 与恢复演练是 Phase 3 的 test:restore 范围**，本阶段只验证了快照可生成。
- **磁盘水位**：未配置告警（常开前必须有实测水位告警，属后续阶段）。
- **租约时钟**：心跳 10s / 租约 45s 是规范可校准起点，未按真实工具时长校准（Phase 3 校准工作的一部分）。
- **锁的残余风险**：lockfile+PID 探测存在 PID 复用窗口（单人单机接受，D-18 记录）。

## 4. 不宣称（本阶段明确不做）

- 不宣称服务常开、已被监控或任何用户收益（hono 75 条仍是评测夹具，监控范围仍只盯 NorthAdb/AegisPi）。
- 不宣称普遍 exactly-once、取消后绝不生效。
- 不做 Phase 3：真实隔离与逃逸测试、应用镜像构建与配额校准、认证控制台定稿、真实备份演练、真实平台回调。`--fake-upstream` 只是测试缝，默认循环如实报「无上游、READY 保持持久化」。
- 不做 Phase 4：真实仓库闭环。
- 短中文召回回退按 01 §5「单独验收」，已标注不与 RRF 等价。
- Timer 条件求值器 Phase 2 仅 event_seen/none 两型（timers.mjs 显式注册，扩展走该模块，不另造语义）。

## 5. 未决项（移交 Phase 3）

1. agent/acquisition/execution 三个应用镜像的真实构建 digest 与容器配额压测校准（06 §4 占位值待校准）。
2. 宿主代理、真实审批回调平台签名核验（本阶段审批人是本地 fake）、外部提交器与真实上游适配器。
3. 认证控制台定稿（审批卡、取消/授权/预算台、四大终态视图）；SSE 重连与 generation 重放未实现（Phase 2 控制台是只读快照面）。
4. 一致性备份维护窗口 + 删除清单 + test:restore 恢复演练。
5. 真实隔离与逃逸测试（test:security:unit/integration、test:cancel-approval）。
6. 真实 ingress 适配器（事件验签、平台事件 ID 信任链）——Phase 2 的 receiveEvent 接收的是已验证输入。
7. offline job 的真实容器执行（本阶段为受控假进程）；task 结论→通知的 Routine 提议链在真实 Agent 执行下的接线。
8. 预算按真实 provider 账单的修正流（第二层保护）。

## 6. Phase 3 最小入口条件

1. 重跑本报告第 2 节五条命令，全绿再继续；开工者持有 schema.sql SHA `ede73eca…` 对应的 v1.4.1 包。
2. 三个应用镜像均已记录真实 digest（04 Phase 3 入口硬条件）。
3. 涉及安全边界、数据模型或阶段依赖的偏离先按包内 ADR 模板报批。
4. 审计史：Phase 2 未安排外部审计轮；如需第五轮审计复核 Phase 1+2，入口证据 = phase1-closure.md + 本报告 + docs/phase2/evidence/ + `.audit/`（todo 与决策 trail 入库）。
