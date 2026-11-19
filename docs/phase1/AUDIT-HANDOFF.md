# Phase 1 审计移交报告（给下一个审计 agent）

生成：2026-11-18 初版；2026-11-19 四轮审计整改期间多次修订；**本版为 Phase 1 收口后状态**。执行方：实施会话（OpenCode）。本文件是自审 + 交接的单一入口。

## 0. 当前状态（一句话）

**Phase 1 已收口（2026-11-19，owner 授权）**：四轮外部审计——第 4 轮判定技术整改通过（N9/N10/N11 独立红绿实测关闭，无新技术阻塞），第 4 轮所余两项用户侧开放（75 条标注 owner 确认、Telegram getMe/getChat）随后由 owner 完成并经机器复测闭合（evidence/07）；收口级最小验收全绿（套件 15/15 退出码 0、配对自检 0、包验证器 14/14）。收口声明 `reports/phase1-closure.md`，四轮审计史 `reports/audit-history.md`，审计原稿归档 `docs/phase1/audits/`。**Phase 2 未开工**；入口条件见第 7 节。

## 1. 本阶段目标（复述）

按开工检查单授权执行 Phase 1（用户基线与底座契约）：核验 exact Pi 1.5.2 的 PI-01~PI-13 契约、在锁定 Node.js 22.23.5 上复测 LF 分帧与 SQLite 驱动、绑定「DeepSeek Flash High」真实模型 ID、记录官方基础镜像真实 digest、用 honojs/hono 真实样本建立 oracle/manifest 夹具。不做四场景实现、不接真实外部写（本仓库自身授权推送除外）、不做逃逸测试。**本轮授权新增**：一次 DeepSeek 最小真实推理（owner-baseline §4）、Telegram 只读身份核验、75 条标注草案生成。

## 2. 版本快照

| 项 | 值 | 锁定证据 |
| --- | --- | --- |
| 实现仓库 | https://github.com/NorthAdb/AegisPi main | HEAD 见 git log（推送记录） |
| Node | 22.23.5（显式路径；他机用 `AEGISPI_NODE_BIN` 覆盖，探针校验子进程版本） | evidence/01-node-lock.md |
| Pi | @earendil-works/pi-coding-agent 1.5.2 exact | package-lock integrity sha512-mUWI04…lom5yA== |
| hono | 4.13.19 exact | package-lock integrity sha512-KmXvQ…fkA== |
| SQLite 驱动 | node:sqlite（内置 3.54.1） | reports/sqlite-driver.md |
| 模型 | deepseek/deepseek-flash + thinking high | reports/model-binding.md（**最小推理契约已实测通过**，evidence/07） |
| 基础镜像 | node:22.23.5-bookworm-slim @ OCI index sha256:e9f565d3…（amd64 清单 sha256:47725aca…，第二轮复审对 registry 核验一致） | reports/image-digest.md |
| 规范包 | D:\AegisPi\aegis-pi-design-pack-v1.4.1（本地，不随库分发，D-01） | evidence/00-pack-validation.txt；schema.sql SHA-256 ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995（与审计环境一致） |
| 审计原稿归档 | docs/phase1/audits/（按被审 SHA 命名，字节一致可复算） | 第三轮原稿 SHA-256 49DB996B… |

## 3. 三轮审计/复审结论与整改（本轮审计者的必读映射）

**第一轮审计**（Ubuntu 24.04.5 / 锁定 Node 复跑退出码 0，判定 Phase 1 未完成）：P1-1..P1-5 整改映射在 `reports/audit-response.md`（route 双路径、字面量清零、GHSA-88fw 恢复 + 第二对 oracle、真实 4.12.24 锁、todo 拆分）。

**第二轮复审**（同环境，对象 `87aa728`，判定"整改未通过"）：N1 套件退出码、N2 cacheWarming 真实路径、N3..N8。整改映射在 `reports/re-review-response.md`——其中 N4 的"honoFrom=参数目录"字符串自证被第三轮 N9 证明不足（历史文档保持原样）。

**第三轮复审**（同环境，对象 `e7b93b7`，判定"整改未通过"于**N9 新假绿**；原稿归档 `audits/AUDIT-PHASE1-REREVIEW-e7b93b77612674f4759bfb47f42a01ec3a82b042.md`）整改映射在 **`reports/audit-e7b93b7-response.md`**：

- **N9**：`createRequire` 上溯使未安装快照被仓库 4.13.19 顶替出 exit 0 假绿。两检查加**解析遏制**（`require.resolve` 真实路径必须落在参数目录内，否则 exit 2；`honoFrom` 输出真实模块路径）；配对工具改核真实路径 + 新增未安装快照必须 exit 2 两行。三复现点全测（evidence/06）。
- **N10**：`--only` 零命中 → 退出码 1（`NOTHING RAN`），实测在案；纯 note 行为未回退。
- **N11**：缺 usage 谓词补齐九个数字字段逐项 `=== 0`；双突变（cost.total / totalTokens）实测变红，还原哈希相等复绿；零值仍无"结清成功"语义。
- 审计 §3"加载器无产品入口"：如实写明（response 文档 + 本报告 §5）——`piSettingsFromDefaults` 目前仅探针引用，daemon 无运行入口，**运行时接线是 Phase 2 义务**。

