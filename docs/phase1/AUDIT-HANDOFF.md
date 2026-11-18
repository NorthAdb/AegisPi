# Phase 1 审计移交报告（给下一个审计 agent）

生成：2026-11-18（Asia/Hong_Kong）。执行方：实施会话（OpenCode）。本文件是自审 + 交接的单一入口，按 PRE-READ §4 的阶段交接包结构组织。

## 0. 本阶段目标（复述）

按开工检查单授权执行 Phase 1（用户基线与底座契约）：核验 exact Pi 1.5.2 的 PI-01~PI-13 契约、在锁定 Node.js 22.23.5 上复测 LF 分帧与 SQLite 驱动、绑定「DeepSeek Flash High」真实模型 ID、记录官方基础镜像真实 digest、用 honojs/hono 真实样本建立 oracle/manifest 夹具。不做四场景实现、不接真实外部写（本仓库自身授权推送除外）、不做逃逸测试。

## 1. 版本快照

| 项 | 值 | 锁定证据 |
| --- | --- | --- |
| 实现仓库 | https://github.com/NorthAdb/AegisPi main | 首推 commit 5afc3c9；本阶段最终 commit 见 git log（HEAD） |
| Node | 22.23.5（显式路径，npm 10.9.9） | evidence/01-node-lock.md；dist/index.json 开工日复核无补丁 |
| Pi | @earendil-works/pi-coding-agent 1.5.2 exact | package-lock integrity sha512-mUWI04…lom5yA== |
| hono | 4.13.19 exact | package-lock integrity sha512-KmXvQ…fkA== |
| SQLite 驱动 | node:sqlite（内置 3.54.1） | reports/sqlite-driver.md |
| 模型 | deepseek/deepseek-flash + thinking high | reports/model-binding.md（目录真值文件路径在内） |
| 基础镜像 | node:22.23.5-bookworm-slim @ sha256:e9f565d3… | reports/image-digest.md |
| 规范包 | D:\AegisPi\aegis-pi-design-pack-v1.4.1（本地，不随库分发，决策 D-01） | evidence/00-pack-validation.txt（14/14 PASS） |

## 2. 行为证据（真实运行命令与退出码）

- **`npm run test:contracts`**（= 锁定 Node 下 `node evals/contracts/run-contracts.mjs`）：15 个探针全 PASS，退出码 0。机器可读结果 `docs/phase1/evidence/contracts-report.json`（generatedAt、nodeVersion、每探针 findings 含实际输出摘录）。复跑注意：探针启动真实 Pi CLI 子进程与本地 fake OpenAI 端点（127.0.0.1 随机端口），单次全量约 3-6 分钟。
- **`python -X utf8 validation/validate_pack.py`**（包目录）：14/14 PASS、CONNECTIONS_LEFT=0。
- **`docker pull node:22.23.5-bookworm-slim`**：成功，RepoDigest 已记。
- **`gh api repos/honojs/hono/security-advisories|releases`**：只读拉取 20 条 GHSA + 45 个窗口内稳定 release，来源已写入夹具 events.json。
- **失败与修复用例（调试过程如实记录）**：探针迭代中踩过的真实坑——`tools: []` 是显式空选择会压掉扩展工具（须用 `noTools: true` 或省略）；`bindExtensions()` 是 MCP 专用会崩；compact 有"session too small"门禁（需 > keepRecentTokens 20000 的会话）；`import { Type } from "typebox"` 的 Type 是命名空间对象非函数；RPC 模式扩展加载需 settings.json `extensions` 数组（项目级扩展被 trust 门禁拦）。这些已固化在探针代码与报告里，最终全量绿。

## 3. 契约结论与偏差清单（审计重点）

15 项全成立的结论见 `reports/PI-contract-report.md`。需要审计者重点核验的实测偏差（全部有探针 findings 支撑，无凭印象写的）：

