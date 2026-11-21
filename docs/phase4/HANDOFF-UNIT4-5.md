# Phase 4 会话交接文档（单元 4.4 已提交 / 单元 4.5 实盘与阶段终审待续）

> 日期：2026-11-21（Asia/Hong_Kong）
> 起始基线：提交单元 4.5 代理前置与本交接后见 `git log -n 2`（单元 4.4 为 `3e85c6d`，镜像**纪元 10**）
> 适用范围：供新对话零损耗接手执行 **单元 4.5 真实端到端闭环 → Phase 4 终局对抗审计与优化修复 → 全量复测与文档同步 → `git push`**

## 一、已完成且已本地验证的基础

1. **单元 4.4（提交 `3e85c6d`，纪元 9）已完整落地**
   - [phase4-4-closure.md](./reports/phase4-4-closure.md)：Scenario 4 `repo_triage` 主机编排（[repo-triage.mjs](../../apps/daemon/src/repo-triage.mjs)）、`container-executor.mjs` 原子暂存与 `StaleWorker` 采集容器终止、[evals/phase4/triage/run.mjs](../../evals/phase4/triage/run.mjs)（7/7）与 [evals/phase4/report-user-value/run.mjs](../../evals/phase4/report-user-value/run.mjs) 已落盘。
2. **单元 4.5 前置修复与镜像纪元 10 已全部绿灯**
   - [telegram-send.mjs](../../apps/daemon/src/telegram-send.mjs) 与 [upstream-telegram-child.mjs](../../apps/daemon/src/upstream-telegram-child.mjs) 新增 HTTP `CONNECT` 代理转发支持，并保持环回端点与未授权路径直连/零出站。[defaults.json](../../apps/daemon/config/defaults.json) 新增 `"proxyUrl": null`，[config.mjs](../../apps/daemon/src/config.mjs) 与 [daemon.mjs](../../apps/daemon/src/daemon.mjs) 完成校验与接线。
   - **镜像纪元 10**（[image-digest.md](../phase3/reports/image-digest.md)）：
     - `agent`: `127.0.0.1:5000/aegispi/agent:phase3-3e85c6d1a9e5` | manifest `sha256:bbdc890f42ee14eb626494ac4a5f62465cf6cc68f0290751075677f1b3250f7d` | config `sha256:dff4ed601b2dcbb9f754adba83cce53391e3d1d86408c6a1085456d50b0a4651` | context `sha256:c0b7914dddf1dc1682929c5b2a076ce8433edf5648f991243d17f44f519e22d6`（`self-check exit 0`）。
     - `acquisition` 携带：`sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c`。
     - `execution` 携带：`sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050`。
   - **纪元 10 终树全量 17 项检查实测通过（Node `v22.23.5`，全部 `exit 0`）**：
     - `image-gate`: `0`
     - `eval:triage`: `7 pass, 0 fail`
     - `test:repo-observe`: `7 pass, 0 fail`
     - `test:model-proposal`: `15 pass, 0 fail`
     - `test:security:unit`: `46 pass, 0 fail`（含新增 `telegram-outbound-connect-proxy-and-fail-closed`）
     - `test:contracts`: `15 probe(s): all PASS`
     - `verify-hono-oracle-pair.mjs`: `0`
     - `test:durability`: `164 pass, 0 fail`
     - `test:acl`: `15 pass, 0 fail`
     - `test:budget`: `20 pass, 0 fail`
     - `test:cancel-approval`: `16 pass, 0 fail`
     - `test:restore`: `11 pass, 0 fail`
     - `test:ingress-telegram`: `7 pass, 0 fail (+ 1 NOTE)`
     - `test:offline-jobs`: `14 pass, 0 fail`
     - `test:security:integration`: `29 pass, 0 fail`
     - `test:quota-calibration`: `5 pass, 0 fail`
     - `report:user-value`: `126/126 pass, 0 fail, defaultsFailClosed=true`（见 [user-value-report.md](./reports/user-value-report.md)）
     - `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：0 命中（`exit 1`）。

## 二、主人已书面授权范围（可直接在新对话执行，无需重复请示）

上一轮主人已对单元 4.5 及阶段收口下达完整授权：

1. **凭据与网络**：`.env` 内已有三个键有效（已确认键存在、未读值打印）：`DEEPSEEK_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_USER_ID`；[owner-baseline.local.md](../../owner-baseline.local.md) 记录 Bot 为 `@aegispibot` 且已 `/start`。无私有仓需求，无需 PAT；允许测试脚本在运行期只读加载 `.env`（严禁打印、入库或进报告）。
2. **真实调用与出站**：允许真实访问 `https://api.deepseek.com`（继续用高峰保底目录价 `300000 / 1200000 / 6000 / null` 防 `HELD`）、真实拉取公开 GitHub 仓库、并通过 `@aegispibot` 向主人 `TELEGRAM_OWNER_USER_ID` 发送真实 Telegram 私聊通知。
3. **测试目标范围**：
   - `honojs/hono` 真实安全公告复现对照：`v4.13.19`（`676c8f80fcafc49e6e74c847a8f0d9c44cc7faee`）vs `v4.12.24`（`5fdde5ab5a7d7c89eba4d1ceab76f4a7c011cd3b`），验证 `GHSA-46wx-v44x-9hh2`（CSRF）与 `GHSA-88fw-hqm2-52qc`（CORS），并覆盖真实 `unaffected` 与回归 `affected` 私聊通知路径。
   - `NorthAdb/AegisPi`（`origin/main` 含 `8943a108df5fceb0a98a91771b23464e50c34dfb` 或最新已推送基线）与 `NorthAdb/pi-agent-north`（`ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`）真实基线检查并推送私聊战报。
