# 单元 4.4 收口报告（Scenario 4 `repo_triage` 判定闭环、`eval:triage` 与 `report:user-value`）

> 日期：2026-11-21（Asia/Hong_Kong）
> 起始基线：`b0a1dc8`（`main`，已包含单元 4.3 `D-84`）
> 授权口径：方案 A 单元 4.4（仅离线与本机容器验收；未读 `.env`、零真实仓库拉取、零真实模型调用、零真实 Telegram 外发；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-85`）
> 运行环境：Windows 11（Docker Desktop `29.9.2` + `127.0.0.1:5000` 本地 registry），锁定 Node `v22.23.5`

## 一、核心结论

单元 4.4 在本地落盘 Scenario 4（`repo_triage`）完整主机编排链路与价值汇总报告生成脚本，并在**镜像纪元 9** 终树上完成全量 **14 套离线/容器套件 + `image-gate` + Hono 配对预检 + `report:user-value`**（全部退出码 `0`）。

**零越界声明**：本单元提交时**未读取 `.env`、未发送真实 Telegram 消息、未拉取公网仓库、未调用真实模型、未修改 `CONSOLE_BIND` 或公网 webhook 开关、未改动既有失败关闭默认值、`git push` 留待单元 4.5 全部验收完成后统一执行。**

1. **宿主编排 `repo_triage` 闭环**：新增 [repo-triage.mjs](../../../apps/daemon/src/repo-triage.mjs) 并接入 [daemon.mjs](../../../apps/daemon/src/daemon.mjs)，按白名单校验 `presetId`、主机启用门禁、`allowRealTriage` 非环回门禁与 `notifyChannel` 收件人白名单后，先以 `acquisition` 容器只读采集基线与目标快照（逐项 `lstatSync` 拒绝软链与特殊文件），可选调用受 `maxInputBytes` 保护的 `pi-ai@1.5.2` 产出建议摘要（空回复或 `HELD` 立即中止，绝不拉起执行容器），最后生成 `environment-manifest` 与双端绑定 oracle 在无网 `--execution-image` 内先后验证基线与目标。
2. **四分类确定性裁定与执行隔离硬化**：[repo-triage.mjs](../../../apps/daemon/src/repo-triage.mjs) 基于容器退出码与 `job-oracle` 状态确定性裁定 `affected`、`unaffected`、`unknown` 与 `infra_error` 四类结论。基线失败或退出码 `2` / `>=124` / `null` 强制归类 `infra_error`，绝不采信容器 stdout 伪造结果。同步硬化 [container-executor.mjs](../../../apps/daemon/src/container-executor.mjs)：校验 `jobId` 与暂存输入相对路径、以临时目录加 `realpathSync` 边界原子写入 `/job/input` 并在终态清理暂存物与卷、在采集等待心跳检测到 `StaleWorker` 时终止孤儿容器。
3. **默认策略与配置收敛**：[defaults.json](../../../apps/daemon/config/defaults.json) 新增 `triage` 节且维持 `allowRealTriage: false` 与 `presets: {}`；[config.mjs](../../../apps/daemon/src/config.mjs) 校验 `allowedRedirectHosts` 类型并剥离 `model` 配置下的注释字段。
4. **离线验收与用户价值报告**：新增 [evals/phase4/triage/run.mjs](../../../evals/phase4/triage/run.mjs)（`npm run eval:triage`）与 [evals/phase4/report-user-value/run.mjs](../../../evals/phase4/report-user-value/run.mjs)（`npm run report:user-value`）。价值报告直接聚合各套件落盘 JSON 与失败关闭断言生成 [user-value-report.md](./user-value-report.md)。

## 二、产物清单

| 类别 | 文件 | 主要变更 |
| --- | --- | --- |
| 默认策略与配置 | [apps/daemon/config/defaults.json](../../../apps/daemon/config/defaults.json)、[apps/daemon/src/config.mjs](../../../apps/daemon/src/config.mjs)、[package.json](../../../package.json) | 新增失败关闭 `triage` 节；校验重定向主机列表与剥离注释键；登记 `eval:triage` 与 `report:user-value` |
| Scenario 4 编排 | [apps/daemon/src/repo-triage.mjs](../../../apps/daemon/src/repo-triage.mjs)、[apps/daemon/src/repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs)、[apps/daemon/src/daemon.mjs](../../../apps/daemon/src/daemon.mjs) | 导出 `isSafeRelativeReadPath`；实现 `repo_triage` 双快照采集、AI 建议、双容器执行、`derived_from` 血缘与 `outbox` 通知集成 |
| 执行器硬化 | [apps/daemon/src/container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) | 新增原子输入暂存、`realpathSync` 边界检查、终态清理及 `StaleWorker` 采集容器终止 |
| 离线套件与报告 | [evals/phase4/triage/run.mjs](../../../evals/phase4/triage/run.mjs)、[evals/phase4/report-user-value/run.mjs](../../../evals/phase4/report-user-value/run.mjs)、[user-value-report.md](./user-value-report.md) | 覆盖 Hono 4.13.19/4.12.24 依赖公告对照、快照回归四分类、空回复停机、软链/穿越/越权拒绝及 125/125 证据聚合 |

## 三、镜像纪元 9 与全量离线终树验收（Node `v22.23.5`）

- **镜像纪元 9**（[image-digest.md](../../phase3/reports/image-digest.md)）：增量重建 `agent`（`manifest: sha256:c3347b709f0e5ee3d89d4cdacdb93a9eff6768d17328da478f20b4b2e717d50d`、`config: sha256:7e7bb0608e19a1e92be0a8731dde1a3fa4d0c2f5465c44358f6a5068e64c89b5`、`context: sha256:fd34b3f3c507f6a08a5bb1fde758d19c5a643721e3f9ee49749623cb2106a274`，`--self-check: green (pi 1.5.2)`），`acquisition` 与 `execution` 核验无漂移携带沿用。

| 套件 | 执行命令 | 实测结果 | 退出码 |
| --- | --- | --- | --- |
| `image-gate` | `node evals/phase3/lib/image-gate.mjs` | 三镜像 context/manifest/config 零漂移 | `0` |
| `eval:triage` | `node evals/phase4/triage/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `test:repo-observe` | `node evals/phase3/repo-observe/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `test:model-proposal` | `node evals/phase3/model-proposal/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:security:unit` | `node evals/phase3/security-unit/run.mjs` | `45 pass, 0 fail, 45 judged` | `0` |
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
| `report:user-value` | `node evals/phase4/report-user-value/run.mjs` | `125/125 pass, 0 fail, defaultsFailClosed=true` | `0` |

- `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：0 命中（退出码 `1`）。
- 接下来进入 **单元 4.5（真实公开仓库 `repo_triage` 与 `@aegispibot` 私聊实盘闭环，并在完成后执行 Phase 4 全面自审计、修复与远端推送）**。