1. **route(request) 单参数**（PI-02）：d.ts 与 docs 示例不符，运行时 ctx=undefined 实测。
2. **扩展 UI 三偏差**（PI-07）：options 嵌套在单字段下（非文档扁平形状）；RPC 模式 dialog timeout 不生效（confirm 1500ms 实测 8s 无 resolve）；无跨重启持久化（SIGKILL 实测）→ 宿主持久停车为硬要求。
3. **cacheWarming 默认 "idle"**（PI-13）：与规范“保温默认关闭”冲突，宿主配置显式 off（config/defaults.json）。
4. **readline 双版本行为**（FRAMING）：锁定 Node 22.23.5 不拆 U+2028/2029；v24.17.0 拆 3 帧全失败（tools/readline-repro.mjs 可复跑对照）。字节 LF 分帧维持宿主契约。
5. **数据修正**：开工检查单描述的 "GHSA-88fw CORS 凭据反射 High" 在 advisory API 不存在；实际条目为 GHSA-wwfh（serve-static Windows 路径穿越，medium）。夹具 README 有完整记录。
6. **unknown usage = 零**（PI-10）：provider 不回 usage 时 Pi 报 0 不报 unknown——账本须保守处理，勿当零成本。

## 4. 风险与未决（如实）

见 `reports/phase1-open-items.md`。要点：DeepSeek 最小推理契约待 key（收口项，非开工项）；通知渠道与基线三句话待用户 → 全量标注集未收口（提案样本在本地 labels 文件，gitignore 已排除）；hono@4.12.24 target integrity 待 Phase 4 前回填；三个应用镜像未构建（无产品代码，规范如此安排）；容器配额为占位值。

**本阶段宣称的“完成”范围**：契约核验、驱动选择、模型绑定（目录层）、镜像 digest、夹具建立、写入链路证实。**不宣称**：产品实现、安全实测、缓存/性能数字、任何用户收益。

## 5. 自审结论（执行方自查，供审计复核）

按 AGENTS 约束逐条对照：

- 版本锁定：exact 无 ^/~；lockfile integrity 与 registry 一致；无假 SHA（hono target integrity 明确标“待回填”而非填占位）。
- 复测纪律：一次失误（探针用了系统 Node v24，错误栈暴露）已纠正，所有正式证据均为显式路径 22.23.5 产出；FRAMING 探针内嵌 locked-node 断言。
- 敏感隔离：labels 本地；探针用隔离 agent dir（PI_CODING_AGENT_DIR 指向临时目录），未碰用户 ~/.pi；未在任何日志/prompt/URL 放密钥（fake key 全是 probe-* 字面量）。
- 证据标注：外部研究数字（hono advisory 数据）标来源 API；资料包验证与产品实测分开陈述；无未测量的性能/安全宣称。
- 诚实的 SKIP/未覆盖：codemode OOM、cacheWarming 真实周期、target 复现执行——都写明未做与理由。

## 6. 审计建议入口（审计者从哪里开始核）

1. 复跑最小验收：包目录 `python -X utf8 validation/validate_pack.py`（预期 14/14）；仓库 `npm run test:contracts`（预期 15/15 PASS，注意需要 Docker 不需要、需要网络不需要——探针全本地）。
2. 抽查 contracts-report.json 任一探针的 findings，对照探针源码与包内 d.ts/docs 核验断言真实性（建议抽 PI-02 route 单参数与 PI-07 timeout 两条关键偏差）。
3. 核对 lockfile：`node -e "…require('./package-lock.json')…"` 验 pi/hono integrity 与报告一致。
4. 核对 manifest 数值：hono tag commit/tarball hash 可用 `gh api` + `Invoke-WebRequest` 重拉复算。
5. 检查 .gitignore 实效：`git check-ignore -v evals/contracts/fixtures/hono-triage/hono-triage.labels.local.json` 应命中规则且该文件不在 `git ls-files`。

## 7. 交接给下一会话的入口证据

下一阶段（Phase 2：持久化只读链路与恢复）入口 = 本报告 + reports/PI-contract-report.md + contracts-report.json。开工前先重跑第 6 节第 1 条的两个最小验收，绿了再继续。schema/状态/事务的唯一规范仍是本机设计包 06 与其 schema.sql（决策 D-01：包不随库分发）。
