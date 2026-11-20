# Phase 3 真实验收执行记录：A（真实模型）与 C（Telegram 只读），2026-11-20

主人 2026-11-20 书面授权「仅限本次」执行计划第 1、2 项（A 真实模型、C Telegram 只读）；B（外部写）与 D（公网 webhook）**未授权、未执行**。本文件是执行后交付的简要结果；详细断言与输出在 `docs/phase3/evidence/`。全程锁定 Node 22.23.5。

## A. 真实模型（DeepSeek，经宿主生产 tick）

- **次数**：恰 **1** 次 `callModelOnce`（授权上限 ≤5；未用满）。载荷为固定中性 prompt。
- **端点与模型名**：完整 URL `https://api.deepseek.com/chat/completions`（客户端原样 POST，未补路径）；wire `model` 字段为供应商模型名 `deepseek-flash`（本地已录官方名，Phase 1 契约被真实 API 接受过，未猜测试错）。
- **退出码**：`test:model:real` **exit 0**（3 PASS / 0 FAIL）。
- **是否外发**：是——1 次 HTTPS POST 到 api.deepseek.com，响应 2xx。
- **是否入账**：是——预留先于调用（`budget_reservations` purpose `worker`，上限 1000 microUSD），响应 usage prompt=40 / completion=13，按宿主目录价（0.3/1.2 USD/M = 300000/1200000 microUSD/M）结清 **28 microUSD**（$0.000028），`source=model-http-transport`，独立复算 `microusdForUsage` 与结算额一致；任务 `SUCCEEDED`，回复 "OK"，证据对象带 ACL 入库。
- **有无超限**：**无**。`budget_overcharge_frozen` 0 条、`model_call_failed` 0 条、`model_usage_not_settled` 0 条；结算额 28 ≤ 预留上限 1000。
- **边界重申**：这次直连不经 Pi SDK，不构成 Pi 端到端证据（缺口 B 维持开放，见 model-path-and-pi.md）。
- **证据**：`docs/phase3/evidence/model-real-log.md` / `model-real-report.json`；入口脚本 `evals/phase3/model-real/run.mjs`（无密钥，缺 key 时 exit 3）。

## C. Telegram 只读（getMe / getUpdates）

- **次数**：恰 **2** 次（getMe ×1 + getUpdates ×1），用满授权后剩余额度。**次数总账**：事故已用 2 + 本次 2 = **4/4，额度清零**；后续任何 Telegram 调用需新的逐项授权。
- **退出码**：`test:ingress-telegram:real` **exit 0**（3 PASS / 0 FAIL / 1 NOTE 无）。
- **结果**：getMe 核验 bot `@aegispibot`（id 掩码）；getUpdates 队列读到 1 条更新，**无 offset 参数、队列未消费**；该更新仅本地映射为 OBSERVE（update_id 500045892，scratch 工作区，未派任务、未外发）。
- **是否外发**：零发送、零 offset 确认、零费用（只读）。
- **凭据**：仅从本机 `.env` 读取，全程 scrub 脱敏，未入提示词、日志或仓库。
- **证据**：`docs/phase3/evidence/ingress-telegram-real-log.md` / `ingress-telegram-real-report.json`。

## 开关与默认值收口（执行后立即恢复）

- 仓库 `apps/daemon/config/defaults.json` **全程未改**（git diff 0 行）：`model.endpoint` 保持 `null`、`allowRealModelCalls` 保持 `false`、价格目录保持 null（未授权状态）、`policy.allowRealExternalWrites` 保持 `false`。本次的真实端点/授权值只存在于临时工作区的 test-config（`workspace-state/`，gitignored），已随工作区废弃，无需再收回。
- B 的 `allowRealExternalWrites` 未曾打开；D 的绑定与 secret 未曾触碰；公网零暴露。
- 事故与本次合计无超限、无冻结、无 `budget_overcharge_frozen`；预算账户无 frozen。

## 未做与待办

- B（真实外部写）、D（公网 webhook）保持未授权、未执行。
- Phase 4 不进入；常开不宣布。
- 本记录与证据入库后，等待主人安排独立复核。
