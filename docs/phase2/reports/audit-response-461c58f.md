# Phase 2 审计整改回应（461c58f，2026-11-19）

对象：独立复审 `docs/phase2/audits/AUDIT-PHASE2-REREVIEW-461c58f968fd96ef9ee3ed752b14f6e879559592.md`（判定 MET WITH RESIDUAL RISKS，无 Phase 3 硬阻塞）。本文逐项列出复审意见、处理决定、代码位置、红绿证据与剩余风险。owner 指示的四项整改目标全部落地，每项红证先行；不预设实现、不擅改规范、未涉及安全边界/数据模型/阶段依赖的结构性变更，故无新 ADR。

## 0. 整改提交与命令

| 单元 | 提交 | 内容 |
| --- | --- | --- |
| A 归档 | `77e46a2` | 复审原稿字节一致入库（SHA-256 `6104803F…BF38BEBC`），文首协调更正保留 |
| B 备份顺序 | `30b8b3c` | 迁移前备份真正先于 `migrate()` |
| C UNKNOWN 对账 | `b304b35` | 按 retry_mode 的对账接入 daemon 运行路径 |
| D 回归网 | `3a44c67` | 三张跨平台可红的门禁 |
| E 证据与文档 | 本提交 | 崩溃矩阵逐窗区分、closure/trail/lockfile/注释校正 + 本回应 |

命令与计数（锁定 Node `D:\AegisPi\tools\node-v22.23.5\node.exe`，2026-11-19 整改后全量；计数较收口时点只增不减：durability 145→157、acl 14→15、budget 20 不变但其内不删任何判据）：

```
node evals/phase2/durability/run.mjs  → 157/157 PASS, EXIT=0   （转录 evidence/remediation-durability-console.txt）
node evals/phase2/budget/run.mjs      → 20/20  PASS, EXIT=0   （evidence/remediation-budget-console.txt）
node evals/phase2/acl/run.mjs         → 15/15  PASS, EXIT=0   （evidence/remediation-acl-console.txt）
node evals/contracts/run-contracts.mjs           → 15/15 PASS, EXIT=0（Phase 1 回归）
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0（含未安装快照 exit 2 两行）
```

## 1. 复审残留 1：pre-migration 备份发生在 migrate() 之后（§5/§13/§14）

**意见**。`daemon.mjs` 的 `VACUUM INTO` 在 `migrate()` 之后执行，快照已含 `schema_migrations`，不能作为迁移失败的回滚点；收口报告的「迁移前自动快照」与代码不符。

**处理决定**。新建 `apps/daemon/src/db/backup.mjs`：`migrationPending(db)`（无 `schema_migrations` 表即待应用）与 `preMigrationBackup(db, {backupsDir, now})`（`VACUUM INTO`，前向斜杠，写后自开只读连接跑完整性校验，失败即抛——坏备份比没有备份更危险）。`daemon.mjs` 改为：完整性检查后、`migrate()` 之前，仅当 `migrationPending` 为真时快照；schema 已当前的库重启不再新增快照（无应用即无需回滚点）。

**红绿证据**。
- 红：独立脚本（整改时点执行，退出码 1）——当前树 `--check` 全新目录后快照内 `schema_migrations` 表存在（post-apply 状态）。
- 绿：四条新门禁入 `evals/phase2/durability/run.mjs`（`pre-migration` case）：
  1. `pre-migration-backup-holds-pre-apply-state`：快照零用户表、零 `schema_migrations`、完整性 ok；
  2. `no-backup-when-no-migration-pending`：已当前库重启，备份计数不变；
  3. `torn-migration-leaves-usable-pre-state-snapshot`：撕裂 DDL 使 `migrate()` 抛出，主库回滚为空（0 表），快照可打开、完整性 ok、0 用户表；
  4. `snapshot-stays-pre-apply-after-successful-migration`：成功迁移后快照仍为前态（0 表、零 migrations 行）而主库 27 用户表。

## 2. 复审残留 1 之二：daemon 进程本身不做 retry_mode 对账（§5/§14/§15）

**意见**。`startupRecovery` 只标 UNKNOWN；同键重发与 LOOKUP 补记由测试进程续调 `autoRecoverUnknown` + `dispatchEffect` 完成；重启 daemon 不会把旗舰窗送进 SUCCEEDED。

