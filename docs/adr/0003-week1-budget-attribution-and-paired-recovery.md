# ADR-0003: 第 1 周预算任务归属、双库配对回退识别与治理库 DDL 调整

## 状态

Accepted（2026-11-25，香港时间；已按第 1 轮审计意见修订并由锁定版 Pi 1.6.0 与 Windows Node 22.23.5 夹具实测验证）。

## 日期

2026-11-25，香港时间（修订：2026-11-25 审计整改）。

## 背景

`D:\AegisPi\aegis-pi-v2-planning\taskbook-1-review.md` 末尾明确提出两项需由实施期实测落定的选择：
1. 在 `Models.streamSimple` / `Models.completeSimple` 签名不含独立 `taskId` 参数的前提下，如何把同会话并行运行的压缩（`pi.compaction`）与生成（`pi.generation`）可靠归属到各自预算任务（仅靠 `conversationId` 判失败），并确保跨委派与跨重启不丢失归属、不另开默认额度。
2. 当 `pi-durable.sqlite` 在保持同一文件名和同一 `runtime_epoch` 的情况下被还原为较旧快照（包括保留相同会话与任务 ID、跨页历史超过 200 条）时，如何在首次调度前识别错配并在换代后使全链路实时切至新代际。

同时，实施期需要对任务书 1 附录的评审草案 DDL 做少量补充以承载上述机制与宿主运行态需求，凡影响权限、账务、恢复或签收口径的差异须单列说明。

## 决定

### 1. 预算任务归属与硬上界约束（S4 / R1 / T6）

- 源码核查与实测确认：`@earendil-works/pi-durable@1.6.0` 的 `TaskScheduler.#phase`（`dist/harness/scheduler.js`）为每次任务阶段调用在宿主传入的 `HarnessOptions.telemetry` 上开启 `pi.durable.phase` span，携带宿主可信的 `task.id`、`task.name`（`pi.generation` / `pi.compaction` / `pi.tool`）、`phase` 与 `attempt`，并经 `invocation.context.telemetry` 原样传入 `GenerationTask.request`（`models.streamSimple`）与 `CompactionTask.summarize`（`models.completeSimple`）。
- 宿主在 `src/runtime/telemetry.ts` 实现 `HostPhaseTelemetry`，使用进程内私有 `WeakMap<TelemetrySpan, PhaseAttribution>` 记录每个 span 对象到 `(taskId, taskName, phase, attempt)` 的不可伪造映射。
- 宿主在治理库新增 `budget_task_bindings` 表，持久化每个活跃代际下 `PI_TASK` 与 `CONVERSATION` 到权威宿主预算任务 `(owner_task_id, purpose)` 的绑定，重启后自动回载。
- `run_worker` 工具参数移除模型可控的 `budgetTaskId`，仅接受 `prompt`；宿主委派入口固定继承父任务/父会话的已持久化宿主 `owner_task_id`（记为 `purpose = "worker"`）。
- 普通 Web 路由（`POST /api/conversations`、`POST /api/conversations/:id/chat`、`POST /api/conversations/:id/compact`）不接受请求体中的 `budgetTaskId`，由宿主在建会话时签发并持久化 `host-task:<runtimeEpoch>:conv:<id>`，聊天与压缩始终复用该宿主绑定；仅宿主内部受信任接口保留显式多任务绑定参数以支撑 S4 并发分账夹具。
- `src/runtime/models.ts` 在物理发送前按 `PI_TASK -> CONVERSATION` 解析持久归属；缺失可信 span 或无法查到宿主绑定时直接失败关闭（`unknown_budget_owner`，新增物理请求为 0，绝不临时合成默认额度账户）。同时向 `pi-ai` OpenAI Completions 传输注入阶段一受限 `fetch`（强制每跳回环校验 + `redirect: "manual"` + 拒绝任何 `3xx` 跳转），防止首跳回环后经 HTTP 重定向跳出本地替身边界（G2）。
- 阶段一 `estimateUpperBoundMu` 仅接受经验证的整数每请求上界（`syntheticFixedUpperMu`）；任何依赖字符长度估算等无法证明硬上界的非固定价表路径一律失败关闭（`unknown_upper_bound`，新增物理请求为 0）。

### 2. 同代际轨迹回退识别与换代联动（S5 / F03 / R3）

- 宿主不向 `pi-durable.sqlite` 做任何裸 SQL 写入，仅在初始化或换代时通过 Pi SDK `root.commit` 写入一条 `kind: "aegis.lineage_anchor"` 记录（携带 `runtimeEpoch` 与 `traceIdentity`）。
- 治理库新增单行表 `paired_manifest`，单调记录当前代际的 `trace_identity`、`anchor_conversation_id`、`last_trace_watermark`（使用游标全分页扫描 `conv.entries()` 跨 200 条分页上限统计的条目总数与任务数下界）、`last_change_counter`（只读文件描述符读取 SQLite 文件头 24–27 字节的 file change counter）及 `known_pi_task_ids_json`。
- 启动第 4 步（`Harness.open` 返回后、仍处于 `scheduling === "paused"` 且未调用 `resume/signal/wait` 之前），宿主全分页只读检查：
  1. 锚点记录缺失或 `traceIdentity` 不符 -> 识别为轨迹库替换（`trace_replaced_or_anchor_mismatch`）；
  2. 已登记的 `conversation_scopes` 或 `known_pi_task_ids` 缺失、全分页条目水位低于 `last_trace_watermark`、或 SQLite change counter 倒退 -> 识别为同代际轨迹回退（`trace_rollback_*`）。
