# 会话交接文档：Phase 5 收官基线 → 个人自用过渡与后续规划（暂缓 Phase 6）

> **交接日期**：2026-11-24（Asia/Hong_Kong）
> **仓库基线**：`main` 分支 `724018a`（已推送，与 `origin/main` 同步 `0 0`）
> **本文件位置**：`docs/HANDOFF-PHASE5-TO-SELFUSE.md`（新建未提交本地交接档，供新对话直接载入上下文；不改动任何生产代码、配置或冻结证据）
> **当前阶段裁定**：Phase 1–5 全部完成并通过终局对抗审计（`D-103`，`PASS WITH RESIDUALS`）；主人拟先进入个人实际试用期，**暂缓启动 Phase 6**。

---

## 一、快速复原上下文（新对话必读入口）

新对话建议按以下顺序建立事实基准，避免重做已验证判断或误改红线文件：

1. [AGENTS.md](../AGENTS.md)：仓库级硬约束（Node 版本锁、Pi 精确版本、严禁读取/输出/提交 `.env` 密钥、evidence 纪律）。
2. [README.md](../README.md) 与 [docs/README.md](README.md)：项目定位、现行规范、脚本目录与历史边界。
3. [docs/phase5/reports/phase5-final-closure.md](phase5/reports/phase5-final-closure.md)：Phase 5 终局收口报告（单元 5.6 许可 2 实盘与 CalDAV 延后裁定）。
4. [docs/phase4/reports/user-value-report.md](phase4/reports/user-value-report.md)：终树全量聚合报告（**327/327 PASS**）。
5. [docs/phase3/reports/image-digest.md](phase3/reports/image-digest.md)：现行 OCI 镜像 digest（**纪元 16**）。
6. [.audit/decision-trail.tsv](../.audit/decision-trail.tsv) 末尾 `D-102`、`D-103`：最新裁定、实测费用与已登记非阻断残留。
7. 设计包规范（仓库外）：`D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\04-Frontend-Console-UX-and-6-Phase-Taskbook.md` 第 6 节（Phase 6 入口条件与验收口径）。

---

## 二、已验收基线事实（`724018a`，实测在案）

### 2.1 运行时、锁文件与 Schema 指纹

| 维度 | 现行锁定事实 | 备注 |
| --- | --- | --- |
| Node.js | `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`） | **严禁依赖 `PATH` 中的 Node**；所有脚本必须显式调用锁定路径 |
| Pi 运行时 | `@earendil-works/pi-coding-agent` / `pi-ai` 精确 `1.5.2` | `cacheWarming: "off"`，宿主执行 `completeSimple` 固定 `reasoning: "high"` |
| HTTP / SQLite | `hono` 精确 `4.13.19` + 内置 `node:sqlite` | 无新增多余运行时依赖 |
| Canonical Schema | `apps/daemon/config/schema-source.json` 指向 `D:\AegisPi\aegis-pi-design-pack-v1.4.1`（LF SHA-256 `ede73eca...`） | 27 用户表 + 10 FTS + 3 触发器保持原样；扩展表（`model_requests`、`credential_slots`）在 `schema_migrations` 之外按需幂等建表 |
| 默认配置开关 | `apps/daemon/config/defaults.json` 全失败关闭 | `taskMicroUsd=800000`（`$0.80`）、`dayMicroUsd=5000000`（`$5.00`）、`baseUrl=null`、双白名单 `[]`、`allowReal*=false`、价格表 `null` |

### 2.2 OCI 镜像纪元（纪元 16）

来自 [docs/phase3/reports/image-digest.md](phase3/reports/image-digest.md)：

- `agent`：`127.0.0.1:5000/aegispi/agent:phase3-cbdc86d5fe60`（manifest `sha256:99938a3626e9dfabdcb3e39d5b575a8d3ef7bc1b9e68a5f1c2b2fd0d89de2e54`，context `sha256:2d28cd64...`）
- `acquisition`：`127.0.0.1:5000/aegispi/acquisition:phase3-2c612c810ddc`（manifest `sha256:488cb3da47f98009fac76e76245dbb2f0dcfe57250f06100e82d41b5ca50d174`，context `sha256:88b5f512...`）
- `execution`：`127.0.0.1:5000/aegispi/execution:phase3-52502432d21f`（manifest `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050`，context `sha256:8183df14...`）
- 提示：后续若修改 `apps/daemon/src` 或 `docker/` 且需要运行 Docker 隔离套件，须先通过 `evals/phase3/image-gate/probes/probe-evidence-holds.mjs` 或按纪元机制选择性重建受影响镜像。

### 2.3 终树回归、实盘验收与真实费用快照（`D-103`）