**处理决定**。`daemon.mjs` 的 tick 在派发 READY 之前先跑 UNKNOWN 对账（仅当接了上游适配器，即 `--fake-upstream` 或未来的真实适配器）：逐行调用 `autoRecoverUnknown`，其策略即 06 §6 表——IDEMPOTENCY_KEY 重排同键重发、LOOKUP_THEN_RETRY 强一致命中补记/明确未发生才重排、AT_LEAST_ONCE 有界重排、**AT_MOST_ONCE 与弱一致未找到一律不动**。无上游适配器时 daemon 如实打印「UNKNOWN 保持 UNKNOWN，留给人工或后续阶段」，不盲动。

**红绿证据**。
- 红：独立脚本（整改时点执行，退出码 1）——旗舰窗（`effects:after-cas-before-call`，IDEMPOTENCY_KEY）后真实 `daemon --once --fake-upstream` 重启，effect 停在 `UNKNOWN`、远端 0 次。
- 绿：两条 **daemon 重启级**验收（`daemon restart reconciliation` case，全程由 daemon 进程自己完成，测试进程不代跑恢复函数）：
  1. `daemon-restart-reconciles-idempotency-to-succeeded` + `daemon-restart-stdout-shows-reconcile-action`：崩溃子进程（退出码非 0）→ daemon `--once` 退出 0 → effect SUCCEEDED、远端恰好 1 次、daemon 自身日志含 `reconcile: … -> requeued`；
  2. `daemon-restart-at-most-once-stays-unknown` + `at-most-once-exits-only-through-recorded-human-reconciliation`：`apply_then_die` 窗口后远端确已持有动作，daemon 重启仍停 UNKNOWN（远端 1 次、无第二次应用）；缺 actor 的人工对账被拒，带 actor+证据才落 SUCCEEDED。

UNKNOWN 的保守语义未被「追求自动成功」破坏：策略函数 `autoRecoverUnknown` 未加任何默认重发分支（无策略的 retry_mode 仍抛 `UnknownNotReconcilable`）。

## 3. 复审残留 3：三处回归网在 Linux 上不够红（§4.2/§4.3/§8）

**意见**。epoch 无 `typeof` 断言（D-22 的描述与实现不符）；Windows 反斜杠 `storage_ref` 的 GC 误删在 Linux 不红；「45 条」断言不点数夹具。

**处理决定与证据**（新 case `typed-column regression` 于 durability，`fixture-really-holds…` 于 acl）：