4. **不可越界底线**：[defaults.json](../../apps/daemon/config/defaults.json) 必须保持全失败关闭（`$0.80` / `$5.00` / `1000` / 全 `null` / 全 `false` / 全 `[]`）；`D` 项公网入站 webhook 与 `CONSOLE_BIND` 保持禁用；不常开。
5. **终局自审计与推送**：授权阶段收尾后使用 `pstack` 工具包自主完成全面对抗审计（既处理 `P0/P1` 大问题，也顺手修掉值得做的小优化），重跑验证并更新文档防漂移，最后执行 `git push`。

## 三、本机已探明事实与避坑提示

- **工作目录与 Node**：终端默认工作目录是 `d:\AegisPi`，运行任何命令前必须先 `Set-Location 'd:\AegisPi\aegis-pi'`，并显式使用 `D:\AegisPi\tools\node-v22.23.5\node.exe`。
- **Windows 系统代理与 Telegram TLS**：本机 Windows WinInet 注册表已启用 `ProxyEnable=0x1`、`ProxyServer=127.0.0.1:7897`。`telegram-send.mjs` 会在非环回且 `allowRealSend=true` 时自动识别环回 WinInet 代理并用 `upstream-telegram-child.mjs` 建立 `CONNECT` 隧道；目前单测已验证明文 HTTP `CONNECT`，**单元 4.5 首个真实动作请先实际验证对 `https://api.telegram.org` 的 HTTPS TLS + CONNECT 握手机制**。
- **GitHub `honojs/hono` 归档源码形式**：GitHub archive 内是 TypeScript 源码（`src/middleware/csrf/index.ts`、`src/middleware/cors/index.ts`）且带无后缀相对导入（如 `'../../http-exception'`），不含 npm `dist/` JS。锁定 Node `22.23.5` 内置了 `module.stripTypeScriptTypes`；`eval:triage:real` 里挂载进 `--execution-image` 的宿主 check 脚本若要直接执行真实抓回的 Hono TS 中间件，需要用 tmpfs `/job/work` 做无后缀相对 TS 解析或按实提取执行，不得退化为只靠字符串 grep 敷衍。
- **既有代码约定**：
  - `apps/daemon/src/db/tx.mjs` 的 `withTx` 直接执行 `BEGIN IMMEDIATE`，不可嵌套。
  - `apps/daemon/src/job-oracle.mjs` 的 `ASSERTION_KINDS` 仅允许 `baseline_passes`、`target_affected`、`target_unaffected`、`exploit_success_exit0`、`infra_failure`、`coverage_required`。
  - 每次修改 `apps/daemon/`、`package.json`、`package-lock.json` 或 `docker/` 后，需运行 `node tools/build-app-images.mjs --only=<name>` 更新对应纪元，再跑 `evals/phase3/lib/image-gate.mjs` 与全量回归。
  - Antigravity 调用 `pstack` 技能前需先读取 `C:\Users\1\.gemini\config\plugins\pstack\docs\harness\antigravity.md`。

## 四、新对话推荐执行顺序

1. **单元 4.5 实盘实现与运行**：
   - 新增受 `AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE=1`（缺省 `exit 4`）守护的 `evals/phase4/triage-real/run.mjs` 与 `package.json` 脚本 `eval:triage:real`，参照 [repo-observe-real/run.mjs](../../evals/phase4/repo-observe-real/run.mjs) 的 `.env` 只读与脱敏扫描纪律。
   - 首跑先核实 `@aegispibot` 走 `127.0.0.1:7897` `CONNECT`+TLS 发真实 DM 可达；若 `upstream-telegram-child.mjs` 对 TLS `CONNECT` 有任何握手或超时细节瑕疵，就地修补并在 `security-unit` 补 TLS+CONNECT 回归用例。
   - 完成 `honojs/hono`（CSRF & CORS `v4.13.19`/`v4.12.24`）、`NorthAdb/AegisPi`、`NorthAdb/pi-agent-north` 真实 `repo_triage` + 真实 DeepSeek + 真实执行容器 + 真实 `@aegispibot` 私聊收信与全链路零密钥泄漏核验。
2. **Phase 4 终局对抗审计与顺手优化**：
   - 使用 `/poteto-mode` + `pstack`（`interrogate` 多路并跑 `research` 对抗核验、`blast-radius`、`no-comments` / `comment-sicko`）全面审计 Phase 4 全量变更（`model-requests`、`repo-observe`、`telegram-send`、`upstream-telegram-child`、`repo-triage`、`container-executor`、`daemon`、`config` 与测试脚本），收口全部确认的 `P0/P1` 缺陷与低风险顺手优化项。
3. **最终验证、防漂移文档更新与推送**：
   - 如代码/配置有改动则重建受影响镜像并重跑全套离线/容器门禁 + `report:user-value`。
   - 撰写单元 4.5 与 Phase 4 最终收口总结报告，同步更新 [phase3-status-and-remaining.md](../phase3/reports/phase3-status-and-remaining.md)、[docs/README.md](../README.md)、[README.md](../../README.md) 与 [decision-trail.tsv](../../.audit/decision-trail.tsv)。
   - 核对 `defaults.json` 失败关闭与 `git status` 洁净，提交并执行 `git push`。
