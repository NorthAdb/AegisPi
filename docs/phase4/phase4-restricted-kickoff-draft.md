# 受限 Phase 4 开工草案（方案已获主人确认 2026-11-20；4.1 未授权开工；不含任何运行授权）

生成 2026-11-20，基线 `44b35141815bc890873f861ec34590654559faf9`。定位：把 04 Phase 4「真实仓库闭环」拆成可验收的小单元，先模型链路、后真实仓库 Observe，聚焦**首个仓库闭环**，不提前扩展 Phase 5/6。**本文是方案草案：任何建议不构成运行授权**；两种许可严格分列。模型链路的实现设计见 `docs/adr/0001-model-path-pi-host-execution.md`（ADR-0001），两文互为引用、口径一致。2026-11-20 同日修订：按方案审核 `REVIEW-MODEL-ADR-cde9bd3`（原稿字节归档于 `docs/phase4/reviews/`，回应另见同目录）同步——单元 4.1 执行接口为已锁定 pi-ai 1.5.2 的 `getBuiltinModel` + `completeSimple`（必传 `reasoning:"high"`）、`model.baseUrl` 为 SDK 根地址语义、`model_requests` 状态机与同事务边界、宿主目录权限与 requestId uuid 校验；**D 项延期不作为全部 Phase 4 的前置条件**。主人已确认本方案（2026-11-20，含 ADR-0001 同日两句澄清，提交 `3fd81c6`）；**方案确认不等于 4.1 开工授权，也不构成任何运行授权**——单元 4.1 开工与单元 4.2 首跑另需主人指令，首跑检查表未确认项照旧阻塞真实运行。

既定不重开：任务预算 $0.80（`defaults.json` `budget.taskMicroUsd=800000`）、日预算 $5（`budget.dayMicroUsd=5000000`）；超额行为按现行事实（结算超限仍 SETTLED 并冻结账户，无金额硬拒绝，ADR-0001 §6 第 5 条）。D 项维持主人决定**延期至首次启用 Telegram 公网入站 webhook 前**，且**不作为全部 Phase 4 的前置条件**（4.1 与 4.2 的模型/仓库部分不等 D）；发送通知不依赖入站 webhook，但**发送本身另需主人逐项授权**，与 D 的延期互不混同。

## 单元划分

### 单元 4.1 模型链路实现（ADR-0001 的实现轮；许可 1 范围内全可做）

产物：ADR-0001 §9 文件清单的代码（提议信封与结果回传、`model_requests` 状态机与同事务边界、pi-ai 执行核心 `getBuiltinModel` + `completeSimple`（必传 `reasoning:"high"`，`model.baseUrl` 根地址语义）、四字段逐类结算硬化、生产 attempt 接线）+ 新 model-proposal 套件 + 既有套件新用例 + **纪元 3** 镜像证据（实现轮先 `appImageContextHash` 复算、只重建已漂名字——预期 `--only=agent`；复算前不构建）。

内部次序（每步以本地套件绿为界）：
- a) 执行核心：model-call.mjs 内核改驱动 pi-ai + `microusdForUsage` 四字段逐类硬化；环回根地址夹具（`model.baseUrl` 写 `http://127.0.0.1:<port>`）断言——请求路径恰为单段 `/chat/completions`、body `model=deepseek-flash` 且 `thinking.type=enabled`（`reasoning:"high"` 已传）、usage 三态（无块无键 / 解析后布尔键 / 全零不结清）、HELD 纪律与 reasoning 不另计。
- b) 通道与宿主处理：worker `model_request` 信封 + host-commands 结果回传；宿主校验/幂等/reserve/结算全链，套件以 docker run 驱动 agent 容器完成端到端（不经生产启动器）。
- c) 生产接线：daemon tick 集成 + agent attempt 生产挂载（bind 三目录，宿主目录仅 daemon/uid 999 可写，非 1777）+ 纪元 3 构建与证据（先复算 context 只重建已漂名字，复算前不构建）。

