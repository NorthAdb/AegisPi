# AegisPi Phase 1 第三轮复审（只读）

结论：**技术整改通过**。N9、N10、N11 由本轮在 `git archive` 副本上的红/绿实测关闭。没有新的技术阻塞。

**Phase 1 整体仍未完成**，不能宣布收口。标注草案不在仓库里，6b 仍是 `[ ]`，owner 对 12 条 uncertain 的确认没有发生。Telegram `getMe` 没有成功记录。DeepSeek 那一次调用的退出码、回复和 usage 只来自实施者证据，本轮没有重放。

Phase 2 的契约套件阻塞（上一轮 N9）已经解除。加载器接到 daemon 是 Phase 2 自己的工作，不把「没有 daemon 产品入口」记成 Phase 1 缺陷。

本轮没有改仓库、没有提交、没有推送、没有开 PR、没有发消息、没有读 `.env`、没有付费请求。工作区结束时仍干净，`HEAD` 仍是 `e7b93b77612674f4759bfb47f42a01ec3a82b042`（审计对象用 `git archive` 取出，没有 checkout）。稿与日志在 `/tmp/aegispi-audit-ff6e497/`。

## 0. 固定起点

| 项 | 值 |
| --- | --- |
| 复审对象 | `ff6e497d066a875acb50e65b3acce45985bb4b20` |
| 核对 | `git fetch origin ff6e497d066a875acb50e65b3acce45985bb4b20` 之后 `git rev-parse` 与该 SHA 相同 |
| 父提交 | `e7b93b77612674f4759bfb47f42a01ec3a82b042` |
| 说明 | Round 3 response: hono resolution containment …；2026-11-19 13:41:31 +0800；NorthAdb |
| 运行树 | `git archive` 解到 `/tmp/aegispi-audit-ff6e497/work`，再 `npm ci` |
| Node | 上一轮已对官方 tarball 做过 `sha256sum -c` 的 v22.23.5。本轮对同一 `node-v22.23.5-linux-x64.tar.xz` 再跑 `sha256sum -c`，结果 OK（`cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8`）。`node -v` = v22.23.5，npm 10.9.9 |
| 开关 | `AEGISPI_NODE_BIN` 指向该二进制；`AEGISPI_NPM_BIN` 指向同目录 npm；`AEGISPI_SPEC_PACK` 指向此前解压的 v1.4.1 包 |
| 环境 | Ubuntu 24.04，Linux 6.12.113+ x86_64 |

`evidence/06` 与 `evidence/07` 只作为宣称。下面「独立观察」都是这次自己执行的。

## 1. N9–N11 闭环

