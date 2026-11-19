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
node evals/phase2/durability/run.mjs  → 164/164 PASS, EXIT=0   （含崩溃矩阵与两轮整改门禁，2026-11-19 第二轮缺口整改后）
node evals/phase2/budget/run.mjs      → 20/20  PASS, EXIT=0
node evals/phase2/acl/run.mjs         → 15/15  PASS, EXIT=0
node evals/contracts/run-contracts.mjs          → 15/15 PASS, EXIT=0（Phase 1 回归）
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0（含未安装快照 exit 2 两行）
```

- 机器报告：`docs/phase2/evidence/{durability,budget,acl}-report.json`；人读日志：同名 `-log.md`；收口时点完整控制台转录：`docs/phase2/evidence/final-{durability,budget,acl}-console.txt`；两轮整改转录：`remediation-*-console.txt` 与 `remediation2-*-console.txt`。
- **数据源全部为 fake/录制**：fake 远端状态持久化于 `workspace-state/<case>/fake-remote.json`（进程崩溃后恢复仍见同一远端状态）；无任何真实外部调用（DeepSeek 单发授权已用尽不重放，Telegram 只读复测不重发）。`--once --fake-upstream` 冒烟的 worker 是 phase2-fake，结果对象如实标注。

### 2.1 崩溃窗口矩阵（验证方式逐项区分，不再统称「全部真实 SIGKILL」）

**杀进程窗口（真实 SIGKILL 子进程 + 重启恢复，共 12 个场景）**：ingress 三窗、dispatch 两窗、审批两窗、`READY→SUBMITTING` 旗舰、远端已成功未记账、Timer 两窗、Task完成Outbox未发。这些由 `AEGISPI_CRASH_POINT` 自毁或父进程 `killHard` 实现。自毁类谓词已收紧为双证（2026-11-19 第二轮整改）：子进程在自毁前同步写 `crash-point.marker`，验收同时要求新鲜 marker 与击杀形状（win32 上 SIGKILL 自毁与未捕获异常同呈 `exit=1 signal=null`，marker 是唯一判别者；POSIX 上 signal=SIGKILL）；三条死亡形状门证明谓词能红。

**非杀进程窗口（按其实际验证方式如实记录，共 3 个）**：delivery/RPC 行验证的是宿主检查点幂等与异检查点拒绝（同进程状态测试，Phase 2 无真实 Pi RPC）；budget 中断行验证的是超时 HELD 的恢复校准（种子状态 + CHARGED_BOUND 校准）；文件落盘与 DB 激活之间验证的是 GC 孤儿识别与恢复期对象引用扫描。

| 06 §9 窗口 | 恢复行为（实测） | 验证方式 |
| --- | --- | --- |
| 入库前 / 事务中 / 提交后未 ACK | 事务中回滚零残留、提交后重投返回 duplicate；终态恰好一行持久化；ACK 行仅在提交后打印 | SIGKILL ×3 |
| 入库后、通知调度前 | 恢复报告 inbox PENDING；router 从持久行补派单 | SIGKILL + 恢复报告 |
| 模型计划后、派单事务前 | dispatch_key 唯一约束防重建；重算计划复用同一任务 | SIGKILL ×2 |
| delivery 写入后 / RPC 前后 | command_id 检查点幂等重投；异检查点拒绝（不重复附加） | 状态测试（宿主检查点语义） |
| 离线 job 运行中 | 真实 detached 孤儿进程越过被杀 daemon 存活，恢复杀之、job 置 LOST | SIGKILL（父进程）+ 孤儿真杀 |
| Task 完成、Outbox 发送前 | 恢复报告 ready_outbox；dispatcher 从持久对续跑送达 | SIGKILL + 恢复续跑 |
| 审批消费前（事务中） | CAS 回滚干净，审批人手中卡片（nonce）重决成功 | SIGKILL |
| 审批消费后（提交后） | 重复回调返回 already CONSUMED，无二次消费 | SIGKILL |
| **READY→SUBMITTING 后（旗舰）** | 提交后未调用：恢复置 UNKNOWN；**daemon 重启自身**（非测试进程）按 retry_mode 对账——IDEMPOTENCY_KEY 同键重发落 SUCCEEDED、远端恰好一次；`--once` 清零 UNKNOWN 后退 0 | SIGKILL（marker 双证）+ daemon `--once` 重启级验收 |
| 远端已成功、本地未记账 | LOOKUP 强一致补记 external_id，零重发；**daemon 重启级验收同样存在**（daemon 自身完成补记、退 0，测试进程不代跑） | SIGKILL（marker 双证）+ daemon 重启级验收 |
| Timer 触发事务中 / 提交后 | 事务中回滚重跑单事件；提交后 occurrence 唯一约束幂等 | SIGKILL ×2 |
| budget 请求中断 | 保守 HELD 不释放；恢复校准超时置 CHARGED_BOUND（可信账单+actor 才可修正） | 状态测试（超时校准） |
| 文件落盘与 DB 激活之间 | 未引用文件 GC 只搬孤儿；恢复校验对象引用，缺失即只读 | 状态测试（GC + 引用扫描） |

整改补充：AT_MOST_ONCE 的 daemon 重启级验收同样存在——远端确已持有动作时，daemon 保守停在 UNKNOWN、不重发，仅人工对账（actor+证据）可结清。

第二轮缺口整改补充（同日，复审维持 MET WITH RESIDUAL RISKS 后的三缺口）：`daemon --once` 的退出码反映未结清 UNKNOWN——清零退 0（含无上游时对账完成的情形），仍有 UNKNOWN 退 4（有上游时 AT_MOST_ONCE 保守停留与无上游停留都覆盖），验收看退出码与数据库状态；LOOKUP_THEN_RETRY 的 daemon 重启级验收落地（变异红证：禁用对账循环时该验收变红）；崩溃窗谓词收紧为 marker+击杀形状双证并配三条死亡形状门。

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
- **备份**：迁移前快照是真正的**迁移前状态**（`VACUUM INTO` 于 `migrate()` 之前，仅当有迁移待执行时创建；撕裂迁移失败后主库回滚为空、快照可用）；**一致性备份的维护窗口流程、加密 manifest 与恢复演练仍是 Phase 3 的 test:restore 范围**，本阶段只验证了快照可生成且可打开、完整性通过。
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
4. 审计史：Phase 2 独立复审（对象 461c58f）判定 **MET WITH RESIDUAL RISKS**，无 Phase 3 硬阻塞；原稿归档 `docs/phase2/audits/AUDIT-PHASE2-REREVIEW-461c58f968fd96ef9ee3ed752b14f6e879559592.md`（文首含协调更正：origin/main 观察不成立，GitHub main 已核实为被审提交）。第一轮四项整改（迁移前备份顺序、daemon 侧 UNKNOWN 对账、三张跨平台回归网、证据与文档校正）逐项红证先行；复审复核确认四项目标与两条升格条件成立，同时指出三缺口（LOOKUP 重启级验收、`--once` 退出码、崩溃谓词收紧），已于同日补齐（回应第 8 节，提交 `a56414b`/`0c257f1`/`862b7f0`）；最终门禁计数见第 2 节（durability 164/164）。残留项见回应第 6/8 节与复审第 15 节。

## 7. 2026-11-19 审计整改增补

独立复审列出的三项残留缺陷已修，计数相应增长（只增不减）：

| 复审残留 | 整改 | 新门禁 |
| --- | --- | --- |
| pre-migration 快照发生在 migrate() 后 | 快照先于 migrate()，仅待迁移时创建 | `pre-migration-backup-holds-pre-apply-state`、`no-backup-when-no-migration-pending`、`torn-migration-leaves-usable-pre-state-snapshot`、`snapshot-stays-pre-apply-after-successful-migration` |
| daemon 不做 retry_mode 对账 | tick 内按 06 §6 表对账（仅在有上游适配器时） | `daemon-restart-reconciles-idempotency-to-succeeded`、`daemon-restart-stdout-shows-reconcile-action`、`daemon-restart-at-most-once-stays-unknown`、`at-most-once-exits-only-through-recorded-human-reconciliation` |
| epoch typeof / 反斜杠 GC / 45 条计数三网在 Linux 不够红 | 存储类型断言 + 边界拒绝 + GC 归一化 + DB 实点夹具 | `scope-epoch-stored-integer-with-numeric-semantics`、`misbound-insert-shape-is-exactly-what-the-gate-catches`、`writer-refuses-backslash-storage-ref`、`gc-keeps-file-referenced-by-legacy-backslash-row`、`fixture-really-holds-45-unauthorized-and-12-legal` |
| 第二轮缺口：LOOKUP_THEN_RETRY 无重启级验收 | daemon 自身完成强一致命中补记（测试进程不代跑；变异红证：禁用对账循环时该验收变红） | `daemon-restart-lookup-then-retry-records-hit-no-resend`、`daemon-restart-lookup-reconcile-in-daemon-log` |
| 第二轮缺口：`--once` 对未结清 UNKNOWN 固定退 0 | 收尾点数 UNKNOWN：清零退 0、未清退 4；验收看退出码与数据库状态 | `daemon-restart-idempotency-clears-unknown-exit-zero`、`daemon-once-no-upstream-unknown-exit-reflects-state`；`daemon-restart-at-most-once-stays-unknown` 原位强化为退 4 断言 |
| 第二轮缺口：崩溃窗谓词偏宽（任何非零退出都算杀） | `crashpoint()` 自毁前同步写 marker，谓词 = 新鲜 marker + 击杀形状，15 处全扫 | `crash-predicate-accepts-armed-crashpoint-kill`、`crash-predicate-rejects-uncaught-exception-death`、`crash-predicate-rejects-clean-exit` |

证据同步：崩溃矩阵按杀进程/状态测试逐项区分（见第 2.1 节）；`package-lock.json` 根 engines 与仓库锁定同步为 `22.23.5`；`defaults.json` 顶部注释更新为当前事实（预算账本已在本树实现、最小推理契约已实测）；`AUDIT-HANDOFF.md` 第 0/7 节的「Phase 2 未开工」过时表述改为当前阶段状态（审计原稿未动）；decision-trail 对 D-22/D-26/D-28 的失实描述按勘误体例追加更正。

第二轮（复审复核后指出的三缺口）整改提交：`a56414b` / `0c257f1` / `862b7f0`，逐项红证先行，durability 计数 157→164。详见回应报告第 8 节。
