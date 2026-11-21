# 单元 4.3 收口报告（核心缺陷修复与 Telegram Bot 出站链路）

> **日期**：2026-11-21（Asia/Hong_Kong）  
> **起始基线**：`c8c4041`（`main`，已包含单元 4.2 许可 2 广度真实 Repo Observe 验收 `D-83`）  
> **授权口径**：方案 A 单元 4.3（本地工程修复、Telegram Bot 出站适配实现与离线/环回验证； resolutions 留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-84`）  
> **运行环境**：Windows 11（Docker Desktop + `127.0.0.1:5000` 本地构建 registry），锁定 Node `v22.23.5`（`D:\AegisPi\tools\node-v22.23.5\node.exe`）

---

## 一、核心结论

单元 4.3 完成了从单元 4.2 广度实测暴露的两项核心质量缺陷修复以及独立可失败关闭的 Telegram Bot 出站发送链路（`sendMessage`），并在 `comment-sicko` 对抗审查清理与**镜像纪元 7** 终树上完成了全量 **13 套离线/容器套件 + `image-gate` + Hono 配对预检**（全部 `exit 0`）。

**零越界声明**：本单元全程**未读取 `.env`、未发送任何真实 Telegram 出站消息、未发起任何真实模型或 GitHub 网络调用、未修改 `defaults.json` 失败关闭默认值（`$0.80` / `$5` / `1000` / `45s` / 全 `null` / 全 `false` / 全 `[]` 完整保留）、未接触 `CONSOLE_BIND` 或 D 项公网入站 webhook、未推送远端。**

1. **空回复防误判 `SUCCEEDED` 闭环**：在 [model-requests.mjs](../../../apps/daemon/src/model-requests.mjs) 与 [adapters.mjs](../../../apps/daemon/src/adapters.mjs) 落地统一拦截。当模型调用返回有效 `usage` 但 `reply` 为空或纯空白时，预算账本照常 `SETTLED` 核扣实际开销，同时任务不再标为 `SUCCEEDED`：写回事务将任务落入 `FAILED`（`result_class='infra_error'`，`error_code='model_output_truncated_empty'` 或 `'model_empty_reply'`），记录审计 `model_empty_reply_uncompleted`，禁止将 `event_deliveries`/`inbox` 提前置 `DONE`，且向容器写入 `ok: false` 拒绝信封而非伪成功空串。
2. **KV 前缀缓存稳定与前置输入限额拦截**：在 [repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs) 将可变的 `\n\nTask Question: ...` 移至不变头与 `Sanitized Read-Only Excerpts:` 之后，并在 `fitPromptToMaxInputBytes` 截断及按 `256B` 最小问题预留对齐 `capLimit` 时保证同快照不同短问题的截断前缀逐字节一致；同时在拉起 `acquisition` 容器前预先核算最小信封字节，若已超 `model.maxInputBytes` 则零容器、零拉取直接以 `input_bytes_exceeded` 拒收。
3. **Fail-Closed Telegram Bot 出站适配器**：新增 [telegram-send.mjs](../../../apps/daemon/src/telegram-send.mjs) 与隔离短命子进程 [upstream-telegram-child.mjs](../../../apps/daemon/src/upstream-telegram-child.mjs)，并接入 [defaults.json](../../../apps/daemon/config/defaults.json)、[config.mjs](../../../apps/daemon/src/config.mjs)、[adapters.mjs](../../../apps/daemon/src/adapters.mjs)、[daemon.mjs](../../../apps/daemon/src/daemon.mjs) 与 [upstream-http.mjs](../../../apps/daemon/src/upstream-http.mjs)（`[::1]` 环回兼容）。关键不变量：
   - **配置失败关闭**：`telegram.apiBase: null`、`telegram.allowRealSend: false`、`policy.allowRealExternalWrites: false`、`adapters.allowedRecipients: []`、`credentials.im: null`。
   - **传输与密钥隔离**：经 `stdin`（绝不走命令行参数或子进程环境）传递 `botToken` 至仅带安全白名单环境的子进程，拒绝含空白/`/`/`?`/`#`/`\` 的畸形 token；所有错误路径与日志均在截取前脱敏替换 token。
   - **强门禁与状态诚实**：仅路由 `^(?:(?:dm|group):)?telegram:(-?\d+)$` 目标（保留已有 `upstream.submitUrl` 兼容性），强制要求非空 `adapters.allowedRecipients` 命中、非环回需 `allowRealSend=true`、动态解析未吊销 `"im"` 凭据槽位并按 `sha256(content)` 校验消息正文（`1..4096` 字符）；`lookup()` 正确按 `effects` 目标路由至 `telegramUpstream` 并返回 `{ found: false, strong: false }` 防止误重放；超时映射 `UNKNOWN`（daemon 退出码 `4`），远端 4xx/5xx 映射非重试 `FAILED`。

---

## 二、产物清单

