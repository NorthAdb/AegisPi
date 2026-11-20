# Phase 3 真实验收最小计划（修订版，待主人逐项授权，未执行）

修订：2026-11-20，按确认审计 `AUDIT-PHASE3-REREVIEW-3cd0652` 第 5、6 节口径改写 A/B/C/D 四项（端点形态、供应商模型名、超限行为、外部写载荷、事故计入次数、webhook 同操作摘除）。初版历史见 git（`3cd0652`）。本计划仍**只提交不执行**：主人对单项书面授权之前，任何一项都不运行。凭据只写槽名与环境变量名，值不进提示词、日志、报告或仓库，只进本机 `.env`（已 gitignore）或宿主凭据服务槽。执行环境固定锁定 Node 22.23.5；失败即停、不自动重试、不换模型或通道。

## 0. 授权时主人需逐项提供的信息（缺一不执行）

| 项 | 需要主人书面给出的值 |
| --- | --- |
| A 真实模型 | ① **完整请求 URL**（客户端把配置的 URL 原样 POST，不自动补 `/chat/completions`，见下节）；② **供应商模型名**（wire 上 `model` 字段的原样字符串，见下节）；③ 费用/次数上限确认（维持 ≤2 次、总额 ≤$0.01 或改定）；④ 回滚方式确认（默认按 A 表回滚行） |
| B 真实外部写 | ① **可丢弃 HTTP 端点**（完整 URL，仅接收一次内部 JSON 载荷）；② 次数确认（=1）；③ 回滚方式确认（默认按 B 表回滚行） |
| C Telegram 只读 | 次数上限确认（维持 ≤4 总额即剩 2 次额度，或改定）；凭据槽确认（`TELEGRAM_BOT_TOKEN`） |
| D 公网 webhook | ① 公网可达地址/隧道与绑定方案；② webhook secret 槽来源（≥16 字符，值不入库）；③ 次数确认（setWebhook/deleteWebhook 各 ≤1、测试消息 ≤3）；④ 回滚失败时的处置确认（默认按 D 表失败分支） |

## A. 真实模型（DeepSeek，一次最小推理经宿主路径）

| 项 | 内容 |
| --- | --- |
| 端点（代码事实） | 客户端 `callModelOnce` → `model-call-child.mjs` 对配置的 URL **原样** `POST`，载荷 `{model, messages}`；**不会自动补 `/chat/completions` 或任何路径**。因此配置值必须是完整请求 URL（OpenAI 兼容 chat 端点，示例形态 `https://api.deepseek.com/chat/completions`，以主人授权时给出的为准） |
| 模型名（代码事实） | wire 上 `model` 字段是配置值**原样透传**，当前路径不做 Pi 目录 ID → 供应商模型名的翻译。因此配置值必须是供应商接受的模型名字符串。参考证据：Phase 1 最小推理契约经 Pi SDK（未重定向 baseUrl）以目录模型名 `deepseek-flash` 被 `api.deepseek.com` 接受过一次（`docs/phase1/reports/model-binding.md`）；**最终以主人授权时书面给出的供应商模型名为准**，不以 Pi 目录 ID `deepseek/deepseek-flash` 代替 |
| 凭据槽 | 宿主凭据服务槽 `model` ← 本机 `.env` 的 `DEEPSEEK_API_KEY`（Phase 1 已录入，不入库） |
| 动作范围 | 最多 **2 次** `callModelOnce`（1 次主调用 + 失败时 0 次重试；不做循环）。载荷为固定中性文本。不经容器、不经 Pi SDK、无工具、无仓库操作 |
| 费用/次数与**超限行为** | 次数 ≤2 与总额 ≤$0.01 是**给主人的授权口径，不是代码里的硬停止条件**。代码事实（`budget.mjs` settle）：实际金额可以超过预留上限 `callUpperMicrousd`（当前占位 1000 microUSD），超限时预留**仍会 SETTLED**（如实入账实际金额），随后任务/日账户被置 `frozen=1` 并记 `budget_overcharge_frozen` 审计与告警流事件；**调用之前没有任何金额硬拒绝**。任务/日预算上限（800000 / 5000000 microUSD）同样只在 reserve 时拒绝超出预留的请求，不拦单笔结算超额 |
| 超限时如何停手与回滚 | ① 见到 `budget_overcharge_frozen` 审计即**停手**：不再使用剩余次数；② `model.endpoint` 置回 null（回到零调用默认）；③ 槽 `model` 撤销/轮换；④ 被冻结的账户**保持冻结**——账本代码没有解冻路径（`frozen=1` 只置位），如实入账的超限金额不抹除，是否解冻/调额属后续人工与 ADR 范围，不在本计划内 |
| 通过标准 | ① HTTP 2xx 且响应含 `usage.prompt_tokens/completion_tokens`；② 预留行 `SETTLED`，`source=model-http-transport`，结算额 = 目录价 × usage；③ `budget_settled` 审计在案；④ 任务 `SUCCEEDED` 且 `task_result` 对象带 ACL 入库；⑤ 全程无 `budget_overcharge_frozen`（若有，按上行停手并如实记录）；⑥ usage 缺失时必须 HELD + `model_usage_not_settled`（失败关闭成立，不计为真实计费闭环） |

## B. 真实外部写（单次受控 POST，主人指定可丢弃端点）

