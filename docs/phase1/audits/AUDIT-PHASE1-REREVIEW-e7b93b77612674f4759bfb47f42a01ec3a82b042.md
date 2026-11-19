# AegisPi Phase 1 第二轮整改复审（只读）

结论：**整改未通过**。

上一轮的 N1、N2 已由本轮独立的红/绿证据关闭。N3 的结清假绿已去掉，缺 usage 的实测对象是数字全零且没有 `totalFromProvider` 键。入库 lockfile 的 SHA-256 可以复算，并与 manifest 的 `e5d0c57e…` / `db2bb134…` 以及 `npm view` integrity 一致。从仓库目录对**已经 npm ci 的** hono 4.12.24 跑 csrf 与 cors，退出码都是 1，`require.resolve` 落在该安装目录内。

未通过的原因是一条新的假绿：检查脚本用 `createRequire` 从参数目录解析 `hono`，但 Node 会向父目录上溯。把参数指到仓库里**尚未安装**的 `snapshots/hono-4.12.24`（只有 `package.json` 与 lock），两条检查都 exit 0，行为是仓库里的 hono 4.13.19，而输出字段 `honoFrom` 仍打印该快照目录。配对工具把 `honoFrom === 参数目录` 当成「解析来源正确」，这条自证因此不成立。按本轮判定，再出现假绿则整改未通过。

Phase 1 **不得宣布完成**：通知渠道、基线三句话、75 条标注确认、DeepSeek 最小推理仍未完成，这次提交没有把它们勾上。Phase 2 实现 **不得开工**。本提交没有写 Phase 2 的 inbox / Task / lease 产品代码；加载器目前只被 PI-13 探针引用。

本轮没有改仓库、没有提交、没有推送、没有开 PR、没有评论、没有发外部消息。脚本、日志和本稿都在 `/tmp/aegispi-audit-e7b93b7/`。结束时 `git status --porcelain` 为空，`HEAD` 仍是下面的 SHA。没有 API key，没有真实付费推理。没有做 Windows 路径 shim。

## 0. 固定起点

| 项 | 值 |
| --- | --- |
| 复审对象完整 SHA | `e7b93b77612674f4759bfb47f42a01ec3a82b042` |
| 父提交 | `87aa728c12ff54c00ad36d43c33403a783abb028`（上一轮审计对象，且是这笔提交的唯一父） |
| 提交说明 | Re-review round 2 response: suite exit gate (note-only=red), cacheWarming real path via loader, measured no-usage shape, explicit hono resolution + committed snapshots |
| 作者 / 时间 | NorthAdb \<1328704940@qq.com\>，2026-11-19 10:57:52 +0800 |
| 本地核对 | `git rev-parse HEAD` 等于上述 SHA；工作区干净 |
| 相对上一轮 diff | 30 个文件，+635 / −126。`events.json` 与 `pi02-virtual-models.mjs` 的 blob 与父提交相同（`ef864d26111a50f72ec9be1bfc1659b7b63dac0e`、`3d415e07b1dfb3d2253e580457347fbc7a3b776e`） |
| 规范包 | 上传 zip 解压到 `/tmp/aegispi-audit-e7b93b7/pack/aegis-pi-design-pack-v1.4.1`。`docs/reference/schema.sql` SHA-256 = `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`。`python3 -X utf8 validation/validate_pack.py` 退出码 0，14/14，`CONNECTIONS_LEFT=0`。这是资料包自检，不是产品验收 |
| 运行位置 | `git archive e7b93b77612674f4759bfb47f42a01ec3a82b042` 解到 `/tmp/aegispi-audit-e7b93b7/work`，再 `npm ci`。运行器会重写副本里的 `contracts-report.json`，仓库里那份没有被改 |

Phase 1 退出门禁（资料包 `docs/04`）：用户选真实 repo 与通知渠道并建立标注样本；在锁定 Node 22.23.5 上核验 exact Pi 1.5.2、LF 分帧与 SQLite；绑定「DeepSeek Flash High」且不编造 ID；记录已取得的基础镜像 digest；用 oracle/manifest 夹具起步。缺命令、空实现、skip 不能当通过。有未决核心契约不得进入自动执行。Phase 2 入口是「Phase 1 契约和 schema 审查通过」。

