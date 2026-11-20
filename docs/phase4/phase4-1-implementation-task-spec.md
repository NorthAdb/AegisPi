# Phase 4.1 实施任务书（模型链路实现；已备待授权，未授权开工）

生成 2026-11-20，基线 `686d10b8881e990534c60aa4e5e2889a4b6e4131`（main，工作树干净）；同日按主人指令修订一轮（T5 崩溃窗口计费更正、T7 注入方式补明、宿主目录权限有效写集合语义、defaults 键名变更与 `test:model:real` 条款澄清，见文末修订追记与决策留痕 D-77；生产代码自基线起零改动）。身份与效力：

- **上游依据**：设计 = [ADR-0001](../adr/0001-model-path-pi-host-execution.md)（方案已获主人确认 2026-11-20，含 `3fd81c6` 两句状态机澄清）；单元划分与许可分列 = [受限开工草案](phase4-restricted-kickoff-draft.md)（单元 4.1 / 4.2）；状态底数 = [phase3-status-and-remaining.md](../phase3/reports/phase3-status-and-remaining.md)（2026-11-20）。本文把草案单元 4.1 的 a/b/c 概要细化为可执行任务书，**不重新讨论架构，不引入新设计**；一切工程约束直接引 ADR 章节号，不复制正文（避免多副本口径漂移）。
- **效力**：主人下达 4.1 开工授权后，本文成为实施依据；授权前它只是「已备」文本，不构成开工授权或任何运行授权。实施中发现本文与 ADR-0001 或草案口径冲突，**冲突即停止条件**（§5），不自行改设计、不自行扩大授权。
- **编制轮边界（诚实声明）**：编制本文的本轮零代码、零配置、零依赖、零测试脚本改动；未跑任何套件、未构建镜像、未读 `.env`、未触任何真实入口；历史审计原稿与冻结证据字节未动。文内「基线核对」均为对基线树的静态读取。

**设计约束速查（只引 ADR，不复制正文）**：容器无密钥、无自由 URL、无网络（ADR §2/§3）；purpose 双白名单与 modelId 白名单（ADR §3）；messages 128 KiB 硬上限与宿主目录权限限制（ADR §2）；请求幂等与同事务边界（ADR §4/§7）；EXECUTING 之后不重放、不 release，EXECUTING 之前预留可 release（ADR §7）；请求 HELD 与账本 HELD 同名不同物、两命名空间分列断言（ADR §7，`3fd81c6` 澄清）；usage 判据与逐类价格规则（ADR §6）；ORPHAN 只表示交付终止、费用仍照常处理（ADR §7）；不新增 agent 循环（ADR §11）。

## 1. Phase 4 总目标与本任务书范围

Phase 4 目标是离线闭环成立后完成首个真实仓库闭环。两单元分列（草案既定，不重开）：

- **单元 4.1（本文范围）**：接通并**离线验收**模型执行链路——容器 agent 在既有 propose-only 通道上提出 `model_request`，宿主经唯一执行核心驱动锁定的 pi-ai 1.5.2 执行单次推理，先 reserve 后调用，按 usage × 价格目录结清或保持 HELD，结果经既有 host-commands 目录回传并由容器消费。全部验证经本地环回夹具完成，**真实推理服务零调用**。
- **单元 4.2（不在本文）**：经另行逐项授权，对主人指定真实仓库做只读 Observe，产出有输入依据的观察结果、用量成本与审计记录；不默认改仓库、不默认创建 PR、不默认发通知。首跑检查表（草案七项）未确认前，其一切真实运行阻塞。

D（公网 webhook）维持主人既定延期（至首次启用 Telegram 公网入站 webhook 前），**不作为 4.1 的前置条件**。

## 2. 分步目标与产物（沿用草案 a/b/c 顺序，不另立次序）

每步以本地套件绿为界（草案既定）。四项必覆盖需求与步骤的对应：执行核心与 baseUrl 语义 = §2a；全链接通 = §2b + §3 锚点；两入口合流与旧客户端退役 = §2a/§2b/§2c；回归、镜像绑定与结果文档 = §2c + §4。步内普通实现问题（夹具形状、路径细节、命名）实施方自行解决并记入决策留痕（§5 第 5 条）。

