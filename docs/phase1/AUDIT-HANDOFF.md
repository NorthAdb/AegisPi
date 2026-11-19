# Phase 1 审计移交报告（给下一个审计 agent）

生成：2026-11-18 初版；**2026-11-19 修订：第一轮外部审计判定“Phase 1 未完成”，本版并入整改记录**。执行方：实施会话（OpenCode）。本文件是自审 + 交接的单一入口。

## 0. 当前状态（一句话）

契约核验、驱动选择、镜像锁定、双 oracle 夹具**均已按第一轮审计整改并复测全绿**（15/15 PASS，退出码 0，字面量断言清零且 mutation 变红实测）；**Phase 1 尚未收口**——DeepSeek 最小推理契约、通知渠道、基线三句话、75 事件标注确认是用户侧硬性项；Phase 2 开工门禁见第 8 节。

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

## 3. 第一轮审计结论与整改（本轮审计者的必读映射）

审计（Ubuntu 24.04.5 / 锁定 Node 22.23.5）：复跑 test:contracts 退出码 0、validate_pack.py 14/14，但判定 Phase 1 未完成。逐条整改记录在 **`docs/phase1/reports/audit-response.md`**（每条：本机核实 → 修复 → 证据）：

- **P1-1 route 双路径**：v1 把“单参数、ctx undefined”写成全局事实，实为 ModelRuntime 单参 + 扩展 (request, ctx) 双路径（loader.js:418 实证）。探针重写双路径，实测 `arguments.length` 1 vs 2。
- **P1-2 字面量 true 的 PASS**：12 处清零——分帧切点改到多字节字符内部、readline/U+2028/超长行改可失败断言、PI-07 重启复验（扩展重载 + 零 dialog 重放）、PI-10 totalFromProvider 实为可选布尔（断言 false）、PI-13 静态声明 + off 读取路径断言、规范类陈述全部降级 note。timeout 表述 8 秒→4 秒。
- **P1-3 GHSA-88fw**：v1 的“检查单写错了”不成立——per_page=20 截断所致。全量重拉 61 条，窗口 30 条，GHSA-88fw（high，<4.12.25）实存且已建第二对 oracle 并实测（4.12.24 反射任意 Origin / exit 1）。
- **P1-4 target manifest**：v1 target 锁指向 4.13.19——已回填隔离安装实测值（4.12.24 lock sha256 db2bb134…，integrity sha512-I36D1s…U4iw== 与 registry 一致）；两对 oracle 的 A2 从约定升级为实测。
- **P1-5 任务 1 勾选**：todo 拆分，标注确认项明确未勾。
- **P2**：LOCKED_NODE 环境覆盖 + 子进程版本校验；engines 收紧 22.23.5；amd64 清单 digest 记录（本地复验待网络）；Markdown 超出 JSON 三处修正。

## 4. 行为证据（真实运行命令与退出码）

- **`npm run test:contracts`**（锁定 Node）：15 探针全 PASS，退出码 0（2026-11-19 整改后全量复跑）。机器结果 `docs/phase1/evidence/contracts-report.json`（每探针 findings 含实测输出摘录）。复跑注意：探针启动真实 Pi CLI 子进程与本地 fake OpenAI 端点，单次全量约 3-6 分钟；Linux 主机设 `AEGISPI_NODE_BIN=<v22.23.5 二进制>`。
- **mutation 变红实测**：故意把 sqlite `synchronous-full` 期望改为 `===3` → 单探针 FAIL、退出码 1 → 还原复绿（`evidence/04-audit-response-verification.md`）。另有 grep 证明全库无残留 `probe.check("…", true, …)`。
- **`python -X utf8 validation/validate_pack.py`**（包目录）：14/14 PASS、CONNECTIONS_LEFT=0（v1 入口证据；本轮复核见 evidence/04）。
- **hono 双 oracle A1/A2**：隔离快照安装（4.13.19 / 4.12.24）上四项检查全实测——csrf：403/exit 0 vs 200 放行/exit 1；cors：`acao:"*"` 不反射/exit 0 vs `acao:"https://attacker.example"` 反射/exit 1。复现须把检查脚本复制进快照安装目录运行（ESM 按脚本位置解析，manifest installNote 有全文）。
- **失败与修复用例（如实记录）**：探针迭代真实踩坑——`tools: []` 是显式空选择压掉扩展工具；`bindExtensions()` MCP 专用；compact 有 keepRecentTokens 门禁；typebox `Type` 是命名空间对象；RPC 模式扩展需 settings.json `extensions` 注册；**本轮新增**：ESM 按 cwd 解析的误信导致 oracle 检查一度在仓库 4.13.19 上假跑（已修正为脚本内复制法）；sqlite 影子表分类初版漏掉虚拟表本身。

## 5. 风险与未决（如实）

见 `reports/phase1-open-items.md`。要点：DeepSeek 最小推理契约待 key；通知渠道与基线三句话待用户 → 75 事件标注未收口（提案含 High 锚点 GHSA-88fw，在本地 labels）；amd64 清单 digest 本地复验待网络；三个应用镜像未构建（规范安排）；容器配额为占位。

**本阶段宣称的“完成”范围**：契约核验（整改后）、驱动选择、模型绑定（目录层）、镜像 digest、双 oracle 夹具（A1/A2 实测）、写入链路证实、第一轮审计 P1 整改。**不宣称**：产品实现、安全实测、缓存/性能数字、任何用户收益、Phase 1 收口。

## 6. 审计建议入口（从哪里开始核）

1. 读 `reports/audit-response.md`（P1-1..P1-5 → 修复 → 证据的完整映射）。
2. 复跑最小验收：包目录 `python -X utf8 validation/validate_pack.py`（预期 14/14）；仓库 `npm run test:contracts`（预期 15/15，退出码 0）。
3. 抽查新断言的骨架：PI-02 的 `ext-path-route-receives-ctx`（对照 loader.js:418 原文）、PI-07 的 `no-dialog-replay-after-restart`、PI-10 的 `cost-totalFromProvider-is-boolean-false`（对照 pi-ai types.d.ts:318）。
4. 核对 manifest 数值：`npm view hono@4.12.24 dist.integrity`（预期 sha512-I36D1s…）；隔离安装法复跑两对检查（预期 0/1 分离）。
5. grep 验证无字面量 PASS：`evals/contracts/probes/*.mjs` 内不应再有 `probe.check("…", true, …)` 模式（evidence/04 存有本次 grep 输出）。
6. 检查 .gitignore 实效：labels 文件应命中规则且不在 `git ls-files`。

## 7. 阶段门禁（Phase 2 开工前）

按第一轮审计的阶段门禁要求逐项对照：**P1-1..P1-4 已改完**；**v22.23.5 上 test:contracts 退出码 0 已复验**；**字面量 true 改 false 必须变红已实测成立**；**开工者须持有 schema.sql SHA `ede73eca…` 对应的 v1.4.1 包**（本机路径与入口验证命令不变）。**Phase 1 宣布完成前仍需用户确认**：DeepSeek key + 最小推理契约、通知渠道、基线三句话、75 事件标注。Phase 4 在此之前不能开。

## 8. 交接给下一会话的入口证据

Phase 2（持久化只读链路与恢复）入口 = 本报告 + `reports/audit-response.md` + `reports/PI-contract-report.md` + contracts-report.json。开工前先重跑第 6 节第 2 条的两个最小验收，绿了再继续。schema/状态/事务的唯一规范仍是本机设计包 06 与其 schema.sql（D-01：包不随库分发）。
