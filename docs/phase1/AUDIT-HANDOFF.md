# Phase 1 审计移交报告（给下一个审计 agent）

生成：2026-11-18 初版；2026-11-19 第一轮审计整改；**同日第二轮复审整改后修订**。执行方：实施会话（OpenCode）。本文件是自审 + 交接的单一入口。

## 0. 当前状态（一句话）

第一轮审计 P1 与第二轮复审 N1～N8 **均已整改并复测**（套件退出码门禁、cacheWarming 真实路径、缺 usage 实测形状、hono 显式解析 + 入库快照、mutation/note-only 红证在案，15/15 全绿退出码 0）；**Phase 1 尚未收口**——DeepSeek 最小推理契约、通知渠道、基线三句话、75 事件标注确认是用户侧硬性项；Phase 2 开工门禁见第 7 节。

## 1. 本阶段目标（复述）

按开工检查单授权执行 Phase 1（用户基线与底座契约）：核验 exact Pi 1.5.2 的 PI-01~PI-13 契约、在锁定 Node.js 22.23.5 上复测 LF 分帧与 SQLite 驱动、绑定「DeepSeek Flash High」真实模型 ID、记录官方基础镜像真实 digest、用 honojs/hono 真实样本建立 oracle/manifest 夹具。不做四场景实现、不接真实外部写（本仓库自身授权推送除外）、不做逃逸测试。

## 2. 版本快照

| 项 | 值 | 锁定证据 |
| --- | --- | --- |
| 实现仓库 | https://github.com/NorthAdb/AegisPi main | HEAD 见 git log（推送记录） |
| Node | 22.23.5（显式路径；他机用 `AEGISPI_NODE_BIN` 覆盖，探针校验子进程版本） | evidence/01-node-lock.md |
| Pi | @earendil-works/pi-coding-agent 1.5.2 exact | package-lock integrity sha512-mUWI04…lom5yA== |
| hono | 4.13.19 exact | package-lock integrity sha512-KmXvQ…fkA== |
| SQLite 驱动 | node:sqlite（内置 3.54.1） | reports/sqlite-driver.md |
| 模型 | deepseek/deepseek-flash + thinking high | reports/model-binding.md（真实推理契约**未验证**，用户侧） |
| 基础镜像 | node:22.23.5-bookworm-slim @ OCI index sha256:e9f565d3…（amd64 清单 sha256:47725aca… 待本地复验） | reports/image-digest.md |
| 规范包 | D:\AegisPi\aegis-pi-design-pack-v1.4.1（本地，不随库分发，D-01） | evidence/00-pack-validation.txt；schema.sql SHA-256 ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995（与审计环境一致） |

## 3. 两轮审计/复审结论与整改（本轮审计者的必读映射）

第一轮审计（Ubuntu 24.04.5 / 锁定 Node 22.23.5 复跑退出码 0）：判定 Phase 1 未完成。P1-1..P1-5 整改映射在 **`docs/phase1/reports/audit-response.md`**（route 双路径、字面量清零、GHSA-88fw 恢复 + 第二对 oracle、真实 4.12.24 锁、todo 拆分）。

第二轮复审（同环境，对象 `87aa728`）：判定"整改未通过"，新发现 N1（套件纯 note 仍退出码 0）、N2（defaults.json 直读 Pi 设置 = idle，探针绿）、N3..N8。整改映射在 **`docs/phase1/reports/re-review-response.md`**：

- **N1**：运行器三条件门禁（FAIL / SKIP / 无 PASS 判据任一 → 退出码 1）+ `summarizeProbe` 升格路径封死；纯 note 探针红证（exit 1）与七条单元规则存 evidence/05。
- **N2**：唯一映射加载器 `apps/daemon/config/load-pi-settings.mjs`；文件直读 = idle（危险**作为断言**）、经加载器 = off（断言）——删加载器即红。
- **N3**：缺 usage 按实测形状断言（`totalFromProvider` 键缺失），零值不再当结清条件；HELD 台账明确"未实现、不宣称"。
- **N4**：hono 检查改 argv + createRequire 显式解析；从仓库对 4.12.24 实测 exit 1；误导性 cwd 注释删除。
- **N5**：快照 `package.json`+`package-lock.json` 入库，lockfileHash 可复算；配对自检工具每次运行复算并打印。
- **N6/N7/N8**：sqlite-driver.md 重写、02-pi-install engines 句修正、driver-selection note 按实际判据条件化。

## 4. 行为证据（真实运行命令与退出码）