### a) 执行核心（宿主侧）

- **模块**：`apps/daemon/src/model-call.mjs`（内核重写，导出面保持 `callModelOnce`/`isLoopbackModelEndpoint`）；`apps/daemon/src/model-call-pi-child.mjs`（新，短命子进程）；`apps/daemon/src/config.mjs` + `apps/daemon/config/defaults.json`（ADR §9 配置行）；`evals/phase3/model-real` 入口改测新核心（ADR §8 第 2 步；该入口本身在 4.1 一律不运行，见 §4）。
- **交付物**：
  1. 单次推理内核：短命子进程 import `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModel("deepseek","deepseek-flash")` 与 `@earendil-works/pi-ai/compat` 的 `completeSimple`，**必传 `reasoning:"high"`**；短命子进程模式保留（tick 保持同步）。这是已锁定的传递依赖 `@earendil-works/pi-ai@1.5.2`，**零新增包版本**；不用 AgentSession，不写 agent 循环（ADR §5）。
  2. baseUrl 根地址语义：宿主配置只写无路径根（目录根或环回 `http://127.0.0.1:<port>`），OpenAI SDK 自行接 `/chat/completions`；**禁止旧完整 chat URL 整段写入**（ADR §5 双发实测教训）；`model.baseUrl`（缺省 null）**替换**旧 `model.endpoint` 键，null 即不调用，失败关闭不因此启用真实端点。
  3. usage 四字段与 `microusdForUsage` 逐类硬化，ADR §6 五条全部落实（totalFromProvider 布尔键判据、全零 HELD、逐类价格规则、宿主自求和、reasoning 含于 output 不另计）。
  4. 环回根地址夹具断言：请求路径恰为单段 `/chat/completions`、body `model=deepseek-flash` 且 `thinking.type=enabled`（`reasoning:"high"` 已传）、usage 三态离线夹具核对（无块无键、解析后布尔键、全零不结清）。
- **依赖**：无前置（pi-ai 1.5.2 已在锁定 lockfile）。
- **通过条件**：新核心环回夹具用例绿；§3 矩阵 T1 的 wire 断言与 T8/T9 的 usage 判定先在夹具层绿；`model-call-child.mjs` 自本步起失去一切生产引用（基线核对：生产树现存唯一引用即 `model-call.mjs:26` 的 `CHILD` 常量；文件删除在 b 步收口）。

### b) 通道与宿主处理

- **模块**：`docker/agent/src/worker.mjs`（信封写入与结果指令消费）；`apps/daemon/src/model-requests.mjs`（新，或并入现有模块，ADR §9）；`apps/daemon/src/db/migrate.mjs` + `apps/daemon/config/schema-source.json`（`model_requests` DDL 落 canonical schema.sql 并同步哈希指针——漂移即红的既有门，合法迁移随指针更新）；`apps/daemon/src/daemon.mjs`（宿主处理链生产实现）；`apps/daemon/src/adapters.mjs`（`model.inference` 分派指向同一核心，门禁语义不变）。
- **交付物**：
  1. 容器侧：`model_request` 信封（字段封闭、无 URL 无凭据、messages 128 KiB 硬上限、requestId 为 uuid v4 且同一 attempt 内不重用，tmp+rename 原子写）；`model_result` 指令消费并按现行 receipt 模式回执（ADR §2）。
  2. 宿主侧全链生产实现（ADR §2/§3/§4/§7）：身份四元组以 RUNNING 领取行复检 → 信封严格校验（未知字段、类型不符、超限即拒）→ `model_requests` 幂等插入（RECEIVED）→ 双白名单（purpose 同时命中账本 `PURPOSES` 与 `model.allowedPurposes`，缺省空即全拒；modelId 命中 `model.allowedModelIds`）→ 与 `ledger.reserve` 同事务进 RESERVED → EXECUTING 提交后再经 a 步核心执行 → usage 判定结清或保持 → 写 `model-result-<requestId>.json` 回传（requestId 先过 uuid 校验才进文件名；reply 回传正文本身；refusal 形态同款）。
  3. 七态状态机与同事务边界（ADR §7 全文）：RESERVED 与 reserve 同一事务；EXECUTING 先于子进程单独提交，此后不重放、不 release、不到 FAILED；settle 与 request 行同一事务恰一次；迟到 usage 唯一入口 = 请求行 EXECUTING 且账本预留 HELD；ORPHAN 只表示交付终止，费用结局以账本行为准；FAILED 只出现在调用前。崩溃注入复用 `apps/daemon/src/testing/crashpoints.mjs`（现机制，timers/effects/scheduler 等已用同款）。
  4. 旧客户端退役（ADR §8 三步同轮完成，不留双路径过渡期）：删除 `model-call-child.mjs`，两字段 usage 断言全部更新。**清理口径**：生产树（`apps/`、`docker/`、`evals/`、`tools/` 与根 `package*.json`）中 `model-call-child` 零出现（`git grep model-call-child -- apps docker evals tools` 为空，文件不存在）；**`docs/` 与 `.audit/` 中该文件名的全部历史提及保持原样，不为清名改写任何审计或证据字节**——ADR §8 第 3 步的 grep 验收按「生产树零出现」执行，ADR 自身与历史材料合法含此名，属史实不属清理对象。
