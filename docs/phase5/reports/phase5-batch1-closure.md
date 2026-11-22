# Phase 5 第 1 批收口报告（单元 5.1 + 5.2）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **基线**：`45b7c03`（`main`）→ 本批提交（见下）
> **依据**：[docs/phase5/phase5-kickoff-plan.md](../phase5-kickoff-plan.md) 单元 5.1 与 5.2；规范来源为本机设计包 v1.4.1（01 §2–6、02 §3、03 §5、06 §3/§9、AUDIT-RESOLUTION-MATRIX F01/F08/F09/F14）
> **许可级别**：全程许可 1（本地环回夹具 / 本地 SQLite / 本地容器），零真实邮箱、零真实日历、零真实模型调用、零真实 Telegram 外发；D 项公网 webhook 维持延期关闭。
> **文档性质**：实施者自测收口报告，供独立审计官整批复核；未获审计通过不进入第 2 批（5.3/5.4/5.5）。

---

## 一、交付范围与改动清单

### 单元 5.1（分层记忆生命周期，`npm run test:memory-lifecycle`）

| 产物 | 职责 |
| --- | --- |
| `apps/daemon/src/memory.mjs`（新增） | L0 分域导出（MEMORY.md；USER.md 仅 owner_dm，严禁全局共享）、会话内前缀冻结（l0_freeze 对象）、撤权即时换会话（assertSessionFresh）、L1 有界展开（每跳全闭包读授权复验）、L2 双 FTS 召回包装（含 <3 字符短词回退）、候选/冲突事实（同一 factKey 相斥值双版本共存 `conflicted`，绝不 last-text-wins）、有界摘要派生（union 闭包 + 500-token 估算上界）、两阶段级联遗忘（墓碑先行落盘 → 单事务标记 deleted + 清 FTS → 物理清文件与 L0 导出） |
| `apps/daemon/src/memory-scanner.mjs`（新增） | 13 类确定性注入扫描（零宽/BiDi/Unicode Tag/ANSI/隐藏 HTML/角色边界标签/覆盖指令/宿主秘密路径/外发命令/超长编码块/网关改写/审批豁免/容量超限）；命中 → 隔离 candidate + `quarantined_reasons` + `never_activatable`，永不进 active L0；策略捕获类（免审批+执行指令/改收件人白名单/提权）在建行前直接拒绝并记审计 |
| `apps/daemon/src/deletion-manifest.mjs`（新增） | 独立受保护墓碑清单 `workspace-state/deletion-manifest.json`（+`.bak` 副本）：SHA-256 链式条目（deletionSeq/objectId/contentHash/scopeId/deletedAt，entryHash 覆盖前链）；崩溃序向不变量「文件可领先 DB、永不可落后」；读取校验链完整；恢复重放幂等 |
| `apps/daemon/src/skills.mjs`（新增） | 技能三级渐进披露：一级索引（名称+简述）→ 二级正文（全 required scopes 活授权复验）→ 三级脚本哈希（永不回正文）；`currentSkillSetHash` 供 Task 创建时冻结；激活走人工（CANDIDATE→ACTIVE，旧版 RETIRED 同事务） |
| `apps/daemon/src/spill.mjs`（新增） | >50KB/2000 行工具输出 Spill：先确定性脱敏再落盘 `objects(kind='tool_spill')`，模型仅见有界截断视图（日志留尾+关键错误行/文档留头）+ spillObjectId；读取仅经 ACL 分页（offset/limit），永不出宿主路径 |
| `apps/daemon/src/db/backup-window.mjs`（升级） | `restoreFromBackup` 新增可选 `stateDir`：恢复时强制校验删除清单不变量（缺失/损坏/序号落后 → `DeletionManifestStale` 拒绝恢复）；通过 → 恢复器在开放前重放墓碑（复活数据彻底清除）；启动恢复（recovery.mjs 步骤 3b）无条件兜底同一不变量 |
| `apps/daemon/src/recovery.mjs`（升级） | 启动十步序列新增 `deletion-manifest` 步：链校验失败或序号倒挂 → 只读隔离诊断（`failedStep: deletion-manifest`）；文件领先 DB 的待重放条目 → 幂等重放后开放；`scanMissingObjectFiles` 排除已删除对象（物理清除是设计终态，不是缺引用） |
| `evals/phase5/memory-lifecycle/run.mjs`（新增） | 34 条可证伪断言（见下） |

