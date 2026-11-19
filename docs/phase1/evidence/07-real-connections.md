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

## 2. Telegram 渠道身份验证 —— 通过（2026-11-19 最终复测）

**过程（如实全记）**：

1. **直连失败**：`fetch failed`（`UND_ERR_CONNECT_TIMEOUT`）；`api.telegram.org:443` TCP 不通，DNS 解析到不可达地址（网络环境阻断）。
2. **经本机系统代理**（WinINET `ProxyEnable=1, ProxyServer=127.0.0.1:7897`——用户自配的本地 Clash 类；脚本新增代理路由：`AEGISPI_TG_PROXY` → `HTTPS_PROXY`/`HTTP_PROXY` → Windows 系统代理，CONNECT 隧道 node:net+node:tls 自实现，零新增依赖）：**getMe 通过**，但 `getChat` 返回 "chat not found"。
3. **诊断（只读、脱敏）**：`--diag-updates` 更新队列 0 条；`.env` 值形状核验（只出布尔）——`TELEGRAM_OWNER_USER_ID` 当时**含字母、非纯数字**。按纪律未输出原值、未猜正确值，owner 侧修正。
4. **owner 修正 ID 值后最终复测**：

```
TELEGRAM-EXIT=0
{
  "via": "proxy 127.0.0.1:7897",
  "getMe":     { "ok": true, "isBot": true, "username": "aegispibot",
                 "idMasked": "****0813", "first_name": "aegispibot" },
  "ownerChat": { "ok": true, "chatType": "private", "idMatchesOwner": true,
                 "idMasked": "****1428", "firstNamePresent": true,
                 "startConfirmed": true },
  "nodeVersion": "v22.23.5"
}
```

**判读**：Bot 身份证实（@aegispibot，is_bot=true）；owner 私聊证实（chatType=private、idMatchesOwner=true、**startConfirmed=true**——即 /start 已由该账号完成，机器可证）。全程未发送任何消息（getMe/getChat/getUpdates 皆只读）。Bot token 只经本机进程与 owner 自己的本地代理进程。

## 3. 75 条标注的 owner 确认（2026-11-19 收口时点）

owner 复核完成并授权确认（记录在本地 owner-baseline.local.md §3，不入库）：30 条窗口内公告保持该关注；9 条修复版保持该关注；**原 12 条 uncertain 对照官方 GitHub 发行说明复核后全部转「可忽略」**（其中 v4.13.0 的 CORS 变化只是默认允许方法加入 QUERY；v4.13.15/17 的转义/cookie 前缀小修复未作为安全公告发布；v4.13.19 为锁定版本常规发布）——最终计数**该关注 39 / 可忽略 36 / uncertain 0**。labels 文件实测与该记录逐项一致（本地 gitignored，per-item reason 不入库）。hono 75 条仍为评测/标注样本夹具，与 AegisPi 服务监控范围（基线第 1 句：只盯 NorthAdb/AegisPi）不混同。

## 4. 与本证据相关的边界声明

- 本轮 DeepSeek 调用是 owner-baseline.local.md §4 授权的**一次**最小推理（不重放：单发授权已用尽，第四轮审计已对脚本结构与目录价算式独立核对）。
- 四项用户侧收口全部有机器证据或 owner 记录：DeepSeek（本文件 §1）、Telegram（§2）、基线三句话（owner-baseline §2）、75 条标注（§3）。
- 收口级自审三件套实测：全套契约 15/15 退出码 0、hono 配对自检退出码 0、规范包验证器 14/14 退出码 0（收口提交时的最新 generatedAt 报告在库）。
