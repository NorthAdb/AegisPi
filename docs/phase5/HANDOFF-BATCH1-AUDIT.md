# Phase 5 会话交接文档（第 1 批 `5.1 + 5.2` 已本地提交待独立审计 → 第 2 批 `5.3–5.5` → 第 3 批 `5.6`）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **远端基线（`origin/main`）**：`45b7c03`（`docs(phase5): record Route 1 getUpdates decision and detailed Phase 5 6-unit kickoff plan (D-90)`）
> **本地当前树（`HEAD -> main`，未推送）**：`52e223a`（在外部实施者交付的第 1 批 `8a48c87` + 终树证据刷新 `52e223a` 之上，含本交接文档提交）
> **适用范围**：供新对话零损耗接手 **① 独立对抗审计第 1 批（单元 5.1 + 5.2）→ ② 推动修复与放行第 2 批（单元 5.3 + 5.4 + 5.5）→ ③ 执行第 3 批（单元 5.6 许可 2 线上实盘验收）与阶段终局收口**

---

## 一、截至交接时刻的精确状态

1. **已完成并推送至远端的部分（`0a90526` → `45b7c03`）**
   - **Phase 4 全量收口（`0a90526`）**：单元 4.1–4.5、实盘 `eval:triage:real` 6/6、`report:user-value` 134/134、终局对抗审计与镜像纪元 11.5。
   - **Phase 5 详细规划定稿（`45b7c03`，`D-90`）**：
     - [docs/phase5/phase5-kickoff-plan.md](./phase5-kickoff-plan.md) 将 Phase 5 拆分为 6 个逻辑单元（`5.1`–`5.6`）；
     - 经主人确认采用 **路线 1（Telegram `getUpdates` 长轮询 Pull 入站）**，**D 项（公网入站 Webhook）继续推迟**至备齐公网 HTTPS 域名/端口材料后再补，不阻挡 Phase 5 及后续阶段进度（已同步 `phase3-status-and-remaining.md`、`docs/README.md`、`README.md`）；
     - 主人采纳「**3 批打包交付**」策略：**第 1 批（`5.1 + 5.2`）→ 第 2 批（`5.3 + 5.4 + 5.5`）→ 第 3 批（`5.6`）**，由外部开发者按批实现，**本仓库核心对话（你）专职担任独立验收审计官**（并在最后按需收口/实盘/终审）。
   - **后台预览进程**：此前测试拉起的 `local-preview` daemon（`task-793`，`127.0.0.1:4310`）**已终止**，端口与锁均已释放。

2. **外部开发者刚在本地交付、尚未经独立审计的部分（`8a48c87` + `52e223a`，未 push）**
   - 外部实施者已完成 **第 1 批（单元 5.1 分层记忆生命周期 + 单元 5.2 Telegram 路线 1 Pull 与跨通道 Canary 隔离）** 的本地代码实现与自测报告（[phase5-batch1-closure.md](./reports/phase5-batch1-closure.md)、`.audit/decision-trail.tsv` `D-91`–`D-94`），重建了镜像 **纪元 12**（`agent` manifest `sha256:72d90bb41e4c747e156057568065d6dda31befc0fd78a95b03703ac97ff7fd4b`，`acquisition` 与 `execution` 携带沿用）。
   - **重要真实性边界**：`52e223a` 提交日志及 `phase5-batch1-closure.md` 中声称的全部通过数字（`test:memory-lifecycle` 34/34、`test:cross-channel` 18/18、既有 16 项回归 + Hono 预检 + `report:user-value` 134/134、`defaultsFailClosed=true` 等）**目前均属实施者自述，尚未经过独立审计复测与源码对抗检查**。

---

## 二、新对话第一要务：对 Phase 5 第 1 批（`45b7c03..52e223a`）执行独立对抗审计

建议直接启用 `/poteto-mode`（调用 `pstack` 多路并行 `interrogate` / `blast-radius` / `comment-sicko`）按以下四步对第 1 批实施整批审计与独立实测：

### 1. 必查源码与设计争议点（对照 [phase5-batch1-closure.md](./reports/phase5-batch1-closure.md) §五与实际 diff）
- **① CP4 执行点与披露边界（`apps/daemon/src/cp4.mjs`、`effects.mjs`、`D-93`）**
  - 实施者仅在 `dispatchEffect` CAS 事务内对 `GROUP` 形状目标执行 CP4 反向校验，且将 `adapters.allowedRecipients` 条目直接视为合法披露授权（含向该群披露 `dm` 闭包派生物），提案层未设门，`dm:*` / `mail` 等非 `GROUP` 目标维持适配器本地拒绝。
  - **审计重点**：严格对照设计包 `01` §3（“群摘要引用私密来源取交集/需人工审查的新脱敏对象”）与 `02` §3–4（CP4 检查范围），确认 `allowedRecipients` 是否会意外放宽私密域向群聊泄密；非 `GROUP` 目标在后续第 2 批（邮件 `To/Cc/Bcc` 与外发）是否会留出接口或语义缺口。