## 1. 独立复跑环境

官方 Node 从 `https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz` 下载。同目录 `SHASUMS256.txt` 核对：

`cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8  node-v22.23.5-linux-x64.tar.xz` → `sha256sum -c` OK。

| 项 | 实测 |
| --- | --- |
| OS | Ubuntu 24.04.5 LTS，Linux 6.12.113+ x86_64 |
| node | `/tmp/aegispi-audit-e7b93b7/node/node-v22.23.5-linux-x64/bin/node` → `v22.23.5` |
| npm | 同目录 `npm` → `10.9.9` |
| `process.versions.sqlite` | `3.54.1` |
| 开关 | `AEGISPI_NODE_BIN` 指向上述二进制。`AEGISPI_NPM_BIN` 指向同目录 npm。`AEGISPI_SPEC_PACK` 指向解压后的 v1.4.1 包 |
| 首次全套 | `npm run test:contracts`，UTC 2026-11-19T04:43:46Z → 04:44:11Z，退出码 **0**，15 个探针均为 PASS，末行 `all PASS with falsifiable evidence` |
| 机器报告 | `/tmp/aegispi-audit-e7b93b7/logs/contracts-report.green.json`，`nodeVersion` = `v22.23.5`，`generatedAt` = `2026-11-19T04:44:11.474Z` |
| 还原后全套 | 全部临时破坏用备份 `cmp` 还原后再次 `npm run test:contracts`，日志 `logs/test-contracts-restored.log`，退出码 **0**，15 个探针均为 PASS。开始于 2026-11-19T04:47:05Z |
| 子进程 | 绿报告里 PI-05/06/07/08 与 FRAMING 的 `child-node-locked` 均为 PASS，detail 写明 `via AEGISPI_NODE_BIN` 且为 v22.23.5 |

`npm ci` 后仓库依赖为 `@earendil-works/pi-coding-agent` 1.5.2（包自身 engines `>=22.19.0`）与 hono 4.13.19。探针走本地 fake OpenAI，不访问付费推理。

## 2. 闭环表

读表方式：每一行先写他们的宣称，再写源码里实际写了什么，再写我自己跑到的结果。`docs/phase1/evidence/05-rereview-response-verification.md` 只作为宣称，不作为观察。

