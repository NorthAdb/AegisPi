# 阶段二网页首次接入验收

从 Windows 当前用户启动阶段二宿主，使用本机控制台口令登录。没有模型配置时，四视图仍可打开，「新建对话」会引导所有者进入「设置」。保存安排下次启动使用的配置，点击「应用配置」在同一端口重启宿主。

```powershell
& '..\tools\node-v22.23.5\node.exe' src/index.ts --stage 2
```

- **模型**。从 SDK 目录选择供应商和模型，填写已核验的 API 地址及 API Key，并确认对话请求的模型目的端。Router 和 Worker 共用已核验的 `deepseek/deepseek-flash` 配置，分别设置输出上限。模型测试在隔离会话用合成提示触发流式回复，走正常预算预留与结算。
- **Gmail**。输入 Google 账号、应用专用密码和所选 IMAP 文件夹。应用后运行「验证 Gmail 只读与已读标记」。宿主经验证的 TLS 使用 `EXAMINE` 和 `BODY.PEEK`，检查前后 `\Seen`，页面接收检查结果。
- **GitHub**。输入限制在所选仓库的细粒度 Contents 只读 PAT，填写仓库、分支和文件。应用后在能力视图审核 `get_file_contents` 定义和指纹，再返回设置验证所选文件。宿主固定官方本地 MCP v2.1.0，分别验证发行包和解压后的程序 SHA-256。 [官方发行版](https://github.com/github/github-mcp-server/releases/tag/v2.1.0)
- **来源送模**。连接器卡片对当前读取范围和模型地址提供单独的授权及撤销按钮。模型出站时重新检查来源读取权限和对应目的端授权。

配置 JSON 保存凭据引用。凭据由 Windows DPAPI `CurrentUser` 加密，浏览器只读回配置状态。账号接入默认只读。

测试发信可由单独授权的宿主 SMTP 配置启用 `useOperatorGmailCredential`，只向已经允许的 Google SMTP 端点提供同一发件账号的凭据，审批快照固定发件账号和收件人。测试仓写入使用宿主单独授权的 MCP 实例、凭据和目标白名单，可与网页配置的只读桥并存。实际外写沿用两次 CAS 和唯一提交器。

## 本机替身实测

2026-11-27，Windows x64，Node 22.23.5，npm 10.9.9，SQLite 3.54.1，Docker 29.9.2，Edge 157.0.4341.60。测试对象为 `1aa988e` 上的本次本地工作树。下表中的 `node` 使用锁定路径下的 `node.exe`。

| 命令 | 退出码 | 脱敏结果 |
| --- | --- | --- |
| `npm --prefix web run build` | 0 | 独立前端类型检查与生产构建通过 |
| `node tests/stage2/run-all.ts --data-dir data/onboarding-proven-stage2 --keep-data` | 0 | `stage2_aeebb202`，分层、依赖锁、五类 P0、桌面和窄屏通过。P0 `s2_p0_45a96409` 中发件账号不一致时拒绝领取，匹配账号的审批令独立假 TLS SMTP 收件增量为 1，重复领取失败 |
| `node tests/stage2/run-browser-e2e.ts --data-dir data/onboarding-browser-final` | 0 | `s2_browser_c0cb5f10`。冷启动、仅所有者可保存及应用、现有会话恢复、旧会话保留原模型、同一读取范围的凭据替换、逐段流式输出与单独送模授权均通过。两库、WAL、配置、加密文件和宿主日志的凭据明文扫描命中为 0 |
| `node tests/week1/run-all.ts --data-dir data/onboarding-release-week1 --keep-data` | 0 | `week1_44a7714c`。矩阵 25/25，W1-B 独立假 SMTP 收件 1 封，结果保留为 `UNKNOWN` |
| `node tests/week2/run-all.ts --data-dir data/onboarding-week2 --keep-data` | 0 | `week2_e279ee5a`。V01–V06、V03 Docker 和 S6 通过，S6 明文扫描命中为 0 |
| `node tests/week2/run-all.ts --data-dir data/onboarding-release-week2 --keep-data` | 1 | `week2_62bf8308`。并行复跑遇到宿主启动超时，且 V03 顺序导入只在限时内观察到一条回执。两条对应聊天命令均已持久化受理 |
| `node tests/week2/run-all.ts --data-dir data/onboarding-isolated-week2 --keep-data` | 1 | `week2_cf29437b`。V03 Docker `v03_e7c9696a`、V02、Edge 与 S6 均通过，S6 禁止位置命中为 0。V05 发现慢客户端队列关闭时漏掉重同步帧 |
| `node tests/week2/run-v04-v05.ts --data-dir data/onboarding-targeted-v04-v05` | 0 | `v04v05_4155cf19`。复核阶段二宿主重启时关闭 Web 连接的改动。原有慢客户端重同步、登出与撤权断流、聊天命令持久受理均通过 |

首次接入浏览器用例的独立假服务计数为 Gmail `BODY.PEEK` 增量 1，`SELECT` 增量 0，`\Seen` 前后相同。GitHub 工具核准之前调用增量 0，核准后指定文件读取增量 1，单独授权和审批的写入增量 1。未获预算的模型探针记录 1 次任务预算拒绝和 0 笔预留。

## 真实服务验收

| 项目 | 本次状态 |
| --- | --- |
| DeepSeek 真实流式与结算 | 2026-11-28 实测通过，见下节。金额取自宿主账本 |
| 第二家模型供应商实测 | 按用户决定暂缓 |
| Gmail 实际账号只读与已读标记核对 | 待指定账号和授权文件夹 |
| GitHub 实际账号指定仓库读取 | 待指定仓库、分支、文件及其授权 |
| 单封测试邮件 | 待单独授权的收件人和发信账号 |
| 测试仓单次写入 | 待单独授权的仓库、分支和写入目标 |

## 2026-11-28 普通对话与授权复验

Windows x64、Edge 157.0.4341.60、Node 22.23.5、npm 10.9.9、SQLite 3.54.1。配置和双库保持原有代际。

| 命令或浏览器操作 | 退出码 | 结果 |
| --- | --- | --- |
| `npm --prefix web run build` | 0 | 前端生产构建 |
| `node tests/stage2/run-all.ts --data-dir %TEMP%\aegis-ux-full-2b766e6f\data --evidence-dir %TEMP%\aegis-ux-full-2b766e6f\evidence` | 0 | `stage2_42dfb3de`。类型检查、分层、依赖锁、P0 和浏览器流程通过。浏览器 `s2_browser_2b1b1294` 复核 L0 未授权跳过、授权当前版本后纳入、撤销后旧对话出站拦截与新对话跳过。低预算下预留数 0。独立假 SMTP 收件 1，IMAP PEEK 增量 1、SELECT 增量 0、已读标记保持，GitHub 工具核准前后读取增量分别为 0 和 1，授权写入增量 1 |
| 锁定 Node 执行本机浏览器复测 `%TEMP%\aegispi-ux-audit-20261128\retest.mts` | 0 | 从普通新会话向真实 DeepSeek 发送合成内容。宿主记录已结算 464 microUSD，记忆来源数 0，中文输入法选词未误发，回复标题正确排版。设置内连接测试另结算 49 microUSD。草稿在会话间隔离且切换视图后保留，刷新恢复所选会话，断网提示保留草稿且无额外结算，320 和 390 像素宽均完整显示四个入口 |

在此前体验测试中，真实 DeepSeek 的前两次调用分别观察到 16 和 42 次可见的逐段文本更新，三次结算合计 356 microUSD。本轮使用合成提示，未授权发送现有本地记忆，未调用真实 Gmail 或 GitHub。
