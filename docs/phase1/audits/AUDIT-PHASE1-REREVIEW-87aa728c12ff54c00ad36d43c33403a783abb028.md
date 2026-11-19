# AegisPi Phase 1 整改复审（只读）

结论：**整改未通过**。P1-1、P1-3、P1-4 的实质缺陷已被独立证据关闭；P1-2 没有关死。套件在「只有 note」时仍以退出码 0 变绿，且 `defaults.json` 里的 `cacheWarming: "off"` 走 `getCacheWarmingMode()` 时读出来是 `idle`，探针却仍然 PASS。按本轮判定标准，出现名改实不改或同类假绿，整改未通过，Phase 2 仍不能开工。Phase 1 也不能宣布完成：用户侧四项本来就未收口。

本轮没有改仓库、没有提交、没有推送、没有开 PR、没有评论、没有发外部消息。全部脚本、日志和本稿在 `/tmp/aegis-audit-87aa728/`。仓库工作区在复审结束时仍是干净的 `87aa728c12ff54c00ad36d43c33403a783abb028`。

## 0. 固定起点

| 项 | 值 |
| --- | --- |
| 复审对象完整 SHA | `87aa728c12ff54c00ad36d43c33403a783abb028` |
| 提交说明 | Audit round 1 response: route two-path, literal-true PASS purge, GHSA-88fw restored with second oracle, real 4.12.24 target lock |
| 作者 / 时间 | NorthAdb \<1328704940@qq.com\>，2026-11-19 09:45:07 +0800 |
| 相对上一轮 | 仅此一个提交，父提交即上一轮审计对象 `4d59f68ec0e20eac4248a084288e0efd1ee4e62d` |
| 本地核对 | `git rev-parse HEAD` = 上述 SHA；`git status --short` 为空 |
| 规范包 | 上传 zip 解压到 `/tmp/aegis-audit-87aa728/spec/aegis-pi-design-pack-v1.4.1`。`docs/reference/schema.sql` 原始字节 SHA-256 = `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`（无 CRLF）。`python3 -X utf8 validation/validate_pack.py` 退出码 0，14/14，`CONNECTIONS_LEFT=0`，验证器自己的 SQLite 是 3.45.1、计 27 张用户表。这是资料包自检，不是产品验收。 |

Phase 1 退出门禁（资料包 `docs/04`）：用户选真实 repo 与通知渠道并建立标注样本；在锁定 Node 22.23.5 上核验 exact Pi 1.5.2、LF 分帧与 SQLite；绑定「DeepSeek Flash High」且不编造 ID；记录已取得的基础镜像 digest；用 oracle/manifest 夹具起步。缺命令、空实现、skip 不能当通过。有未决核心契约不得进入自动执行。Phase 2 入口是「Phase 1 契约和 schema 审查通过」。

## 1. 独立复跑环境

官方 Node 从 `https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz` 下载。`SHASUMS256.txt` 核对：

`cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8  node-v22.23.5-linux-x64.tar.xz` → `sha256sum -c` OK。

| 项 | 实测 |
| --- | --- |
| OS | Ubuntu 24.04.5 LTS，Linux 6.12.113+ x86_64 |
| node | `/tmp/aegis-audit-87aa728/node/node-v22.23.5-linux-x64/bin/node` → `v22.23.5` |
| npm | 同目录 `npm` → `10.9.9` |
| `process.versions.sqlite` | `3.54.1` |
| 开关 | `AEGISPI_NODE_BIN` 指向上述二进制。没有做 Windows 路径 shim。 |
| 资料包 | `AEGISPI_SPEC_PACK=/tmp/aegis-audit-87aa728/spec/aegis-pi-design-pack-v1.4.1` |
| 工作副本 | `git archive 87aa728c12ff…` 解到 `/tmp/aegis-audit-87aa728/work`，再 `npm ci`。运行器会重写 `contracts-report.json`，所以没有在 git 工作区里跑。 |
| 命令 | `npm run test:contracts`（即 `node evals/contracts/run-contracts.mjs`） |
| 时间 | UTC 2026-11-19T01:52:21Z → 01:52:46Z |
| 退出码 | **0** |
| 汇总 | `15 probe(s): no FAIL`，15 个探针状态均为 PASS |
| 日志 | `/tmp/aegis-audit-87aa728/logs/test-contracts.log` |
| 机器报告 | `/tmp/aegis-audit-87aa728/logs/contracts-report.green.json`（`nodeVersion` = `v22.23.5`，`generatedAt` = `2026-11-19T01:52:46.933Z`） |

