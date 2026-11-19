# Phase 3 收口报告：安全边界与首次常开门槛（2026-11-19）

实施会话（OpenCode / GLM）按 `D:\AegisPi\PHASE3-KICKOFF-HANDOFF.md` 授权开工，按其第 5 节拆步逐格交付。本文按 PRE-READ「阶段交接包」列已做与未做，不写笼统「全绿」。状态/字段/事务/恢复的唯一规范仍是本机设计包 06 + schema.sql（SHA-256 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`，本会话两度复核一致）。**本报告不宣布常开，不构成 Phase 4 的开工授权。**

## 1. 版本

| 项 | 值 | 证据 |
| --- | --- | --- |
| 开工基线 | `6f9c93f`（与 origin/main 一致） | 开工前五条出口验收实测全绿（见 §5 回归） |
| 收口源码 | 本报告所在提交（Phase 3 工作全量） | git log；分组提交见 §6 |
| Node | 22.23.5（显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`；开工核查 2026-11-11 安全公告后 22.x 无更新补丁，锁不变） | 全部套件锁定 Node 守卫（非锁定 exit 2） |
| Pi / hono / SQLite | Pi exact 1.5.2（未动）；hono 4.13.19（pair 自检 sha e5d0c57e… 复核一致）；node:sqlite 3.54.1 | 配对自检输出 |
| 规范 schema | `ede73eca…a2995`，迁移器指针+哈希门未动 | 同 Phase 2 |
| **应用镜像（首次真实构建）** | agent `sha256:5355348ad93e1e9be4380531ab78265fac8a77fed89a2dc6181de98062bc1bf5`；acquisition `sha256:e045e9670a804e9f3ab97b48e69e9c09047b1c05f0877bdaf72b39588f756c97`；execution `sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8` | `docs/phase3/reports/image-digest.md` 机器块；image-gate 值位占位即拒（exit 2）；构建/冒烟命令与输出同文件。基础镜像 digest 与 Phase 1 一致（`e9f565d3…`） |
| 政策/默认值 | `apps/daemon/config/defaults.json`：预算 800000/25 步/15 分钟/日 5000000 microUSD、保温 off 不变；新增 `policy.allowRealExternalWrites=false`（真实外部写失败关闭）、adapters 部署白名单、disk 水位（warn 20GiB/critical 10GiB）、backup 维护窗口（04-05 HKT、保留 14 天） | config.mjs 唯一加载器（D-11 义务未破坏） |
| 校准后配额 | 占位值保留（06 §4），实测依据见 `docs/phase3/reports/quota-calibration.md`：CPU 双线程比值 2.11、内存 2 GiB 脏页 3 GiB 被 OOM、pids 风暴 249/256、tmpfs 512 MiB 同机制 ENOSPC（4 GiB 全量写推迟 Phase 4，避免开发机 VM 内存压力，已如实记入依据） | quota-calibration-report.json measurements 字段 |
| 凭据 | 密钥值只在本机 `.env`（gitignore 已验证）；库内仅槽位引用（credential_slots 表：slot/purpose/env 名/注册/轮换/撤销时间），密钥值零入 DB/审计/日志（canary 断言实测） | credentials.mjs + security-unit 两检查 |

## 2. 行为（命令、退出码、日志位置）

锁定 Node 显式路径执行，全部实测退出码 0：

```
# Phase 3 验收（package scripts）
node evals/phase3/cancel-approval/run.mjs        → 16/16  PASS, EXIT=0（+ red-proofs.mjs 3 组变异红证全过）
node evals/phase3/security-unit/run.mjs          → 23/23  PASS, EXIT=0
node evals/phase3/security-integration/run.mjs   → 21/21  PASS, EXIT=0（内含组合 offline-jobs 10/10）
node evals/phase3/offline-jobs/run.mjs           → 10/10  PASS, EXIT=0
node evals/phase3/restore/run.mjs                →  9/9   PASS, EXIT=0
node evals/phase3/ingress-telegram/run.mjs       →  8/8   PASS, EXIT=0
node evals/phase3/quota-calibration/run.mjs      →  5/5   PASS, EXIT=0
# Phase 1/2 回归（收口树终跑）
node evals/phase2/durability/run.mjs             → 164/164 PASS, EXIT=0
node evals/phase2/budget/run.mjs                 → 20/20 PASS, EXIT=0
node evals/phase2/acl/run.mjs                    → 15/15 PASS, EXIT=0
node evals/contracts/run-contracts.mjs           → 15/15 PASS, EXIT=0
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0
```