- **依赖**：a 步核心；既有 `scheduler.mjs` 租约纪律、`budget.mjs` 门禁语义、`credentials.mjs` 槽位（三者语义不动，ADR §9「不动」清单）。
- **通过条件**：新 model-proposal 套件（ADR §9 evals 行，落 `evals/` 既有分台布局，复用 `evals/phase3/lib/harness.mjs` 与 image-gate 现机制）中 §3 矩阵 T1–T10 主干绿；套件以 docker run 驱动 agent 容器完成端到端，不经生产启动器（草案 b 句）；`model.inference` 分派已指向唯一核心。

### c) 生产接线与纪元 3

- **模块**：`apps/daemon/src/daemon.mjs`（tick 集成：worker 分支改读提议全链，旧 inline 直调分支删除，终树无并行客户端——两入口自此均由唯一核心执行）；`apps/daemon/src/container-executor.mjs`（per-attempt 三目录 bind 挂载）；`tools/build-app-images.mjs`（`--only` 选择性重建，现机制）；`docs/phase3/reports/image-digest.md`（纪元 3 记录）。
- **交付物**：
  1. 生产 attempt 启动器：agent 镜像经与 `--execution-image` 平行的镜像解析启动 worker 容器；三目录 bind——proposals（容器可写；**宿主侧有效写集合仅限 daemon 进程与容器作业身份（uid 999），这是权限语义本身，不是照搬某一种 chmod 数值**；任意本机用户可写（1777 即一例）即违例）、host-commands（宿主写、容器 ro）、context.json（宿主写、容器 ro）；沿用挂载纪律（tmpfs noexec、ro bind、rootfs ro、`--network none`、无 socket）（ADR §2 末段）。实施环境（如 Windows 宿主机）无法忠实实现该有效写集合 → 停止并记录冲突，等待主人裁量（§5 第 6 条），不得放宽为任意本机用户可写。
  2. bind-mount 生产形态断言用例（ADR §2 末段 + §10.7）：proposals 可写、host-commands ro、rootfs ro、无网络、**宿主 proposals 目录有效写集合恰为 daemon 与容器作业身份（断言不含任意本机用户可写，1777 即违例）**、requestId 非 uuid 拒入文件名、身份四元组以 RUNNING 行复检。
  3. 纪元 3：**先以 `appImageContextHash` 复算三镜像 context，复算之前不构建**；只重建已漂移名字（预期 agent——`apps/daemon/src` 与 `docker/agent/src/worker.mjs` 均在 agent 清单）；acquisition/execution 复算一致且 manifest 于本机 registry 复解析后方可携带（携带核验拒绝即重建）；`image-digest.md` 更新为唯一现行 v2 机器块，纪元 2 保留为历史节；构建证据（log、agent `--self-check` exit 0）入档。