系统自带的 Node 是 v22.23.4。把它填进 `AEGISPI_NODE_BIN` 后，同一套 `assertChildNodeLocked` 给出 `child-node-locked` = FAIL，detail 为 `spawned CLI node is v22.23.4 ... via AEGISPI_NODE_BIN`，`summarizeProbe` 为 FAIL。开关有效，指错版本会红。日志：`logs/wrong-node.txt`。

没有 API key，没有真实付费推理。GitHub advisory/release 与 Docker Hub 清单、npm registry 都是只读公开查询。

## 2. 上轮条目闭环表

读表方式：每一行先写他们的宣称，再写源码里实际写了什么，再写我自己跑到的结果。不能复跑的不记 PASS。

| 项 | 闭环 | 宣称 | 源码静态 | 独立观察 |
| --- | --- | --- | --- | --- |
| P1-1 route 双路径 | **是** | ModelRuntime 单参、扩展双参，`arguments.length` 1 对 2，`ctx.modelRegistry.find('deepseek','deepseek-flash')` 有结果，报告不再把 ctx 写成全局恒 undefined | `pi02-virtual-models.mjs` 两条路径都注册并记录 `arguments.length` 与 `found.id`。安装后的 pi 1.5.2：`model-runtime.js:712` 为 `definition.route(request)`，`loader.js:418` 为 `model.route(request, runtime.createContext())` | 绿报告：`runtime-path-route-single-argument` PASS，`arguments.length=1`；`ext-path-route-receives-ctx` PASS，`arguments.length=2` 且 `ctx.modelRegistry present=true`；`ext-path-ctx-resolves-physical-model` PASS，返回 `deepseek-flash`。契约报告只在 ModelRuntime 路径上写「第二参 undefined」 |
| P1-2 字面量 true / 可失败断言 | **否** | 12 处字面量清零；`summarizeProbe` 无 PASS 则 SKIP；分帧切在「哈」内部；PI-07 同目录重启且 4 秒；PI-10 `totalFromProvider===false`；PI-13 读 off；规范句降为 note；只有 note 不能让套件变绿 | 探针目录里 `probe.check` 的第二实参没有裸 `true`（扫描结束无命中）。`summarizeProbe` 在无 FAIL、无 `finalStatus`、无 PASS 时返回 SKIP。运行器只看有没有 FAIL，SKIP 仍 `process.exit(0)`。PI-13 用正则读文件，另用字面量 `{cacheWarming:"off"}` 调 API，两步不相连 | 见第 3 节 N1、N2、N3。分帧切点、PI-07、字面量清零、`synchronous-full` 破坏变红，这几条是真的，见第 4 节 |
| P1-3 GHSA-88fw / 75 候选 | **是** | 撤回「API 中不存在」；`per_page=100` 共 61 条；窗口内 30 条 advisory；GHSA-88fw 在窗；75 = 45 release + 30 advisory，无重复 | `events.json` 窗口 `[2026-05-18T00:00:00Z, 2026-11-18T00:00:00Z)`，`candidateCount` 75，advisory 总数字段 61。现行正文把「不存在」写成已撤回的旧结论，不是现行断言 | 独立 `GET /repos/honojs/hono/security-advisories?per_page=100`：HTTP 200，无 Link 头，61 条且 page=2 与 page 1 完全相同。窗口内 30 条，严重性 medium 27 / low 2 / high 1，与 `events.json` 的 ghsa、CVE、摘要、时间、范围逐条一致，差集为空。`GHSA-88fw-hqm2-52qc` 在列：high，CVE-2026-54290，2026-06-09T03:29:52Z，`< 4.12.25`。Release 第一页 100 条已覆盖到窗口起点之前；稳定版窗口内 45 个 tag 与 events 完全一致（2 个 rc 被排除）。75 条 `eventId` 无重复、无窗口外条目 |
| P1-4 target 锁指向 4.12.24 | **是（integrity 与行为）；lockfile 全文哈希标 unknown，不记 PASS** | target `lockfileHash` `sha256:db2bb134…dad4`，integrity `sha512-I36D1s…U4iw==`，且不再等于仓库里锁 4.13.19 的那份 lock | 两个 manifest 的 target 都写了上述两个值，版本字段是 `4.12.24`。仓库 `package-lock.json` 里的 hono 仍是 4.13.19，integrity 为 `sha512-KmXvQ…fkA==` | `npm view`（npm 10.9.9 / Node 22.23.5）与隔离安装的 lock 内 integrity 都等于宣称的 4.12.24 integrity；4.13.19 的 integrity 也与 registry 一致。仓库 lock 的 SHA-256 是 `f1364f6e23b29d020f164fa8cf83d50904215ae6c9f7a883a9950585a57f947e`，既不是 `db2bb134…` 也不是 baseline 的 `e5d0c57e…`。我用 npm 10.9.9 干净安装得到的 lock 哈希是 4.12.24 → `b025b20e…`（包名 `hono-iso-4.12.24`）、`npm init -y` 后再装 → `5dbdd9d5…`（依赖写成 `^4.12.24`）。换了一批包名、精确/caret、是否带 version/ISC、LF/CRLF，都没有撞上 `db2bb134…` / `e5d0c57e…`。因此这两个全文哈希 **unknown**，不能算我复算通过。它们也没有重新等于仓库的 4.13.19 lock。oracle 行为见第 4 节，是实测闭合的 |
| P1-5 任务 1 / 用户侧 | **保持未完成（这是要求的状态，不是整改失败）** | 不宣称 Phase 1 收口；标注确认不勾 | `.audit/phase1.todo.md` 第 12 行 6b 仍是 `[ ]`。第 6–9 行的 Node/Pi/探针/驱动/镜像是另一套开工步骤，其中「1. 落地 Node」打勾，与规范任务 1（用户 repo、通知渠道、基线三句话、标注）不是同一项 | `phase1-open-items.md` 仍把 DeepSeek 最小推理、通知渠道、基线三句话列为未收口；75 条标注待用户确认。`model` 节写明最小推理待 key。没有把这四项勾成完成 |
| P2 `AEGISPI_NODE_BIN` | **是** | 环境变量覆盖，子进程版本不对会红 | `probe-utils.mjs` 第 15–16 行：`process.env.AEGISPI_NODE_BIN ?? "D:\\AegisPi\\..."`；`assertChildNodeLocked` 要求子进程 `v22.23.5` | 本轮全套就是靠这个开关跑的。绿报告里 PI-07 / FRAMING 的 `child-node-locked` detail 写明 `via AEGISPI_NODE_BIN` 且为 v22.23.5。指向 v22.23.4 时该检查 FAIL |
| P2 engines | **代码是；证据文档不是** | 根 engines 收成 `"22.23.5"` | `package.json` 的 `engines.node` 是 `"22.23.5"` | 同上。`docs/phase1/evidence/02-pi-install.md` 第 25 行仍写根 engines `>=22.19.0 <23.0.0`。见 N7 |
| P2 镜像 digest | **是** | index 与 amd64 分开记；amd64 `sha256:47725aca…` 标成当时未在本机复验 | `image-digest.md` 把 RepoDigest 写成 OCI index `sha256:e9f565d3…`，amd64 清单写成 `sha256:47725aca…`，并写明 2026-11-19 本机 registry 超时、待补拍。三个 Dockerfile 的 `FROM` 钉的是 index，不是 amd64 清单 | 我直接向 registry-1.docker.io 拉了 `node:22.23.5-bookworm-slim` 的 OCI index。响应头 `docker-content-digest` 与正文 SHA-256 都是 `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`，`mediaType` 为 `application/vnd.oci.image.index.v1+json`。index 内 linux/amd64 条目是 `sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc`。两个数都对，而且表述把 index 和平台清单分开了。日志：`logs/image-digest-result.txt`、`logs/image-index.json` |
| P2 Markdown 超出 JSON | **部分** | 8 秒改 4 秒；`totalFromProvider` 改为可选布尔 false；27 表改为非 FTS 恰 27 + 2 虚拟 + 8 影子 = 37 | `PI-contract-report.md` 的 timeout 写 4 秒，`totalFromProvider` 写可选布尔 false。`sqlite-driver.md` 仍是 2026-11-18 快照 | 绿报告与 PI-07 源码的等待都是 4 秒 / `setTimeout(..., 4000)`。有 usage 时 `totalFromProvider: false` 已实测。SQLITE 绿结果写明用户表 27、影子 8、总量 37。`sqlite-driver.md` 第 9、21 行仍写「27 表」和已不存在的检查名 `reference-schema-loads`。见 N6 |