- **全量离线 + 容器验证**：12 项本地套件 + 6 套 Docker 套件 + `probe-evidence-holds.mjs` + `verify-hono-oracle-pair.mjs` 全 `rc=0`；6 个 `*:real` 入口未设 opt-in 环境变量时全部 `exit 4`。
- **用户价值聚合报告**（`report:user-value`）：**327/327 PASS**，`defaultsFailClosed=true`，12 份证据文件零密钥扫描 clean，62 个提交文件独立秘密扫描零命中。
- **已发生真实调用与费用记录**（来自 [user-value-report.md](phase4/reports/user-value-report.md) 与 [scenarios-real-report.json](phase5/evidence/scenarios-real-report.json)）：
  - `worker` purpose 合计：**6 次请求 / `12708` microUSD**（含单元 4.5 `triage-real` 5 次 `12225` microUSD，及单元 5.6 `scenarios-real` 邮件草稿 1 次 `483` microUSD、`175` in / `358` out、`reasoning: "high"`）。
  - `router` / `summary` / `classify` 实盘费用仍为 `null`（未测）。
  - 单元 5.6 实盘（`eval:scenarios:real`）：Telegram `getUpdates` 隔离 + Canary 零跨群泄露通过（`offsetAfter=500045908`）；真实 IMAP→DeepSeek→`127.0.0.1:4310` session+CSRF→SMTP **恰 1 封**回信 `SUCCEEDED`；真实 CalDAV 登记 `DEFERRED / NOT VERIFIED`。第 4 次运行 23/23 全 PASS 后 Windows 收尾阶段在 `rmSync` 先于 DB `close` 时遇到 `EBUSY` 崩溃，已由 `--finalize-kept-workspace` 从保留工作区只读恢复补齐 12/12 证据并引用 `.audit/batch3-real-run-4.log`。

---

## 三、个人自用完备度评估（现状 vs 真实使用缺口）

### 3.1 已经完备可放心使用的核心能力

1. **底座可靠性与资金/安全防线**：排他锁、WAL 恢复十步序列、墓碑删除清单（`deletion-manifest`）、`$0.80 / $5.00` 账本预留与四字段结清、`local_error:` / `UNKNOWN` 保守语义（绝不盲目重发 `AT_MOST_ONCE` 邮件）。
2. **域隔离与审批台**：L0–L3 分层记忆、13 类注入扫描隔离、CP4 跨群防泄漏、`127.0.0.1:4310/` 控制台四页签（待办与审批、任务与故障诊断、记忆与治理、链路与分用途成本）。
3. **专项强闭环场景**：`repo_observe`（只读公仓剖析）与 `repo_triage`（双快照无网容器对比复现四分类裁定 + Telegram 通知）已有完整端到端分支。

### 3.2 进入日常自用前需要知晓的限制与缺口（经源码核对）

| 类别 | 现状与源码位置 | 对日常自用的影响 |
| --- | --- | --- |
| **通用任务循环非多轮对话** | `apps/daemon/src/daemon.mjs` 通用分支将一条 `modelRequest` 写入 `context.json` 后由 `docker/agent/src/worker.mjs` 提交单次请求，宿主 `processPendingModelProposalsAsync(..., { completeActiveTask: true })` 在收到 `model_result` 后直接结清并把 Task 标完结 | 通用 Telegram/邮件会话目前是**单轮提问→回答**，不会自动多轮调用本地工具或自发从自由回复转为 `mail.send` / `calendar.write` / `im.notify` 审批卡 |
| **首次自用部署组装无脚手架** | `apps/daemon/config/defaults.json` 100% 失败关闭；`daemon.mjs` 启动需要外部 `--config=<json>`、`--data-dir=<dir>`、容器镜像参数，且凭据槽位与初始 scope 授权需预先播种；`127.0.0.1:4310/` 每次重启/新会话需从 `workspace-state/console/token` 粘贴 bootstrap token | 初次长期自用前需要一套个人私有运行配置模板与一次性初始化引导脚本（私有路径 `.gitignore`，绝不碰 `defaults.json`） |
| **邮件分诊 vs 通用自动草稿** | 场景一模块（`mail-triage.mjs` `ingestInboundMail` / `proposeMailReplyEffect`）和晨报模块（`briefing-followup.mjs`）已接通特定状态驱动入口，但通用私聊指令直接触发带草稿卡片的外发编排仍待按自用需求串接 | 日常若希望“收到某类邮件自动起草回复进审批台 / Telegram 一句话触发建审批卡”，可在试用前或试用中做轻量接线 |
| **CalDAV 真实通道未实盘** | `CALDAV_*` 未在 `.env` 配置，仅经过 Permit 1 环回 TLS 夹具验证 | 如日常要同步真实日历，需先补 `.env` 凭据并做一次只读/单写实盘核对 |
| **Telegram 公网 Webhook 延后** | D 项持续推迟；目前走路线 1 `getUpdates` 长轮询 | 个人本地试用无需公网域名与隧道，`getUpdates` 已够用 |
| **平台与 P3 已知小瑕疵** | ① `adapters.mjs` / `mail-adapter.mjs` 对 `allowedRecipients` 精确匹配大小写，而 `mail-triage.mjs` 归一为小写（混合大小写配置会在分发层安全拒发）；② `briefing-followup.mjs:174,218` 仍读不存在的 `digestObject.content_hash`（安全落回 P3-1 空清单哈希兜底），且同文件存在未使用导入/死辅助 `enqueuePlain`；③ Windows 下 `proposals` 目录 ACL 仅能区分到当前 Windows 账号层级（Docker Desktop proxy 限制，`D-78`） | 均为保守/非阻断残留，可在自用优化小补丁中顺手清掉 |

