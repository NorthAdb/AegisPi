# Phase 5 第 2 批浏览器交互端到端实测记录

- **日期**：2026-11-22（Asia/Hong_Kong）
- **入口**：`http://127.0.0.1:4310/`（本地 daemon：`apps/daemon/src/daemon.mjs --data-dir=workspace-state/e2e/daemon --config=workspace-state/e2e/daemon-config.json`，锁定 Node `v22.23.5`）
- **许可级别**：许可 1。邮件/日历后端为本地环回 TLS 夹具（`evals/phase5/scenarios/fixtures/serve-fixtures.mjs` helper 进程），凭据为套件夹具假值（`AEGISPI_E2E_MAIL_CRED`），零真实邮箱/日历/Telegram/模型调用。
- **驱动方式**：ZCode 内置浏览器（browser-use）真实点击 + 截图；截图归档于本目录。

## 实测步骤与结果

| # | 操作 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 打开 `127.0.0.1:4310/`，粘贴 bootstrap token（`workspace-state/console/token`）登录 | `POST /api/session` 建立会话；四页签导航出现；generation/watermark 显示 | 01 截图 |
| 2 | ① 待办与审批台：`mail.send` 草稿审批卡（scope/任务/动作/action_hash/4h 到期）完整呈现 | 卡片渲染，含「批准此动作 / 编辑草稿并重新生成审批 / 拒绝」三按钮 | 01 |
| 3 | 点击「批准此动作」 | `decideApproval` CAS 消费（`WAITING→CONSUMED`），daemon dispatcher 经 SMTP 子进程向环回 TLS 夹具**真实投递恰 1 封**（`smtpStats count=1`），effect `SUCCEEDED` + `external_id`（`<9699…@aegispi.local>`）入账 | 02（批准后 WAITING 清空）+ daemon 日志/DB |
| 4 | UNKNOWN 对账行：填写 `externalEvidenceRef=sent-items-check-2026-11-23`、选择 `CONFIRMED_NOT_SENT`、点击「对账」 | `reconcileUnknown` 成功，`/api/effects-unknown` 返回 0 条 | 02 下方行 + 页面状态 |
| 5 | ② 任务与故障诊断台：健康/恢复/磁盘水位栏（mode=open、node v22.23.5、failedStep=无）、按 scope 分组任务（Steer/取消任务）、对象分页读取 | 以真实 `obj:` id 分页读取成功（kind=memory_fact，totalBytes=28，textContent 渲染） | 03 |
| 6 | ③ 记忆与治理台：candidate 列表、Dreaming/Routine 区、ACL 授权列表 | XSS 候选 `<script>alert(1)</script>` 以**纯文本**渲染（隔离原因 `hidden_html_or_comment` 同行展示），零脚本执行；干净候选「激活」后 `candidate→active`；隔离候选无「激活」按钮（前端按 `neverActivatable` 隐藏） | 04 |
| 7 | ④ 链路与分用途成本台：$5.00 日账户进度条、分用途表（summary $0.0004 / 1 请求 / cache tokens=未测）、Trace 查询 | Trace 返回完整脱敏时间线（inbox→attempt PARKED→effects→approval CONSUMED） | 05、06 |
| 8 | SSE 状态机 | 快照先行（generation/watermark 记录），SSE Bearer 流连接，`reset`/断线按 04 §5 自动重连（页面顶栏如实显示连接状态） | 各截图顶栏 |

## 环境说明（与收口报告对应）

- E2E 专用配置仅写于 `workspace-state/e2e/daemon-config.json`（仓库 `defaults.json` 保持全失败关闭）：mail/calendar 环回 host + 显式 allow 标志 + `policy.allowRealExternalWrites=true` + `adapters.allowedRecipients=["dest@example.com"]` —— 全部为许可 1 环回验证缝的显式测试值。
- 首张卡的发送一度 `FAILED`（policy 未放行 → local_error）后经 `requeueLocalFailure` 重排；第二张卡为浏览器批准后由 daemon 一次投递成功。
- 实测结束后已停 daemon 与夹具进程、清理 `workspace-state/e2e/`（见收口报告 §容器与临时区）。
