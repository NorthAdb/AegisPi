# 单元 4.5 与 Phase 4 收口报告（实盘端到端 `eval:triage:real`、终局对抗审计加固与全量验证）

> 日期：2026-11-21（Asia/Hong_Kong）
> 起始基线：`2c612c8`（`main`，已包含单元 4.5 `CONNECT` 代理前置 `D-86`）
> 授权口径：主人对单元 4.5、阶段收口自审计优化与 `git push` 书面授权（`.env` 仅运行期只读、全链路零密钥/主人 ID 泄漏、`defaults.json` 全失败关闭、D 项公网入站 webhook 与常开继续禁用；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-87`–`D-89` 与 [phase4-unit4-5-trail.tsv](../../../.audit/phase4-unit4-5-trail.tsv)）
> 运行环境：Windows 11（Docker Desktop `29.9.2` + `127.0.0.1:5000` 本地 registry），锁定 Node `v22.23.5`

## 一、核心结论

单元 4.5 与 Phase 4 全部收尾任务已完成并在最新交付树（**镜像纪元 11.5**）收口：

1. **单元 4.5 实盘端到端闭环（`eval:triage:real`，纪元 11.4 终跑 `6/6 PASS`）**：
   - 修复 [upstream-telegram-child.mjs](../../../apps/daemon/src/upstream-telegram-child.mjs) 中 `http.request({ agent: false })` 绕过 `createConnection` 的 TLS+`CONNECT` 隧道缺陷，改为一次性 `HttpAgent`/`HttpsAgent`，补齐 IP 字面量 SNI 与 `CONNECT 200` 状态行严格匹配、预 HTTP 失败归类 `local` 及 TLS+`CONNECT` 回归用例（[security-unit/run.mjs](../../../evals/phase3/security-unit/run.mjs)）。
   - 修复首次实跑暴露的三项工程根因：[repo-observe.mjs](../../../apps/daemon/src/repo-observe.mjs) `buildSafeRepoExcerpt` 改为 max-min fair waterfill 按文件配额防多文件饥饿；[container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) 改用异步 `dockerAsync` 拷贝并在等待心跳内持续续租、为超长 `jobId` 引入 SHA-256 token 尾缀；[daemon.mjs](../../../apps/daemon/src/daemon.mjs) 与 [repo-triage.mjs](../../../apps/daemon/src/repo-triage.mjs) 增加 `stageSubpaths` 白名单裁剪、wall-clock 刷新与 `excludeTriageTaskIds` 同批隔离。
   - **5 条真实公网仓 + 真实 DeepSeek + 无网 `--execution-image` + 真实 `@aegispibot` 私聊全部 `PASS`**（`tg:[REDACTED_OWNER]:11`–`15`，遥测零密钥/零主人 ID 泄漏），外加失败关闭与默认策略对照（总计 **6/6 PASS**，详情见 [triage-real-report.json](../../phase3/evidence/triage-real-report.json) 与 [triage-real-log.md](../../phase3/evidence/triage-real-log.md)）。
2. **Phase 4 终局对抗审计与结构加固（4 路并行审计 → 实证修复 → 纪元 11.4 & 11.5）**：
   - 并行调度 Model/Observe、Triage/Executor、Telegram/Proxy/Eval 三路对抗审计与 `comment-sicko` 清理审计，修复全部确认缺陷，包括：
     - **SSRF 防护闭环（纪元 11.5）**：[downloader.mjs](../../../docker/acquisition/src/downloader.mjs) 拒绝 `destRelPath` 含 `.`/空段、手动重定向阻断 `https:`→`http:` 降级与同主机换端口，并在调用 Node `http(s).request` 前直接拦截非公网/保留/RFC1918/link-local/ULA/IPv4-mapped IP 字面量（规避 Node `net.connect` 对 IP 字面量跳过自定义 `lookup` 回调）。
     - **出站与重试安全**：[upstream-http-child.mjs](../../../apps/daemon/src/upstream-http-child.mjs) 与 [telegram-send.mjs](../../../apps/daemon/src/telegram-send.mjs) 禁止自动重定向、收紧 `local` 错码白名单以保 `AT_MOST_ONCE`、收紧 Windows 环回代理解析（拒绝 SOCKS-only 或非环回系统代理）。
     - **SQLite 启动锁与事务原子性**：[connect.mjs](../../../apps/daemon/src/db/connect.mjs) 将 `PRAGMA busy_timeout=5000` 置首解决多进程并发启动 `SQLITE_BUSY`；[budget.mjs](../../../apps/daemon/src/budget.mjs) 修复 `splitAccounts` 大整数余数精确分摊；[scheduler.mjs](../../../apps/daemon/src/scheduler.mjs)/[effects.mjs](../../../apps/daemon/src/effects.mjs)/[outbox.mjs](../../../apps/daemon/src/outbox.mjs) 抽取 `*InTx` 确保 `model_requests` 与 `repo_triage` 写回同事务原子提交；[execution-jobs.mjs](../../../apps/daemon/src/execution-jobs.mjs) 与 [container-executor.mjs](../../../apps/daemon/src/container-executor.mjs) 清理 `container:<cid>` 孤儿、失败回滚与大小写不敏感暂存碰撞校验。
3. **默认策略与越界边界确认**：
   - [defaults.json](../../../apps/daemon/config/defaults.json) 维持全失败关闭（`$0.80` / `$5.00` / `1000` / `baseUrl=null` / `allowReal*=false` / `telegram.apiBase=null` / `telegram.proxyUrl=null` / `triage.allowRealTriage=false` / 空白名单）；`eval:triage:real` 缺省无条件 `exit 4`；`D` 项公网入站 webhook 与常开运行保持禁用。

## 二、单元 4.5 实盘验收明细（纪元 11.4，2026-11-21T14:44:08Z）

| 用例 | 目标与对照 | 实测结论 | DeepSeek 用量（`in / out / cacheRead`） | 峰期实账（非高峰估算） | 真实 DM 回执 |
| --- | --- | --- | --- | --- | --- |
| `hono-ghsa-46wx-csrf` | `honojs/hono` v4.13.19 vs v4.12.24（TS 容器实跑） | `unaffected`（`jobs: SUCCEEDED:0, FAILED:1`） | `5266 / 1241 / 4864` | `3099 u$`（`~1550 u$`） | `tg:[REDACTED_OWNER]:11` |
| `hono-ghsa-88fw-cors` | `honojs/hono` v4.13.19 vs v4.12.24（TS 容器实跑） | `unaffected`（`jobs: SUCCEEDED:0, FAILED:1`） | `269 / 753 / 9856` | `1044 u$`（`~522 u$`） | `tg:[REDACTED_OWNER]:12` |
| `hono-csrf-regression-affected` | v4.12.24 目标回归检测 | `affected`（`jobs: SUCCEEDED:0, FAILED:1`） | `253 / 2874 / 9856` | `3584 u$`（`~1792 u$`） | `tg:[REDACTED_OWNER]:13` |
| `aegispi-baseline-check` | `NorthAdb/AegisPi@8943a108` 基线安全检查 | `unaffected`（`jobs: SUCCEEDED:0, SUCCEEDED:0`） | `5362 / 254 / 5120` | `1945 u$`（`~973 u$`） | `tg:[REDACTED_OWNER]:14` |
| `pi-agent-north-baseline-check` | `NorthAdb/pi-agent-north@ce950d78`（`stageSubpaths`） | `unaffected`（`jobs: SUCCEEDED:0, SUCCEEDED:0`） | `6976 / 370 / 2560` | `2553 u$`（`~1277 u$`） | `tg:[REDACTED_OWNER]:15` |
| `fail-closed-controls` | 关闭开关 / 非法收件人 / `defaults.json` / 零泄漏 | `PASS`（`triageOff=triage_real_disabled` 等） | — | `0` | 零外发 |

- 实盘总花费（5 轮合计）：峰值账本结算 **`12,225 microUSD`**（约 `$0.0122`，非高峰 5 折估算约 **`6,114 microUSD`** / `$0.0061`）。
- 注：`eval:triage:real` 实盘跑通于**纪元 11.4**；此后在纪元 11.5 仅追加了 [downloader.mjs](../../../docker/acquisition/src/downloader.mjs) IP 字面量入网前拒绝及对应单元测试，未再重复发起真实公网收费调用，并在纪元 11.5 终树复核了 `eval:triage:real` 缺省拒绝（`exit 4`）。

## 三、镜像纪元 11.5 与全量终树验收（Node `v22.23.5`）

- **镜像纪元 11.5**（[image-digest.md](../../phase3/reports/image-digest.md)）：
  - `agent`（携带纪元 11.4）：manifest `sha256:93cc518599f7b83d7027d1407cae36fc9fcfdf193a310ee38bb643633d669b75` | context `sha256:779ab42c883997ac2e223fdc6fddbf26eef8062a03ee589db8be87787cdfcc97`
  - `acquisition`（本纪元重建）：manifest `sha256:488cb3da47f98009fac76e76245dbb2f0dcfe57250f06100e82d41b5ca50d174` | context `sha256:88b5f512021048bd116e8f5fcaeaecd44af368ee5ae3a9be223aeaf11a3cdb52`
  - `execution`（携带沿用）：manifest `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | context `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab`

