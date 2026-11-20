# Phase 3 真实验收最小计划（待主人逐项授权，未执行）

生成：2026-11-20。本计划回应复审 11d649a 的授权待验清单，给出四项真实验收各自的端点、凭据槽、动作范围、费用/次数上限、通过与回滚标准。**在主人对单项明确点头之前，任何一项都不执行；本轮已完成的所有工作不含下列任何真实调用。** 凭据一律只写槽名与环境变量名，值不进提示词、日志、报告或仓库；值只进本机 `.env`（已 gitignore）或宿主凭据服务槽。执行环境固定：锁定 Node 22.23.5，失败即停、不自动重试、不换模型/通道，全程审计留痕。

## A. 真实模型（DeepSeek，一次最小推理经宿主路径）

| 项 | 内容 |
| --- | --- |
| 端点 | `https://api.deepseek.com`（Phase 1 最小推理契约已实测过的官方端点），宿主 `model.endpoint` |
| 凭据槽 | 宿主凭据服务槽 `model` ← 本机 `.env` 的 `DEEPSEEK_API_KEY`（Phase 1 已录入，不入库） |
| 模型 | `deepseek/deepseek-flash`（Phase 1 绑定，Pi 目录真实 ID），经宿主 `callModelOnce` 直连，**不经容器、不经 Pi SDK** |
| 动作范围 | 最多 **2 次** `callModelOnce`（1 次主调用 + 失败时 0 次；不做重试循环）。载荷为一段固定中性文本。无 SendMessage、无工具、无仓库操作 |
| 费用上限 | 单次调用预留上限 `callUpperMicrousd`（defaults 当前为占位 1000 microUSD，授权时由主人连同价格目录一并核定，目录按 Phase 1 绑定 0.3/1.2 USD/M = 300000/1200000 microUSD/M）；本轮总额上限 **$0.01**（按目录价，一次最小调用约 $0.0002，Phase 1 实测 $0.0001407）。任务/日预算上限（800000 / 5000000 microUSD）兜底 |
| 通过标准 | ① HTTP 200 且响应含 `usage.prompt_tokens/completion_tokens`；② 预留行 `SETTLED`，`source=model-http-transport`，结算额 = 目录价 × usage；③ `budget_settled` 审计在案且结算额 ≤ 上限；④ 任务 `SUCCEEDED` 且 `task_result` 对象带 ACL 入库；⑤ 若 usage 缺失 → 必须 HELD 并如实记 `model_usage_not_settled`（失败关闭仍成立也算部分通过，但不计为「真实计费闭环」） |
| 回滚 | `model.endpoint` 置回 null（回到零调用默认）；槽 `model` 撤销/轮换；预算日账户冻结可即停后续调用。已发生的 1-2 次计费不可逆，如实入账，金额 ≤ 上限 |

## B. 真实外部写（单次受控写，主人指定目标）

| 项 | 内容 |
| --- | --- |
| 端点 | 主人指定的真实平台端点写入 `upstream.submitUrl`（示例形态：GitHub API 或其他 IM/邮件网关，由主人选定目标后填入） |
| 凭据槽 | 按所选平台对应槽（`repo` / `im` / `mail`），值入 `.env`，宿主适配器提交时读取 |
| 动作范围 | **1 个 effect**、1 次提交。目标必须是主人自有的可丢弃对象（如主人私有测试仓库的 `aegis-fix/*` 分支草稿 PR，或主人与自己的测试会话）。`AT_MOST_ONCE`。不经容器、模型不拼接 URL |
| 费用/次数上限 | 1 次写。GitHub/邮件发送零费用（平台内）；总外部写次数上限 = 1，超出的任何重试都需再次授权 |
| 通过标准 | ① effect `SUCCEEDED` 且 `external_id` 为平台返回真值；② 平台侧可见该产物（人工核对一次）；③ 服务日志/审计无第二次提交；④ 未授权路径回归重测仍零字节（`allowRealExternalWrites=false` 对照）；⑤ 全程审批链在案（proposal → CAS 审批 → SUBMITTING → SUCCEEDED） |
| 回滚 | `policy.allowRealExternalWrites` 置回 **false**（默认失败关闭恢复）；平台侧删除测试产物（若平台支持）；撤换对应凭据槽；effect 台账保留记录不抹除 |

