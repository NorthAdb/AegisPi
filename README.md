# AegisPi

> **状态归档（`v1-zero-trust-baseline`）**：当前分支为 **AegisPi v1**（Phase 1–5 + 个人自用控制台与热重载配置，`327/327 PASS`）已完成并正式封存的零信任基线版本。后续架构演进为基于 `@earendil-works/pi-durable@1.6.0` + `@earendil-works/pi-mcp@1.6.0` 的纯 TypeScript v2 主线，v1 剩余缺口处置与核心资产复用清单见 [docs/V1-CLOSURE-AND-V2-MIGRATION.md](docs/V1-CLOSURE-AND-V2-MIGRATION.md)。

自托管、事件驱动的个人常驻 Agent 系统（实现仓库）。边界原则：宿主 daemon 单点持有 ACL、预算、审批、凭据与外部提交器；模型文本与工具结果从不授予权限（`AGENTS.md` §5）。本仓库公开，密钥与人工判断标注一律不入库。

## 本地启动控制台

安装锁定依赖后，在仓库根目录用默认配置启动。以下命令使用独立的本地数据目录，不需要 Docker 或 `.env`，真实模型、Telegram、邮件和日历集成默认关闭。

```powershell
& 'D:\AegisPi\tools\node-v22.23.5\node.exe' apps/daemon/src/daemon.mjs --data-dir=workspace-state/console-preview
```

