# honojs/hono triage fixture (Phase 1 task 6)

监控对象 `honojs/hono`（本仓库 daemon 的 HTTP 宿主框架，锁定 exact 4.13.19，见 `apps/daemon/package.json`）。本目录是 Phase 1 的 oracle 与 environment manifest 夹具起点，全部数值为 2026-11-18 实测，无占位。

## 文件

- `events.json`：候选事件窗口（2026-05-18 至 2026-11-18），45 个稳定 release + 20 条 GHSA，共 65 个候选，来源为 GitHub REST API 只读拉取（`gh api repos/honojs/hono/...`）。生成脚本见 `evals/contracts/tools/build-hono-events.mjs`。
- `oracle.hono-triage.json`：命题 = csrf() text/ping hyperlink auditing 绕过（GHSA-46wx-v44x-9hh2，影响 <4.13.16）。断言 A1 已在锁定 Node 22.23.5 + hono 4.13.19 上实测通过（403 拒绝，exit 0）。断言 A2（target v4.12.24 预期绕过）为 Phase 4 security_repro 的记录约定，Phase 1 未执行。
- `manifest.hono-triage.json`：baseline = v4.13.19（commit 676c8f80…，tarball sha256 e1a19a8a…），target = v4.12.24（commit 5fdde5ab…，tarball sha256 4ce62f3e…），基础镜像 digest 为实测 `node:22.23.5-bookworm-slim`。target 的 hono@4.12.24 integrity 待 Phase 4 隔离安装后回填真实值——按 schema 描述"缺值必须阻塞可复现 run"，gate 拒绝占位符。
- `checks/csrf-textping-check.mjs`：最小检查脚本（fixtureHash = sha256 4e89f269…）。

## 标注状态

`hono-triage.labels.local.json` 是标注提案（正/负/未知三类），**只留本地不入库**（labels 属于主人私密判断，.gitignore 已排除）。待用户三项准备齐（通知渠道、基线三句话）后确认或修正，再决定是否以脱敏形式入库。

## 实测与开工检查单的差异记录

1. 检查单写"2026-05 至 2026-11 共 10 条 GHSA，High 一条（GHSA-88fw CORS 凭据反射，<4.12.25）"。实测 API 返回 20 条，其中 `<4.12.25` 的条目为 GHSA-wwfh-h76j-fc44（CVE-2026-54286，medium，serve-static Windows 路径穿越）；未找到名为 GHSA-88fw 的 High 条目，也未找到"CORS 凭据反射"描述的条目（最接近的是 GHSA-8j4g-w8fx-2239，medium，CORS 中间件 ReDoS，<4.12.34）。以实测为准，检查单三分类示例的意图（csrf unknown 例、CORS 负例、RegExpRouter 正例）在 labels 提案中均已保留。
2. 检查单预估窗口约 47 个候选事件；实测 65 个（45 稳定 release + 20 advisory）。