| 套件 | 执行命令 | 终树实测结果（纪元 11.5） | 退出码 |
| --- | --- | --- | --- |
| `image-gate` | `node evals/phase3/lib/image-gate.mjs` | 三镜像 context/manifest/config 零漂移 | `0` |
| `test:contracts` | `node evals/contracts/run-contracts.mjs` | `15 probe(s): all PASS` | `0` |
| Hono 配对预检 | `node evals/contracts/tools/verify-hono-oracle-pair.mjs` | 4.13.19 / 4.12.24 / 未安装拒绝全过 | `0` |
| `test:durability` | `node evals/phase2/durability/run.mjs` | `164 pass, 0 fail, 164 judged` | `0` |
| `test:acl` | `node evals/phase2/acl/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:budget` | `node evals/phase2/budget/run.mjs` | `20 pass, 0 fail, 20 judged` | `0` |
| `test:cancel-approval` | `node evals/phase3/cancel-approval/run.mjs` | `16 pass, 0 fail, 16 judged` | `0` |
| `test:restore` | `node evals/phase3/restore/run.mjs` | `11 pass, 0 fail, 11 judged` | `0` |
| `test:ingress-telegram` | `node evals/phase3/ingress-telegram/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `test:security:unit` | `node evals/phase3/security-unit/run.mjs` | `48 pass, 0 fail, 48 judged`（含 TLS+`CONNECT` 与 IP-literal SSRF 回归） | `0` |
| `test:model-proposal` | `node evals/phase3/model-proposal/run.mjs` | `15 pass, 0 fail, 15 judged` | `0` |
| `test:repo-observe` | `node evals/phase3/repo-observe/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `eval:triage` | `node evals/phase4/triage/run.mjs` | `7 pass, 0 fail, 7 judged` | `0` |
| `test:offline-jobs` | `node evals/phase3/offline-jobs/run.mjs` | `14 pass, 0 fail, 14 judged` | `0` |
| `test:security:integration` | `node evals/phase3/security-integration/run.mjs` | `29 pass, 0 fail, 29 judged` | `0` |
| `test:quota-calibration` | `node evals/phase3/quota-calibration/run.mjs` | `5 pass, 0 fail, 5 judged` | `0` |
| `eval:triage:real`（缺省守卫） | `node evals/phase4/triage-real/run.mjs` | `REFUSED`（未设 `AEGISPI_ALLOW_REAL_TRIAGE_ACCEPTANCE=1`） | `4` |
| `report:user-value` | `node evals/phase4/report-user-value/run.mjs` | `134/134 pass, 0 fail, defaultsFailClosed=true` | `0` |

- `git grep model-call-child -- apps docker evals tools package.json package-lock.json`：0 命中（退出码 `1`）。
- 至此 Phase 4（单元 4.1–4.5、终局对抗审计加固、全量回归与文档同步）全部收口，后续仅当主人显式规划 `D` 项（公网入站 webhook）或 Phase 5 常开演练时按需另行授权启用。