| 项 | 闭环 | 宣称 | 源码静态 | 独立观察 |
| --- | --- | --- | --- | --- |
| N1 高：只有 note 时退出码仍为 0；`result("PASS")` 把 note 升格为 PASS | **关闭** | `summarizeProbe` 在无 PASS 判据时先返回 SKIP，运行器对 FAIL、SKIP、无 PASS finding 退出码 1；纯 note 红证退出码 1 | [`probe-utils.mjs` 73–83](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/helpers/probe-utils.mjs#L73-L83)：FAIL 判据与 `finalStatus==="FAIL"` 之后，若没有任何 `status==="PASS"` 的 finding 就返回 `SKIP`，然后才看 `finalStatus`。[`run-contracts.mjs` 86–106](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/run-contracts.mjs#L86-L106)：FAIL、SKIP、或没有 PASS finding 则 `exit 1` | 直接调用：notes only → SKIP；notes + `result("PASS")` → **SKIP**；notes + `result("FAIL")` → FAIL；FAIL 判据 → FAIL；真实 PASS → PASS。临时副本把 sqlite 探针换成纯 note：探针状态 SKIP，退出码 **1**。换成 note + `result("PASS")`：状态仍是 SKIP，退出码 **1**。绕过 `summarizeProbe`、返回值硬写 `status:"PASS"` 但 findings 只有 note：控制台先打印 PASS，随即 `probes without any PASS finding`，退出码 **1**。还原后全套退出码 0 |
| N2 高：`defaults.json` 的 off 走 `getCacheWarmingMode()` 得到 idle，探针用手写顶层对象变绿 | **关闭（配置路径可测；daemon 运行时未接线，属 Phase 2）** | 唯一加载器把 `budget.cacheWarming` 映到顶层 `cacheWarming`；文件直读 = idle 与经加载器 = off 都是断言；删加载器或改键形则探针变红；文件保持 06 嵌套形状 | [`defaults.json` 4–10](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/apps/daemon/config/defaults.json#L4-L10) 仍是 `budget.cacheWarming:"off"`，顶层没有 `cacheWarming`。数值与 06 一致：800000 microUSD、25 步、900 秒、日 5000000、保温 off。[`load-pi-settings.mjs` 15–27](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/apps/daemon/config/load-pi-settings.mjs#L15-L27) 只在 `budget.cacheWarming !== undefined` 时写入顶层。全库产品入口不引用该模块，唯一调用方是 [`pi13-cache-warming.mjs` 130–155](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/probes/pi13-cache-warming.mjs#L130-L155)。`apps/daemon` 没有运行入口。安装包 `settings-manager.js` 的 `getCacheWarmingMode()`（725–727 行）只读 `globalSettings.cacheWarming`，缺省回落 `"idle"` | v22.23.5：`inMemory({})` = idle；手写 `{cacheWarming:"off"}` = off；`inMemory(JSON.parse(defaults.json))` = **idle**；`{budget:{cacheWarming:"off"}}` = idle；`piSettingsFromDefaults(JSON.parse(file))` 得到 `{"cacheWarming":"off"}`，再 `getCacheWarmingMode()` = **off**。`SettingsManager.create` 把同一对象写成 `settings.json` 再加载：原始文件 = idle，加载器输出 = off。绿报告两条断言都是 PASS。临时副本：删除加载器 → 探针抛 `ERR_MODULE_NOT_FOUND`，退出码 1；加载器改成 `return defaults`（绕过映射）→ `defaults-json-off-reaches-pi-via-loader` FAIL（读到 idle），退出码 1；把键挪到顶层 → 危险断言与加载器断言都 FAIL（直读变成 off，加载器得到 `{}` 因而 idle），退出码 1；把值改成 `"idle"` → 加载器断言与文件正则都 FAIL，退出码 1。还原后 `--only=pi13` 退出码 0 |
| N3 中：缺 usage 时没有 `totalFromProvider`，却把 `cost.total===0` 当成结清 PASS | **关闭**。谓词没有锁住每一个数字字段，见 N11，不推翻这项关闭 | 断言改为数字全零且 `!("totalFromProvider" in cost)`；名称不再把零成本当成结清；HELD 留在 open-items | [`pi10-usage.mjs` 160–164](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/probes/pi10-usage.mjs#L160-L164) 的条件是 `input===0 && output===0 && cost 存在 && !("totalFromProvider" in cost)`。条件里没有 `cost.total===0`。有 usage 的检查（85–89 行）仍是 `typeof === "boolean" && value === false`。HELD 只出现在 note（179–182 行），并写明 Phase 1 未实现 | 绿报告缺 usage 对象原文：`{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}`，没有 `totalFromProvider` 键。九个数字都是 0。该检查 PASS。有 usage 的 detail：`cost.totalFromProvider = false (typeof boolean)`，检查 PASS。用同一谓词试 `{input:0,output:0,cost:{total:999}}` 仍为真；键存在（false 或 true）为假；`input===1` 为假。当前实测对象满足要求的形状，零成本不再是 PASS 条件 |
| N4 中：检查留在仓库目录时 4.12.24 假绿 | **已安装目录这一条关闭；解析自证未关闭，见 N9** | `createRequire(join(dir,"package.json"))` 显式加载；从仓库对 4.12.24 跑 exit 1；`honoFrom` 自证来源；`verify-hono-oracle-pair.mjs` 断言 0/1 与解析来源 | [`csrf-textping-check.mjs` 26–28 与 63–67](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/fixtures/hono-triage/checks/csrf-textping-check.mjs#L26-L28)、[`cors-credential-check.mjs` 28–30 与 61–66](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/fixtures/hono-triage/checks/cors-credential-check.mjs#L61-L66)：`honoFrom` 被赋成参数 `installDir`，不是 `require.resolve` 的结果。文件头已去掉 `cwd must resolve hono`。[`verify-hono-oracle-pair.mjs` 84–90](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/tools/verify-hono-oracle-pair.mjs#L84-L90) 把 `honoFrom === resolve(参数目录)` 当作 resolution OK | 工作目录 = git archive 副本。已安装目录（`npm ci` 于 `/tmp/.../hono-installs/`，不在仓库树内）：4.12.24 csrf exit **1**（status 200，`rejected:false`），cors exit **1**（`acao:"https://attacker.example"`，`acac:"true"`，`reflected:true`）。4.13.19 csrf exit **0**（403），cors exit **0**（`acao:"*"`，`reflected:false`）。`honoFrom` 都是对应安装目录，不是仓库。独立 `require.resolve`：4.12.24 的 `hono` / `hono/csrf` / `hono/cors` 都在该安装目录的 `node_modules/hono/dist/cjs/` 下。`verify-hono-oracle-pair.mjs` 退出码 0，四行 OK，并打印两个 lock 哈希 |
| N5 低：lockfile 全文哈希未能复算 | **关闭** | 两个快照的 `package.json` + `package-lock.json` 入库，哈希即 manifest 的 lockfileHash | 快照 lock 把 hono 钉在 4.12.24 与 4.13.19，integrity 与 manifest 相同。`package.json` 的依赖范围写成 `^4.12.24` / `^4.13.19`，不是 exact；锁文件本身是 exact | `sha256sum` 仓库字节：4.12.24 lock = `db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4`；4.13.19 lock = `e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e`。与两个 manifest 的 `lockfileHash` 逐字相同。`npm view`（npm 10.9.9）：4.12.24 integrity `sha512-I36D1s+HgQc55KbhEr4iybfxv/9o1zdpw+XEM6dJa91LqQD0HCoSGdxpRJCZE+aavs87j4V3Ls2OJzq8c/U4iw==`；4.13.19 integrity `sha512-KmXvQAXwcAHV+muzbIwoJ23niEB5nMoDVr9WcRkU8mvjUECm/1+7v4Jgp7P7a+H6MLFrh+vXrGonGrGS+RQfkA==`。隔离 `npm ci` 装出的版本就是 4.12.24 与 4.13.19。仓库自己的 `package-lock.json` SHA-256 仍是 `f1364f6e…947e`，没有和快照哈希混同 |
| N6 低：`sqlite-driver.md` 仍是 27 表旧快照 | **关闭** | 按绿报告重写 27/2/8/37 与 `synchronous-full` | [`sqlite-driver.md` 9–13、19–26](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/docs/phase1/reports/sqlite-driver.md#L9-L13) 写检查名 `reference-schema-user-tables-27`，非 FTS 恰 27、2 张虚拟表、8 张影子、总量 37，以及 `PRAGMA synchronous = 2`。旧名 `reference-schema-loads` 不再出现 | 绿报告 SQLITE：`reference-schema-user-tables-27` 的 detail 为用户表 27、FTS `fts_messages_lex`/`fts_messages_tri`、影子 8、`sqlite_master` 总量 37；`synchronous-full` 为 `PRAGMA synchronous = 2`。与该 Markdown 一致 |
| N7 低：`02-pi-install.md` 仍写旧 engines | **关闭** | 改成根 engines `"22.23.5"`，并与 Pi 包自己的 `>=22.19.0` 分开 | [`02-pi-install.md` 25](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/docs/phase1/evidence/02-pi-install.md#L25) 写根 engines `"22.23.5"`，并注明 Pi 包仍是 `>=22.19.0`。根 [`package.json` 7–9](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/package.json#L7-L9) 是 `"22.23.5"` | `npm ci` 后读到的 pi 包 engines 是 `{"node":">=22.19.0"}`。文档句与根 `package.json`、与安装结果一致 |
| N8 低：FAIL 时 note 仍写全部门禁已满足 | **关闭** | note 仅在无 FAIL 时声称满足；有 FAIL 时写成未结论 | [`sqlite-node.mjs` 135–149](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/probes/sqlite-node.mjs#L135-L149)：`gateFailures.length === 0` 才写 satisfied；否则写 `NOT concluded` 与失败门禁名 | 绿报告的 `driver-selection` note 写 satisfied every asserted gate。把 `synchronous === 2` 改成 `=== 3` 后：`synchronous-full` FAIL，detail `PRAGMA synchronous = 2 (2 = FULL)`，同一次 note 为 `driver-selection NOT concluded in this run: failing gate(s): synchronous-full`。退出码 1。还原后该文件与备份 `cmp` 一致 |
| 用户侧四项 | **仍未完成（这是要求的状态）** | 不宣布 Phase 1 完成，不勾选这四项，不开工 Phase 2 | [`.audit/phase1.todo.md` 12](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/.audit/phase1.todo.md#L12) 的 6b 仍是 `[ ]`。[`phase1-open-items.md` 7–9](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/docs/phase1/reports/phase1-open-items.md#L7-L9) 仍列 DeepSeek 最小推理、通知渠道、基线三句话。标注确认写在 6b 与第 9 行。[`model-binding.md` 23–25](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/docs/phase1/reports/model-binding.md#L23-L25) 标题仍是「未完成项」 | 相对父提交，6b 的复选框没有从 `[ ]` 改成 `[x]`。open-items 第 6 条从「amd64 清单待本机复验」换成「宿主 HELD 账本未实现」，四项用户准备没有被划掉。本轮没有重拉镜像 registry，不把 amd64 digest 记成我的新 PASS；文档把该数字归到上一轮复审，没有把它写成用户项已完成 |
| P1-1 双路径 | **未回退** | 本轮未改 | `pi02-virtual-models.mjs` blob 与 `87aa728` 相同 | 绿报告：`runtime-path-route-single-argument` PASS，`arguments.length=1`；`ext-path-route-receives-ctx` PASS，`arguments.length=2` 且 `ctx.modelRegistry present=true`；`ext-path-ctx-resolves-physical-model` PASS，返回 `deepseek-flash` |
| P1-3 GHSA-88fw / 75 候选 | **未回退；本轮未重拉 advisory** | 本轮未改 events.json | blob 与父提交相同 | 按本次任务，events.json 未改则不重新全量拉取。不把上一轮的 61/30/45/75 记成本轮新测 PASS，只确认这份提交没有改那份夹具 |
| P1-5 未勾完 | **未回退** | 维持未勾选 | 见上栏 6b | 6b 仍是 `[ ]` |

## 3. 新发现

### N9　中　未安装的快照目录位于仓库树内时，4.12.24 检查仍假绿，且 `honoFrom` 不反映真实模块

- 位置：[`csrf-textping-check.mjs` 第 26–28 行与第 63–67 行](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/fixtures/hono-triage/checks/csrf-textping-check.mjs#L63-L67)；[`cors-credential-check.mjs` 第 28–30 行与第 61–66 行](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/fixtures/hono-triage/checks/cors-credential-check.mjs#L61-L66)；配对工具 [`verify-hono-oracle-pair.mjs` 第 87–90 行](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/tools/verify-hono-oracle-pair.mjs#L87-L90)
- 宣称：hono 从参数给出的安装目录加载，与 cwd、脚本位置无关；`honoFrom` 自证来源；从仓库对 4.12.24 跑必然 exit 1。
- 源码：`createRequire(join(installDir, "package.json"))` 然后 `require("hono")`。Node 的模块查找在该目录没有 `node_modules/hono` 时继续向父目录找。`honoFrom` 写入的是参数路径。配对工具只比较这个字符串和参数路径。
- 复现（cwd = git archive 副本，Node v22.23.5）：
  1. 已安装对照：`node evals/contracts/fixtures/hono-triage/checks/csrf-textping-check.mjs /tmp/aegispi-audit-e7b93b7/hono-installs/hono-4.12.24` 与同目录的 cors 脚本。exit 1 / exit 1。`require.resolve` 位于该安装目录内。
  2. 假绿：同一 cwd，参数改为副本内的 `evals/contracts/fixtures/hono-triage/snapshots/hono-4.12.24`（目录里只有 `package.json` 与 `package-lock.json`）。csrf exit **0**，status 403，`rejected:true`。cors exit **0**，`acao:"*"`，`reflected:false`。`honoFrom` 等于该快照路径。`require.resolve("hono")` = `/tmp/aegispi-audit-e7b93b7/work/node_modules/hono/dist/cjs/index.js`，即仓库 `npm ci` 的 hono **4.13.19**。
  3. 仓库外的空目录（自带一份 `package.json`、没有父级 `node_modules/hono`）：两条都 exit **2**，输出 `infra_error` / `Cannot find module 'hono'`。假绿依赖「参数目录在已安装的仓库树下」。
- 观察与预期：已安装的 4.12.24 行为符合上一轮要求的 exit 1。未安装的入库快照被 4.13.19 盖住后，两条都呈现「已修复」的 exit 0，来源字段却指向名为 4.12.24 的目录。预期是：解析结果必须落在给定目录之内，否则 exit 2，不得 exit 0。
- 影响：照快照目录直接跑（漏了 `npm ci`，或把入库快照路径当成安装目录）会得到「4.12.24 未受影响」。`verify-hono-oracle-pair.mjs` 自己先在临时目录 `npm ci`，那一次我跑到的 0/1 矩阵是真的；它的 resolution 判定却查不出这种上溯。
- 最小修复：`require.resolve("hono")`、`hono/csrf`、`hono/cors` 的真实路径必须位于参数目录之下，否则 exit 2。`honoFrom` 写解析到的文件路径。配对工具改为核对这个路径，并加一条：对仓库内未安装的快照目录，两条检查都必须 exit 2。已安装的 4.12.24 仍须 exit 1，4.13.19 仍须 exit 0。

### N10　低　`--only` 匹配不到探针时退出码仍为 0

- 位置：[`run-contracts.mjs` 89–106](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/run-contracts.mjs#L89-L106)
- 复现：`npm run test:contracts -- --only=does-not-exist`
- 观察：退出码 **0**，末行 `0 probe(s): all PASS with falsifiable evidence`。日志 `logs/only-empty.log`。
- 预期：零个探针不能算全套通过。
- 影响：`--only` 拼错时，门禁报告成功且不跑任何断言。这不推翻 N1 对「有探针但只有 note」的关闭。
- 最小修复：`results.length === 0` 时 `exit 1`。

### N11　低　缺 usage 的谓词窄于「数字全零」

- 位置：[`pi10-usage.mjs` 160–162](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/evals/contracts/probes/pi10-usage.mjs#L160-L162)
- 观察：当前 Pi 返回的对象九个数字都是 0，且没有 `totalFromProvider`，检查因此 PASS，detail 也贴出了这个对象。谓词本身只要求 `input` 与 `output` 为 0、`cost` 为真、键不存在。`{input:0, output:0, cost:{total:999}}` 会使该检查 PASS。`cost.total===0` 已经不在条件里，detail 也写明这不是零成本结清证据。
- 预期：形状断言覆盖实测到的每个数字字段为 0，同时继续不把「total 等于 0」命名成结清成功。
- 影响：今天的对象是对的；以后若省略路径带上非零 cost 且仍无该键，这枚检查不会变红。
- 最小修复：对 `input/output/cacheRead/cacheWrite/totalTokens` 以及 `cost` 的四个分项与 `total` 逐项 `=== 0`，并保留 `!("totalFromProvider" in cost)`。检查名与 detail 继续写「无可信结算证据」。

### 加载器没有产品入口（不是新的假绿，必须写明）

`piSettingsFromDefaults` 的引用只在 PI-13 探针、该模块自身，以及说明它的文档。`apps/daemon/package.json` 没有 `main`，目录里没有 daemon 进程入口。配置路径已经可测：文件 → 加载器 → `getCacheWarmingMode()` 在加载器完好时为 off，绕过或删除时探针为红。daemon 运行时是否真的调用这个加载器，仍是 Phase 2 范围。我另测的 `SettingsManager.create` 读 `settings.json`：写入原始 `defaults.json` 得到 idle，写入加载器输出得到 off。探针没有覆盖 `create()`，结果与 `inMemory` 一致。仓库里没有第二条产品代码在读这份文件。

危险断言 `raw-defaults-json-reads-idle-hazard` 把「直读仍是 idle」写成 PASS。这是在记录危险仍然存在。它单独不能证明 off 已生效；off 由另一条断言承担，并且我已把那条断言打红。

## 4. 阶段门禁

技术整改 **未通过**，因为 N9 是新的假绿。N1 与 N2 的红/绿已经独立成立，不能再把上一轮那两条当作未关闭项。

Phase 1 **不能宣布完成**。用户侧四项仍开放。

Phase 2 **不能开工**。技术门禁没有过。移交文档 [`AUDIT-HANDOFF.md` 第 7–8 节](https://github.com/NorthAdb/AegisPi/blob/e7b93b77612674f4759bfb47f42a01ec3a82b042/docs/phase1/AUDIT-HANDOFF.md#L64-L70) 把 N1–N8 写成已关死，并写「最小验收绿了再继续」作为 Phase 2 入口。那是宣称。本提交没有 Phase 2 产品实现；在 N9 关闭之前，下一会话也不应开始 Phase 2。

P1-5 的 6b 保持未勾选是对的。

## 5. 给 GLM 的剩余清单

按这个顺序改。改完用锁定的 Node 22.23.5 在临时副本里重跑，不要只改措辞，不要勾选用户项。

1. hono 检查：`require.resolve` 必须落在参数目录之内，否则 exit 2。`honoFrom` 写真实文件路径。从仓库目录对**已安装**的 4.12.24 仍须 csrf exit 1、cors exit 1；对 4.13.19 仍须都是 exit 0。再加一条：参数指向仓库内未 `npm ci` 的 `snapshots/hono-4.12.24` 时，两条都必须 exit 2，不得 exit 0。配对工具要核对解析路径，不能只比较参数字符串。
2. `run-contracts.mjs`：`--only` 一个探针都没选中时退出码 1。纯 note、以及 note + `result("PASS")`，保持现在的退出码 1。
3. PI-10：缺 usage 的谓词补上实测对象里其余数字字段 `=== 0`，继续不要把 `cost.total===0` 写成结清成功。有 usage 的 `totalFromProvider===false` 保持。
4. 不要勾选：通知渠道、基线三句话、75 条标注的用户确认、DeepSeek 最小推理。不要宣布 Phase 1 完成。不要开始 Phase 2 实现。daemon 将来加载 `defaults.json` 必须经过 `load-pi-settings.mjs`；在接线落地之前，不要把「探针调用了加载器」写成运行时已经强制 off。

N1、N2、N5、N6、N7、N8 不要为了措辞再改一遍。已安装目录上的 4.12.24/4.13.19 行为矩阵和两个 lock 哈希已经能复算，保留它们。

## 6. 日志索引

都在 `/tmp/aegispi-audit-e7b93b7/logs/`。

| 文件 | 内容 |
| --- | --- |
| `test-contracts.log` / `test-contracts.exit` | 首次全套。退出码 0。含 OS、node v22.23.5、npm 10.9.9、命令 |
| `contracts-report.green.json` | 该次机器报告，`generatedAt` `2026-11-19T04:44:11.474Z` |
| `test-contracts-restored.log` / `.exit` | 破坏还原后的全套，退出码 0 |
| `note-only.log` / `note-result-pass.log` / `note-lie-status.log` | 纯 note、note+`result("PASS")`、硬写 status PASS。退出码都是 1 |
| `only-empty.log` | `--only=does-not-exist`，退出码 0 |
| `pi13-paths.txt` | `JSON.parse(defaults.json)` → idle；加载器 → off；`SettingsManager.create` 同形；`summarizeProbe` 矩阵 |
| `pi13-delete-loader.log` | 删除加载器，退出码 1，`ERR_MODULE_NOT_FOUND` |
| `pi13-bypass-detail.log` / `.report.json` | 加载器 `return defaults`，`defaults-json-off-reaches-pi-via-loader` FAIL，读到 idle |
| `pi13-flatten-detail.log` / `.report.json` | 键挪到顶层，危险断言与加载器断言都 FAIL |
| `pi13-idle-detail.log` / `.report.json` | 值改成 idle，加载器断言与正则都 FAIL |
| `pi13-restored.log` | 还原后 `--only=pi13` 退出码 0 |
| `sqlite-note-detail.log` / `.report.json` | `synchronous === 3`，note 为 NOT concluded，退出码 1 |
| `hono-independent.txt` | 已安装 4.12.24 exit 1/1，4.13.19 exit 0/0，`require.resolve` 路径，未安装快照假绿，配对工具退出码 0 |
| `npm-view-4.12.24.json` / `npm-view-4.13.19.json` | registry integrity |
| `validate-pack.log` | 规范包 14/14，退出码 0 |
| `SHASUMS256.txt` 与 `node-v22.23.5-linux-x64.tar.xz` | 在审计根目录，`sha256sum -c` OK |