| 类别 | 文件 | 职责与主要变更 |
| --- | --- | --- |
| 默认配置与启动校验 | [apps/daemon/config/defaults.json](../../../apps/daemon/config/defaults.json)、[apps/daemon/src/config.mjs](../../../apps/daemon/src/config.mjs) | 新增失败关闭 `telegram` 配置块（`apiBase: null`、`allowRealSend: false`、`timeoutMs: 15000`），校准 `adapters.$comment`，校验 URL 与字符串白名单数组 |
| Telegram 出站核心 | [apps/daemon/src/telegram-send.mjs](../../../apps/daemon/src/telegram-send.mjs)、[apps/daemon/src/upstream-telegram-child.mjs](../../../apps/daemon/src/upstream-telegram-child.mjs)、[apps/daemon/src/model-call.mjs](../../../apps/daemon/src/model-call.mjs)、[apps/daemon/src/upstream-http.mjs](../../../apps/daemon/src/upstream-http.mjs) | 导出 `buildSafeChildEnv`；实现 `stdin` 传参、`sha256` 载荷验证、失败关闭门禁、`spawnSync` 与网络错误映射、`[::1]` 环回识别与先脱敏后截断 |
| 适配器与 Daemon 接线 | [apps/daemon/src/adapters.mjs](../../../apps/daemon/src/adapters.mjs)、[apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs) | 统一共享 `isRecipientAllowed`、`model.inference` 空回复拒绝、`lookup()` 按 `effects` 目标路由至 `telegramUpstream`；`daemon.mjs` 统一 `canDispatchEffectRow` 避免 SQL/正则漂移 |
| 模型状态机与 Observe | [apps/daemon/src/model-requests.mjs](../../../apps/daemon/src/model-requests.mjs)、[apps/daemon/src/repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs) | 空回复结算后强制任务 `FAILED`（`infra_error`）并拒绝 `DONE`/伪成功回执；`Task Question:` 后置稳态 KV 前缀并前置拦截超 `maxInputBytes` 请求 |
| 测试与本地夹具 | [evals/phase3/security-unit/helpers/local-telegram-service.mjs](../../../evals/phase3/security-unit/helpers/local-telegram-service.mjs)、[evals/phase3/security-unit/run.mjs](../../../evals/phase3/security-unit/run.mjs)、[evals/phase3/model-proposal/run.mjs](../../../evals/phase3/model-proposal/run.mjs)、[evals/phase3/repo-observe/run.mjs](../../../evals/phase3/repo-observe/run.mjs)、[evals/phase3/security-unit/helpers/local-model-service.mjs](../../../evals/phase3/security-unit/helpers/local-model-service.mjs) | 新增 Telegram 环回服务与 9 场景失败关闭/超时/远端错误/零泄漏回归、`length` 与空白回复 `SUCCEEDED` 拒绝验证、`repo-observe` KV 前缀稳定与前置零容器截停验证 |

---

## 三、镜像纪元 7 与全量离线/容器终树验收（Node `v22.23.5`）

- **镜像纪元 7**（[image-digest.md](../../phase3/reports/image-digest.md)）：仅增量重建 `agent`（`manifest: sha256:08b5ef169f76c808fcea07ab4dad05d3f7005c6eb56adf8335d1c2e66a7bfc2a`、`config: sha256:19b9e118c163d41073032d6e43f33eeb111082fdde210f0ab55d552a2650650c`、`context: sha256:f5c5f2b3f8c96d17b4723e17f3a0ec2a59bc866296f42991e59193b3dc22e056`，`--self-check: green (pi 1.5.2)`），`acquisition` 与 `execution` 核验无漂移携带沿用。

| 套件 | 执行命令 | 实测结果 | 退出码 |
| --- | --- | --- | --- |
| `image-gate` | `node evals/phase3/lib/image-gate.mjs` | 三镜像 context/manifest/config 零漂移 | `0` |
| `test:security:unit` | `node evals/phase3/security-unit/run.mjs` | `45 pass, 0 fail, 45 judged` | `0` |
| `test:model-proposal` | `node evals/phase3/model-proposal/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:repo-observe` | `node evals/phase3/repo-observe/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `test:contracts` | `node evals/contracts/run-contracts.mjs` | `15 probe(s): all PASS` | `0` |
| Hono 配对预检 | `node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 / 4.12.24 / 未安装拒绝全过 | `0` |
| `test:durability` | `node evals/phase2/durability/run.mjs` | `164 pass, 0 fail, 164 judged` | `0` |
| `test:acl` | `node evals/phase2/acl/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:budget` | `node evals/phase2/budget/run.mjs` | `20 pass, 0 fail, 20 judged` | `0` |
| `test:cancel-approval` | `node evals/phase3/cancel-approval/run.mjs` | `16 pass, 0 fail, 16 judged` | `0` |
| `test:restore` | `node evals/phase3/restore/run.mjs` | `11 pass, 0 fail, 11 judged` | `0` |
| `test:ingress-telegram` | `node evals/phase3/ingress-telegram/run.mjs` | `7 pass, 0 fail, 7 judged (+ 1 NOTE)` | `0` |
| `test:offline-jobs` | `node evals/phase3/offline-jobs/run.mjs` | `14 pass, 0 fail, 14 judged` | `0` |
| `test:security:integration` | `node evals/phase3/security-integration/run.mjs` | `29 pass, 0 fail, 29 judged` | `0` |
| `test:quota-calibration` | `node evals/phase3/quota-calibration/run.mjs` | `5 pass, 0 fail, 5 judged` | `0` |

- `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：0 命中（退出码 `1`）。
- 接下来推进 **单元 4.4（Scenario 4 完整判定闭环 `repo_triage`、`eval:triage` 与 `report:user-value` 离线验收）**。
