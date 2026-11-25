# ADR-0003: 第 1 周预算任务归属、双库配对回退识别与治理库 DDL 调整

## 状态

Accepted（2026-11-25，香港时间；已由锁定版 Pi 1.6.0 与 Windows Node 22.23.5 夹具实测验证）。

## 日期

2026-11-25，香港时间。

## 背景

`D:\AegisPi\aegis-pi-v2-planning\taskbook-1-review.md` 末尾明确提出两项需由实施期实测落定的选择：
1. 在 `Models.streamSimple` / `Models.completeSimple` 签名不含独立 `taskId` 参数的前提下，如何把同会话并行运行的压缩（`pi.compaction`）与生成（`pi.generation`）可靠归属到各自预算任务（仅靠 `conversationId` 判失败）。
2. 当 `pi-durable.sqlite` 在保持同一文件名和同一 `runtime_epoch` 的情况下被还原为较旧快照时，如何在首次调度前识别错配。

同时，实施期需要对任务书 1 附录的评审草案 DDL 做少量补充以承载上述机制与宿主运行态需求，凡影响权限、账务、恢复或签收口径的差异须单列说明。

## 决定

### 1. 预算任务归属机制（S4）

- 源码核查与实测确认：`@earendil-works/pi-durable@1.6.0` 的 `TaskScheduler.#phase`（`dist/harness/scheduler.js`）为每次任务阶段调用在宿主传入的 `HarnessOptions.telemetry` 上开启 `pi.durable.phase` span，携带宿主可信的 `task.id`、`task.name`（`pi.generation` / `pi.compaction` / `pi.tool`）、`phase` 与 `attempt`，并经 `invocation.context.telemetry` 原样传入 `GenerationTask.request`（`models.streamSimple`）与 `CompactionTask.summarize`（`models.completeSimple`）。
- 宿主在 `src/runtime/telemetry.ts` 实现 `HostPhaseTelemetry`，使用进程内私有 `WeakMap<TelemetrySpan, PhaseAttribution>` 记录每个 span 对象到 `(taskId, taskName, phase, attempt)` 的不可伪造映射。
- 宿主在 `src/runtime/harness.ts` 经公开接口 `harness.observeTaskGraph` 同步跟踪全部活跃任务的 `(taskId -> conversationId, owner)`，并支持按 `piTaskId` 显式绑定预算任务（`bindPiTaskBudgetOwner`）。
- `src/runtime/models.ts` 在所有物理发送前从 `options.telemetry` 查表解析归属；缺失可信 span 或无法解析预算归属任务时直接失败关闭（`unknown_budget_owner`，新增物理请求为 0）。

### 2. 同代际轨迹回退与替换识别（S5 / F03）

- 宿主不向 `pi-durable.sqlite` 做任何裸 SQL 写入，仅在初始化新代际时通过 Pi SDK `root.commit` 写入一条 `kind: "aegis.lineage_anchor"` 记录（携带 `runtimeEpoch` 与 `traceIdentity`）。
- 治理库新增单行表 `paired_manifest`，单调记录当前代际的 `trace_identity`、`anchor_conversation_id`、`last_trace_watermark`（已观测到的会话条目数与任务数总和下界）、`last_change_counter`（以只读文件描述符读取 SQLite 文件头 24–27 字节的 file change counter）及 `known_pi_task_ids_json`。
- 启动第 4 步（`Harness.open` 返回后、仍处于 `scheduling === "paused"` 且未调用 `resume/signal/wait` 之前），宿主只读检查：
  1. 锚点记录缺失或 `traceIdentity` 不符 -> 识别为轨迹库替换（`trace_replaced_or_anchor_mismatch`）；
  2. 已登记的 `conversation_scopes` 或 `known_pi_task_ids` 在 Pi 中缺失、已观测水位低于 `last_trace_watermark`、或 SQLite change counter 倒退 -> 识别为同代际轨迹回退（`trace_rollback_*`）。
- 任一不匹配均阻断调度释放，宿主进入 `NEEDS_ATTENTION` 并拒绝接单，直至显式执行 `rotateEpochAfterMismatch`：隔离旧代际全部未领 `READY` 效果与 `PENDING` outbox、保全旧代际 `HELD` 预留记录、退役旧代际并签发新 `runtime_epoch`。

### 3. 相对任务书 1 附录 DDL 的增量调整（全部向后兼容且收紧安全语义）

| 表 / 字段 | 相对附录草案的变化 | 影响口径 |
|---|---|---|
| `paired_manifest`（新增表） | 单行表记录 `trace_identity`、单调水位、只读 change counter 与已知 Pi 任务 ID | 恢复：支持同代际回退检测（F03 / S5） |
| `conversation_scopes`（新增表） | 绑定 `(conversation_id, scope_id, principal_id, runtime_epoch)` | 权限：强制会话归属校验，阻断跨会话/越权决定（E09 / 403） |
| `approval_challenges`（新增表） | 宿主私有表，仅在审批 `PENDING` 期间保存明文 nonce 供已鉴权指定审批人在权威快照读取，离开 `PENDING` 即删除；`approvals` 表仍只存 `nonce_digest` | 权限/审批：对齐 v1 `approvals.mjs` 纪律，明文 nonce 不进 URL/SSE/日志 |
| `scopes` 新增列 | 增加 `allowed_principals_json`、`allowed_tools_json`、`allowed_targets_json` | 权限：T1/T2/T4 实时 ACL 复核（E08 / E09 / E10） |
| `proposals` 新增列 | 增加 `tool_name`、`target`、`created_at` | 审批/提交：T4 复核工具与目标绑定，支持视图①按时间排序 |
| `effects` 新增列 | 增加 `reconciled_by`、`reconciled_at`、`reconcile_evidence` | 恢复/审计：记录 `UNKNOWN` 人工核对操作者、时间与依据 |
| `budget_accounts` 新增列 | 增加 `frozen INTEGER NOT NULL DEFAULT 0` | 账务：对齐 v1 超额结清自动冻结账户约束 |
| `signal_outbox` 新增列 | 增加 `attempts`、`updated_at` | 投递/恢复：记录投递重试次数与更新时间 |
| `audit_events` 新增列 | 增加 `details_json` | 审计/视图①：持久化拒绝原因供原会话展示（W1-A / B01） |

## 后果

1. 任何未经宿主 `HostPhaseTelemetry` 开启 `pi.durable.phase` 的模型调用均会被 `src/runtime/models.ts` 拒绝（含未来自定义扩展直接调 `models.streamSimple` 时若未继承宿主上下文，将安全失败关闭）。
2. `paired_manifest` 依赖宿主在提交会话/任务及优雅停机时单调推进水位；若宿主在极短窗口内崩溃早于水位推进，只会导致水位保守偏小（不会误报正常崩溃），而任何回退到更早已知已观测快照的操作均可被识别。

## 证据链接

- `tests/week1/run-sdk-contracts.ts`（S1–S5 实测）
- `docs/v2/week1-audit/s1-s5-evidence.json`
- `docs/v2/week1-audit/matrix-evidence.json`（F03、B01–B07、E01–E10 实测）
