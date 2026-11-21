# AegisPi

自托管、事件驱动的个人常驻 Agent 系统（实现仓库）。边界原则：宿主 daemon 单点持有 ACL、预算、审批、凭据与外部提交器；模型文本与工具结果从不授予权限（`AGENTS.md` §5）。本仓库公开，密钥与人工判断标注一律不入库。

## 当前位置（2026-11-21）

- Phase 1（底座契约）与 Phase 2（持久化只读链路）已收口；**Phase 3 出口 MET WITH RESIDUAL RISKS**，其中 `44b3514` 两项限定修复已独立验收关闭，不重开。
- 模型链路设计 [ADR-0001](docs/adr/0001-model-path-pi-host-execution.md) **已在单元 4.1 落地、通过独立对抗审计并按路线 A 冻结于 `8943a10`（纪元 5）**（[单元 4.1 收口报告](docs/phase4/reports/phase4-1-closure.md)、[独立审计报告](docs/phase4/audits/AUDIT-PHASE4-UNIT4-1-8943a10.md)）。
- Phase 4 单元 4.2 **许可 1 离线闭环**（[4.2 离线任务书](docs/phase4/phase4-2-offline-task-spec.md)、[4.2 离线收口报告](docs/phase4/reports/phase4-2-offline-closure.md)）与 **许可 2 广度真实 Repo Observe 验收**（6 个锁定 commit 公开仓库 + 真实 DeepSeek `8/8 PASS`，[4.2 实测验收报告](docs/phase4/reports/phase4-2-real-acceptance.md)），以及 **单元 4.3 核心修复与 Telegram Bot 出站适配器**（[4.3 收口报告](docs/phase4/reports/phase4-3-closure.md)，镜像**纪元 7** 全量 13 套件 + Hono 预检通过）均已在本地完成；**`defaults.json` 保持全失败关闭、`telegram.allowRealSend=false`、`repo-observe-real` 需 `AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE=1`（缺省 exit 4），不构成常开、真实 Telegram 外发或入站授权。**
- **不常开。** 无任何新增真实模型、Telegram、外部写或公网入口授权；默认配置保持失败关闭。
- 任务预算 $0.80、日预算 $5 已定，不重开；真实运行前的价格目录、token 约束与单次预留确认属首跑检查表核对，不是重新讨论预算。
- 真实验收 A（模型）/B（外部写）/C（Telegram 只读）各已执行一次且授权闭合，**无剩余额度**；D（公网 webhook）延期至首次启用 Telegram 公网入站 webhook 前，且不作为全部 Phase 4 的前置条件；出站发送另需授权。历史 A/B/C 缺证按既定口径归档不追补；原镜像按主人「本机验证通过即闭项」口径处理。
- 现行权威状态：[docs/phase3/reports/phase3-status-and-remaining.md](docs/phase3/reports/phase3-status-and-remaining.md)；文档索引：[docs/README.md](docs/README.md)。

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
- **三个应用镜像**（`docker/`；构建与推送仅至本机 loopback registry `127.0.0.1:5000`，容器 `aegispi-build-registry`）：`agent`（worker：`PI_OFFLINE=1`、凭据环境 denylist、对宿主仅 propose-only 通道）、`acquisition`（fail-closed 只读获取）、`execution`（无网 job）。镜像以 context digest 绑定源码树，image-gate 在每条 docker 套件前复算本树哈希，漂移即拒（exit 2）。现行纪元表：[docs/phase3/reports/image-digest.md](docs/phase3/reports/image-digest.md)。
- **失败关闭默认**（`apps/daemon/config/defaults.json`）：`model.baseUrl=null`、`model.allowedPurposes=[]`、`model.allowedModelIds=[]`、`allowRealModelCalls=false`、`allowRealExternalWrites=false`、`upstream.submitUrl=null`、`telegram.apiBase=null`、`telegram.allowRealSend=false`、价格目录四项均 `null`、凭据槽 `null`——未授权即零调用、零外发。

## 已实现 / 未实现（防误读）

**已实现并经离线套件在案验证**（最近记录见下节）：

- 持久化与恢复：SQLite WAL 事务、崩溃恢复、一致性备份窗口（durability、restore 套件；扩展表 `model_requests` 经独立幂等建表按需启用，在 `schema_migrations` 之外）。
- 预算账本与门禁：任务/日双账户、reserve/settle/HELD/CHARGED_BOUND/超限冻结（budget、security-unit 套件）。
- scope ACL 与审批/取消流（acl、cancel-approval 套件）。
- 离线 job 容器执行与磁盘水位（offline-jobs 套件；docker）。
- Telegram 入站解析（本地夹具，零真实外联；ingress-telegram 套件）。
- 应用镜像真实构建（现行**纪元 7**）、digest 绑定与门禁、容器配额实测（三 docker 套件 + `test:model-proposal` + `test:repo-observe` + `test:quota-calibration`）。
- 容器→宿主模型提议与宿主 `pi-ai@1.5.2` 单一执行核心：`model_request` 闭信封与 `model-result-<uuid>.json` 通道、`model_requests` 七态状态机与同事务预留/结算（含空回复 `infra_error` 防误判）、Windows 宿主程序化 `icacls` 锁定 `proposals` 目录及 POSIX 权能拒绝校验（`model-proposal` 15/15、`security-unit` 45/45，零真实推理调用）。
- 只读 Repo Observe 离线编排（许可 1）：`--acquisition-image=<digest>` 启动器、`sha256` 钉住归档下载与脱敏有界 `repo_observe_manifest` + `derived_from` 溯源、稳态 KV 前缀提示词、前置与后置 `maxInputBytes`/`maxOutputTokens` 门禁及 Observe `HELD` 停机语义（`test:repo-observe` 7/7，零真实仓库拉取与模型调用）。
- Fail-closed Telegram Bot 出站适配器：`telegram-send.mjs` + `upstream-telegram-child.mjs`（`stdin` 传参、非空 `allowedRecipients` 门禁、`allowRealSend` 非环回门禁、动态 `im` 槽位解析与全链 token 脱敏；已通过环回集成验证，零真实外发）。