- **② 事故 `D-94` 核验与结构守卫（`evals/phase3/ingress-telegram/real.mjs`）**
  - 实施者在验证未设环境变量守卫时误触一次真实 `test:ingress-telegram:real`（产生 1 次 `getMe` + `getUpdates(limit=1)` 只读请求，随后恢复冻结证据文件并补充了 `AEGISPI_ALLOW_REAL_TELEGRAM_READ` 缺省 `exit 4` 守卫）。
  - **审计重点**：检查 `evals/phase3/ingress-telegram/real.mjs` 守卫是否严格先于任何 `.env` 读取与网络请求；核对 `git diff 0a90526..HEAD -- docs/phase3/evidence/ingress-telegram-real*` 确认冻结证据确实逐字节未改；将 `D-94` 事故及整改结果向主人如实汇报裁量。
- **③ 第 1 批自述的三项延迟/残余边界核查（`phase5-batch1-closure.md` §五.7）**
  - **L3 Dreaming**：仅落地 `candidate`/`conflicted`/过期结构，未实现 Dreaming 编排调度循环（静默时段 + 独立预算）。判断其应在本批补齐还是明确转入后续单元登记。
  - **Telegram Pull 代理**：`telegram-pull.mjs` / `ingress-telegram-child.mjs` 仅在显式传 `proxyUrl` 时走 `CONNECT`，未复用 `telegram-send` 的 Windows WinInet 环回代理自动探测（影响单元 5.6 实盘开箱可用性）。
  - **`defaults.json` 与核心不变量**：逐行 `git diff 45b7c03..52e223a -- apps/daemon/config/defaults.json`，核对所有既有预算（`$0.80`/`$5.00`/`1000`）与开关绝对零放宽、新增键全 fail-closed；核对 `schema-source.json`（`ede73ecaa...`）与 `recall.mjs` 漂移门无损、`withTx` 无嵌套。
- **④ 单元 5.1 + 5.2 全新代码安全与崩溃矩阵逐行深审**
  - 重点排查：`memory.mjs`（L0 写入原子性/撤权换会话/摘要权限并集闭包/遗忘级联）、`memory-scanner.mjs`（13 类扫描绕过、Unicode 规范化/多语言边界）、`deletion-manifest.mjs`（Hash 链校验/`.bak` 修复安全性/恢复序号倒挂拒绝）、`skills.mjs`、`spill.mjs`（路径遍历/脱敏顺序）、`recovery.mjs` + `backup-window.mjs`（步骤 `3b` 恢复门禁）、`telegram-pull.mjs` + `control.mjs` + `router.mjs` + `scheduler.mjs` + `daemon.mjs`（批次合并 ≤8 与 ≤64KiB 输入是否与 `model.maxInputBytes` 正确协同、`completePendingDeliveryCheckpointInTx` 是否会误消未处理分支）。

### 2. 独立全量实跑验证（全程禁跑真实外部端点、禁读 `.env`）
在审计完 diff 后，必须在锁定 Node（`D:\AegisPi\tools\node-v22.23.5\node.exe`）下**亲手重跑**并核对退出码：
- `evals/phase3/lib/image-gate.mjs`（exit 0）
- `npm run test:memory-lifecycle`、`npm run test:cross-channel`
- 全部既有 16 项离线/容器检查 + `verify-hono-oracle-pair.mjs` + `npm run report:user-value`
- 验证全部 5 个 `*-real` 入口未设环境变量时均直接拒绝返回 `exit 4`（先于 `.env` 读取）。

### 3. 第 1 批闭环出口与第 2 批交接
- 若审计发现 P0/P1 或高价值优化项：征得主人指令后在本对话修复（或退回开发者返工）、若触及代码则重建受影响镜像并刷新全量验证、记录 `.audit/decision-trail.tsv`，经主人确认后将第 1 批与审计加固提交 `git push origin main`。
- 第 1 批验收过关后，向开发者发放 **第 2 批（单元 `5.3 + 5.4 + 5.5`）实施指令**（覆盖场景一邮件 IMAP/SMTP 草稿审批与对账、场景二晨报/条件跟进 Timer/CalDAV ETag 审批、以及 Phase 5 控制台 API + `127.0.0.1:4310/` 最小可用 Web 前端），待其交付后再由本仓库主控对话审计验收，最后推进 **第 3 批（单元 5.6 许可 2 线上实盘与终局审计）**。

---

## 三、本机环境与操作纪律速查

- **工作路径**：`d:\AegisPi\aegis-pi`（务必确认在 repo 目录内执行命令）
- **锁定 Node**：`D:\AegisPi\tools\node-v22.23.5\node.exe`（npm `10.9.9`）
- **本地镜像 Registry**：`127.0.0.1:5000`（容器 `aegispi-build-registry`，Docker Desktop `29.9.2`）；改 `apps/daemon/`、`docker/`、`package*.json` 后必须跑 `node tools/build-app-images.mjs --only=<name>` 并过 `image-gate.mjs`
- **Antigravity `pstack` 适配**：使用任何 `pstack` / `/poteto-mode` 技能前先读 `C:\Users\1\.gemini\config\plugins\pstack\docs\harness\antigravity.md`
- **本机规范包（只读）**：`D:\AegisPi\aegis-pi-design-pack-v1.4.1`（`schema.sql` SHA-256 LF `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`）
- **`.env` 与代理纪律**：`.env` 严禁打印或入库；除单元 5.6 明确授权实盘外严禁读取 `.env`；本机 Windows WinInet 代理为 `127.0.0.1:7897`；D 项公网 Webhook 与常开保持关闭。
