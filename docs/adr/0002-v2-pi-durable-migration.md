# ADR-0002: AegisPi v2 分支迁移与工程约束切换（Pi Durable 1.6.0 + 纯 TypeScript）

## 状态

Accepted（2026-11-25，香港时间；随 v2.3 总体规划定稿及任务书 1 第 1 周实施生效于 `v2` 分支；`main` 与 `v1-zero-trust-baseline` 保持只读封存）。

## 日期

2026-11-25，香港时间。

## 背景

1. `v1-zero-trust-baseline`（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）已完成 Phase 1–5 零信任治理验收（历史基线 `327/327 PASS` 与 `selfuse 31/31 PASS`）。现行根 `AGENTS.md` 仍锁定 `@earendil-works/pi-coding-agent` exact `1.5.2` 且限定 v1 Phase 1 契约与夹具边界。
2. `D:\AegisPi\aegis-pi-v2-planning\baseline-v2.3\aegispi_v2_overview.md`（v2.3 定稿）确立方案 A：基于 `v1-zero-trust-baseline` 切出独立 `v2` 分支，以 `@earendil-works/pi-durable@1.6.0`、`@earendil-works/pi-mcp@1.6.0`、`@earendil-works/pi-ai@1.6.0` 为新底座，采用 Node 22 原生可擦除 TypeScript（`.ts` 相对导入、`allowImportingTsExtensions`、`verbatimModuleSyntax`、`erasableSyntaxOnly`），并保留 v1 经审计的审批 CAS、外发状态机、微美元双账户账本与宿主边界。
3. 在 `v2` 分支实施任务书 1 第 1 周前，必须先通过本 ADR 切换分支级工程约束与依赖锁定，再进入 SDK 契约探针（S1–S5）与治理功能实施。

## 选项

- **选项 A（采用）**：在 `v2` 分支更新 `AGENTS.md`、根 `package.json` 与 `tsconfig.json`，移除根 `workspaces: ["apps/*"]` 以隔离旧 `pi-coding-agent@1.5.2` 依赖树，提交精确锁定 `1.6.0` 家族包与辅助依赖的真实 `package-lock.json` 和完整性清单。旧 `apps/`、`evals/` 保留在仓内仅作阶段一第 2 周能力迁移只读参考，不参与 v2 构建与测试，待第 1–2 周全部能力迁移与红线验证通过后再统一清理退役。
- **选项 B（否决）**：在 `v2` 分支保持 `apps/*` workspace 与 `1.5.2` 并存，导致根 `package-lock.json` 混入两代 Pi 依赖树并违反单点导入纪律。
- **选项 C（否决）**：在第 1 周尚未完成第 2 周连接器与记忆迁移前立刻删除 `apps/` 与 `docker/`，增加第 2 周跨 tag 对照成本。

## 决定

采用选项 A：

1. **版本锁定**：
   - 运行时：Windows 显式 `D:\AegisPi\tools\node-v22.23.5\node.exe`（Node `v22.23.5`，内置 SQLite `3.54.1`）、npm `10.9.9`。
   - Pi 家族包：exact `@earendil-works/pi-durable@1.6.0`、`@earendil-works/pi-mcp@1.6.0`、`@earendil-works/pi-ai@1.6.0`。
   - Web 与工具链：exact `hono@4.13.22`、`@hono/node-server@2.1.11`、`typescript@5.9.3`、`vitest@5.1.2`、`@types/node@22.20.7`。
   - 所有直接依赖严禁使用 `^` 或 `~`，真实 `package-lock.json` 与 `docs/v2/dependency-integrity.json` 随仓提交。
2. **双库与单向依赖边界**：
   - Pi 独占 `pi-durable.sqlite`（`WAL + NORMAL`）；宿主独占 `aegis-gov.sqlite`（`WAL + FULL + foreign_keys=ON`）。
   - 分层依赖：`src/web/` (L4) -> `src/runtime/` (L3) -> `src/capabilities/` (L2) -> `src/governance/` (L1)。全仓仅允许 `src/runtime/` 导入 `@earendil-works/pi-*`，并由自动化测试硬校验。
   - 取消 v1 审批事务对旧 `tasks` 表的更新，审批决定与 `signal_outbox`、唯一 `READY` 效果同事务提交；提交器领取 CAS（`READY -> SUBMITTING`）与网络外发严格分离。
3. **第 1 周范围与红线**：
   - 本阶段仅使用本地独立假模型服务、独立假 SMTP、合成凭据与脱敏输入。
   - 不启用真实模型计费、真实邮件发送、真实 GitHub 写入或公网监听。
   - 若 S1–S5 实测推翻任何关键 SDK/Windows 前提，记录最小复现、实际输出并增补后续 ADR，暂停受影响路径，不得通过放宽断言绕过。
4. **遗留目录处置**：
   - 根 `package.json` 移除 `workspaces: ["apps/*"]`。v1 历史验收成绩（327/327 与 selfuse 31/31）仅作为 `v1-zero-trust-baseline` 历史证据，不计入 v2 实测结果。

## 后果

1. `v2` 分支上旧 `npm run test:*`（v1 phase1–5 脚本）不再从根 `package.json` 触发；如需复核 v1 历史套件，请切回 `v1-zero-trust-baseline` 或 `main`。
2. 第 1 周所有交付必须提供独立可复跑的 PowerShell 命令、脱敏证据目录与逐项矩阵结果（S1–S5、F01–F03、B01–B07、E01–E10、W1-A、W1-B）。
3. 任何偏离任务书 1 评审草案 DDL 或状态机细节之处（如新增列/表用于配对恢复清单、预算冻结或幂等键），必须在交付清单与本文后续修订中单列说明。

## 证据链接

- 基线标签：`v1-zero-trust-baseline`（`3a88b6895991d328e8e27fd1072a29846e7a9adf`）
- 规划依据：`D:\AegisPi\aegis-pi-v2-planning\baseline-v2.3\aegispi_v2_overview.md`、`D:\AegisPi\aegis-pi-v2-planning\taskbook-1-review.md`
- 依赖完整性清单：`docs/v2/dependency-integrity.json`（安装锁文件后生成并核验）
- 契约与第 1 周实测证据：见 `docs/v2/week1-audit/`（执行验收后落盘）