- **依赖**：b 步全链绿；Docker 29.9.2 与本机 `aegispi-build-registry`（127.0.0.1:5000）在位。
- **通过条件**：终树三 docker 套件、新套件与按 §4 选定的回归套件全绿；image-gate 全放行（**交付树零绑定漂移**）；§5 失败关闭核对通过；收口报告成文（§4 交付物清单）。

## 3. 可执行验收标准（本地闭环，零真实调用）

**测试不能只证明 helper 可用。** 矩阵之外必须有一条**端到端锚点用例**，全链走生产实现：

1. 真实 agent 容器（manifest digest 上 `docker run`，`--network none`，`PI_OFFLINE=1`，凭据 denylist 不变）内 `worker.mjs` 写出 `model_request` 提议。
2. 宿主以真实 daemon tick 进程处理（`--once`/`--data-dir`/`--config` 测试缝，现行套件同款；`--config` 注入双白名单与环回根地址，不改生产代码路径）：身份复检、幂等插入、`ledger.reserve`（真实 budget 逻辑，任务/日双账户）。
3. 唯一执行核心的短命子进程经 pi-ai（`getBuiltinModel` + `completeSimple`，`reasoning:"high"`）向**宿主本地环回模拟服务**（`model.baseUrl=http://127.0.0.1:<port>`）发出请求——环回服务为 OpenAI 形状夹具，断言 wire：`model=deepseek-flash`、`thinking.type=enabled`、请求路径恰为单段 `/chat/completions`。
4. 宿主按回传 usage × 夹具目录价同事务结清（请求行 SETTLED，账本行 SETTLED）。
5. 宿主写 `model-result-<requestId>.json`，容器 `serveCommands` 消费并回执，reply 正文在容器侧可读。
6. 全程**真实推理服务零调用**（唯一配置端点是环回根；`defaults.json` 保持 `baseUrl=null` 与 `allowRealModelCalls=false`；实现轮不读 `.env`）；**容器隔离不放宽**（容器无网络，环回服务只对宿主子进程可见）。

**最小测试矩阵**（每项断言两命名空间状态、费用与环回调用次数，不以「测试通过」四字交差。矩阵用例可经提议文件直接驱动宿主生产链——通道是文件契约，容器侧生产实现已由锚点用例证明）：

