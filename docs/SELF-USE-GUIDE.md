# AegisPi 个人自用指南

本指南说明如何在本机启动并配置 AegisPi 个人实例. 所有命令都在仓库根目录执行, 并固定使用锁定的 Node 运行时 `D:\AegisPi\tools\node-v22.23.5\node.exe`.

`apps/daemon/config/defaults.json` 必须保持全失败关闭, 不要修改它.

## 快速开始 (推荐路径)

首次启动只需两条步骤, 无需手动编辑 JSON 或 `.env`:

1. 一键启动守护进程与本地控制台:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs start
```

若仓库根目录尚未存在 `selfuse.local.json`, `start` 会自动从 `apps/daemon/config/selfuse.example.json` 复制生成该文件 (全部 `allowReal*` 开关默认 `false`, 保持失败关闭). 如需更换端口或开启晨报, 可附加 `--port=4310` 或 `--briefing-time=08:30`.

2. 在 Web 控制台完成配置与热生效:
   1. 浏览器打开 `http://127.0.0.1:4310/` (若使用了自定义 `--port`, 替换为对应端口).
   2. 从 `workspace-state/console/token` 复制一次性启动令牌并建立会话.
   3. 点击顶部引导横幅或 **"⑤ 设置与接入"** 页签, 按需填写 Model / Telegram / Mail / Backup 配置与密钥.
   4. 点击各板块的 **"测试模型连通性"** / **"测试 Telegram 连通性"** / **"测试 IMAP 连通性"** 验证环回或远端链路 (Model `/models`, Telegram `getMe`, Mail 只读 IMAP `LOGIN` + `SELECT`).
   5. 点击 **"保存并热生效"**, 宿主会原子写入 `selfuse.local.json` 与 `.env`, 同步数据库凭据槽位与作用域权限, 并原地重载守护进程运行时配置. (`calendar.quietHours` 为只读展示.)

密钥输入框留空保存时会保留 `.env` 中已有密钥, 不会覆盖或清空; 需要删除某项密钥时, 点击对应密钥旁的 **"清空该密钥"** 后再保存.

## Telegram 日常指令

Bot 只接收 `telegram.allowedChatIds` 白名单中的数字会话 ID.

- `/status`: 查询当前作用域运行中任务, 排队任务, 待审批数与暂停状态.
- `/stop`: 立即取消当前会话线程的未完结任务.
- `/pause`: 暂停当前作用域路由并取消其 `SCHEDULED` 定时器.
- `/resume`: 恢复当前作用域路由.
- `/observe <targetId> [question]`: 对已配置的只读仓库目标拉取源码并问答.
- `/triage <presetId> [question]`: 触发预配置的只读复现与四分类影响判定.
- 自由文本消息: 进入单轮模型问答, 开启 `telegram.autoReplyOnTask: true` 且目标在 `adapters.allowedRecipients` 中时自动回发结果.

## 邮件草稿与本地审批流程

1. 守护进程通过 IMAP 拉取 `mail.allowedFolders` (默认 `["INBOX"]`) 中的新邮件并做脱敏摘要入库.
2. 当 `mail.autoDraftReplies` 为 `true` 且发件人在 `mail.allowedRecipients` 与 `adapters.allowedRecipients` 小写白名单内时, 模型生成回复草稿并停在 `WAITING_APPROVAL`.
3. 打开控制台 **"② 待办与审批卡"** 页签, 核对收件人, 主题和正文后点击批准.
4. 宿主校验会话, CSRF 与白名单后通过 SMTP 提交发送, 并记录 `external_id`.

## 晨报定时任务

可在 **"⑤ 设置与接入"** 页签直接设置或清空晨报时间 (`HH:MM`), 或在命令行传入 `--briefing-time=08:30`, 宿主会幂等创建或更新 `tmr:selfuse-morning-briefing`.

- 调度时区取自 `calendar.defaultTimezone` (默认 `Asia/Hong_Kong`), 按 `daily_wall_clock` 规则跨日与跨夏令时触发.
- 若触发时刻落在 `calendar.quietHours` (默认 `23:00` 到 `07:00`) 静默时段内, 通知会通过 `not_before` 推迟到静默结束并合并同日旧简报, 不会静默丢弃.
- 推送目标优先取 `telegram.ownerDestination`, 未设置时取 `telegram.allowedChatIds` 中第一个非负私聊 ID.

## 高级配置与 CLI 参考

### 手动编辑配置与密钥

如需离线准备配置, 可手动编辑 `selfuse.local.json` (或使用 `--config=<path>` 指定独立配置文件, 均已被 `.gitignore` 忽略) 与仓库根 `.env`:

- 在开启 `model.allowRealModelCalls: true` 前, 需在 `model.priceCatalog` 填入四项已核准的整数单价 (`inputPerMTokMicrousd`, `outputPerMTokMicrousd`, `cacheReadPerMTokMicrousd`, `cacheWritePerMTokMicrousd`).
- `.env` 支持的密钥键名:
  - `DEEPSEEK_API_KEY`: 模型 API 密钥.
  - `TELEGRAM_BOT_TOKEN`: Telegram Bot 令牌.
  - `TELEGRAM_OWNER_USER_ID`: 可选, 用于群聊场景绑定主人 Telegram 数字用户 ID.
  - `MAIL_USER` 与 `MAIL_APP_PASSWORD`: 邮箱账号与应用专用密码 (`scripts/selfuse.mjs` 与设置保存接口会在内存中自动合成为 `AEGISPI_MAIL_CREDENTIAL`, 不会打印或写入 JSON).
  - `AEGISPI_BACKUP_MANIFEST_KEY`: 可选, 64 位十六进制密钥, 用于一致性备份清单签名; 未配置时备份窗口内会按失败关闭跳过.
  - `AEGISPI_REAL_TG_PROXY`: 可选, Telegram 出站/测试用 HTTP CONNECT 代理地址.

### CLI 初始化, 预检与镜像重建

如果修改过 `apps/daemon/src` 或 `apps/daemon/config`, 需要先重建 `agent` 镜像以更新摘要绑定:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe tools/build-app-images.mjs --only=agent
```

`scripts/selfuse.mjs` 子命令参考 (默认读取 `--config=selfuse.local.json`, `--data-dir=workspace-state`, `--env-file=.env`, `--port=4310`):

1. 仅初始化数据库, 凭据槽位与初始权限 (未传 `--config` 时自动从 `selfuse.example.json` 创建 `selfuse.local.json`, 可重复执行):

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs init
```

2. 运行配置, 环境变量键名, 镜像摘要与守护进程 `--check` 预检:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs check --config=selfuse.local.json
```

3. 预览启动命令而不启动守护进程:

```powershell
D:\AegisPi\tools\node-v22.23.5\node.exe scripts/selfuse.mjs start --dry-run
```

### 一致性备份窗口

守护进程在 `backup.windowStartHour` 到 `backup.windowEndHour` (默认香港时间 `04:00` 到 `05:00`) 每日执行一次一致性备份并按 `backup.retentionDays` (默认 `14` 天) 清理过期快照, 前提是 `AEGISPI_BACKUP_MANIFEST_KEY` 已配置为有效的 64 位十六进制密钥.

## 当前明确边界

- CalDAV 真实日历通道延后, 默认配置保持 `calendar.caldavUrl: null`.
- Telegram 公网 Webhook 延后, 当前只启用路线 1 主动 `getUpdates` 长轮询.
- 通用 Telegram 或邮件对话为单轮问答, 不会自动执行多轮工具循环或从自由回复直接生成外部写审批卡.