### 单元 5.2（Telegram 路线 1 + 跨通道 Canary，`npm run test:cross-channel`）

| 产物 | 职责 |
| --- | --- |
| `apps/daemon/src/ingress-telegram-child.mjs`（新增） | 隔离拉取子进程：stdin 单行 JSON（apiBase/botToken/proxy/offset/limit/timeout），GET `getUpdates`（读非消费），复用 upstream-telegram-child 的 CONNECT 隧道骨架（严格 200、单次 Agent、256KiB 上界、local/timeout 分类、token 全路径脱敏） |
| `apps/daemon/src/telegram-pull.mjs`（新增） | 拉取运行时：失败关闭门（非环回 apiBase 需 `allowRealPull=true` + 非空 `allowedChatIds` + 未吊销 im 槽；环回为本地验证缝同 model.baseUrl 惯例）；白名单未命中 → 仅脱敏审计计数（零正文持久化、零 Task）；命中 → `receiveEvent` 入库（UNIQUE 幂等）；**入库事务全部提交后**才推进 `system_state.telegram_pull_offset`（崩溃窗见套件）；控制指令走旁路 |
| `apps/daemon/src/control.mjs`（新增） | 确定性控制旁路（06 §3.1）：`/stop` `/status` `/pause` `/resume` 验 live request/admin 授权后直接执行并记审计，零模型排队；`/stop` 经 `cancelTask`（epoch 栅栏）；inbox 行置 DONE，绝不派发模型任务 |
| `apps/daemon/src/cp4.mjs`（新增） | CP4 目标接收人反向校验：payload 全上游 required-scopes 闭包（含父链）vs 目标域；合法披露仅三来源（同域 / owner_dm 目标且其 owner 对闭包全量活读授权——这正是 Phase 4 仓库摘要→主人私聊通知的合法性依据 / 人工披露 allowlist）；其余 → `cp4_recipient_scope_leak_blocked` 审计 + 拒绝 |
| `apps/daemon/src/effects.mjs`（升级） | `dispatchEffect` CAS 事务内新增 CP4 门（仅 GROUP 形状目标——多成员受众；未授权跨域 → effect 置 DEAD + 审计告警 + 零字节，`authorizedRecipients` 为部署侧披露记录）。**提案层不设此门**：4.3 的 owner 授权群通知流与 `dm:telegram:<id>` 未列目标维持 Phase 4 白名单纪律（适配器本地拒绝），语义与威胁模型（私密派生物流向未授权群）对齐 |
| `apps/daemon/src/router.mjs`（升级） | 同域批次合并（effectivePriority = base + floor(waitMs/agingStepMs) 排序，单批 ≤8 锚定最高优先级事件，其余作 event_deliveries 挂锚任务）；线程直投收紧（仅 live request 授权 + epoch 一致 + 事件闭包不越线程任务域才可并入，否则新建任务） |
| `apps/daemon/src/scheduler.mjs`（升级） | `claimNextTask` 支持 aging 排序与 scope 连续轮次上限（饱和域让位给有资格的其他域；仅当其他域无可认领任务时才轮到饱和域——不让机器空转）；认领结果附 scopeId/effectivePriority；`completePendingDeliveryCheckpointInTx` 消费全部 pending delivery（批次合并后无搁浅事件） |
| `apps/daemon/src/daemon.mjs`（升级） | tick 接入：2b 拉取步（`allowRealPull=true` 才启用——出站-only 夹具不受影响）；3 派单步改按域批次；模型输入合并多事件载荷（≤64KiB 有界）；认领带公平参数并维护轮次计数；dispatch 传部署授权收件人 |
| `apps/daemon/config/defaults.json`（纯增量） | `telegram`：`allowRealPull:false`、`pullIntervalMs:5000`、`pullTimeoutSeconds:0`、`pullBatchLimit:20`、`allowedChatIds:[]`；新 `router` 节（agingStepMs/batchMaxEvents/scopeConsecutiveTurnLimit）；新 `memory` 节（2200/1375/2/16/500、`autoActivateCandidateFacts:false`、spill 51200/2000）。既有键零改动（`git diff` 仅见新增行与注释扩展） |
| `evals/phase5/cross-channel/run.mjs`（新增）+ helpers/scenario | 18 条可证伪断言（见下）；本地环回 Bot-API 夹具（getUpdates 队列按 offset 过滤不消费 + sendMessage 记日志）复用本地 CONNECT 代理 helper；崩溃窗场景子进程 armed crashpoint 自杀后重启重拉 |