| # | 场景 | 驱动与注入 | 预期请求行 | 预期账本 | 预期费用与审计 | 环回调用 |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 正常返回（含 §3 锚点全链形态） | 合法提议；环回回 usage input=40 / output=13、cache 二类=0；夹具目录价 input 300000 / output 1200000 µ$/M，cache 二价 null（经 `--config` 注入，`defaults.json` 价保持 null） | RECEIVED→RESERVED→EXECUTING→SETTLED | 同事务 SETTLED **28 µ$**（40×0.3+13×1.2=27.6 进位，对齐 A 项实测口径与 ADR §10.5） | `budget_settled` 在场；reasoning 无独立计费行；reply 落 scope-ACL 证据对象（截 4000 字符）且容器 receipt 在场 | 恰 1 |
| T2 | 拒绝输入 | 六触发逐项断言（ADR §10.1 同款）：白名单外 purpose、白名单外 modelId、scope 不匹配、fence 或 attemptId 不匹配、未知字段、messages 超 128 KiB | FAILED（调用前） | reservations=0，零预留 | `model_request_refused` 逐项在场 | 0 |
| T3 | 重复请求 | 同 requestId 二次提议 | 主键冲突回读已有状态，不插第二笔预留、不第二次调用 | 同一预留，无二次占用 | 幂等回执，重复投递丢弃并审计 | 累计仍 1 |
| T4 | 调用前取消 | RESERVED 提交后、EXECUTING 提交前注入取消（crashpoint 式缝） | FAILED | release（仅账本 HELD 可 release），双账户 held 相应回落 | release 审计在场；零费用 | 0 |
| T5 | 崩溃：reserve 与调用之间（pre-call 窗口，与 T4 同一） | crashpoint 注入于 RESERVED 与 EXECUTING 两提交之间，重启 | 停留 RESERVED，不自动重放（不要求断点续跑，超出 ADR 最小范围）；或在放弃该次 attempt 时转 FAILED——两种处置任一成立即过，所选处置入档 | 预留保持 HELD（重启后不自动 release、不结清，ADR §7 测试要求句「reserve 与调用间崩溃保持 HELD」即此义）；调用未发出，预留仍处 pre-call 可 release 区间（ADR §7 RESERVED 条，与 T4 同款）；随 attempt 放弃即 release | **零费用：不进 CHARGED_BOUND、不按 `callUpperMicrousd` 占额**（该保守路径只属于 T6）；崩溃前后均无第二次调用 | 0 |
| T6 | 崩溃：EXECUTING 提交后 | crashpoint 注入于 EXECUTING 提交后、写回落地前，重启 | 停留 EXECUTING，不重放、不 release、不到 FAILED | HELD 保持 → 保守超时 CHARGED_BOUND（占满 `callUpperMicrousd=1000`，双账户拆分；ADR §7 EXECUTING 条——调用可能已发出，这是唯一保守出路） | 已发出调用计 1 次，重启后不再发；**CHARGED_BOUND 只属于本窗口**（T5 的 pre-call 窗口不得进入） | 1 |
| T7 | 迟到 usage | 注入方式写明：第一次调用已完成且 usage 已取得，写回事务尚未提交（crashpoint 式缝，子进程已答、settle 与写回未落）；随后迟到 usage 到达；其后再次投递同 requestId 的 usage | 恰一次进入 SETTLED；二次投递丢弃并审计 | 同事务一次结清（40/13 → 28 µ$），只结清一次 | 迟到结清审计在场；**结清是纯账本事务，不得再发第二次环回请求** | 累计仍 1 |
| T8 | usage 缺失或全零 | 环回回无 usage 块（流占位，无 `totalFromProvider` 键）／四字段全零 | HELD（**请求态**，与账本 HELD 同名不同物，两命名空间分列断言） | HELD 保持，不结清不 release | `model_usage_not_settled` 在场；不判 0 费；夹具三态逐项核对 | 1 |
| T9 | 合法零值与逐类价格 | 子例一：usage input=10 / output=0 / cache 二类=0（总和>0）；子例二：cacheWrite>0 而 cacheWrite 价 null | 子例一 SETTLED；子例二 HELD（请求态） | 子例一结清 **3 µ$**（本任务书夹具值：10×300000/1M 进位）；子例二整笔 HELD | 子例一正常结清；子例二 `model_usage_not_settled`（ADR §6.2 逐类规则） | 1 / 1 |
| T10 | 任务终态与费用分离 | 写回前任务已终态。子例一 usage 有效；子例二 usage 无效 | 均转 ORPHAN（交付侧终态） | 子例一：账本同事务 SETTLED 28 µ$；子例二：保持 HELD → 保守超时 CHARGED_BOUND | `model_result_orphan` 在场；结果不再投递；费用照常处理（两子例分别断言） | 1 / 1 |

**其余边界不另造**：超时 → `model_call_failed` 且 request 停在 EXECUTING/HELD 走保守超时；超额结算仍 SETTLED + 冻结 + `budget_overcharge_frozen`；容器隔离不变量（denylist、`PI_OFFLINE`、无 socket、bind 形态、宿主 proposals 目录有效写集合仅 daemon 与容器作业身份、requestId uuid 校验、RUNNING 行复检）——全部按 ADR-0001 §10 第 1、4、5、6、7 条对号执行，并复用既有套件已覆盖面（`security-unit` 现行 worker 模型用例随核心切换更新为「既有套件新用例」，ADR §9 evals 行）。**矩阵与 ADR §10 之外不新增行为面**（不扩展新功能）。

## 4. 环境、镜像与交付

**环境前置**（AGENTS §1 与根 README 运行前置同款）：

1. 锁定 Node 22.23.5 显式路径调用（`D:\AegisPi\tools\node-v22.23.5\node.exe`；非锁定 Node 套件 exit 2）。
2. `npm ci`（根 lockfile，workspaces 布局；daemon 与多数套件在 import 期要求 `node_modules` 在位）。**实现轮不新增任何依赖**。
3. 三 docker 套件另需 Docker（在案 29.9.2，linux/amd64）与本机构建 registry 容器 `aegispi-build-registry`（127.0.0.1:5000，registry:2；勿动其他项目容器）。新套件凡跑容器一律经 image-gate 绑 manifest digest，浮动 tag 禁用（现行纪律）。
4. 实现轮**不读 `.env`**（许可 1 明确排除；环回夹具不需凭据）。