退出条件：三套 docker 套件、新 model-proposal 套件及按实际 diff 范围选定的本地套件全绿（选择依据入档）；`git grep model-call-child` 为空；**零真实调用**（含 simulate 一律不碰真实端点/凭据）；`defaults.json` 失败关闭不变；实现提交过独立验收。

停止条件：任一步发现必须真实 key/真实端点/真实价格才能继续 → 停在失败关闭态，报告卡点与首跑检查表状态；任何门禁（image-gate/预算/白名单）拒绝 → 停在拒绝态，不绕过。

### 单元 4.2 真实仓库 Observe（首个仓库闭环；进入前须 4.1 验收通过 + 主人对首跑检查表的逐项书面确认）

形态：一个经授权的 claimed task → agent attempt（4.1 链路）→ 对**主人指定仓库**的只读获取（acquisition 镜像；读取范围由宿主侧 plan 固定，模型不得拼接 URL/范围，02 §4「不由模型拼接」同纪律）→ 基于真实仓库内容的模型轮次（经 4.1 核心结算）→ 结果存 scope-ACL 证据对象 →（可选，另授权）通知发送。

产物：闭环执行记录（命令/输出/退出码/镜像身份）、结算记录（usage × 核定目录价）、证据对象与脱敏入库件。

退出条件：单任务单闭环完成、全程在核定目录价与单次上限内结清、**对目标仓库零写**、目标仓库内容不整库入库（只入指针/脱敏摘要，AGENTS §3 同纪律）。

停止条件：任何未确认项将被触碰 → 立即停在失败关闭态并报告；结算 HELD（usage 缺失或价格未核定）→ 闭环不判完成，如实记录后停。

## 两种许可

**许可 1（本地实现与夹具测试，无需另行授权）**：单元 4.1 全部——本地代码与套件、环回端点夹具、本地 docker 容器、镜像纪元构建（构建供应链按纪元 2 已记录形态如实记档：digest 固定基础镜像本地在位、npm ci 经公网 npm registry 取 lockfile 依赖、推送仅至 loopback registry）、本仓库 git 推送。不触：真实 key、真实端点、外部 POST、公网监听、`.env`（实现轮亦不读）。

**许可 2（真实运行前须主人逐项书面确认——首跑检查表）**：

1. **具体仓库与读取范围**：仓库名与 URL、ref/分支钉住、路径范围、获取方式与深度；只读获取、零写。
2. **结果查看与通知目标**：结果在何处查看（本地证据/控制台只读诊断）；若发通知，目标与通道；Telegram 发送另需逐项授权（入站 webhook 非前置）。
3. **官方现价**：input/output/cacheRead/cacheWrite 每百万 token 的**官方当日现价**（以官方价目页为准，非 Phase 1 记录价沿用），写入 `priceCatalog` 四价位并经主人书面核定；未核定 → 调用只能 HELD，闭环不得判完成。
4. **输入/输出 token 约束**：单次请求输入上限（信封 128 KiB 硬上限之上的业务上限）、输出上限（现行 4000 字符截断之外的硬上限）。
5. **单次预留上限**：`callUpperMicrousd` 数值核定（现占位 1000）。
6. **模型端点授权**：`model.baseUrl` 写无路径根地址（SDK 自行接 `/chat/completions`，禁用旧完整 chat URL）+ `allowRealModelCalls=true` + 凭据槽接线（key 只经宿主凭据服务，不入库、不进 prompt/日志）。
7. **（若含通知）发送授权**：目标、仅限本次口径、模板与频率。

以上是**首跑检查表**，不是历史整改清单；其中未确认项不阻塞许可 1 的实现与夹具测试，但阻塞单元 4.2 的每一次真实运行。任一项未确认时把「已实现、待确认」如实入档，不把方案建议当授权解读。

## 不做（本草案显式排除）

Phase 5/6 场景与受控 RSI；多通道/多模型；常开宣布；D 项公网 webhook（延期维持）；检查表之外的任何真实运行解读；预算重开讨论。