**第四轮复审**（同环境，对象 `ff6e497`，判定**技术整改通过**；原稿归档 `audits/AUDIT-PHASE1-REREVIEW-ff6e497d066a875acb50e65b3acce45985bb4b20.md`）：N9/N10/N11 由审计方独立红绿实测关闭（含路径规范化、同前缀兄弟目录、空目录、未安装快照全部 exit 2；双突变复现；配对工具退出码 0）；无新技术阻塞；判定 Phase 1 未完成仅余 owner 确认标注与 Telegram getMe 两项用户侧条件——二者随后由 owner 完成/修正并复测通过（标注终态 39/36/0；Telegram 复测退出码 0，startConfirmed=true，evidence/07 §2/§3）。同轮明示：`load-pi-settings.mjs` 接入 daemon 是 Phase 2 实现工作，不是 Phase 1 缺陷。

## 4. 行为证据（真实运行命令与退出码）

- **`npm run test:contracts`**（锁定 Node）：15 探针全 PASS，退出码 0（2026-11-19 第三轮整改后全量复跑）。机器结果 `evidence/contracts-report.json`。Linux 主机设 `AEGISPI_NODE_BIN`；单次全量约 3-6 分钟（真实 Pi CLI 子进程 + 本地 fake OpenAI）。
- **hono 双 oracle 配对自检**：`node evals/contracts/tools/verify-hono-oracle-pair.mjs` 退出码 0——已安装矩阵（4.13.19 csrf/cors 0/0；4.12.24 1/1）+ **解析路径遏制** + **两个未安装快照双检查 exit 2** + lockfile 哈希复算（e5d0c57e… / db2bb134…）。
- **第三轮红证**（evidence/06）：未安装快照 → 双检查 exit 2（打印真实上溯路径）；仓库外空目录 → exit 2；`--only=does-not-exist` → 退出码 1；PI-10 双突变 → FAIL 退出码 1（还原复绿）。
- **前两轮红证**（维持有效）：纯 note 探针 → SKIP → 退出码 1（evidence/05）；`result("PASS")` 升格封死；mutation 变红（evidence/04）。
- **DeepSeek 最小推理契约（真实调用）**：`node evals\phase1-closure\verify-deepseek-minimal.mjs` → 退出码 0——`deepseek-flash` + thinking high 被真实 API 接受（stopReason=stop），回复 "OK"，usage 461+2=463，目录价 cost.total $0.0001407，904ms。单次、无重试、未换模型；密钥仅本机进程内加载。脱敏证据 `evidence/07-real-connections.md`。
- **Telegram 身份核验（只读，收口闭合）**：直连被本机网络阻断（DNS 污染 + TCP 不通）；经本机系统代理（WinINET `127.0.0.1:7897`，用户自配，脚本自实现 CONNECT 隧道零依赖）——**getMe 通过**（@aegispibot、is_bot=true）。首次 getChat 曾返回 "chat not found"，根因是 `.env` 的 `TELEGRAM_OWNER_USER_ID` 值含字母非纯数字（getUpdates 队列空）；**owner 改为数字 user ID 后复测通过**（`verify-telegram-identity.mjs` 退出码 0，ownerChat chatType=private、idMatchesOwner=true、startConfirmed=true），全程未发送任何消息。脱敏证据 `evidence/07-real-connections.md` §2。
- **`python -X utf8 validation/validate_pack.py`**（包目录）：14/14 PASS、CONNECTIONS_LEFT=0（evidence/00/04；本轮未改受包约束文件）。
- **失败与修复用例（如实记录）**：`tools: []` 压掉扩展工具；`bindExtensions()` MCP 专用；compact keepRecentTokens 门禁；typebox `Type` 命名空间对象；RPC 扩展需 settings.json 注册；第二轮：hono cwd 误信、Windows spawn `.cmd` 需 shell；第三轮：**`honoFrom=参数目录` 字符串自证被上溯攻破（N9）**——自证自此必须是真实解析路径 + 遏制断言。

## 5. 风险与未决（如实）