**回归范围**：按实际生产 diff 触及选定，选择依据入档（草案退出条件）。预期必跑：新 model-proposal 套件；三 docker 套件（offline-jobs、security-integration、quota-calibration——镜像绑定面）；`test:security:unit`（现行 worker 模型用例更新、ordering 与失败关闭）；`test:budget`（settle/release/CHARGED_BOUND 语义回归）；`test:contracts`（PI 契约与 SQLite 门）；hono 配对自检（`node evals/contracts/tools/verify-hono-oracle-pair.mjs`）；`test:durability` 与 `test:restore`（`db/migrate.mjs` 与 schema 触及）；`test:cancel-approval`（调用前取消语义）。预期零 diff 模块所辖套件（如 `test:acl`、`test:ingress-telegram`）可沿用 `44b3514`/`33d6361` 在案记录，沿用依据同样入档。三条 real 入口**一律不运行**（根 README 真实入口纪律）；`test:model:real` **只改接到新核心，4.1 仍不运行它**——不追加一次性守卫，该入口无守卫按现状在收口报告登记为已知残留（不为此改代码）；历史缺证不重开。

**镜像与纪元**：按 §2c 执行——先复算后构建、只重建漂移名字、携带者必须复算一致且复解析、纪元 3 入 `image-digest.md`（前纪元保留为历史节，唯一现行 v2 机器块），终树交付时 image-gate 全放行（零绑定漂移）。**构建网络行为如实记档**（纪元 2 已记录形态）：digest 固定基础镜像本地在位；镜像内 `npm ci` 经公网 npm registry 取 lockfile 固定依赖；push 仅至 loopback registry。**该构建供应链行为与真实模型调用是不同的网络行为**——4.1 的「零真实调用」指推理服务零调用，npm ci 的供应链网行为不构成破例，两件事在证据里分开记。

**交付与验收方式**：沿用既定口径——**实施方本机验证通过，我方审核代码与证据**；原镜像不要求移交审计机（主人 2026-11-20 决定维持）。步骤间不设逐项人工批准：实施授权下达后，实施方按本任务书连续完成 §2a→§2b→§2c，统一交付验收。交付物清单：

1. 实施提交（可多 commit）+ 最终 SHA + push 至 main；决策留痕追记一行（实施轮自编）。
2. 套件证据：每条命令、输出与退出码，锁定 Node 版本在案。
3. 纪元 3 构建证据与 `image-digest.md` 更新。
4. 回归选择依据（跑了什么、沿用什么、为什么）。
5. 收口报告（建议 `docs/phase4/reports/phase4-1-closure.md`，实施方可定名）：逐条矩阵结果（观测状态、费用、调用次数对照本表预期）、`model-call-child` 生产树 grep 证明、defaults 失败关闭核对（键名级变更逐行对照 ADR §9、失败关闭值不变，不以「零行 diff」为通过条件）、遗留与停止记录（含 `test:model:real` 无一次性守卫的已知残留登记）；文档索引与状态清单同步登记。

## 5. 范围锁定与停止条件

**预算与失败关闭（不重开）**：任务 $0.80 / 日 $5 已定（`defaults.json` `budget.taskMicroUsd=800000`、`budget.dayMicroUsd=5000000` 不动）；`callUpperMicrousd=1000` 占位不动（核定属首跑检查表第 5 项）；`priceCatalog` 四价保持 null（任何真实调用前由主人核定，检查表第 3 项）。**实现轮允许 `defaults.json` 按 ADR §9 做键名级变更**（`baseUrl` 替换 `endpoint`、新增双白名单键与 cache 二价键）；**通过条件不是「零行 diff」**（零行 diff 是非实现轮的纪律），而是失败关闭值全部不变：`model.baseUrl=null`、`model.allowedPurposes=[]`（缺省空=全拒）、`model.allowedModelIds=[]`（同）、`allowRealModelCalls=false`、`allowRealExternalWrites=false`、`upstream.submitUrl=null`。变更逐行对照 ADR §9 展示。