---

## 四、关于暂缓 Phase 6 的设计依据与后续路线

### 4.1 为什么现在暂缓 Phase 6 完全合理

设计包 `04-Frontend-Console-UX-and-6-Phase-Taskbook.md` 对 Phase 6（**受控 RSI、可复现 Replay 与终态控制台**）明确设定的入口条件是：

> **入口**：已有跨任务真实失败及可靠来源，环境产物可保留并满足隐私规则。

在没有真实个人使用样本和跨任务失败轨迹之前硬做 Phase 6，只会造出脱离真实痛点的离线回归夹具。**先进入实际自用，在 `workspace-state` 中自然沉淀真实失败样本、路由噪音与使用成本分布，再回过头做 Phase 6 的 Shadow Replay / Curator 候选 / 技能晋升 / `501 not_implemented_yet` 终态四视图补齐，完全符合架构本意。**

### 4.2 Phase 6 保留范围备忘（未来重启时参考）

- **受控 RSI 与隔离评测**：Curator 改进候选、脚本评审、删除原目录后基于环境 manifest 重放（`eval:replay`）、不可见 holdout 隔离防泄露、人工晋升（`test:promotion`）、运行中 Task 锁定 `skill_set_hash` 与技能回滚、盲测报告费用与波动。
- **终态控制台补齐**：替换 `apps/daemon/src/console/api.mjs` 末尾兜底返回 `501 not_implemented_yet` 的后阶段路由，补齐 Replay Studio、完整拓扑 Trace、MCP pin 治理与补偿删除候选展示。

---

## 五、新对话推荐讨论议题（按轻重缓急）

打开新对话后，可以直接决定以下三条路径中的一条（或组合）：

1. **路线 A（推荐第一步）：制定「个人自用最小启动与日常操作手册 / 脚手架」**
   - 梳理你想先用于日常的场景（例如：只读监控 GitHub/依赖公告 `repo_triage` + Telegram 汇总、或特定发件人邮件拉取分诊 + 控制台审批回信）。
   - 生成一份 gitignored 私有配置模板 + 初始化检查脚本（验证锁定 Node、Docker 镜像就位、凭据槽位注册、owner scope 授权、启动 daemon 与读取 `4310` bootstrap token）。
2. **路线 B：顺手清理 Phase 5 遗留的小瑕疵（低风险 P3 补丁）**
   - 修复 `allowedRecipients` 配置边界大小写归一化，消除 `mail-triage.mjs` 与 `adapters.mjs` 的大小写失配陷阱；
   - 清理 `briefing-followup.mjs:174,218` 残留 `content_hash` 读取与死辅助 `enqueuePlain`；
   - 如有需求，补齐 `CALDAV_*` 环境变量完成真实日历只读验证。
3. **路线 C：按实际体验决定是否增强通用助手编排**
   - 决定是否需要让 Telegram 私聊或邮件分诊接出更顺手的“多轮只读检索 + 生成外部写审批卡”轻量闭环（不引入失控自循环，继续严守 CP2/CP4 与人工点击审批）。

---

## 六、硬红线速查（下轮对话不可违反）

- **Node 锁**：必须使用 `D:\AegisPi\tools\node-v22.23.5\node.exe`，禁用 `PATH` 默认 `node`。
- **安全配置**：仓库 `apps/daemon/config/defaults.json` 必须保持全失败关闭，个人实跑开关只写进 gitignored 的外部 `--config` 文件。
- **密钥零落地**：绝不读取打印 `.env` 具体值，绝不把 token/邮箱/个人聊天 ID 提交进仓库。
- **真实入口守卫**：不擅自触发带 `AEGISPI_ALLOW_REAL_*` 的真实外部发送/消费脚本；若改动产品源码后跑容器套件，必须先核验 `probe-evidence-holds.mjs` 或按纪元机制重建对应镜像。
- **工作区清理**：当前 `docs/HANDOFF-PHASE5-TO-SELFUSE.md` 为本次新增交接文件；下轮开始如需保持零脏文件状态，可决定提交归档或移至个人笔记区。
