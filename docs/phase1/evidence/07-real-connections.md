# 证据 · 07 用户侧收口项的真实连接验证（2026-11-19）

执行环境：锁定 Node v22.23.5（显式路径），Windows 11，仓库 `D:\AegisPi\aegis-pi`。

## 0. 凭据安全前置检查（在任何调用之前）

```
git check-ignore -v .env          → .gitignore:4:.env   .env     （命中忽略规则）
git ls-files .env                  → （空：未跟踪）
git status --porcelain .env        → （空：既未跟踪也不显示为未跟踪改动）
git check-ignore -v owner-baseline.local.md → .gitignore:6:owner-baseline.local.md （本轮新增规则）
```

`.env` 含 3 个变量（`DEEPSEEK_API_KEY`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_USER_ID`，仅核验名称均为 SET；**值从未被读取输出**）。密钥只经脚本在本机进程内加载：DeepSeek 用 Pi 的 `setRuntimeApiKey`（内存态运行时凭据，隔离临时 authPath，进程退出即弃）；Telegram 用进程内 fetch。全输出经 scrub（任何位置出现密钥值即替换为 `***`）；本文件不录任何密钥或 owner ID 原值。

## 1. DeepSeek 最小推理契约 —— 通过（一次调用）

命令：`node evals\phase1-closure\verify-deepseek-minimal.mjs`（锁定 Node）

```
DEEPSEEK-EXIT=0
{
  "ok": true,
  "binding": { "provider": "deepseek", "modelId": "deepseek-flash", "thinkingLevel": "high" },
  "accepted": true,
  "stopReason": "stop",
  "errorMessage": null,
  "replyText": "[{\"type\":\"text\",\"text\":\"OK\"}]",
  "reasoningReported": false,
  "usage": {
    "input": 461, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 463,
    "cost": { "input": 0.0001383, "output": 0.0000024, "cacheRead": 0,
              "cacheWrite": 0, "total": 0.0001407, "totalFromProvider": false }
  },
  "durationMs": 904,
  "nodeVersion": "v22.23.5"
}
```

判读（与 Phase 1 契约逐条对照）：

- **模型 ID 被接受**：真实 `api.deepseek.com`（Pi 目录 deepseek.json 原值 baseUrl，未做任何 models.json 重定向）接受 `deepseek-flash`，`stopReason=stop`，无错误。
- **thinking high 被接受**：Pi 1.5.2 对 deepseek 的 thinking 编码（catalog `thinkingFormat:"deepseek"`，thinkingLevelMap high→high，wire 上 `thinking:{type:"enabled"}`）被接受，请求正常完成。本次极小 prompt（"Reply with exactly the single word OK"）未回传 reasoning 文本（`reasoningReported:false` 如实记录）；接受性由 stopReason 证明，不虚构"深度思考已发生"。
- **实际返回**：回复恰为 "OK"。
- **usage 与可取得的费用信息**：input 461 / output 2 / totalTokens 463；目录价（0.3/1.2/0.006 USD per M）实算 cost.total **$0.0001407**；`totalFromProvider:false` 与 PI-10 实测形状一致（布尔旗标，DeepSeek 响应不含账单总额——usage 数字是唯一可取得的计费依据）。
- **纪律**：单次调用、无重试、未换模型（脚本内 retry.enabled=false、单 prompt、无循环）。失败即停的设计未触发。

## 2. Telegram 渠道身份验证 —— 本机网络不可达，如实开放

命令：`node evals\phase1-closure\verify-telegram-identity.mjs`（锁定 Node）

```
TELEGRAM-EXIT=1
{ "ok": false, "getMe": null, "ownerChat": null, "error": "fetch failed" }
```

诊断（连接层，非凭据层）：

```
Test-NetConnection api.telegram.org -Port 443
  RemoteAddress: 31.13.76.65    TcpTestSucceeded: False
代理环境变量：仅 NO_PROXY 存在，无 HTTP_PROXY/HTTPS_PROXY 配置
```

判读：

- `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_OWNER_USER_ID` 均已配置（变量名核验 SET；未输出值，脚本也未发送任何内容——getMe/getChat 均为只读调用，且本次连 API 层都未到达）。
- 失败原因是 `api.telegram.org:443` **TCP 不通**（DNS 解析到不可达地址），属本机网络环境事实。不猜测、不配置代理、不盲重试。
- 收口路径（二选一，均不需重新授权）：owner 在网络可达环境（或配置代理后）重跑同一脚本；或 owner 自行向 @aegispibot 复核。脚本已入库（`evals/phase1-closure/`），无密钥内容，可随 `.env` 在任何机器复跑。
- **未发送任何测试消息**（按本轮指令）。

## 3. 与本证据相关的边界声明

- 本轮 DeepSeek 调用是 owner-baseline.local.md §4 授权的**一次**最小推理，用于核对「DeepSeek Flash High」的真实模型绑定；未授权的其他付费调用一概未发生。
- Telegram 只读验证未完成不影响"渠道已选定"的事实（owner 已在 baseline §1 填 @aegispibot 与 /start 完成）；影响的是"机器侧核实"这一步，如实记为开放项。
- Phase 1 宣布完成前仍需：75 条标注的 owner 确认（草案已生成，12 条 uncertain 待复核）与 Telegram getMe 的可达环境补验。