见 `reports/phase1-open-items.md`。收口后现状：**75 条标注已由 owner 确认**（原 12 条 uncertain 对照官方发行说明复核后转「可忽略」，终态 该关注 39 / 可忽略 36 / uncertain 0；确认记录在本地 owner-baseline §3，labels 文件本地不入库）；**Telegram ownerChat 确认已闭合**（owner 修正 `.env` 的 ID 值后复测退出码 0，startConfirmed=true，evidence/07 §2）；**加载器无产品入口**——`load-pi-settings.mjs` 目前仅被 PI-13 探针引用，daemon 运行时接线属 Phase 2，"探针调用了加载器"≠"运行时强制 off"；宿主 HELD 账本未实现（Phase 2）；三个应用镜像未构建；容器配额占位。

**本阶段宣称的"完成"范围**：契约核验（三轮整改后）、驱动选择、模型绑定（**含真实最小推理**）、镜像 digest、双 oracle 夹具（A1/A2 实测 + 遏制自检）、写入链路证实、三轮审计整改、DeepSeek 最小推理、**75 条标注 owner 确认（终态 39/36/0）**、**Telegram 身份与 ownerChat 确认（复测退出码 0）**、审计原稿归档、**Phase 1 收口（owner 授权 + 第四轮技术判定，见第 0 节与 `reports/phase1-closure.md`）**。**不宣称**：产品实现、安全实测、缓存/性能数字。

## 6. 审计建议入口（从哪里开始核）

1. 读 `reports/audit-e7b93b7-response.md`（第三轮 N9/N10/N11 → 修复 → 证据）与归档原稿 `audits/AUDIT-PHASE1-REREVIEW-e7b93b77…md`（SHA-256 49DB996B…）。
2. 复跑最小验收：包目录 `python -X utf8 validation/validate_pack.py`（预期 14/14）；仓库 `npm run test:contracts`（预期 15/15，退出码 0）。
3. **第三轮门禁抽查**：对未安装快照 `node evals/contracts/fixtures/hono-triage/checks/csrf-textping-check.mjs evals/contracts/fixtures/hono-triage/snapshots/hono-4.12.24` 必须 **exit 2**；`node evals/contracts/run-contracts.mjs --only=does-not-exist` 必须退出码 **1**；`verify-hono-oracle-pair.mjs` 全绿（含 exit 2 两行）。
4. **第二轮门禁抽查**：纯 note 探针 → 套件退出码 1；`SettingsManager.inMemory(JSON.parse(defaults.json)).getCacheWarmingMode()` = idle（危险断言），经 `piSettingsFromDefaults` 后 = off；对已安装 4.12.24 跑双检查 exit 1。
5. **第一轮断言骨架**：PI-02 `ext-path-route-receives-ctx`（对照 loader.js:418）、PI-07 `no-dialog-replay-after-restart`、PI-10 `cost-totalFromProvider-is-boolean-false`（对照 pi-ai types.d.ts:318）。
6. 核对数值：`npm view hono@4.12.24 dist.integrity`（sha512-I36D1s…）；`Get-FileHash snapshots/hono-4.12.24/package-lock.json`（db2bb134…）。
7. grep 验证：probes 无 `probe.check("…", true, …)`；`grep -r "honoFrom" checks/` 应见真实路径赋值而非参数字符串。
8. 敏感内容核查：`git ls-files` 无 `.env` / labels / owner-baseline；`git check-ignore` 三者均命中规则。
9. 真实连接证据：evidence/07（DeepSeek 实测 + Telegram 网络诊断，脱敏）。

## 7. 阶段门禁（Phase 1 收口后 / Phase 2 开工前）

**Phase 1 已收口**（owner 授权 + 第四轮技术判定通过 + 用户侧两项复测闭合；声明 `reports/phase1-closure.md`）。Phase 2 开工前仍需：重跑第 6 节前两条最小验收（预期全绿）；开工者持有 schema.sql SHA `ede73eca…` 对应的 v1.4.1 包；daemon 加载 defaults.json 必须走 `load-pi-settings.mjs`（D-11，Phase 2 接线时生效）；如需第五轮外部审计复核后再开工，入口证据 = 本报告 + audit-history.md + phase1-closure.md + evidence/04-07。**本阶段未开工 Phase 2 任何产品代码**（inbox/Task/lease/daemon 入口均未写）。Phase 4 证据类工作（容器化 security_repro、真实 warm 计费）按规范另行安排。

## 8. 交接给下一会话的入口证据

Phase 2（持久化只读链路与恢复）入口 = 本报告 + `reports/phase1-closure.md`（收口声明与出口门禁对照）+ `reports/audit-history.md`（四轮审计史）+ `reports/audit-e7b93b7-response.md` + `reports/re-review-response.md` + `reports/audit-response.md` + `reports/PI-contract-report.md` + contracts-report.json + evidence/04-07。开工前先重跑第 6 节前两条最小验收，绿了再继续；schema/状态/事务的唯一规范仍是本机设计包 06 与其 schema.sql（D-01：包不随库分发）；Phase 2 daemon 必须经 `load-pi-settings.mjs` 加载 defaults.json（D-11）。
