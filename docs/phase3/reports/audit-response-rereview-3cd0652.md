# Phase 3 确认复审 3cd0652 回应（计划口径修订）

生成：2026-11-20。对象：主人提供的确认原稿 `AUDIT-PHASE3-REREVIEW-3cd0652`（判定：五项收口成立，Phase 3 仍 MET WITH RESIDUAL RISKS）。原稿已归档于 `docs/phase3/audits/AUDIT-PHASE3-REREVIEW-3cd0652.md`，文件 SHA-256 `b6ced2a649397c99110eef763961de8a5c0ad13018633f3e9dcc632926ff831c`（10387 字节），原文一字未改；本回应另写。

本轮只改计划与文档，不改生产调度、授权或预算语义，不重开已关闭项，不执行任何真实验收。

## 逐项修订映射（审计第 5、6 节 → 计划修订版）

| 审计意见 | 修订落点（docs/phase3/reports/real-acceptance-plan.md） |
| --- | --- |
| A：客户端把 `{model, messages}` 原样 POST 到配置 URL，不自动补 `/chat/completions`（R，model-call-child.mjs） | A 表「端点（代码事实）」行：配置值必须是完整请求 URL，示例形态 `https://api.deepseek.com/chat/completions`；「授权时主人需提供的信息」表第 A 行第①项 |
| A：当前路径不做 Pi ID → 供应商模型名翻译 | A 表「模型名（代码事实）」行：wire `model` 字段原样透传；Phase 1 经 Pi 以 `deepseek-flash` 被真实 API 接受过一次仅作参考证据，最终以主人书面给出的供应商模型名为准 |
| A：实际金额大于预留时仍 SETTLED 并记超限告警，不是硬拒绝 | A 表「费用/次数与超限行为」行：`budget.mjs` settle 的代码事实（SETTLED + `budget_overcharge_frozen` + 账户 frozen=1，调用前无金额硬拒绝）；新增「超限时如何停手与回滚」行：见告警即停手、endpoint 置回 null、槽撤销、冻结账户保持冻结（代码无解冻路径），解冻属后续人工/ADR |
| B：现有传输提交的是内部 JSON，不是 GitHub PR；草稿 PR 读起来像仓库写，属 Phase 4 | B 表整体重写：限定为向主人指定的可丢弃 HTTP 端点 POST 一次内部信封 `{kind:"submit", businessKey, idempotencyKey, operation, at}`（upstream-http.mjs 代码事实）；明文排除 GitHub/PR/仓库写 |
| B：执行后 allowRealExternalWrites 立即回到 false | B 表「动作范围」与「回滚」行：执行完成后立即置回 false，不等收尾 |
| C：事故已用 getMe ×1 + getUpdates ×1 = 2 次；授权后只剩 2 次额度，不得满额重跑 | C 表「次数账本」行：总上限 ≤4 时已用 2、剩余 2，明文禁止在事故之外按原表满额重跑；零费用、无 sendMessage、无 offset 确认、凭据不进提示词/日志/仓库全部保留 |
| D：setWebhook/deleteWebhook 必须同一次操作完成，测完立即摘除，不留隧道或公网监听面 | D 表「同操作约束」行：同一操作窗口内注册→观察→立即摘除并绑回 `127.0.0.1`，隧道即拆；次数各 ≤1 不变 |
| D：写明通过标准和回滚失败时的处置 | D 表「回滚」行新增失败分支：`deleteWebhook` 失败时立即人工在 Telegram 侧删除/必要时轮换 token，如实记录公网入口存续时刻，重试不超过 1 次 |

## 其他核对项（审计已验，无需整改动作）

- 时序收口（43/43 含未到期零派发与到期前 1ms 拒绝）、原镜像归档文档与 SHA 一致性、`image-digest.md` 两纪元、`--simulate-no-token` 实况文案、模型/Pi 文档分法：审计判定成立，本轮零改动。
- 审计指出 image-delivery.md 的复跑配方依赖 `docker load` 保留 `phase3-52502432d21f` 标签（R）：不改交付文档原文（配方对「标签被保留」的 Docker 行为依赖属审计标注的已知限度，自证哈希步骤不受影响）；获授权移交后由接收方按文档步骤实测，若标签未保留则改用 `docker tag <digest 对应 image id> 127.0.0.1:5000/...` 再 push，该说明已在 image-delivery.md 第 3 节命令形态内可推得，不另开勘误。
- 事故原始输出不在仓库（实施者申报为准）：维持 D-61 与本回应的事实链，不做补充核验调用。

## 出口

计划修订版提交即等待主人逐项书面授权。未获授权前默认不变：零付费调用、零真实平台外发、公网 webhook 未注册。不进入 Phase 4，不宣布常开。
