# Phase 5 会话交接文档（第 2 批 `5.3 + 5.4 + 5.5` 独立审计 HOLD → 返工清单 → 第 3 批 `5.6`）

> **日期**：2026-11-22（Asia/Hong_Kong）
> **审计对象**：`1d019fc`（基线 `86f5cd2`，本地未推送）
> **裁定**：**HOLD**（不放行单元 5.6，不推送 `1d019fc`）。完整证据与定级见 [phase5-batch2-audit-report.md](./reports/phase5-batch2-audit-report.md)；决策留痕 D-98
> **审计证据**：`.audit/batch2-audit/`（probes/ 自写反例脚本、logs/ 全部套件与探针日志、evidence/ 截图）

---

## 一、一句话结论

本地 14 项套件计数与实施者逐项一致、安全边界反例（CP4/AT_MOST_ONCE/nonce/Web 门禁/真实进程重启）全部扛住；但纪元 14 镜像证据不绑定提交树（六套 Docker 套件在 HEAD 全拒）+ 四项 P1（routine 端点 500、邮件 ingest 与提醒/晨报编排未接线、SMTP mid-DATA 误分级 local、Timer 条件无 scope 隔离）需要返工后方可进入 5.6。

## 二、返工清单（按优先级）

### R1（P0，机械修复）镜像证据重建
1. `node tools/build-app-images.mjs --only=agent` 在**当前提交树**重建（纪元 15），提交刷新 `docs/phase3/reports/image-digest.md` v2 块。
2. `node evals/phase3/image-gate/probes/probe-evidence-holds.mjs` 必须 rc=0。
3. 六套 Docker 套件（`test:model-proposal` / `test:repo-observe` / `eval:triage` / `test:offline-jobs` / `test:security:integration` / `test:quota-calibration`）锁定 Node 实跑全绿并记录日志。
4. 顺带把「image-gate exit 0」的验证口径改为 `probe-evidence-holds.mjs`（直接 `node evals/phase3/lib/image-gate.mjs` 是无 CLI 的空跑，禁止再作为证据）。

### R2（P1）F-2 routine 模式切换 500
1. 删除 `apps/daemon/src/console/api.mjs:854` SELECT 中的 `content` 列（该端点不需要内容，metadata_json 足够）。
2. 在 `test:security:unit` 补 routine 用例：GET /api/routines 200 + POST mode 切换 observe→auto（带 reviewReportRef）200 + 无 reviewReportRef 422 + expectedRevision 失配 409。

### R3（P1）F-3 编排接线
1. **mail ingest 接线**：daemon tick 2b2 将 `pullMailMessages` 结果逐封送入 `ingestInboundMail`（单封失败不楔死整轮，审计 `mail_ingest_refused`；无 Message-ID 的邮件按 P3-7 容错）。
2. **followup/晨报编排**：对 `processFiredFollowUpTimers` / `composeMorningBriefing` / `mergeQuietBriefings` 做明确的接线实施或**范围裁定 ADR**（若判定「提醒由通用 worker 模型路径承担、确定性窄例行仅作套件验证」，须主人批准并修订 kickoff 计划单元 5.4 的验收口径；不允许保持「模块存在但无人调用」的现状）。
3. 补端到端反例：daemon 离线模式下真实拉取夹具邮件 → inbox/payload/任务落库（修复 F-3-1 的直接证明）。

### R4（P1）F-5 SMTP mid-DATA 诚实分级
1. `upstream-mail-child.mjs`：记录 `dataAccepted`（354 收到）状态；`dataAccepted` 之后的一切中断（含 payload 写回调失败）一律 `unknown`。
2. `eval:scenarios` 补反例：354 后断流 → effect `UNKNOWN` 且零自动重发（复用本审计 E1 夹具形状：`evals/phase5/scenarios/fixtures/serve-fixtures.mjs` 增加 `dropAfterData354` 模式或审计探针 `probe-adversarial.mjs` E1 段直接移植）。

### R5（P1）F-6 Timer 条件 scope 隔离
1. `timers.mjs evaluateCondition` 的 `contact_no_reply` 查询增加 `scope_id` 过滤（timer 冻结的 `scope_id` 作为参数传入；`cancelSatisfiedFollowUpReminders` 与 `markTimerSatisfied` 同步传入）。
2. `test:cross-channel` 补反例：跨 scope 同 thread_key 不得满足（移植审计探针 C1/C2 形状）。

### R6（P2，建议同批）
1. F-7：`composeMorningBriefing` 的 `pendingApprovals`/`unrecoveredAlerts` 补 scope 过滤（或明确并入主人 DM/service 域的书面口径），补跨 scope 泄露反例（审计探针 G1/G2 形状）。
2. F-8：`runDreamingLoop` 无 ledger 时审计 `dreaming_budget_refused` 并跳过（与收口 §六.3 声明对齐）。
3. F-9：child-import 防护扩为全 `apps/daemon/src` 扫描 + 双引号/单引号/动态 import 三形态。
4. P3 项择机登记（见审计报告 §二 P3 清单，不阻断）。

## 三、放行条件

1. R1–R5 全部完成且各反例入套件；R6 至少 F-7/F-8 完成（F-9 可放宽至 5.6 前完成，须登记）。
2. 终树全量复跑刷新计数（含六套 Docker），`report:user-value` 全绿 + `defaultsFailClosed=true`。
3. 修复提交本地落盘后，由独立审计官复核（预期为轻量复核：diff 走读 + 反例重放 + gate 探针 rc=0）。
4. 通过后放行单元 5.6（许可 2 实盘）；`git push` 仍待主人指令。

## 四、本机操作纪律速查（沿用 HANDOFF-BATCH1-AUDIT §三）

- 锁定 Node：`D:\AegisPi\tools\node-v22.23.5\node.exe`（PATH 上是 v24.17.0，禁止依赖 PATH 命中）。
- 审计探针与日志：`.audit/batch2-audit/`（probes/ 可直接重放，全部只读产品代码）。
- `.env` 纪律、5 个 real 入口 exit 4 守卫、D 项公网 webhook 关闭，均不变。