## C. Telegram 只读复验（getMe / getUpdates）

| 项 | 内容 |
| --- | --- |
| 端点 | `https://api.telegram.org`，经本机已配置的系统代理出网（Phase 1 收口时实测过同路径） |
| 凭据槽 | 本机 `.env` 的 `TELEGRAM_BOT_TOKEN`（已在库外；自检脚本全程脱敏，token 不入日志） |
| 动作范围 | `test:ingress-telegram:real` 套件本身：getMe ×1 + getUpdates ×1-2。**无 sendMessage、无 offset 确认、队列不消费**（只读语义） |
| 费用/次数上限 | Bot API 只读零费用；调用次数 ≤ 4 |
| 通过标准 | 退出码 0；`authorized-telegram-identity-readable` PASS（@aegispibot 身份核验）；`authorized-telegram-updates-readable-readonly` PASS（队列空时如实记 NOTE）；输出无 token 明文；本地确定性套件仍 7/7 |
| 回滚 | 只读无副作用，无需回滚；如需，主人可在 @BotFather 轮换 token（`.env` 同步更新） |

**事故申报（本轮如实记录）**：2026-11-20 整改过程中，实施 agent 在验证 `--simulate-no-token` 文案修复时误运行了无旗标的 real 入口一次，构成一次未授权的真实只读调用（getMe 通过、getUpdates 网络层 ECONNRESET、exit 1；无 sendMessage、无 offset 确认、零费用、token 未泄露）。这违反了本轮「不复验 Telegram」的执行边界；被覆盖的证据文件已还原为提交版本，特此申报并由主人裁量是否计入 C 项次数。C 项在授权后仍按上表全量执行一次。

## D. 公网 Telegram webhook（唯一涉及「部署形态变化」的一项）

| 项 | 内容 |
| --- | --- |
| 端点 | 主人指定的公网可达主机/隧道（如主人已有的反代或隧道域名）→ 宿主 console 的 `POST /ingress/telegram/webhook`；Telegram 侧 `setWebhook` 一次 |
| 凭据槽 | `telegramWebhookSecret`（≥16 字符随机值，宿主配置，不进日志）；Telegram 投递凭据复用 C 项 token（setWebhook 需写权限，属平台配置写，需主人执行或明确授权） |
| 动作范围 | ① 绑定变更：console 监听从 `127.0.0.1` 扩到主人指定地址/端口（Host 白名单随之更新，保持 Origin/Host 检查）；② `setWebhook` ×1（携带 secret_token）；③ 从 Telegram 发 2-3 条真实测试消息观察投递；④ `deleteWebhook` ×1 恢复 pull 模式 |
| 费用/次数上限 | setWebhook/deleteWebhook 各 ≤1 次（平台配置写，零费用）；测试消息 ≤3 条 |
| 通过标准 | ① 合法 secret 头投递 → 202，inbox `DONE/OBSERVE`、不派任务、重复 update_id 去重为一行（本地阶梯在公网复现）；② 错误 Host/Origin/缺头 → 403 零处理；③ secret 值不出现在任何日志/审计/报告；④ 回滚后 pull 模式恢复（getUpdates 可读） |
| 回滚 | `deleteWebhook`（Telegram 回到 pull）；`telegramWebhookSecret` 撤除；console 绑定回 `127.0.0.1`（白名单恢复默认）；secret 轮换。全链路回到本轮验证过的本机形态 |

## 总边界

- 四项独立授权、独立执行、独立记录；任一项失败即停该项，不自动重试，不扩大范围补救。
- 执行后逐项记录命令、退出码、计数、实际费用与残留，追加进 `docs/phase3/evidence/`，不改写历史记录。
- 凭据值在任何环节不进提示词、日志、仓库；本计划只含槽名。
- Phase 4（真实仓库业务闭环）不在本计划内，另按 04 任务书入口门禁申报。
- 本计划提交即等待；**未获逐项授权前，保持本轮默认：零付费调用、零真实平台外发、公网 webhook 未注册。**