| 项 | 内容 |
| --- | --- |
| 端点 | 主人指定的**可丢弃 HTTP 端点**（完整 URL）。**不是 GitHub 草稿 PR，不是任何仓库写**——仓库/PR 类动作属 Phase 4，本项不含 |
| 载荷（代码事实） | 现有真实传输 `upstream-http.mjs` 提交的是**内部 JSON 信封**：`{kind:"submit", businessKey, idempotencyKey, operation, at}`，其中 `operation` 为适配器字段（`operation`/`targetResource`/`expectedHead`）。原样 POST 一次，无平台 API 客户端、无凭据进载荷 |
| 凭据槽 | `im`（`allowRealExternalWrites=true` 时适配器要求已接线凭据槽；值入 `.env`，仅槽名入库） |
| 动作范围 | **1 个 effect、1 次 POST**，`AT_MOST_ONCE`。执行完成后 `policy.allowRealExternalWrites` **立即置回 false**（回到默认失败关闭），不允许第二次 |
| 费用/次数上限 | 1 次外部 POST；超出的任何重试都需再次授权 |
| 通过标准 | ① effect `SUCCEEDED` 且 `external_id` 为端点返回真值；② 端点侧恰好收到 1 份载荷（人工核对一次）；③ 无第二次提交（审计与传输日志核对）；④ 未授权对照重测仍零字节（`allowRealExternalWrites=false`）；⑤ 审批链在案（proposal → CAS → SUBMITTING → SUCCEEDED） |
| 回滚 | `policy.allowRealExternalWrites` 置回 false（**执行后立即做，不等收尾**）；撤换 `im` 槽；effect 台账保留；端点由主人自行丢弃 |

## C. Telegram 只读（getMe / getUpdates，事故已计入上限）

| 项 | 内容 |
| --- | --- |
| 端点 | `https://api.telegram.org`，经本机已配置的系统代理出网 |
| 凭据槽 | 本机 `.env` 的 `TELEGRAM_BOT_TOKEN`（脚本全程脱敏；值不入提示词、日志、仓库） |
| 次数账本（2026-11-20 更新） | 总上限维持 ≤4 时**已用 2 次**：2026-11-20 事故一次无旗标 real 运行 = getMe ×1（通过）+ getUpdates ×1（网络层 ECONNRESET，失败）。**授权后剩余额度 = 2 次**（如 getMe ×1 + getUpdates ×1），**不得**在事故之外按原表满额重跑；若主人改定上限，按改定值扣减已用 2 次计算 |
| 动作范围 | 仅 getMe / getUpdates。**无 sendMessage、无 offset 确认、队列不消费**；超出剩余额度的任何调用都需再次授权 |
| 费用 | Bot API 只读零费用 |
| 通过标准 | 退出码 0；身份核验 PASS（@aegispibot）；updates 可读或队列空如实记 NOTE；输出无 token 明文；本地确定性套件仍 7/7 |
| 回滚 | 只读无副作用；如需，主人在 @BotFather 轮换 token（`.env` 同步更新） |

## D. 公网 Telegram webhook（唯一改变监听面的一项）

| 项 | 内容 |
| --- | --- |
| 端点 | 主人指定的公网可达地址/隧道 → 宿主 console 的 `POST /ingress/telegram/webhook` |
| 凭据槽 | `telegramWebhookSecret`（≥16 字符随机值，宿主配置，不进日志）；`setWebhook` 属平台配置写，用 C 项同一 token 由主人执行或明确授权 |
| **同操作约束** | `setWebhook` 与 `deleteWebhook` 必须在**同一次操作窗口内完成**：注册 → 观察投递 → 立即摘除并绑回 `127.0.0.1`。**不留下隧道、不留下公网监听面**；两调用之间不做其他事 |
| 动作范围与次数 | 绑定临时放开（Host 白名单随之更新，Origin/Host 检查保持）；`setWebhook` ×1 + 测试消息 ≤3 + `deleteWebhook` ×1；次数各不超限 |
| 通过标准 | ① 合法 secret 头投递 → 202，inbox `DONE/OBSERVE`、不派任务、重复 update_id 去重为一行；② 错误 Host/Origin/缺头 → 403 零处理；③ secret 值不出现在任何日志/审计/报告；④ 操作结束时 `deleteWebhook` 已成功、绑定已回到 `127.0.0.1`、隧道已拆 |
| 回滚 | 默认路径：`deleteWebhook` 成功 + 绑定回 `127.0.0.1` + secret 撤除/轮换 + 隧道拆除，恢复本轮验证过的本机形态。**回滚失败处置**（写明）：若 `deleteWebhook` 失败，立即人工在 Telegram 侧删除 webhook（@BotFather 或平台控制台），必要时轮换 token 使旧 webhook 失效，并在操作记录里如实记「公网入口曾存续至 X 时刻」；不自动重试超过 1 次 |
| 费用 | setWebhook/deleteWebhook 与消息接收零费用 |

## 总边界

- 四项独立授权、独立执行、独立记录；任一项失败即停该项，不自动重试，不扩大范围补救。
- 授权口径（次数、总额）不是代码里的硬门禁，是执行纪律；代码侧的失败关闭（未授权零字节、缺 usage HELD、未到期不派发）保持不动。
- 执行后逐项记录命令、退出码、计数、实际费用与残留，追加进 `docs/phase3/evidence/`，不改写历史记录。
- 凭据值在任何环节不进提示词、日志、仓库；本计划只含槽名与主人授权时才提供的非密参数。
- Phase 4（真实仓库业务闭环）不在本计划内，另按 04 任务书入口门禁申报。
- 本修订提交即等待；**未获逐项书面授权前，保持默认：零付费调用、零真实平台外发、公网 webhook 未注册。**