- **`npm run test:contracts`**（锁定 Node）：15 探针全 PASS，退出码 0（2026-11-19 整改后全量复跑）。机器结果 `docs/phase1/evidence/contracts-report.json`（每探针 findings 含实测输出摘录）。复跑注意：探针启动真实 Pi CLI 子进程与本地 fake OpenAI 端点，单次全量约 3-6 分钟；Linux 主机设 `AEGISPI_NODE_BIN=<v22.23.5 二进制>`。
- **mutation 变红实测**：故意把 sqlite `synchronous-full` 期望改为 `===3` → 单探针 FAIL、退出码 1 → 还原复绿（`evidence/04-audit-response-verification.md`）。另有 grep 证明全库无残留 `probe.check("…", true, …)`。
- **`python -X utf8 validation/validate_pack.py`**（包目录）：14/14 PASS、CONNECTIONS_LEFT=0（v1 入口证据；本轮复核见 evidence/04）。
- **hono 双 oracle A1/A2**：四项检查全实测（argv 显式解析，`honoFrom` 自证来源）——csrf：403/exit 0 vs 200 放行/exit 1；cors：`acao:"*"` 不反射/exit 0 vs `acao:"https://attacker.example"` 反射/exit 1。一键复现：`node evals/contracts/tools/verify-hono-oracle-pair.mjs`（从入库快照 npm ci、断言 0/1 矩阵 + 解析来源 + lockfile 哈希复算，实测全 OK 退出码 0）。**从仓库目录对 4.12.24 跑必须 exit 1**（第二轮 N4 门禁）。
- **note-only 红证（第二轮 N1）**：临时纯 note 探针 → SKIP → 套件退出码 1（evidence/05）；`summarizeProbe` 七条规则单元核验（含 `result("PASS")` 不得升格纯 note）。
- **失败与修复用例（如实记录）**：探针迭代真实踩坑——`tools: []` 是显式空选择压掉扩展工具；`bindExtensions()` MCP 专用；compact 有 keepRecentTokens 门禁；typebox `Type` 是命名空间对象；RPC 模式扩展需 settings.json `extensions` 注册；**第二轮新增**：hono 检查的 cwd 误信（v1 注释与事实相反，改为 argv + createRequire 显式解析）；Windows 下 spawn `.cmd` 需 shell（配对自检工具踩坑即修）。

## 5. 风险与未决（如实）

见 `reports/phase1-open-items.md`。要点：DeepSeek 最小推理契约待 key；通知渠道与基线三句话待用户 → 75 事件标注未收口（提案含 High 锚点 GHSA-88fw，在本地 labels）；**宿主 HELD 账本未实现（Phase 2）**；三个应用镜像未构建（规范安排）；容器配额为占位。

**本阶段宣称的“完成”范围**：契约核验（两轮整改后）、驱动选择、模型绑定（目录层）、镜像 digest、双 oracle 夹具（A1/A2 实测 + 配对自检工具）、写入链路证实、两轮审计/复审整改。**不宣称**：产品实现、安全实测、缓存/性能数字、任何用户收益、Phase 1 收口。

## 6. 审计建议入口（从哪里开始核）

1. 读 `reports/re-review-response.md`（第二轮 N1..N8 → 修复 → 证据）与 `reports/audit-response.md`（第一轮 P1）。
2. 复跑最小验收：包目录 `python -X utf8 validation/validate_pack.py`（预期 14/14）；仓库 `npm run test:contracts`（预期 15/15，退出码 0）。
3. **第二轮门禁抽查**：临时把任一探针换成纯 note 模块 → 套件必须退出码 1（evidence/05 有本次红证）；`SettingsManager.inMemory(JSON.parse(defaults.json)).getCacheWarmingMode()` 必须是 `idle`（危险断言），而经 `piSettingsFromDefaults` 后必须是 `off`（加载器断言）；从仓库目录 `node checks/cors-credential-check.mjs <4.12.24 安装目录>` 必须 exit 1。
4. 抽查第一轮断言骨架：PI-02 `ext-path-route-receives-ctx`（对照 loader.js:418）、PI-07 `no-dialog-replay-after-restart`、PI-10 `cost-totalFromProvider-is-boolean-false`（对照 pi-ai types.d.ts:318）。
5. 核对 manifest 数值：`npm view hono@4.12.24 dist.integrity`（预期 sha512-I36D1s…）；`Get-FileHash snapshots/hono-4.12.24/package-lock.json`（预期 db2bb134…）；`verify-hono-oracle-pair.mjs` 全绿。
6. grep 验证无字面量 PASS：`evals/contracts/probes/*.mjs` 内不应有 `probe.check("…", true, …)` 模式（evidence/04 存 grep 输出）。
7. 检查 .gitignore 实效：labels 文件应命中规则且不在 `git ls-files`。

## 7. 阶段门禁（Phase 2 开工前）

两轮审计门禁逐项对照：**P1-1..P1-4 已改完**（第一轮）；**N1 套件退出码与 N2 真实路径已关死**（第二轮，含红证）；**v22.23.5 上 test:contracts 退出码 0 已复验**；**断言破坏（mutation）与纯 note 探针均实测变红**；**开工者须持有 schema.sql SHA `ede73eca…` 对应的 v1.4.1 包**（本机路径与入口验证命令不变）。**Phase 1 宣布完成前仍需用户确认**：DeepSeek key + 最小推理契约、通知渠道、基线三句话、75 事件标注。Phase 4 在此之前不能开。

## 8. 交接给下一会话的入口证据

Phase 2（持久化只读链路与恢复）入口 = 本报告 + `reports/re-review-response.md` + `reports/audit-response.md` + `reports/PI-contract-report.md` + contracts-report.json。开工前先重跑第 6 节第 2 条的两个最小验收，绿了再继续。schema/状态/事务的唯一规范仍是本机设计包 06 与其 schema.sql（D-01：包不随库分发）；Phase 2 daemon 加载 defaults.json 必须走 `apps/daemon/config/load-pi-settings.mjs`（D-11）。
