# evals/phase1-closure — 用户侧收口项验证脚本（不进 test:contracts）

这里放的是 Phase 1 出口门禁中**用户侧收口项**的验证脚本。它们与 `evals/contracts/`（15 探针契约套件）刻意分离，原因：

1. **真实外部调用**：`verify-deepseek-minimal.mjs` 执行**一次**真实付费推理（DeepSeek Flash High 绑定契约）；`verify-telegram-identity.mjs` 调用 Telegram Bot API 的只读方法（getMe / getChat）。契约套件全部走本地 fake 端点、零费用、可无限重跑——这两条不是。
2. **凭据来源**：两脚本只在**本机进程内**从仓库根的 `.env` 读取 `DEEPSEEK_API_KEY` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_USER_ID`，绝不打印、写盘或入库（`.env` 已被 `.gitignore` 排除）。脚本文件本身不含任何密钥，只含变量名。
3. **无重试纪律**：DeepSeek 脚本一次推理、失败即停、不自动换模型（owner-baseline.local.md §4 的授权边界）；Telegram 脚本不发消息（暂不发送测试消息）。

运行（锁定 Node 22.23.5）：

```
node evals\phase1-closure\verify-deepseek-minimal.mjs     # 一次最小真实推理
node evals\phase1-closure\verify-telegram-identity.mjs    # getMe + getChat（只读）
```

证据落位：`docs/phase1/evidence/07-real-connections.md`（脱敏：只记变量名、布尔与脱敏摘要，不录任何密钥或 owner ID 原值）。
