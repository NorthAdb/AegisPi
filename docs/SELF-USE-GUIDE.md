# AegisPi 个人自用指南

本指南说明如何在本机配置, 检查并启动 AegisPi 个人试用实例. 所有命令都在仓库根目录执行, 并固定使用锁定的 Node 运行时 `D:\AegisPi\tools\node-v22.23.5\node.exe`.

## 准备本地配置与环境变量

`apps/daemon/config/defaults.json` 必须保持全失败关闭, 不要直接修改它. 按下列步骤创建本地配置和密钥文件.

1. 复制 `apps/daemon/config/selfuse.example.json` 为 `apps/daemon/config/selfuse.local.json` 或仓库根的 `selfuse.config.json`, 两者都已被 `.gitignore` 忽略.
2. 在本地配置中填入真实的非密钥字段: Telegram `allowedChatIds`, `adapters.allowedRecipients`, 邮箱 `imapHost` 与 `smtpHost`, `adapters.fixedSendingIdentity`, 以及已核准的 `model.priceCatalog` 四项单价.
3. 确认已核对费率与风险后, 按需将 `model.allowRealModelCalls`, `policy.allowRealExternalWrites`, `telegram.allowRealPull`, `telegram.allowRealSend`, `mail.allowRealMailRead`, `mail.allowRealMailSend` 设为 `true`.
4. 在仓库根 `.env` 中配置以下键名, 不要把真实值写入任何文档或配置 JSON:
   - `DEEPSEEK_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_OWNER_USER_ID`
   - `MAIL_USER`
   - `MAIL_APP_PASSWORD`
   - 可选 `AEGISPI_TG_PROXY` 与 `AEGISPI_MAIL_CREDENTIAL`

`scripts/selfuse.mjs` 会在内存中根据 `MAIL_USER` 与 `MAIL_APP_PASSWORD` 自动合成 `AEGISPI_MAIL_CREDENTIAL`, 不会将其打印或落盘.

## 初始化, 检查与启动

如果修改过 `apps/daemon/src` 或 `apps/daemon/config`, 需要先重建 `agent` 镜像以更新摘要绑定.

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe tools/build-app-images.mjs --only=agent
```

使用 `scripts/selfuse.mjs` 执行初始化, 预检与启动.

1. 初始化数据库, 凭据槽位与初始权限, 可重复执行:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs init --config=apps/daemon/config/selfuse.local.json --briefing-time=08:30
```

2. 运行配置, 环境变量键名, 镜像摘要与守护进程预检:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs check --config=apps/daemon/config/selfuse.local.json
```

3. 启动常驻守护进程与本地控制台, 加 `--dry-run` 可先预览命令参数:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs start --config=apps/daemon/config/selfuse.local.json --briefing-time=08:30
```

启动后浏览器打开 `http://127.0.0.1:4310/`, 从 `workspace-state/console/token` 读取一次性登录凭据完成会话登录.

## Telegram 日常指令

Bot 只接收 `telegram.allowedChatIds` 白名单中的会话消息.

- `/status`: 查询当前作用域运行中任务, 排队任务, 待审批数与暂停状态.
- `/stop`: 立即取消当前会话线程的未完结任务.
- `/pause`: 暂停当前作用域路由并取消其 `SCHEDULED` 定时器.
- `/resume`: 恢复当前作用域路由.
- `/observe <targetId> [question]`: 对已配置的只读仓库目标拉取源码并问答.
- `/triage <presetId> [question]`: 触发预配置的只读复现与四分类影响判定.
- 自由文本消息: 进入单轮模型问答, 开启 `telegram.autoReplyOnTask: true` 且目标在 `adapters.allowedRecipients` 中时自动回发结果.

## 邮件草稿与本地审批流程

1. 守护进程通过 IMAP 拉取 `mail.allowedFolders` 中的新邮件并做脱敏摘要入库.
2. 当 `mail.autoDraftReplies` 为 `true` 且发件人在 `mail.allowedRecipients` 与 `adapters.allowedRecipients` 小写白名单内时, 模型生成回复草稿并停在 `WAITING_APPROVAL`.
3. 打开 `http://127.0.0.1:4310/` 第一页签, 核对收件人, 主题和正文后点击批准.
4. 宿主校验会话, CSRF 与白名单后通过 SMTP 提交发送, 并记录 `external_id`.

## 晨报定时任务

在 `init` 或 `start` 时传入 `--briefing-time=HH:MM`, 脚本会幂等创建 `tmr:selfuse-morning-briefing`.

- 调度时区取自 `calendar.defaultTimezone`, 按 `daily_wall_clock` 规则跨日与跨夏令时触发.
- 若触发时刻落在 `calendar.quietHours` 静默时段内, 通知会通过 `not_before` 推迟到静默结束并合并同日旧简报, 不会静默丢弃.
- 推送目标优先取 `telegram.ownerDestination`, 未设置时取 `telegram.allowedChatIds` 中第一个非负私聊 ID.

## 当前明确边界

- CalDAV 真实日历通道延后, 默认配置保持 `calendar.caldavUrl: null`.
- Telegram 公网 Webhook 延后, 当前只启用路线 1 主动 `getUpdates` 长轮询.
- 通用 Telegram 或邮件对话为单轮问答, 不会自动执行多轮工具循环或从自由回复直接生成外部写审批卡.