终端出现 `daemon: open` 后，打开 [本地控制台](http://127.0.0.1:4310/)，用 `workspace-state/console-preview/console/token` 文件里的凭据登录。可以在聊天区输入 `/status` 查看运行状态。按 `Ctrl+C` 停止前台进程。

需要接入外部服务时，参见 [个人自用指南](docs/SELF-USE-GUIDE.md)。

## 当前位置（2026-11-25，v1 正式封存）

- **Phase 1–5 全部收口通过**：Phase 1（底座契约）、Phase 2（持久化只读链路）、Phase 3（安全边界）、Phase 4（`eval:triage:real` 6/6 + 终局审计）及 Phase 5（`D-102` 单元 5.6 实盘验收 + `D-103` 终局独立对抗审计 `PASS WITH RESIDUALS`）全部收官闭合；`report:user-value` 全绿 **327/327 PASS**（`defaultsFailClosed=true`、`secretScan=clean`）。
- **个人自用与 Web 控制台闭环（`289bd42`–`1b847e7`）**：已完成 `scripts/selfuse.mjs start` 零参数冷启动、scoped 多轮对话历史（`GET/POST /api/chat`）、本地控制台五页签（含 **`⑤ 设置与接入`** 可视化表单、连通性探针与原地热重载）及 `evals/phase5/selfuse/run.mjs`（**31/31 PASS**）。
- **`defaults.json` 与守卫保持失败关闭**：`model.baseUrl=null`、`allowRealModelCalls=false`、`allowRealExternalWrites=false`、`telegram.allowRealSend=false`、`mail.allowRealMailSend=false`；6 个 `*-real` 入口缺省无授权环境变量时直接 `exit 4`。
- **现行应用镜像**：见 [docs/phase3/reports/image-digest.md](docs/phase3/reports/image-digest.md)（`agent:phase3-357d3a70e2ea` manifest `sha256:a3d84892…`，`acquisition` 与 `execution` 沿用已验证 digest）。
- **v1 封存与 v2 路线**：本分支已在 `v1-zero-trust-baseline` 正式封存，不在 v1 继续推进旧 Phase 6；所有设计差额处置与 v2 复用清单详见 [docs/V1-CLOSURE-AND-V2-MIGRATION.md](docs/V1-CLOSURE-AND-V2-MIGRATION.md)。文档总索引见 [docs/README.md](docs/README.md)。

## 规范来源

唯一规范是本机的 `aegis-pi-design-pack-v1.4.1` 资料包（`D:\AegisPi\aegis-pi-design-pack-v1.4.1`）。该包不随本库分发，避免公开设计全文与规范多副本漂移；本库只记录其版本、入口证据与指针。需要修订契约时读原包，不在本库复制其规范正文。仓库级硬约束见根 [AGENTS.md](AGENTS.md)。

入口证据（2026-11-18）：`python -X utf8 validation/validate_pack.py` 在包目录运行，14 项全 PASS，CONNECTIONS_LEFT=0，SQLite 3.45.3（Python 侧）、27 表、FTS5+trigram 可用。

## 锁定版本

| 项 | 值 | 证据 |
| --- | --- | --- |
| Node.js | 22.23.5 LTS（Jod），显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`（npm 10.9.9）；套件对非锁定 Node exit 2 | nodejs.org/dist/index.json 2026-11-18 复核；安装 zip SHA256 4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3 |
| Pi 底座 | `@earendil-works/pi-coding-agent` exact 1.5.2（含传递依赖 `@earendil-works/pi-ai@1.5.2`） | package-lock.json 完整性字段；`apps/daemon/package.json` |
| Hono | `hono` exact 4.13.19（daemon HTTP 宿主，「影响我」锚点） | package-lock.json 完整性字段 + `evals/contracts/fixtures/hono-triage/README.md` |
| SQLite | `node:sqlite`（内置 3.54.1，WAL + FULL） | `apps/daemon/config/defaults.json`；Phase 1 驱动选择报告 `docs/phase1/reports/sqlite-driver.md` |
| 主推理模型 | 显示名「DeepSeek Flash High」= provider `deepseek` / wire 模型 ID `deepseek-flash` / thinking high（Pi 1.5.2 内置目录真值，不编造标识符） | `docs/phase1/reports/model-binding.md`；`apps/daemon/config/defaults.json` |

## 核心架构（现行）

宿主单点持有权能，容器零信任：

- **宿主 daemon**（`apps/daemon/src/daemon.mjs`，单进程 tick 驱动，`--data-dir=<dir>` 缺省 `workspace-state/`）：调度租约（fence/lease 纪律）、预算账本（先 `reserve` 后调用，缺 usage 保持 HELD，超限结算后冻结账户）、scope ACL、审批与取消、凭据槽服务（密钥只在本机 `.env`）、容器执行器（`--network none`、tmpfs noexec、只读 bind、rootfs 只读）、SQLite WAL 持久化 + 崩溃恢复 + 一致性备份窗口、hono 控制台（本机绑定）。全部外部效果（模型调用、外部写、通知）只由宿主经门禁执行。
- **三个应用镜像**（`docker/`；构建与推送仅至本机 loopback registry `127.0.0.1:5000`，容器 `aegispi-build-registry`）：`agent`（worker：`PI_OFFLINE=1`、凭据环境 denylist、对宿主仅 propose-only 通道）、`acquisition`（fail-closed 只读获取）、`execution`（无网 job）。镜像以 context digest 绑定源码树，image-gate 在每条 docker 套件前复算本树哈希，漂移即拒（exit 2）。现行摘要见 [docs/phase3/reports/image-digest.md](docs/phase3/reports/image-digest.md)。
- **失败关闭默认**（`apps/daemon/config/defaults.json`）：`model.baseUrl=null`、`model.allowedPurposes=[]`、`model.allowedModelIds=[]`、`allowRealModelCalls=false`、`allowRealExternalWrites=false`、`upstream.submitUrl=null`、`telegram.apiBase=null`、`telegram.allowRealSend=false`、价格目录四项均 `null`、凭据槽 `null`——未授权即零调用、零外发。

## 已实现与 v1 封存边界（`v1-zero-trust-baseline`）

**已实现并经回归套件验证**（对应 v1 封存基线 `1b847e7` / `25fe3ea`）：

- 持久化与恢复：SQLite WAL 事务、崩溃恢复、一致性备份窗口（`durability` 164/164、`restore` 11/11；扩展表 `model_requests` 与 `credential_slots` 按需幂等建表）。
- 预算账本与门禁：任务 `$0.80` / 日 `$5.00` 双账户、reserve/settle/HELD/CHARGED_BOUND/超限冻结（`budget` 20/20、`security:unit` 68/68）。
- scope ACL 与审批/取消流（`acl` 15/15、`cancel-approval` 20/20）。
- 离线 job 容器执行与逃逸/配额隔离（`offline-jobs` 14/14、`security:integration` 29/29、`quota-calibration` 5/5）。
- Telegram 入站解析与多通道 Canary 隔离（`ingress-telegram` 7/7、`cross-channel` 25/25）。
- 分层记忆 L0–L3、13 类注入扫描与墓碑遗忘恢复（`memory-lifecycle` 47/47）。
- 邮件分诊审批与晨报/条件 Timer/日历环回夹具矩阵（`scenarios` 89/89）。
- 容器→宿主模型提议、只读 Repo Observe 与 Scenario 4 `repo_triage`（`model-proposal` 15/15、`repo-observe` 7/7、`triage` 7/7）。
- 个人自用冷启动、scoped 多轮对话与 Web Console `⑤ 设置与接入` 原地热重载（`selfuse` 31/31）。

**已执行过且仅限单次/按需授权的真实验收**（默认禁止重跑，均受环境变量或文书守卫约束）：A 真实模型 1 次；B 真实外部写 1 次；C Telegram 只读 2 次；单元 4.2 真实 Repo Observe `8/8 PASS`；单元 4.5 真实 `repo_triage` `6/6 PASS`；单元 5.6 实盘验收 1 批（真实 `getUpdates` 隔离 + 真实邮箱 IMAP→DeepSeek→4310 审批→SMTP 恰 1 封回信，详情见 [Phase 5 终局收口报告](docs/phase5/reports/phase5-final-closure.md)）。

**v1 封存边界（不在 v1 继续补充，分别随 v1 封存、长期后置或移交 v2）**：

- 公网入站 webhook（随 v1 封存抛弃，v1 统一走路线 1 `getUpdates` 长轮询）。
- 真实 CalDAV 日历实盘（`CALDAV_*` 长期后置，场景二由环回 TLS 夹具 `eval:scenarios` 89/89 验证在案）。
- 容器内多步工具循环、GitHub PR 真实写传输、旧 Phase 6 终态四视图与重型评测矩阵等（全部处置结论见 [docs/V1-CLOSURE-AND-V2-MIGRATION.md](docs/V1-CLOSURE-AND-V2-MIGRATION.md)）。

## 运行前置条件

1. 锁定 Node 显式路径调用（`D:\AegisPi\tools\node-v22.23.5\node.exe`）；PATH 上的其他 Node 仅开发用途。
2. 依赖安装：`npm ci`（根 `package-lock.json`，workspaces 布局；不新增依赖——新增依赖先审来源与必要性，AGENTS §1）。daemon 及多数套件要求 `node_modules` 已安装（缺失时 import 期 fail-fast）。
3. Docker 套件需 Docker（在案环境：Docker 29.9.2，linux/amd64）与本机构建 registry 容器 `aegispi-build-registry`（`127.0.0.1:5000`，registry:2；勿动其他项目的容器）。
4. 凭据只写本机 `.env`（已 gitignore；`.env.*` 同样不入库）；密钥不进代码、日志、prompt 与 URL。
5. 设计包在本机 `D:\AegisPi\aegis-pi-design-pack-v1.4.1`（不分发，见上）。

## 离线测试命令（v1 封存全量基线）

`package.json` 脚本名与实际入口一致（`node evals/…`）。锁定 Node 显式路径执行：

| 套件（npm 脚本） | 需 Docker | v1 封存实测（锁定 Node v22.23.5） |
| --- | --- | --- |
| `report:user-value`（全量聚合与 defaults 失败关闭确认） | 否 | **327/327 PASS**，exit 0（`defaultsFailClosed=true`，`secretScan=clean`） |
| `test:selfuse`（零参数冷启动、Web 设置热重载与探针脱敏） | 否 | **31/31 PASS**，exit 0 |
| `test:contracts`（PI-01..13 契约探针 + LF 分帧 + SQLite 门禁） | 否 | 15 probe(s) PASS，exit 0 |
| `test:durability` / `test:acl` / `test:budget`（Phase 2 三套件） | 否 | 164/164、15/15、20/20，exit 0 |
| `test:cancel-approval` / `test:security:unit` / `test:restore` | 否 | 20/20、68/68、11/11，exit 0 |
| `test:ingress-telegram`（本地夹具） | 否 | 7/7 + 1 NOTE，exit 0 |
| `test:memory-lifecycle`（Phase 5.1 分层记忆/墓碑遗忘/技能与 Spill） | 否 | 47/47 PASS，exit 0 |
| `test:cross-channel`（Phase 5.2 Telegram 路线 1 拉取 + Canary 隔离） | 否 | 25/25 PASS，exit 0 |
| `eval:scenarios`（Phase 5.3+5.4 邮件/Timer/日历/Dreaming 环回 TLS 夹具） | 否 | 89/89 PASS，exit 0 |
| `test:model-proposal`（4.1 锚点 E2E + T1–T10 + 生产启动器 + 空回复拦截） | 是 | 15/15 PASS，exit 0 |
| `test:repo-observe`（4.2 离线 Observe + KV 前缀稳定 + 容量前置拦截） | 是 | 7/7 PASS，exit 0 |
| `eval:triage`（Scenario 4 基准/目标双执行 + 四分类神谕 + 环回通知） | 是 | 7/7 PASS，exit 0 |
| `test:offline-jobs` / `test:security:integration` / `test:quota-calibration` | 是 | 14/14、29/29、5/5，exit 0 |
| hono 配对自检（非 npm 脚本）：`node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 否 | lockfile sha 双核对 exit 0 |

在案证据：[docs/phase4/reports/phase4-5-closure.md](docs/phase4/reports/phase4-5-closure.md)、[docs/phase4/reports/phase4-4-closure.md](docs/phase4/reports/phase4-4-closure.md)、[docs/phase4/reports/user-value-report.md](docs/phase4/reports/user-value-report.md)、[docs/phase4/reports/phase4-3-closure.md](docs/phase4/reports/phase4-3-closure.md)、[docs/phase4/reports/phase4-2-offline-closure.md](docs/phase4/reports/phase4-2-offline-closure.md)、[docs/phase4/reports/phase4-1-closure.md](docs/phase4/reports/phase4-1-closure.md)、[phase3-status-and-remaining.md](docs/phase3/reports/phase3-status-and-remaining.md) §5 与 [image-digest.md](docs/phase3/reports/image-digest.md)。以上 15 套离线/容器脚本（含 `image-gate`）、`report:user-value` 与 Hono 预检均已在纪元 11.5 终树以锁定 Node v22.23.5 全量实跑通过（零真实推理调用、零真实仓库拉取、零真实 Telegram 外发）。

## 真实入口（不进快速开始）

以下入口对应已闭合或环境变量严格守卫的真实验收，**禁止盲跑/自动进快速开始**（缺省无环境变量时，Phase 4 真实验收入口直接拒绝退出码 `4`）：

- `npm run test:model:real`（A 真实模型）；`npm run test:external-write:real`（B 真实外部写，其 postverify 属实施者自查非独立审计）；`npm run test:ingress-telegram:real`（C Telegram 只读）。
- `evals/phase4/repo-observe-real/run.mjs`（需显式 `AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE=1`，缺省 `exit 4`）；`npm run eval:triage:real`（需显式 `AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE=1`，缺省 `exit 4`）。
- `npm run eval:scenarios:real`（单元 5.6 许可 2 实盘验收：Telegram Pull 隔离 + 真实邮箱草稿审批发送 + CalDAV 登记边界；需显式 `AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE=1`，缺省 `exit 4`；`--finalize-kept-workspace` 为其零外部副作用的证据补齐模式）。

任何真实模型调用、Telegram 调用、外部写或公网入口，须先获主人逐项书面授权（口径「仅限本次」）；授权闭合是文书纪律，不是代码保证。D 公网 webhook 未授权、未执行。详见[权威状态清单 §1](docs/phase3/reports/phase3-status-and-remaining.md)。

## 目录

```text
apps/daemon/          宿主 daemon（config/defaults.json 唯一策略默认 + src/：scheduler、budget、acl、credentials、container-executor、console 等）
docker/               agent / acquisition / execution 三个镜像源（构建仅推本机 loopback registry）
evals/                分阶段离线套件与夹具（contracts、phase2 三套件、phase3 十一条脚本含 model-proposal、hono oracle 夹具）
docs/                 文档索引见 docs/README.md（现行规范 / 设计决策 / 阶段计划 / 状态说明 / 历史审计与证据）
.audit/               决策留痕（decision-trail.tsv，逐轮追记）
```

`workspace-state/`（原始数据、DB、对象、备份）与私密人工判断标注一律不入库。

## 文档入口

[docs/README.md](docs/README.md) 是统一索引：分类指路（现行规范、设计决策、阶段计划、状态说明、历史审计/证据）并给出新人阅读顺序；README 只保留指针，不复制各文档正文。