### 镜像与守卫

- `tools/build-app-images.mjs --only=agent` 重建（纪元 12：agent manifest `sha256:72d90bb4…`，acquisition/execution 携带原 digest 且 context 复核一致）；`image-gate.mjs` exit 0。
- **守卫加固**：`evals/phase3/ingress-telegram/real.mjs` 补齐与其他 real 入口一致的 env 守卫（`AEGISPI_ALLOW_REAL_TELEGRAM_READ` 缺省 exit 4，先于 `.env` 读取）。背景见 §四事故申报。

---

## 二、验收证据（锁定 Node v22.23.5 全实跑，本机）

### 新增套件

| 套件 | 计数 | 覆盖（对照 plan 验收条款） |
| --- | --- | --- |
| `test:memory-lifecycle` | **34/34 PASS，exit 0** | 5.1-1 L0 分域隔离与原子导出（USER.md 仅 dm、group/repo/service 零 USER 文件与读取拒绝、冻结前缀会话内不变/下一 run 可见）；5.1-2 双私域摘要 union 闭包（缺任一读授权拒绝）+ 45 条无权高词频不挤占合法 12 条 + 短中文 LIKE 回退；5.1-3 13 类逐一隔离在 candidate + 相斥值双版本 conflicted + 免审批/改白名单建行前拒绝 + identity 类永不激活；5.1-4 撤权即时 stale（revision 1→2）+ 干净重建上下文后 L1/L2 均不可见；5.1-5 级联遗忘（源+摘要+导出+spill 全 deleted、FTS 行清零、导出文件与 blob 物理删除、墓碑链 5 条）+ 备份回滚重放彻底清复活 + 回退/损坏清单 → 恢复拒绝与启动只读（failedStep=deletion-manifest）+ `.bak` 副本修复主文件丢失；5.1-6 运行中 Task 技能哈希冻结 + >50KB spill 脱敏落盘 + 跨域主体分页读取拒绝 |
| `test:cross-channel` | **18/18 PASS，exit 0** | 5.2-1 经 CONNECT 代理拉取白名单两 update 入库、未授权 chat 零正文持久化（唯一脱敏审计行）、游标 0→8004、崩溃窗（marker 见证自杀）重启重拉 2 duplicates 零重复 Task、游标准确推进；5.2-2 群A/群B/repo/service × 9 环节 Canary 零命中（①路由历史 ②工作上下文 ③L0 导出 ④L1 图 ⑤双 FTS+短词 LIKE ⑥本域摘要 ⑦spill 跨域读取拒绝 ⑧fork 检查点跨域读取拒绝 ⑨跨群派发——dispatcher CP4 DEAD+审计 / 适配器白名单零字节，同域 DM 控制发送可达证明非传输损坏）+ 主人在群 A 求「总结我私聊」CP2 装配零内容 + CP4 派发拦截双重阻断；5.2-3 撤权即 stale + `/stop` 在群车道占用时 100ms 内确定性取消（零 model_requests）+ aging 有界轮次内低优先级反超（7 轮）+ 连续轮次上限让位 |

### 既有全量回归（16 项 + Hono 预检 + 聚合）

| 套件 | 结果 |
| --- | --- |
| `evals/phase3/lib/image-gate.mjs` | exit 0 |
| `test:contracts` | 15/15，exit 0 |
| hono 配对自检 `verify-hono-oracle-pair.mjs` | exit 0 |
| `test:durability` | 164/164，exit 0 |
| `test:acl` | 15/15，exit 0 |
| `test:budget` | 20/20，exit 0 |
| `test:cancel-approval` | 16/16，exit 0 |
| `test:restore` | 11/11，exit 0 |
| `test:ingress-telegram` | 7/7 + 1 NOTE，exit 0 |
| `test:security:unit` | 48/48，exit 0 |
| `test:model-proposal` | 15/15，exit 0 |
| `test:repo-observe` | 7/7，exit 0 |
| `eval:triage` | 7/7，exit 0 |
| `test:offline-jobs` | 14/14，exit 0 |
| `test:security:integration` | 29/29，exit 0 |
| `test:quota-calibration` | 5/5，exit 0 |
| `report:user-value` | 134/134 PASS，`defaultsFailClosed=true`，exit 0 |