- 机器报告与人读日志：`docs/phase3/evidence/{cancel-approval,security-unit,security-integration,offline-jobs,restore,ingress-telegram,quota-calibration}-report.json` 与同名 `-log.md`；Phase 2 回归证据在 `docs/phase2/evidence/`（收口时点刷新）。
- **隔离与逃逸（真实容器，digest 固定，无 mock 过门）**：逃逸电池 12 探针全 BLOCKED（直 HTTP ENETUNREACH、清空 env 重试仍 ENETUNREACH、DNS/IPv6 EAI_AGAIN、宿主路径 EACCES/ENOENT、docker socket 缺席、秘密 env CLEAN、软链容器内、宿主 canary 未被读、oracle 验收文件 EROFS、fork 风暴 249 顶于 pids 256、git -c 仅沙箱内、电池完成留证、宿主 canary+oracle 全程未动）；agent 容器 rootfs 只读、仅提议通道可写、无网无 socket；acquisition 下载滥用八用例（好归档可解、路径穿越拒、越界软链拒、设备成员拒、gzip 炸弹死于解压上限、超尺寸拒、file:// 重定向拒、重定向环拒、正常 HTTP 重定向可跟随）。
- **离线无网络 job**：执行（SUCCEEDED/0）/失败退出码入证（FAILED/7）/超时（宿主墙钟强制 TIMED_OUT+容器收尸）/取消（CANCELLED+容器消失）/内存与盘配额强制（OOM FAILED+signal 证据；ENOSPC FAILED/9）/孤儿回收（LOST+容器杀）/坏 manifest 拒（FAILED/126）/daemon 级 `--once --execution-image=<digest>` 真实启动并等待终态。
- **审批与取消线性化（生产路径）**：全部经控制台会话（session+CSRF+JSON-only）驱动。双击单消费（审批审计单行）；编辑改体（旧卡 INVALIDATED、旧 effect CANCELLED、新 business_key `~rev1`、旧卡 decide 被拒）；HEAD 变化（dispatcher 在 CAS 事务内预检拒绝→旧动作 CANCELLED、按当前 HEAD 铸新卡、任务回 WAITING_APPROVAL、重批后恰好一次送达、陈旧动作零送达）；旧 attempt（fence 漂移拒绝+context_stale 审计）；取消两序（先取消→cancelledBeforeCommit+派发拒绝；先提交（apply_then_die→UNKNOWN）→committedEffectsPending 如实保留）；审批人身份（他人卡拒、撤权后拒、bootstrap token 只读、无 CSRF 403、非 JSON 415、匿名 401、恶意 Origin/Host 403、会话铸造须真 bootstrap token）。
- **备份恢复**：维护窗口外拒绝、无密钥拒绝（失败关闭）、错误密钥解封失败、manifest AES-256-GCM 密文落盘（明文字段零出现）；恢复后待审卡可 decide、待发可 dispatch、Timer 可触发、删除清单使被遗忘对象不复活、恢复推进 stream_generation、迁移幂等。
- **预算硬门禁**：未知 usage 不结零（MissingUsage）、HELD 超时 CHARGED_BOUND 保守占额、校正仅凭可信账单+actor、并发预留单赢家零残留、冻结账户拒新留、提额须审批；收费提交须持 HELD 预留（adapter 门禁实测 FAILED）。
- **ingress**：HMAC-SHA256 验签+±5min 时窗+平台事件 ID 去重、无密钥失败关闭（拒绝而非跳过）；真实只读源（主人授权 bot，Phase 1 同一凭据）：`getMe` 确认 @aegispibot（id 掩码）、`getUpdates` 只读取队列（未消费、未确认 offset）、一条真实 update 以 OBSERVE 落入本地演练库；凭据撤销演练（撤销后适配器构造即拒绝）。
- **数据源如实标注**：所有上述用例的传输/远端均为 fake（测试缝，`--fake-upstream` 与注入 fetch）+ 本机一次性 HTTP 源（host.docker.internal，仅本机）；唯一真实外部调用为 Telegram 只读两接口（主人授权 bot token，零发送、零消息副作用、token 不出现在任何输出与审计）。**无付费模型调用**（DeepSeek key 未使用）。未向真实同事或公开仓库发出任何消息。