## 3. 新发现（导致未通过的，以及残留）

### N1　高　只有 note 时套件仍退出码 0

- 位置：[`evals/contracts/run-contracts.mjs` 第 86–89 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/run-contracts.mjs#L86-L89)；[`evals/contracts/helpers/probe-utils.mjs` 第 73–81 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/helpers/probe-utils.mjs#L73-L81)
- 宣称：无 PASS 判据不得判 PASS；规范句是 note/INFO；只有 note 不能让套件变绿。
- 源码：`summarizeProbe` 在没有 FAIL、没有 `finalStatus`、也没有 PASS 时返回 `SKIP`。运行器是 `const anyFail = results.some((r) => r.status === "FAIL"); process.exit(anyFail ? 1 : 0)`。SKIP 走退出码 0，并打印 `no FAIL`。另外 `finalStatus` 的短路写在「无 PASS 则 SKIP」之前：若有人调用 `probe.result("PASS")`，只有 note 也会被升成 PASS。当前探针没有调用 `.result(`，这条是潜伏路径，本轮没有现网假绿。
- 复现：在临时副本把 `sqlite-node.mjs` 换成只 `probe.note(...)` 的模块，然后 `AEGISPI_NODE_BIN=<v22.23.5> AEGISPI_SPEC_PACK=<规范包> npm run test:contracts -- --only=sqlite`。跑完已用 `git show 87aa728c12ff…:evals/contracts/probes/sqlite-node.mjs` 把临时副本还原。git 仓库未改。
- 观察：探针状态 `SKIP`，finding 只有一条 `INFO`。退出码 **0**，日志末行 `1 probe(s): no FAIL`。直接调用：只有 note → `SKIP`；有 FAIL → `FAIL`；有真实 PASS → `PASS`；`result("PASS")` 且只有 note → `PASS`。
- 预期：只有 note 的探针不得让套件成功退出。
- 影响：把可失败断言改回 note，或新探针只写规范句，全套仍是绿的。这正是上一轮字面量 PASS 的套件级形态，只是单探针状态从 PASS 改成了 SKIP。
- 最小修复：运行器把任一 `SKIP`，或任一探针没有 PASS 判据，当成失败并 `exit 1`。`summarizeProbe` 先判断「没有任何 PASS」，再允许 `finalStatus`，且 `finalStatus==="PASS"` 在没有 PASS 判据时不得生效。

### N2　高　`defaults.json` 的 off 走运行时路径得到的是 idle，探针仍然绿

- 位置：[`evals/contracts/probes/pi13-cache-warming.mjs` 第 122–138 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/probes/pi13-cache-warming.mjs#L122-L138)；[`apps/daemon/config/defaults.json` 第 5–10 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/apps/daemon/config/defaults.json#L5-L10)
- 宣称：`explicit-off-respected-by-settings-path` 用 `inMemory({off})` 读回 off；`defaults-json-sets-off` 读文件断言含 off；并写明 daemon 加载属 Phase 2、运行时强制尚未落地。
- 源码：仓库里没有加载该文件的产品代码。`apps/daemon` 只有 `package.json` 和 `defaults.json`。探针自己 `readFileSync` 后用正则 `/"cacheWarming"\s*:\s*"off"/`。`getCacheWarmingMode()` 被调用了两次，入参分别是 `{}` 和手写的 `{ cacheWarming: "off" }`，都不是这份 JSON。文件里的键在 `budget.cacheWarming`，顶层没有 `cacheWarming`。安装包里的 `settings-manager.js` `getCacheWarmingMode` 只读 `this.globalSettings.cacheWarming`，缺省回落到 `"idle"`。
- 复现：在已 `npm ci` 的临时副本上，用 v22.23.5 执行 `SettingsManager.inMemory(JSON.parse(defaults.json)).getCacheWarmingMode()`，并对照手写顶层 off、以及 `{ budget: { cacheWarming: "off" } }`。日志：`logs/pi13-load.txt`。
- 观察：

| 入参 | `getCacheWarmingMode()` |
| --- | --- |
| `{}` | `idle` |
| `{ cacheWarming: "off" }`（探针测的这个） | `off` |
| `JSON.parse(defaults.json)` | **`idle`** |
| `{ budget: { cacheWarming: "off" } }` | **`idle`** |
| `{ cacheWarming: file.budget.cacheWarming }` | `off` |

绿报告里 `defaults-json-sets-off` 与 `explicit-off-respected-by-settings-path` 都是 PASS。

- 预期：探针读取 `defaults.json`，把解析结果送进 `getCacheWarmingMode()`（或等价的、会真正加载该文件的运行时路径），并断言结果为 `off`。
- 影响：两枚绿检查分别证明「字符串在文件里」和「另一个对象能读出 off」。把文件本身交给 Pi 的设置路径，保温仍是默认开启的 `idle`。Phase 2 若按文件原样装进 `SettingsManager`，探针不会变红。
- 最小修复：先把配置收成 API 能读到的顶层 `cacheWarming`（或写一个唯一加载器，把 `budget.cacheWarming` 映射过去）。探针改为 `JSON.parse` 该文件，经这个加载器再调用 `getCacheWarmingMode()`，期望 `"off"`。按现在的文件形状，这枚断言应当是红的。

### N3　中　缺 usage 时 `totalFromProvider` 并不存在，零成本仍是 PASS 条件

- 位置：[`evals/contracts/probes/pi10-usage.mjs` 第 85–88 行与第 154–158 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/probes/pi10-usage.mjs#L154-L158)
- 宣称：有 usage 时断言 `totalFromProvider` 为布尔 false；缺 usage 时 Pi 报零，账本必须 HELD，不得当零成本结清。
- 源码：有 usage 的检查是 `typeof === "boolean" && value === false`，这是可失败的。缺 usage 的检查要求 `input===0 && output===0 && cost.total===0` 才 PASS。HELD 只写在该检查的 detail 字符串和后面的 `probe.note("ledger-sums-itself")` 里。
- 观察（绿报告原文）：有 usage 的 cost 含 `"totalFromProvider": false`，对应检查 PASS。缺 usage 的对象是 `{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}`，**没有 `totalFromProvider` 键**。该检查仍 PASS。
- 预期：两条路径都按实际字段断言。有 usage 时期望 false，这一条成立。缺 usage 时字段实际缺失，不能把 `cost.total===0` 当成结清成功，也不能把「实为 false」写到这条路径上。
- 影响：缺 usage 的绿检查把「成本为零」当成成功条件。规范上的「不得结清」不能单独把套件打红（见 N1）。
- 最小修复：缺 usage 的断言改成实际形状：用量数字为 0，且 `cost` 上没有 `totalFromProvider`（或其值不是可加总的数字）。不要把 `cost.total===0` 命名或判定成结清成功。HELD 若仍是宿主义务，就不要用一条无法失败的 note 代替宿主侧门禁；在宿主账本出现之前，这条保持未完成，不要算作已结清。

### N4　中　检查脚本留在仓库目录时，4.12.24 仍会假绿

- 位置：[`evals/contracts/fixtures/hono-triage/checks/cors-credential-check.mjs` 第 9 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/fixtures/hono-triage/checks/cors-credential-check.mjs#L9)（注释写 `cwd must resolve hono`）。manifest 的 `installNote` 写的是把脚本复制进快照目录。
- 宣称：ESM 按脚本位置解析 `hono`，在仓库里跑会命中仓库的 4.13.19 而假绿；正确做法是把脚本复制进隔离安装目录。A1/A2 已实测。
- 观察（v22.23.5，两套隔离 `npm install`，日志 `logs/hono-oracle.txt`）：

| 跑法 | cors | csrf |
| --- | --- | --- |
| 脚本复制进 4.13.19 目录 | exit 0，`acao:"*"`，`reflected:false` | exit 0，status 403，`rejected:true` |
| 脚本复制进 4.12.24 目录 | exit 1，`acao:"https://attacker.example"`，`reflected:true` | exit 1，status 200，`rejected:false` |
| cwd 设为 4.12.24 目录，脚本路径仍在仓库副本里 | exit 0，`acao:"*"`，`reflected:false` | exit 0，status 403 |

隔离复制之后，两对 oracle 的 0/1 分离是真的，和宣称一致。不复制、只改 cwd，4.12.24 被仓库里的 4.13.19 盖住，两条都假绿。检查文件头的 cwd 说明与 `installNote` 相反，按文件头操作就会走到假绿。

- 影响：下一次若按检查文件头在仓库里复跑，A2 会显示「未受影响」。
- 最小修复：检查脚本用 `createRequire` 或显式路径加载目标安装目录里的 `hono`，不要靠脚本所在目录向上找 `node_modules`。删掉「cwd must resolve hono」这句。在仓库目录跑 4.12.24 目标时必须得到 exit 1，这条可以加进夹具自检。

### N5　低　宣称的隔离 lockfile 全文 SHA-256 未能复算（unknown，不算 PASS）

- 位置：两个 manifest 的 `target.lockfileHash` / `baseline.lockfileHash`，以及 `docs/phase1/evidence/04-audit-response-verification.md` 第 69–72 行。
- 观察：integrity 与 `npm view hono@4.12.24 dist.integrity`、`hono@4.13.19` 一致，见第 2 节 P1-4。全文哈希在本机 npm 10.9.9 的多种 lock 形状下都对不上。哈希依赖未入库的根包名和 `package.json` 字段，对方没有留下那份 `package.json`。
- 影响：不能把 `db2bb134…` / `e5d0c57e…` 当作已复核的锁文件身份。它们当前也不是仓库那份 4.13.19 lock，旧的「指错版本」没有复发。
- 最小修复：把生成该哈希的 `package.json` 与 `package-lock.json` 作为夹具旁路文件入库（或只提交哈希所覆盖的字节），让第三者能复算。在此之前，manifest 应以 registry integrity 与「脚本必须从该安装目录加载」为准，不要把无法复算的全文哈希写成已锁定身份。

### N6　低　`sqlite-driver.md` 仍是整改前的 27 表快照

- 位置：[`docs/phase1/reports/sqlite-driver.md` 第 9 行与第 16–25 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/docs/phase1/reports/sqlite-driver.md#L9)
- 观察：现行探针与绿报告写的是 `reference-schema-user-tables-27`：用户表 27、FTS 虚拟表 2、影子表 8、`sqlite_master` 总量 37，并且 `synchronous-full` 读回 `PRAGMA synchronous = 2`。该 Markdown 仍引用已不存在的 `reference-schema-loads` / `27 tables`，快照日期仍是 2026-11-18，摘录里没有 synchronous 读回。`PI-contract-report.md` 里的 4 秒和 `totalFromProvider` 布尔这两处已经改过来了。
- 最小修复：用本次绿报告的 SQLITE 节重写该快照，检查名和 27/2/8/37 与 JSON 一致。

### N7　低　安装证据仍写旧 engines 范围

- 位置：[`docs/phase1/evidence/02-pi-install.md` 第 25 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/docs/phase1/evidence/02-pi-install.md#L25)，对照 [`package.json` 第 7–9 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/package.json#L7-L9)
- 观察：根 `engines.node` 已是 `"22.23.5"`。证据句仍是 `>=22.19.0 <23.0.0`。
- 最小修复：改这一句，并注明它描述的是整改后的根 `package.json`，不是 pi 包自己的 `>=22.19.0`。

### N8　低　驱动选择 note 在断言失败时仍宣称门禁已满足

- 位置：[`evals/contracts/probes/sqlite-node.mjs` 第 135–140 行](https://github.com/NorthAdb/AegisPi/blob/87aa728c12ff54c00ad36d43c33403a783abb028/evals/contracts/probes/sqlite-node.mjs#L135-L140)
- 观察：把 `synchronous === 2` 改成 `=== 3` 后，`synchronous-full` 为 FAIL（实测 `PRAGMA synchronous = 2`），同一次结果里的 `driver-selection` note 仍写「satisfies every asserted gate … synchronous=FULL」。探针总状态是 FAIL，所以这次没有把套件洗绿。退出码 1，还原后 `--only=sqlite` 退出码 0。日志：`logs/mutation-fail2.log`、`logs/mutation-restore.log`。
- 最小修复：这句 note 改成只在 `summarizeProbe` 为 PASS 时出现，或改成不声称「每一条门禁都已满足」。

## 4. 已经独立证实、不必再改的部分

这些不是「他们说绿所以算绿」。临时副本上的破坏已还原。

1. 字面量 `true` 作为 `probe.check` 第二实参：对 `evals/contracts` 下全部 `.mjs` 做括号匹配扫描，零命中。
2. 分帧切点在「哈」的 UTF-8 内部。独立构造与探针相同的 `JSON.stringify({ id:"c1", type:"prompt", message:"x哈y" })`：`哈` = `e5 93 88`，起点字节 39，切点 40。part1 末字节 `e5`，part2 开头 `93 88`。`length-2` 落在字节 43，内容是 `22 7d`（`" }`）。切点不等于该 ASCII 边界。全套 FRAMING 的 `input-chunked-utf8-buffered` PASS，detail 为 `cut at byte 40`，prompt `success:true`。日志：`logs/framing-cut.txt`。
3. PI-07：绿报告 `dialog-timeout-not-dependable` 写明 `confirm(timeout:1500)` 在 4 秒后仍 pending；`restart-loads-extension` PASS（`probe_ui` 重新出现）；`no-dialog-replay-after-restart` PASS（0 条未请求 dialog，0 个旧 id）。源码是 SIGKILL 后用同一 `agent.dir` 再 `spawnPiRpc`，然后 `setTimeout` 4000。与 `PI-contract-report.md` 的「4 秒」一致。
4. 破坏 `synchronous-full`：临时副本把期望从 `=== 2` 改为 `=== 3`，`npm run test:contracts -- --only=sqlite` 退出码 1，唯一失败检查是 `synchronous-full`，detail `PRAGMA synchronous = 2 (2 = FULL)`。还原后退出码 0。这是我自己改临时副本跑的，不是复述 `evidence/04`。
5. 双 oracle 在「脚本复制进各自安装目录」时：4.13.19 为 cors 不反射 / csrf 403，退出码都是 0；4.12.24 为 cors 反射 `https://attacker.example` / csrf 200 放行，退出码都是 1。
6. GHSA 窗口、75 条无重复无截断、index digest 与 amd64 digest，见第 2 节。我这次把 amd64 清单也核到了 registry，他们原稿里「本机未复验」的那句因此可以被第三者补上，但数字本身是对的。
7. labels：`.gitignore` 第 6–7 行忽略 `*.labels.json` 与 `*.labels.local.json`。`git check-ignore -v` 命中这两条。`git ls-files` 无 label 文件。

## 5. 阶段门禁

现在**不能**宣布技术收口。

Phase 2 **不能开工**。N1 和 N2 仍是上一轮「不可失败的绿」的同类问题：一个在套件退出码，一个在保温默认值。规范写明有未决核心契约不得进入自动执行，Phase 2 的入口是 Phase 1 契约审查通过。用户侧四项可以继续由用户准备（通知渠道、基线三句话、标注确认、DeepSeek key 与一次最小推理），这四项的准备**不是** Phase 1 完成，也**不是** Phase 2 开工许可。

P1-5 的未勾选状态是对的，不要为了「看起来做完」把 6b 或用户基线勾上。

## 6. 给 GLM 的剩余清单

按这个顺序改，改完用锁定的 Node 22.23.5 再跑，不要只改措辞。

1. `run-contracts.mjs`：存在 `SKIP`，或任一探针没有 PASS 判据，退出码必须为 1。补一条只含 `probe.note` 的探针（或临时替换）证明退出码 1；还原后全套退出码 0。`summarizeProbe` 不得因 `finalStatus==="PASS"` 把零条 PASS 升成 PASS。
2. `defaults.json` 与 PI-13：让 `getCacheWarmingMode()` 真正读到这份文件里的 off。现在 `JSON.parse` 后调用得到 `idle`。探针要走这条路径，期望 `"off"`。在形状修好之前，这枚检查应是红的，不要用正则加手写对象维持绿色。
3. PI-10 缺 usage：按绿报告里的实际对象断言。该对象没有 `totalFromProvider`。不要把 `cost.total===0` 当成结清 PASS。有 usage 的 `totalFromProvider===false` 可以保留，我已复现。
4. hono 检查：从目标安装目录解析 `hono`，不要靠 cwd，也不要靠「脚本放在哪」。在仓库目录对 4.12.24 跑必须得到 cors exit 1 与 csrf exit 1。删掉检查文件头里的 `cwd must resolve hono`。把能复算出 `lockfileHash` 的 `package.json` 与 lock 放进夹具；在此之前不要把 `db2bb134…` 写成已复核身份。integrity 可以保留，它和 `npm view` 一致。
5. 改完再跑一次全套 `npm run test:contracts`，并保留退出码。同步改掉 `sqlite-driver.md` 的旧检查名和 `02-pi-install.md` 的旧 engines 句子。`driver-selection` 的 note 不要在 FAIL 时仍写「全部门禁已满足」。
6. 不要勾选：通知渠道、基线三句话、75 条标注的用户确认、DeepSeek 最小推理。不要宣布 Phase 1 完成，不要开始 Phase 2 实现。

## 7. 日志索引

都在 `/tmp/aegis-audit-87aa728/logs/`。

| 文件 | 内容 |
| --- | --- |
| `test-contracts.log` / `test-contracts.exit` | 全套，退出码 0，含 node/npm/OS |
| `contracts-report.green.json` | 该次机器报告 |
| `mutation-fail2.log` / `.exit` | `synchronous === 3`，退出码 1，失败检查 `synchronous-full` |
| `mutation-restore.log` / `.exit` | 还原后 sqlite 退出码 0 |
| `note-only.log` / `.exit` | 只有 note，探针 SKIP，套件退出码 0 |
| `wrong-node.txt` | `AEGISPI_NODE_BIN` 指向 v22.23.4，`child-node-locked` FAIL |
| `pi13-load.txt` | 解析 `defaults.json` 后 `getCacheWarmingMode()` = `idle` |
| `framing-cut.txt` | 切点字节 `e5 \| 93 88` |
| `ghsa-p1.json` / `rel-p1.json` | 独立拉取的 advisory 与 release |
| `hono-oracle.txt` | 两版本复制进目录的 0/1，以及 cwd 假绿 |
| `npm-view-hono.txt` | registry integrity |
| `image-digest-result.txt` / `image-index.json` | index 与 amd64 清单 |
| `validate-pack.log` | 规范包 14/14，退出码 0 |