| 项 | 闭环 | 宣称 | 源码 | 独立观察 |
| --- | --- | --- | --- | --- |
| N9 hono 解析必须落在参数目录内；未安装快照不得假绿；`honoFrom` 是真实文件 | **关闭** | `require.resolve` 后用目录包含判断，越界 exit 2；`honoFrom` 写解析路径；已安装 4.13.19 为 0/0、4.12.24 为 1/1；配对工具核对真实路径 | [`csrf-textping-check.mjs` 48–55、92](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/contracts/fixtures/hono-triage/checks/csrf-textping-check.mjs#L48-L55) 用 `path.relative`，拒绝 `..` 或绝对相对路径，`honoFrom` 赋 `resolvedHono`。cors 同形于 [46–50、85](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/contracts/fixtures/hono-triage/checks/cors-credential-check.mjs#L46-L50)。配对工具 [47–50、132、66、148](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/contracts/tools/verify-hono-oracle-pair.mjs#L47-L50)：`npm ci` 失败 `exit 2`；矩阵不符 `exit 1` | 见第 2 节。已安装矩阵、路径规范化、未安装快照 exit 2、空目录 exit 2、同前缀兄弟目录不被当成内部，都已执行。`verify-hono-oracle-pair.mjs` 退出码 0 |
| N10 `--only` 零匹配仍退出码 0；note / `result("PASS")` 不得回退 | **关闭** | 零探针 exit 1；纯 note 与升格路径保持红 | [`run-contracts.mjs` 96–111](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/contracts/run-contracts.mjs#L96-L111)：`results.length === 0` 计入失败并打印 `NOTHING RAN` | `--only=does-not-exist` 退出码 **1**，末行 `0 probe(s): NOTHING RAN`。临时纯 note 探针：SKIP，退出码 **1**。note + `result("PASS")`：`summarizeProbe` 为 SKIP，退出码 **1**。还原后全套退出码 **0** |
| N11 缺 usage 九个数字都要钉在 0；`cost.total` 与 `totalTokens` 改预期必须变红 | **关闭** | 九字段 `=== 0` 且无 `totalFromProvider`；文案仍写这不是结清证据 | [`pi10-usage.mjs` 164–180](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/contracts/probes/pi10-usage.mjs#L164-L180) 包含 `totalTokens === 0` 与 `cost.total === 0`，并要求键不存在 | 绿报告对象九个数字全是 0，无该键，检查 PASS。有 usage 时 `totalFromProvider = false` 仍 PASS。把 `u.totalTokens === 0` 改成 `=== 1`：该检查 FAIL，退出码 **1**，detail 里的真实对象仍是 `totalTokens:0`。把 `u.cost.total === 0` 改成 `=== 1`：同样 FAIL，退出码 **1**，真实对象仍是 `total:0`。两处还原后 `cmp` 一致，全套退出码 **0** |

## 2. N9 独立执行

命令都在副本根目录，Node 为上面的 v22.23.5。日志：`logs/hono-n9.txt`（2026-11-19T05:49:26Z–05:49:29Z）。

已安装目录（`npm ci` 在 `/tmp/aegispi-audit-ff6e497/hono-installs/`，不在仓库树内）：

| 目标 | csrf | cors | `honoFrom` |
| --- | --- | --- | --- |
| 4.12.24 | exit 1，status 200，`rejected:false` | exit 1，`acao:"https://attacker.example"`，`reflected:true` | `.../hono-4.12.24/node_modules/hono/dist/cjs/index.js` |
| 4.13.19 | exit 0，status 403 | exit 0，`acao:"*"`，`reflected:false` | `.../hono-4.13.19/node_modules/hono/dist/cjs/index.js` |

子路径 `csrfFrom` / `corsFrom` 同样在对应安装目录的 `dist/cjs/middleware/` 下。

路径规范化（仍指向已安装的 4.12.24）：参数分别为带尾部斜杠、`/.`、`../hono-4.12.24`、`node_modules/..`。四次 csrf 都是 exit 1，`honoFrom` 都是该安装目录里的 `dist/cjs/index.js`。`path.resolve` 先规范化，再做包含判断；这几条真实路径没有把 4.12.24 判丢。

未安装快照（副本里的 `snapshots/hono-4.12.24` 与 `snapshots/hono-4.13.19`，只有 package.json 和 lock）：csrf 与 cors 都是 exit **2**。stderr 写明 resolved 到副本 `node_modules/hono`（仓库的 4.13.19），并拒绝运行。这是基础设施拒绝，不是「漏洞不存在」的 exit 0，也不是「漏洞存在」的 exit 1。

仓库外空目录（自带 `package.json`）：两条都是 exit **2**，`Cannot find module 'hono'`。同样是基础设施失败。

同前缀兄弟目录：`/tmp/ff6-prefix-…/inst` 没有 hono；旁边的 `inst-extra` 用快照 `npm ci` 装了 hono 4.13.19。对这两条具体路径：

- 朴素 `siblingFile.startsWith(install)` = **true**（`inst` 是 `inst-extra/...` 的字符串前缀）。
- 脚本所用的 `path.relative` = `../inst-extra/node_modules/hono/dist/cjs/index.js`，`insideInstall` = **false**。
- 实际把 `inst` 交给两个检查：都是 exit **2**，`Cannot find module 'hono'`。没有加载兄弟目录里的 4.13.19，因此没有 exit 0。

Node 的查找不会横向进入兄弟目录。包含判断用的是 `relative` 的 `..`，不是字符串前缀。这条真实场景没有误判成绿。

`verify-hono-oracle-pair.mjs`：4.13.19 的 csrf/cors exit 0 且 resolution=resolved-inside-target；4.12.24 的 csrf/cors exit 1 且同样 inside；四个未安装快照检查都是 exit 2。工具退出码 **0**。它打印的 lock SHA-256 为 `e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e` 与 `db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4`。本轮 `npm ci` 成功，所以这次不是基础设施失败。工具源码里 `npm ci` 非 0 会 `process.exit(2)`，与矩阵失败的 `exit 1` 分开。

## 3. 套件

`npm run test:contracts`，2026-11-19T05:49:44Z 起，退出码 **0**，15 个探针 PASS，`generatedAt` `2026-11-19T05:50:09.350Z`，`nodeVersion` `v22.23.5`。日志 `logs/test-contracts.log`，报告 `logs/contracts-report.green.json`。

破坏还原后再次全套，`logs/test-contracts-restored.log`，退出码 **0**，末行 `15 probe(s): all PASS with falsifiable evidence`。

## 4. 独立执行与仅报告证据

### 独立执行（本轮）

- N9、N10、N11、全套两次、配对工具、前缀兄弟目录、路径规范化、空目录。
- 目录价算式：`461/1e6*0.3 = 0.0001383`，`2/1e6*1.2 = 0.0000024`，和为 `0.0001407`，与 evidence/07 里的三个数一致。安装包 `pi-ai` 的 `deepseek.json` 中 `deepseek-flash` 的 `cost` 为 input 0.3 / output 1.2 / cacheRead 0.006，`thinkingLevelMap.high` 为 `"high"`，`baseUrl` 为 `https://api.deepseek.com`，`thinkingFormat` 为 `"deepseek"`。
- 脚本 [`verify-deepseek-minimal.mjs` 76–108](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/phase1-closure/verify-deepseek-minimal.mjs#L76-L108)：`getModel("deepseek","deepseek-flash")`，`thinkingLevel:"high"`，`retry.enabled:false`，只有一次 `session.prompt`。`allowModelNetwork:false` 在安装包 `model-runtime.js` 第 100 行只决定要不要从网络刷新模型目录，不代替这次推理。本轮没有运行该脚本。
- 无凭据访问 `https://api.telegram.org/`：`curl` 退出码 0，TLS 校验结果 0，HTTP/2 302，`location: https://core.telegram.org/bots`。这只说明本审计环境的 HTTPS 路径可达。没有 Bot token，没有 `getMe`，不能验证凭据，也不能代替实施者机器上的那次失败。

### 仅报告证据（未重放）

- `docs/phase1/evidence/07-real-connections.md`：DeepSeek `DEEPSEEK-EXIT=0`，`stopReason=stop`，回复文本 `"OK"`，usage 461+2=463，`totalFromProvider:false`，`durationMs:904`，`nodeVersion:v22.23.5`。这些数字与目录价算式一致，但不是本轮打出来的。
- 同文件：Telegram `TELEGRAM-EXIT=1`，`error:"fetch failed"`，并记录 `Test-NetConnection` 的 `TcpTestSucceeded: False`。脚本 [`verify-telegram-identity.mjs`](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/evals/phase1-closure/verify-telegram-identity.mjs) 只调用 `getMe` 与 `getChat`，源码里没有 `sendMessage`。按他们的记录，请求没有到达 API，因此那次不能解释成凭据错误，也没有发出消息。本轮没有重跑该脚本。
- 75 条标注的 30/9/12/24 划分、12 条 `uncertain:true`、以及「评测夹具不等于服务监控范围」这句话，只出现在 [`phase1-open-items.md` 第 9 行](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/docs/phase1/reports/phase1-open-items.md#L9) 和 todo 6b。本地 labels 文件不在这棵树里。不能编造条目，也不能写成 owner 已批准。

hono 夹具测的是 honojs/hono 的两个版本在隔离安装里的 csrf/cors 行为。仓库 daemon 依赖声明了 hono 4.13.19，Phase 1 没有 AegisPi 自己的 HTTP 服务实现。夹具绿，不等于 AegisPi 服务已被监控。

## 5. 审计原稿与忽略规则

`ff6e497` 将上一轮原稿放在 `docs/phase1/audits/AUDIT-PHASE1-REREVIEW-e7b93b77612674f4759bfb47f42a01ec3a82b042.md`。SHA-256 与本审计环境里上一轮原稿相同：`49db996b86f64fd8b0635a3c1c8de3dbdded6be9e8c91b57d27214336cbdd0be`，147 行。对这份原稿、`evidence/06`、`evidence/07`、收口脚本和 model-binding 做了密钥形状扫描（`sk-` 长令牌、Telegram bot 令牌形、`Bearer`、赋值形式的 key），命中数为 0。

该提交的 `.gitignore` 含 `.env`、`.env.*`、`owner-baseline.local.md`、`evals/contracts/fixtures/**/*.labels.json` 与 `*.labels.local.json`。`git ls-tree -r` 这个 SHA 没有 `.env`、labels 或 `owner-baseline.local.md` 的 blob。

## 6. 阶段门禁

技术整改：**通过**。N9–N11 关闭。没有新的、需要改代码才能过的阻塞。

Phase 1 整体：**未完成**。

- [todo 6b](https://github.com/NorthAdb/AegisPi/blob/ff6e497d066a875acb50e65b3acce45985bb4b20/.audit/phase1.todo.md#L12) 仍是 `[ ]`。owner 还要确认标注，其中包括报告所称的 12 条 uncertain；草案内容本轮无法核对。
- Telegram 机器侧核验仍开放。本环境能 HTTPS 到达 `api.telegram.org`，这不关闭 `getMe`。
- DeepSeek 最小推理：脚本路径和目录价算式经得起核对；一次真实调用的结果停留在实施者证据。

Phase 2 最小剩余条件：

1. 技术门禁侧，N9–N11 已过，不再用上一轮的假绿挡住契约套件。
2. 不要宣布 Phase 1 完成，不要勾 6b，直到 owner 自己确认标注。
3. Telegram `getMe`/`getChat` 仍是用户侧开放项；它不是本轮契约探针的失败。
4. `load-pi-settings.mjs` 接到 daemon 进程，是 Phase 2 实现时要做的事，不是 Phase 1 的未关闭缺陷。

## 7. 日志

| 文件 | 内容 |
| --- | --- |
| `logs/hono-n9.txt` | 已安装 0/0 与 1/1、路径规范化、未安装快照 exit 2、空目录 exit 2、兄弟前缀、配对工具退出码 0 |
| `logs/test-contracts.log` / `.exit` | 全套退出码 0 |
| `logs/contracts-report.green.json` | 该次机器报告 |
| `logs/note-only.log` / `note-result-pass.log` / `only-empty.log` | 退出码都是 1 |
| `logs/pi10-totalTokens.log` / `.report.json` | `totalTokens === 1` 时期望，检查 FAIL，退出码 1 |
| `logs/pi10-cost-total.log` / `.report.json` | `cost.total === 1` 时期望，检查 FAIL，退出码 1 |
| `logs/test-contracts-restored.log` | 还原后全套退出码 0 |
| `logs/telegram-curl-meta.txt` / `telegram-head.txt` | 无凭据 HTTPS：校验 0，HTTP 302 |
| `logs/archived-audit.md` | 入库原稿副本，用于哈希对照 |