## 3. 风险与如实边界（不随收口消失）

- **未对账 effect**：UNKNOWN 自动策略按 retry_mode 分流不变；本阶段全部演练于 fake 远端，真实平台的 UNKNOWN 积压未发生也未实证。
- **未知 usage**：CHARGED_BOUND 保守语义不变；真实 provider 账单修正流（第二层保护）未接——未获主人对调用类型与预算的授权，零真实模型调用。
- **真实外部写**：`policy.allowRealExternalWrites=false` 且无任何真实凭据接线；真实写传输全部失败关闭（零请求字节）。真实平台写闭环属 Phase 4。
- **同容器证据可伪造**（02 §5 明文承认）：恶意 job 可伪造自身 result.json；宿主墙钟 deadline、容器回收、退出码链不受影响；Task 结论始终归可信 oracle，本阶段已用 NOTE 留痕。
- **PID/进程表行为**（本轮实测发现）：runner 为容器 PID 1 不收割孤儿 → 已以 docker `--init`（tini）加固执行器与测试运行；`sh -c` 孤儿与 node 同步阻塞未收割窗口仍可在 deadline 内占满 pids 预算（该上限即防御目标，行为已记录于套件注释）。
- **PID 复用窗口**（D-18）不变，单人单机接受。
- **磁盘水位**：阈值已接线（warn 阻新 job+审计告警、critical 只读诊断），但本机水位未实测触警（466GiB 空闲）；水位告警的「实测触发」记录为后续常开前演练项。
- **4 GiB tmpfs 全量写**：为避免开发机 Docker VM 内存压力未做全量，同机制在 512 MiB 实测 ENOSPC；Phase 4 真实 job 画像后定终值。
- **备份保留期**：defaults 记录 14 天，但按保留期的自动清理/删除清单的批量沉淀未实现（当前清单随每次备份全量内嵌 manifest）。

## 4. 未决项（移交 Phase 4，不自行开工）

1. 第一个真实仓库闭环（场景四 Observe→有限 Auto）、主人通知 Routine——未开始，未授权。
2. 真实 ingress webhook 源（需公网端点+授权的 webhook secret；本阶段以 HMAC 验签模块+只读 pull 实证）与真实平台事件持续接入。
3. 真实 provider 账单修正流与按真实用量的配额终值（需主人对调用类型与预算的授权）。
4. 真实审批回调平台签名核验（本阶段审批人为本地会话主体；卡片的平台回传核验按 04 §2 语义已在 decideApproval 就绪，未接真实平台卡片）。
5. 四大终态视图、SSE 常驻连接（本阶段为有界重放）、oracle/holdout 可信验证器。
6. Task 结论→通知的 Routine 提议链在真实 Agent 执行下的接线（Phase 2 fake worker 仍为执行故事）。

## 5. 回归

Phase 1 与 Phase 2 全部出口套件在收口树上终跑全绿：durability **164/164**、budget **20/20**、acl **15/15**、contracts **15/15**、hono 配对 **EXIT=0**（含未安装快照 exit 2 两行断言）。本阶段唯一改动到的 Phase 2 断言：`later-phase-endpoints-answer-explicit-not-implemented` 的探针从「decide 返回 501」改为「replay jobs（后续阶段面）返回 501 `not_implemented_yet`」——decide 在本阶段实现后原探针指向已实现端点，检查身份（后续阶段端点明确不可用、不造假数据）未变，红证方向一致。

## 6. 提交与验证单元

按可验证单元分组提交（本提交组即镜像最终构建的源码树）：容器入口与镜像构建/门禁 → 宿主检查点/控制台/审批修订 → 容器执行器与离线 job → 验签/凭据/备份恢复/水位 → ingress 与配准 → 集成套件/证据/本收口报告。每组提交前对应套件在该组树形态上实测绿。

Phase 3 未通过前不宣布常开；本报告亦不构成 Phase 4 授权。停止条件（移交 §6）全程未触发：无跨域泄露、无越权提交、无恢复丢任务、无预算旁路、无 UNKNOWN 被自动当成功或盲重试、控制台未授权不能审批、未向任何未授权外部系统写出副作用、隔离与逃逸测试无 P0/P1 边界失败。