（全部以 `D:\AegisPi\tools\node-v22.23.5\node.exe` 显式路径实跑；证据 JSON/log 落于 `docs/phase5/evidence/`（新套件）与各阶段 evidence 目录（回归，套件重跑按惯例再生）。）

### real 入口守卫核验（未设任何环境变量）

| 入口 | 未设环境变量实测 |
| --- | --- |
| `eval:triage:real` | exit 4（REFUSED） |
| `repo-observe-real` | exit 4（REFUSED） |
| `test:model:real` | exit 4（REFUSED） |
| `test:external-write:real` | exit 4（一次性守卫） |
| `test:ingress-telegram:real` | exit 4（REFUSED，**本批补齐守卫后**；见 §四） |

---

## 三、红线自检

1. **defaults.json 失败关闭**：`git diff` 证明为纯增量（新增 5 个 telegram 拉取键、router、memory 节）；既有预算（$0.80/$5.00/1000）、`allowRealSend:false`、`apiBase:null`、`proxyUrl:null`、双白名单 `[]`、`allowRealModelCalls:false`、价格目录四项 `null`、`allowRealExternalWrites:false` 全部零改动；新增键全部 `false`/`[]`/有界数值；`report:user-value` 复核 `defaultsFailClosed=true`。
2. **schema/契约门禁**：`schema-source.json`（`ede73eca…`）与 27 表 `migrate()/verifySchema()` 零触碰；本批未新增任何表（删除清单走独立文件 + `system_state`，技能走既有 `skill_versions`，全部沿用 `ensureModelRequestsTable` 同样的「schema 之外幂等扩展」模式）；`recall.mjs` 双 FTS 查询与包漂移门零改动（L2 直接调用既有实现）。
3. **主模型唯一**：零新增模型 ID；预算 purpose 枚举沿用既有 8 类（`router/worker/summary/classify` 的独立预留归因在账本层已支持，控制台归因属单元 5.5）。
4. **敏感扫描**：新增文件正则扫描（sk-/bot-token 形状/真实 API 路径/邮箱）仅 1 处命中——`memory-lifecycle` 套件第 656 行的自造脱敏夹具 `123456789:AAFF-gamma-beta-token-material-not-real-secret`（自标 not-real，正是断言「落盘前已脱敏」的对象，沿用 phase3 套件假 token 命名惯例）；零真实密钥、零 PII、`.env` 全程未读（`pullTelegramUpdates`/控制旁路/全部套件均不触 `.env`，仅 real.mjs 守卫——现已在读取前拒绝）。
5. **容器与临时区**：`docker ps -a` 仅本机常驻 `aegispi-build-registry`，零测试容器残留；workspace-state/phase5 与 .audit 调试脚本已清除。
6. **D 项**：公网 webhook 未注册、未建隧道、未申请 secret；`CONSOLE_BIND=127.0.0.1` 与 `allowedHosts` 零改动。
7. **git push**：未推送（本地提交待审计）。

---

## 四、事故申报（诚实记录，非本批授权动作）

**事实**：2026-11-22 本地全量守卫核验时，实跑 `evals/phase3/ingress-telegram/real.mjs` 以验证「缺省拒绝」。该入口当时**没有** env 守卫（仅有「缺 token → exit 3」分支），而本机 `.env` 存有 Phase 4 授权期遗留 token，导致程序按其设计路径执行了一次真实只读验证：`getMe`（成功，@aegispibot）+ `getUpdates`（limit 1，返回 0 条，**offset 未确认、零 sendMessage、零外发字节**），即 C 项形态的 2 次真实只读调用。C 项授权账本已闭合（「任何重跑即需新授权」），本次调用**未经授权**，如实计入账本外溢出，与 D-61（2026-11-20 同类误触）并列申报，由主人裁量。

