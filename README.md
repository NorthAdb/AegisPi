# AegisPi v2

AegisPi 是自托管的个人常驻 Agent 系统。宿主负责访问控制、预算、审批、凭据和外部提交。当前 `v2` 分支基于锁定的 Pi 1.6.0 SDK 和 Node 原生 TypeScript。

## 阶段一已签收

2026-11-26，冻结代码候选 `8b3aad9d564dc966d62c13a1b0814170e2113a9f` 通过阶段一本机验收。同一候选的第 1 周与第 2 周独立全量复跑均通过，覆盖 W1-A、W1-B、S6、V01–V06，以及 Windows 上的 Docker 和 Edge 实测。[独立签收结论](docs/v2/week2-audit/WEEK2-AUDIT-REPORT.md#163-第-7-轮审计人复审与签收栏) · [验收报告与复跑命令](docs/v2/week2-audit/WEEK2-ACCEPTANCE-REPORT.md)

真实 Gmail IMAP、真实 GitHub MCP 的授权只读与 V01 逐 token 首延迟列为待验证。阶段一使用本地替身验证模型和连接器，真实模型计费、真实邮件外发、真实 GitHub 写入和公网监听保持关闭。

## 本地复跑

在仓库根目录使用 Node 22.23.5 和 npm 10.9.9，按 `package-lock.json` 执行 `npm ci`。第 2 周全量还需要 Docker、验收报告列明的不可变镜像及 Microsoft Edge。

```powershell
$node = 'D:\AegisPi\tools\node-v22.23.5\node.exe'
$runRoot = Join-Path $env:TEMP ('aegis-v2-' + [guid]::NewGuid().ToString('N'))
& $node tests/week1/run-all.ts --data-dir (Join-Path $runRoot 'w1-data') --evidence-dir (Join-Path $runRoot 'w1-evidence')
& $node tests/week2/run-all.ts --data-dir (Join-Path $runRoot 'w2-data') --evidence-dir (Join-Path $runRoot 'w2-evidence')
```

正式宿主入口是 [src/index.ts](src/index.ts)，最小视图①通过本机回环访问。完整本地用例由 [Edge 验收夹具](tests/week2/run-v01-v06-browser.ts) 启动宿主和各独立替身。

## 文档

- [文档索引](docs/README.md) 汇总 v2 的工程约束、架构决策和周次验收。
- [v1 封存与迁移说明](docs/V1-CLOSURE-AND-V2-MIGRATION.md) 记录 v1 的封存成绩（`327/327` 和 `selfuse 31/31`）及迁移决议。Phase 1–5 报告、审计证据和自用指南见 [`v1-zero-trust-baseline` 标签](https://github.com/NorthAdb/AegisPi/tree/v1-zero-trust-baseline)。