**明确不在 4.1 授权内（触碰即停）**：单元 4.2 真实仓库 Observe；真实模型调用（任何非环回端点、任何真实 key）；Telegram（入站 webhook 与出站发送）；外部写（`allowRealExternalWrites` 与 `CONSOLE_BIND` 不动）；公网监听；常开；第二模型；agent 循环（ADR §11 显式不做）；流式透传；预算重开讨论。D 维持延期，不挡 4.1。

**停止条件**：

1. 发现必须修改 ADR-0001 任何决策句（接口形态、状态机、结算规则、隔离不变量）才能继续 → **停在当前步骤**，记录具体冲突（哪一句、什么证据、为何无法在现行设计内解决），等待主人裁量，不自行改设计。
2. 发现必须触碰上段范围外项才能继续（如需真实 key、真实端点、真实价格）→ 停在失败关闭态，报告卡点与首跑检查表状态（草案 4.1 停止条件沿用）。
3. 任何门禁拒绝（image-gate、预算、白名单、schema 哈希门）→ 停在拒绝态，不绕过、不强行刷绿。
4. Phase 3 已关闭的限定修复与历史缺证（A 账单、B 正文、C 次数与 T2 网络事实）不重开、不追补；不为历史文件名清改审计与证据（§2b 清理口径）。
5. 普通范围内的实现问题自行解决：夹具形状、路径细节、命名、套件接线方式（如是否为新套件加 npm script——若加，其 agent context 漂移已由纪元 3 重建覆盖，属实现细节非范围变更）。解决过程记入决策留痕即可。
6. 宿主 proposals 目录的有效写集合（仅 daemon 进程与容器作业身份，§2c 权限语义）在实施环境（如 Windows 宿主机）无法忠实实现 → 停止并记录冲突（已试何种实现、为何不忠实），等待主人裁量；**不得放宽为任意本机用户可写**。

## 修订追记（2026-11-20，主人指令，决策留痕 D-77）

1. **T5 更正**：RESERVED 与 EXECUTING 之间崩溃时调用尚未发出，该窗口与 T4 同一（pre-call，ADR §7 RESERVED 条），预留可 release、请求行停留 RESERVED 或随 attempt 放弃转 FAILED；**不得进 CHARGED_BOUND、不得按 `callUpperMicrousd` 占额**——该保守路径只属于 T6（已进入 EXECUTING、调用可能已发出之后）。原表把 ADR §7 测试要求句「reserve 与调用间崩溃保持 HELD」误延拓为保守超时占额；「保持 HELD」的本义是重启后不自动 release、不结清，未授权任何费用。
2. **T7 注入方式补明**：第一次调用已完成、usage 已取得、写回事务尚未提交；迟到结清是纯账本事务，不得再发第二次环回请求，累计调用次数仍为 1。
3. **宿主目录权限改述**：要求是有效写集合仅限 daemon 与容器作业身份（uid 999），不是照搬某一种 chmod 数值（1777 只是一种被禁止的放宽形态）；Windows 宿主机无法忠实实现即停止记录冲突（§5 第 6 条），不得放宽为任意本机用户可写。
4. **defaults 与 `test:model:real` 条款澄清**：实现轮允许 `defaults.json` 按 ADR §9 做键名级变更，通过条件是失败关闭值不变，不以「零行 diff」为条件；`test:model:real` 只改接到新核心且 4.1 仍不运行，无一次性守卫按现状登记为收口已知残留，不为此改代码。

本轮修订零代码、零配置、零依赖、零测试脚本改动，未跑套件、未构建镜像、未读 `.env`、未触真实入口；生产代码自基线 `686d10b` 起零改动，正文代码引用仍准确；历史审计与冻结证据字节未动。

---

本文由主人 2026-11-20 指令编制（编制轮仅文档，决策留痕 D-76）；同日修订一轮（决策留痕 D-77）。授权下达前，仓库现状与待办一律以状态清单为准；下达后，本文为单元 4.1 的唯一实施依据文本。