**已执行过且仅限单次授权的真实验收**（默认禁止重跑，均受环境变量/证据守卫或仅限本次纪律约束）：A 真实模型 1 次；B 真实外部写 1 次；C Telegram 只读 2 次；**单元 4.2 广度真实 Repo Observe 1 轮（6 个锁定 commit 公开 GitHub 仓库 + 真实 DeepSeek 8/8 PASS，`evals/phase4/repo-observe-real/run.mjs` 需 `AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE=1`）**。

**未实现 / 未授权**（不得当已实现或已放行）：

- 真实 Telegram Bot 出站消息实盘发射授权（出站代码已完成环回验证，`defaults.json` 的 `telegram.apiBase` / `telegram.allowRealSend` / `policy.allowRealExternalWrites` 仍保持关闭，待后续授权确认后触发）与公网入站 webhook（D，延期）。
- Scenario 4 完整 `repo_triage` 判定闭环（基准/目标复现与 `eval:triage` / `report:user-value`，单元 4.4 正在实施）与常开运行。

## 运行前置条件

1. 锁定 Node 显式路径调用（`D:\AegisPi\tools\node-v22.23.5\node.exe`）；PATH 上的其他 Node 仅开发用途。
2. 依赖安装：`npm ci`（根 `package-lock.json`，workspaces 布局；不新增依赖——新增依赖先审来源与必要性，AGENTS §1）。daemon 及多数套件要求 `node_modules` 已安装（缺失时 import 期 fail-fast）。
3. 三个 docker 套件另需 Docker（在案环境：Docker 29.9.2，linux/amd64）与本机构建 registry 容器 `aegispi-build-registry`（`127.0.0.1:5000`，registry:2；勿动其他项目的容器）。
4. 凭据只写本机 `.env`（已 gitignore；`.env.*` 同样不入库）；密钥不进代码、日志、prompt 与 URL。
5. 设计包在本机 `D:\AegisPi\aegis-pi-design-pack-v1.4.1`（不分发，见上）。

## 离线测试命令（已确认在案）

`package.json` 脚本名与实际入口一致（`node evals/…`）。锁定 Node 显式路径执行：

| 套件（npm 脚本） | 需 Docker | 最近在案全量记录（单元 4.3 纪元 7 终树，2026-11-21） |
| --- | --- | --- |
| `test:contracts`（PI-01..13 契约探针 + LF 分帧 + SQLite 门禁） | 否 | 15/15 PASS，exit 0 |
| `test:durability` / `test:acl` / `test:budget`（Phase 2 三套件） | 否 | 164/164、15/15、20/20，exit 0 |
| `test:cancel-approval` / `test:security:unit` / `test:restore` | 否 | 16/16、45/45、11/11，exit 0 |
| `test:ingress-telegram`（本地夹具） | 否 | 7/7 + 1 NOTE，exit 0 |
| `test:model-proposal`（4.1 锚点 E2E + T1–T10 + 生产启动器 + 空回复拦截） | 是 | 15/15 PASS，exit 0 |
| `test:repo-observe`（4.2 离线 Observe + KV 前缀稳定 + 容量前置拦截） | 是 | 7/7 PASS，exit 0 |
| `test:offline-jobs` / `test:security:integration` / `test:quota-calibration`（Phase 3 三 docker 套件） | 是 | 14/14、29/29、5/5，exit 0（纪元 7） |
| hono 配对自检（非 npm 脚本）：`node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 否 | lockfile sha 双核对 exit 0 |

在案证据：[docs/phase4/reports/phase4-3-closure.md](docs/phase4/reports/phase4-3-closure.md)、[docs/phase4/reports/phase4-2-offline-closure.md](docs/phase4/reports/phase4-2-offline-closure.md)、[docs/phase4/reports/phase4-1-closure.md](docs/phase4/reports/phase4-1-closure.md)、[phase3-status-and-remaining.md](docs/phase3/reports/phase3-status-and-remaining.md) §5 与 [image-digest.md](docs/phase3/reports/image-digest.md)。以上 13 套离线/容器脚本与 Hono 预检均已在纪元 7 终树以锁定 Node v22.23.5 全量实跑通过（零真实推理调用、零真实仓库拉取、零真实 Telegram 外发）。

## 真实入口（不进快速开始）

以下入口对应已闭合的一次性授权，**一律不重跑**（包括缺凭据或「模拟」模式——历史教训：曾因误触造成计划外调用）：

- `npm run test:model:real`（A 真实模型）；`npm run test:external-write:real`（B 真实外部写，其 postverify 属实施者自查非独立审计）；`npm run test:ingress-telegram:real`（C Telegram 只读）。

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