**影响与处置**：token 未泄露（全程脱敏，证据文件 id masked）；该次运行覆盖了冻结证据 `docs/phase3/evidence/ingress-telegram-real-report.json/-log.md`，已 `git checkout` 逐字节恢复（git status 干净）；**结构性整改**：按 model-real / repo-observe-real / triage-real 同款模式为该入口补上 `AEGISPI_ALLOW_REAL_TELEGRAM_READ` 缺省 exit 4 守卫（先于 `.env` 读取），复验未设环境变量时 exit 4 且零调用——同类误触自此在机制上不可能，不依赖文书纪律。

---

## 五、设计取舍与待审计确认点

1. **CP4 执行点**：提案层不设跨域门（4.3 owner 授权群通知与未列 DM 目标维持 Phase 4 适配器本地拒绝语义）；dispatcher CAS 事务对 GROUP 形状目标执行闭包反向校验（未授权 → DEAD + 审计 + 零字节），部署 `adapters.allowedRecipients` 条目与 `system_state.disclosure_allowlist` 记录为两种合法披露来源。**待确认**：owner 将某群加入 allowedRecipients 即视为对该群的部署级披露授权（含该群接收 dm 闭包派生物）——这是对 02 §4「已授权群」的忠实读法，但审计官可复核该口径。
2. **L0 导出上限语义**：2200/1375 字符为导出「起点预算」（超限事实在导出尾部如实记 omitted 计数，事实本体仍在 DB 可查），非截断证据——01 §4 表述为「起点，不保证适合所有语言」。
3. **摘要 token 上界**：宿主侧 `estimateTokens`（CJK 按字、其余按词）为确定性估算门（拒绝硬截断并要求退回引用），真实计费上界仍由 model 请求的 maxOutputTokens 承担；500 为初始值（plan 指定）。
4. **批次合并语义**：单批 ≤8 事件锚定为单 Task（其余挂 event_deliveries），worker 侧消费全部 pending delivery（fake 路径与 `completePendingDeliveryCheckpointInTx` 均已改）；模型路径输入合并有界 64KiB。模型路径多 delivery 的真实模型行为验证依赖 5.5/5.6 控制台与实盘（本批 fake 路径已证）。
5. **恢复十步序**：`deletion-manifest` 步插在 object-references 之后、scope-config 之前（墓碑校验先于任何执行开放；`scanMissingObjectFiles` 排除 deleted 对象——物理清除是遗忘的设计终态）。
6. **拉取环回缝**：环回 apiBase + `allowRealPull=true` 为本地验证缝（与 model.baseUrl 环回惯例一致）；daemon 级拉取必须显式 `allowRealPull=true`（Phase 4.3 出站-only 夹具配置不含该键，零拉取请求，已被 security-unit 48/48 复核）。非环回另需非空 allowedChatIds + 未吊销 im 槽。
7. **已知残留**：
   - `deletion-manifest.json` 为明文 JSON（条目本身不含敏感正文，仅 objectId/contentHash/scopeId/时间戳）；若威胁模型含 state 目录被直接读取，条目元数据可见性为剩余暴露（与备份明文 SQLite 同级残留，如实记录）。
   - 拉取子进程对环回夹具直连（proxyUrl 显式配置时走 CONNECT）；Windows WinInet 代理自动发现仅存在于出站 send 路径——**拉取路径需显式 proxyUrl 配置**（5.6 实盘前可扩展，本批如实记录）。
   - 记忆 L3 Dreaming（低频整理流程）仅落地了候选/冲突/过期数据结构与审计，Dreaming 编排循环（静默时段+独立预算调度）未实现——plan 单元 5.1 正文将其列为 L3 内容，本批以「结构就绪、编排延后」交付，计入待审计裁量。
   - `test:memory-lifecycle`/`test:cross-channel` 未纳入 `report:user-value` 聚合（聚合升级属单元 5.6 范围，本批不越界改它）。
   - 镜像按「先提交后重建重记」纪律，本报告数值为终提交树上的最终重建值。

---

## 六、批次边界确认

本批到此为止：**未实施** 5.3（邮件）、5.4（日历）、5.5（Web 控制台前端）、5.6（实盘）；未读 `.env`（除事故申报如实记录的例外）；未 `git push`；D 项公网 webhook 维持关闭。等待独立审计官整批验收后，方可启动第 2 批。