- 任一不匹配均阻断调度释放，宿主进入 `NEEDS_ATTENTION` 并拒绝接单，直至显式执行 `rotateEpochAfterMismatch`：隔离旧代际全部未领 `READY` 效果与 `PENDING` outbox、保全旧代际 `HELD` 预留记录、退役旧代际并签发新 `runtime_epoch`。
- 宿主通过共享可变代际引用（`epochBox`）向 `Models` 出口、`aegis-policy` 扩展与委派入口提供 `getRuntimeEpoch()`，换代后无需重启即刻对首个新审批与首笔新预留生效；同时旧代际审批与草稿编辑在治理层校验 `runtime_epochs.status = 'ACTIVE'`，拒绝执行。

### 3. 审批挑战传播与重复唤醒核验（G3 / R4）

- `approval_challenges` 仅在 `PENDING` 期间存放明文 nonce，离开 `PENDING` 即删除；`approvals` 表仅存 `nonce_digest`。
- 通用快照（`GET /api/conversations/:id/snapshot`）与 SSE 推送（`GET /api/conversations/:id/events`）均不输出明文 `nonce`，仅返回 `hasChallenge: boolean`；经认证且拥有目标作用域权限的审批人仅可通过专用决定入口 `POST /api/approvals/:id/challenge`（带 `Origin` 校验与 `Cache-Control: no-store`）按需获取挑战，确保明文 nonce 不进入 SSE、URL、快照或审计日志。
- `deliverPendingOutbox` 收到 SDK `duplicate` 时，必须回读 Pi 任务持久化 `memos` 核对已存信号值与规范化载荷是否一致：同键同值才 `ACKED`，值冲突或无法证明一致一律收口为 `ISOLATED` 并隔离未领 `READY` 效果（人工待核对）。

### 4. 相对任务书 1 附录 DDL 的增量调整（全部向后兼容且收紧安全语义）

| 表 / 字段 | 相对附录草案的变化 | 影响口径 |
|---|---|---|
| `paired_manifest`（新增表） | 单行表记录 `trace_identity`、全分页单调水位、只读 change counter 与已知 Pi 任务 ID | 恢复：支持含跨页历史的同代际回退检测（F03 / S5 / R3） |
| `conversation_scopes`（新增表） | 以复合主键 `(runtime_epoch, conversation_id)` 绑定 `(scope_id, principal_id)`；开库时对旧版单列主键 `(conversation_id)` 自动执行幂等原位迁移并保全历史行；快照、聊天、压缩与轨迹读取均按代际隔离，已退役代际仅返回历史治理审计且不读当前活跃轨迹库 | 权限/恢复：防止新旧治理库换代后复用数字会话 ID 沿用旧 ACL 或跨主体泄露新轨迹（G1 / R3 / E09） |
| `budget_task_bindings`（新增表） | 持久化 `(runtime_epoch, binding_kind, binding_key) -> (conversation_id, owner_task_id, purpose)` | 账务：确保委派与重启后归属不丢失、不另开默认账户（R1 / S4） |
| `approval_challenges`（新增表） | 宿主私有表，仅在 `PENDING` 期间保存明文 nonce 供已鉴权审批人经专用 `/api/approvals/:id/challenge` 读取，离开 `PENDING` 即删除 | 审批安全：明文 nonce 零暴露于 SSE / 快照 / URL / 日志（G3） |
| `scopes` 新增列 | 增加 `allowed_principals_json`、`allowed_tools_json`、`allowed_targets_json` | 权限：T1 / T2 / T4 / 核对 / 撤销实时 ACL 复核（G1 / E08 / E09 / E10） |
| `proposals` 新增列 | 增加 `tool_name`、`target`、`created_at` | 审批/提交：T4 复核工具与目标绑定，支持视图①按时间排序 |
| `effects` 新增列 | 增加 `reconciled_by`、`reconciled_at`、`reconcile_evidence` | 恢复/审计：记录 `UNKNOWN` 人工核对操作者、时间与依据 |
| `budget_accounts` 新增列 | 增加 `frozen INTEGER NOT NULL DEFAULT 0` | 账务：对齐 v1 超额结清自动冻结账户约束 |
| `signal_outbox` 新增列 | 增加 `attempts`、`updated_at` | 投递/恢复：记录投递重试次数与更新时间 |
| `audit_events` 新增列 | 增加 `details_json`；开库时对缺失 `runtimeEpoch` 的旧版 `budget_denial` 仅在会话授权、代际时间窗与任务绑定三方唯一可证时幂等补齐，无法证明归属的旧事件保留于内部审计并严格排除出按代际授权的快照与 SSE | 审计/视图①：持久化拒绝原因供原会话展示，同时杜绝旧无代际记录跨代际混入新主体视图（W1-A / B01 / R3） |

## 证据链接

- `tests/week1/run-sdk-contracts.ts`（S1–S5 实测，含产品账本并发分账 S4）
- `tests/week1/audit-regressions.ts`（G1-AUTH、G2-EGRESS、G3-NONCE-SSE、R1-ATTRIBUTION、R3-EPOCH-ACL、R3-LEGACY-UPGRADE 实测）
- `tests/week1/run-matrix.ts`（F01–F03、B02–B07、E01–E05、E07–E10 实测）
- `docs/v2/week1-audit/`（全量脱敏 JSON 证据包与审计报告）