| 门禁 | 红-able 方式 | 绿证据 |
| --- | --- | --- |
| `scope-epoch-stored-integer-with-numeric-semantics` | 生产写路径若回到 8 占位符错位绑定，`typeof(epoch)` 变 `text`（任何平台红） | `epoch=1/integer`、`policy_version=pv1/text`、`epoch+0=1/integer` |
| `misbound-insert-shape-is-exactly-what-the-gate-catches` | 自证探针：旧错位 INSERT 实测落 `typeof=text value='pv1'`，即上一条所捕获的形状 | 探针行 `t=text v=pv1` |
| `writer-refuses-backslash-storage-ref` | 写入器若再接受反斜杠 ref 即红（新增边界：`insertObjectRow` 拒绝含 `\` 的 storageRef，前向斜杠契约） | 拒绝并抛「must use forward slashes」 |
| `gc-keeps-file-referenced-by-legacy-backslash-row` | 旧 GC 比较对反斜杠 ref 必然误判孤儿（任何平台红）；新实现把引用集同时计入原始 ref 与其反斜杠归一双胞胎 | raw-SQL 遗留行指向活文件：dry-run `trashed=0`，真实清扫后文件仍在、`trashed=0` |
| `fixture-really-holds-45-unauthorized-and-12-legal` | 缩小夹具循环即红（DB 实点，非数组长度空谈） | 外域 25、未授予闭包 20、合法 12/12 全部在库中数出 |

## 4. 复审 §13：证据与文档校正

- **崩溃矩阵**：`docs/phase2/reports/phase2-closure.md` §2.1 重写——标题不再统称「全部真实 SIGKILL」，正文分「杀进程窗口（12 个场景）」与「非杀进程窗口（3 个，按其实际验证方式记录：delivery 检查点状态测试、budget 超时校准、GC/引用扫描）」，表格加「验证方式」列；旗舰行改为 daemon 重启级事实并注明 AT_MOST_ONCE 的保守验收。
- **decision-trail**：D-22 追加勘误（typeof 断言当时未落地，且「dispatcher 纪元测试」非充分回归网）；D-26 追加勘误（备份时序）；D-28 追加勘误（「12/12 全部真实 SIGKILL」过宽、旗舰为套件拼接）；新增 D-29 记录四项整改。
- **AUDIT-HANDOFF**：第 0、5、7 节的「Phase 2 未开工」「加载器无产品入口」「HELD 未实现」过时表述改为当前事实（Phase 2 已实施并过复审、D-11 已闭合、账本已实现），并指向 phase2 目录；第 3 节第三轮审计的历史叙述保留原样。
- **`package-lock.json`**：根块 engines 由 `>=22.19.0 <23.0.0` 改为 `22.23.5`（与 `package.json` 一致；依赖自身的 engines 不动）。真正拒绝错误 Node 的仍是运行器退出码 2 门。
- **`defaults.json`** 顶部 `$comment`：由「Phase 1 只落配置值，运行时预算门禁在 Phase 2/3 实现」改为当前事实（账本已实现并给出门禁计数；最小推理契约已实测 evidence/07；D-11 警示保留）。

## 5. 未升级为阻塞、未处理项（如实）

- 复审 §4.5 指出崩溃窗谓词用 `code !== 0` 偏宽（信号死亡与未捕获异常都满足）。本轮未收紧谓词：其实测值均为 `exit=null`（SIGKILL 自毁），失败方向已被窗口状态断言锁住；收紧为「必须 signal」属可选强化，未列入 owner 四项目标。
- 复审 §2 关于 `origin/main` 的观察按文首更正处理（GitHub main 已核实为被审提交），仓库侧无动作。
- 短中文 LIKE 回退的排序验收、`loader-is-what-makes-off-survive` 不直接调 SettingsManager（PI-13 承担实测）：维持复审时的判定，不改动。

## 6. 剩余风险（整改后仍在，移交 Phase 3）

1. 未知 usage 的诚实状态仍是 HELD→CHARGED_BOUND；真实 provider 账单修正流未接。
2. 真实 ingress 验签、真实上游适配器、真实审批回调未接（本树只有 fake/录制）。
3. 备份演练的维护窗口流程、加密 manifest、删除清单与 test:restore 属 Phase 3；本轮只保证迁移前快照的真实性与可用性。
4. lockfile+PID 锁的 PID 复用窗口（D-18）未消除。
5. 心跳/租约/容器配额仍是占位值，未按真实负载校准；磁盘水位告警未做。
6. UNKNOWN 无上游适配器时停留等待人工——这是保守语义，不是缺陷。

## 7. Phase 2 门禁判断（整改后）

- 六条停止条件（静默丢事件、越权召回、预算旁路、UNKNOWN 盲重试、无鉴权控制台、真实外部写）在整改后树上均未触发，且有专门红门。
- 复审两项升格条件（daemon 重启自身完成旗舰重发、06 §9 迁移前备份逐字落地）已由整改 B、C 满足。
- 结论：**Phase 2 出口维持 MET WITH RESIDUAL RISKS 且残留清单已收窄**；等待独立复审复核本整改回应，不自行进入 Phase 3。

## 8. 第二轮追加整改（同日，复审复核后的三缺口）

复审复核结论：Phase 2 出口 MET WITH RESIDUAL RISKS 维持，第一轮四项目标与两条升格条件（daemon 重启自身完成旗舰重发、06 §9 迁移前备份逐字落地）确认成立，另指出三缺口。三缺口已全部补齐，逐项红证先行，提交各自成单元：

| 缺口 | 提交 | 处理决定与红绿证据 |
| --- | --- | --- |
| 1. LOOKUP_THEN_RETRY 缺旗舰同级验收 | `a56414b` | 直跑即绿（整改 C 的对账循环为四模式共享路径），故红证取变异式：临时禁用 daemon tick 的 reconcile 循环，同一场景 effect 停 UNKNOWN（脚本退 1），恢复后绿。新增 `daemon-restart-lookup-then-retry-records-hit-no-resend`（崩溃后真实 `daemon --once` 重启自身完成强一致命中补记，SUCCEEDED、external_id 取自 lookup、远端恰好一次零重发，测试进程不代跑）与 `daemon-restart-lookup-reconcile-in-daemon-log`（daemon 自身日志含 `-> recorded_success`） |
| 2. `--once` 对未结清 UNKNOWN 固定退 0 | `0c257f1` | 红证：AT_MOST_ONCE 崩溃后 `daemon --once` 退 0（脚本退 1）。修：收尾点数 `effects WHERE state='UNKNOWN'`，清零退 0、未清退 4（0/1/2/3 已被 ok/锁/完整性/`--check` 占用）并打 stderr 行。验收改退出码+数据库状态：`daemon-restart-at-most-once-stays-unknown` 原位强化为 `exit=4` 断言；新增 `daemon-restart-idempotency-clears-unknown-exit-zero`（清零后退 0）与 `daemon-once-no-upstream-unknown-exit-reflects-state`（无上游同样退 4、UNKNOWN 保留、日志如实） |
| 3. 崩溃窗谓词 `code !== 0` 偏宽 | `862b7f0` | 红证为本平台实测：武装 crashpoint 自毁与未捕获异常死同为 `exit=1 signal=null`，宽松谓词无法分辨（脚本退 1）。修：`crashpoint()` 自毁前同步写 `AEGISPI_CRASH_MARKER`（writeFileSync 先于 SIGKILL，任何平台先落盘）；套件 `armCrash` 每次先清 marker（所读 marker 只可能来自本子进程），谓词 `wasCrashpointKill` = 新鲜 marker（内容=点名）+ 击杀形状（POSIX `signal=SIGKILL`；win32 `exit=1 signal=null`，marker 是与异常死的唯一判别）。15 处崩溃子谓词全扫，PASS 详情列 exit/signal/marker；新增三条死亡形状门：`crash-predicate-accepts-armed-crashpoint-kill`（阳性对照并记录平台击杀形状）、`crash-predicate-rejects-uncaught-exception-death`（同形状无 marker、拒收）、`crash-predicate-rejects-clean-exit`。父进程 `killHard` 的孤儿 case 保持孤儿实况断言不变 |

**对本文第 5 节的勘误**：第一轮回应曾写「崩溃窗谓词实测值均为 `exit=null`，未收紧」。本轮实测证明该测量不实：win32 上 SIGKILL 自毁呈现为 `exit=1 signal=null`，与未捕获异常死完全同形——这正是谓词必须收紧、且 marker 成为唯一判别者的原因。该行所述「未列入 owner 四项目标」在当时属实，本轮已按 owner 指示完成收紧。

**第二轮后全量计数**（锁定 Node 22.23.5，2026-11-19；转录 `docs/phase2/evidence/remediation2-*.txt`；计数较第一轮只增不减）：

```
node evals/phase2/durability/run.mjs  → 164/164 PASS, EXIT=0（第一轮整改后 157）
node evals/phase2/budget/run.mjs      → 20/20  PASS, EXIT=0
node evals/phase2/acl/run.mjs         → 15/15  PASS, EXIT=0
node evals/contracts/run-contracts.mjs           → 15/15 PASS, EXIT=0
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0
```

**剩余风险更新**：第 6 节六项不变，仍全部为 Phase 3+ 既定边界（真实账单修正流、真实 ingress/上游/审批回调、备份演练 test:restore、PID 复用窗口 D-18、配额校准与磁盘告警、无上游时 UNKNOWN 等人工）。第 5 节中崩溃谓词一项已由本节缺口 3 关闭；短中文 LIKE 排序验收与 PI-13 两项维持复审时判定。UNKNOWN 保守语义在本轮未被破坏：`autoRecoverUnknown` 无新增分支，AT_MOST_ONCE 与弱一致未找到仍停 UNKNOWN，`--once` 的退出码只如实报告，不改变任何状态。

