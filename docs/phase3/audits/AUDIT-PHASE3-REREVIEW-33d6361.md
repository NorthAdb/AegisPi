# Phase 3 独立复核（仓库阶段）：33d6361

目标：`origin/main` = `33d63611327c131935666d7dfd5f8bf2afecf15f`（结论前再次 `git fetch`，仍是该 SHA）。祖先：`ec23ef7aa199319a000b8d9c16d6557fc1195d02`（A/C）、`26929a0dd6fea0aeab2f0b34ff5cc95245e940d3`（B）。对照树：此前已复核的 `3cd065247c6f9b52c622308ca216730cc50c879d`。

本文件是**仓库阶段报告**。三份原 OCI 归档仍标 **待到件**。未重建、未 push registry、未把镜像结案。未跑任何 real 入口（含 simulate），未读 `.env`，未改生产代码，未 push，未开/改/合并 PR。

标记：T 本机测量，R 读源码，S 读规范/移交原文，U 本机没有可复核对象。

## 判定

| 问题 | 判定 |
| --- | --- |
| 本轮文档收口（勘误追加、D 暂缓、A/B 不再挂 Phase 5/6） | **成立，附残留**。生产 `apps/` `docker/` `tools/` `package-lock.json` `defaults.json` 相对 `3cd0652` 零差异。 |
| A 真实 provider / usage 结清 | **目录价算术成立，供应商账单未核对**。冻结证据仍写「≤5」；勘误追加改为 ≤2；套件记录恰 1 次、28 microUSD。授权闭合是文书口径，`model-real` 入口没有一次性守卫。 |
| B 原始 exit 1 与 postverify | **分开记录属实**。postverify 只能重读 scratch 库；本机缺库，exit 3。用户见证只核请求头。固定 `externalId` 是测试端点契约。一次性守卫被写成「结构上不可能」，实际是证据文件是否存在。 |
| C 次数与授权 | **最小 6 / 可能 8 的未知边界写对了，但不能闭项**。T0 的引用依据不是逐项授权。T1 原输出缺。T2 入库差异只有生成时间。scratch 的 `received_at` 本机缺证。不认定造假。 |
| 受限 Phase 4 Observe | **D 不是统一阻塞**。本轮未批准开工。跑三镜像的执行仍等原归档。 |
| 常开 | **否**。 |
| 原镜像 | **待到件，未结案**。 |

阶段出口维持上一轮的 **MET WITH RESIDUAL RISKS**。A 的账单、B 的正文、C 的历史次数与 T2 网络事实、原镜像，四项都不因本轮文书而关闭。

## 1. 三轮生产树

`git diff 3cd0652..33d6361 -- apps docker tools package.json package-lock.json apps/daemon/config/defaults.json`：只有 `package.json` 增加两行 npm script（`test:model:real`、`test:external-write:real`）。`apps/`、`docker/`、`tools/`、lockfile 的 diff 为空。`defaults.json` 两边 blob 都是 `23d9f66d8856ba89c47fa653ce48bc83bf279d49`。

现行默认（R）：`model.endpoint=null`，`allowRealModelCalls=false`，`upstream.submitUrl=null`，`policy.allowRealExternalWrites=false`，价格目录两侧 null，`callUpperMicrousd=1000`，任务上限 `800000` microUSD（$0.80），日上限 `5000000` microUSD（$5）。

四个提交各自对 `apps/docker/tools/lock/defaults` 的 diff 都为空。变的是文档、证据、`evals/phase3/model-real/run.mjs`、`evals/phase3/external-write-real/{run,postverify}.mjs` 和上述两条 script。

本机 `test:security:unit`：43 pass / 0 fail，退出码 0（T）。跑完已 `git checkout -- docs`。

## 2. A：目录价结清，不是供应商账单

冻结证据 `docs/phase3/evidence/model-real-log.md:9` 与 `model-real-report.json:27` 仍写「本次恰 1 次调用（授权上限 ≤5）」。勘误 1（`errata-2026-11-20.md:5-16`）不涂改这两份，只在 `real-acceptance-run-a-c.md:39` 追加，并把活脚本 `evals/phase3/model-real/run.mjs:202` 改成「授权上限 ≤2」。四处定位与「冻结不改、活脚本改」一致。

套件自报（U：本机未重放，也不应重放）：daemon exit 0；usage prompt=40、completion=13；结清 28 microUSD；`source=model-http-transport`；回复 "OK"；模型名 `deepseek-flash`；端点域名 `api.deepseek.com`；超限审计 0。

目录价复算（R，`model-call.mjs:99-104`）：`ceil((40×300000 + 13×1200000) / 1e6) = ceil(27.6) = 28`。与证据一致。这是宿主配置目录价，不是供应商发票、余额或请求 ID。CHARGED_BOUND / 账单校正没有这次调用的外部对账（`model-path-and-pi.md:60` 自己也这样写）。

「无剩余额度」只写在勘误和状态清单里。`model-real/run.mjs` 在缺 key 时 exit 3，**没有**「证据已存在则 exit 4」的守卫。本机 `.env` 若带 key，再跑这条 script 会再打一次付费 API。文书闭合不等于入口拒绝。

证据强度：中等，仅限「实施者套件记录了一次按目录价入账的调用，算术与公式相符」。不足以称为供应商账单已结清。

## 3. B：exit 1 与 postverify 分开；守卫被说重了

原始输出保留为 1 PASS / 2 FAIL（`external-write-real-log.md:7-9`，生成 `2026-11-20T09:03:52.804Z` = 香港 17:03:52.804）。两条 FAIL 的打印还是旧断言口径：`effect_draft_to_ready=0` 被当成失败，对照组 `submitting-audits=1` 被当成失败。现行 `run.mjs:194-202` 与 `240-247` 已改成「`draftToReady === 0` 才通过」和「`bytes_sent === 0` 才通过」。原始 log 没有被改成全绿。postverify log 是另一份文件，3 PASS，生成 `09:06:43.067Z`（`external-write-real-postverify-log.md:3-11`）。两份退出码没有混写。

postverify 证明什么（R，`postverify.mjs:44-77`）：只读打开两个 gitignored scratch 库，按审计码重数行。它不发网络，也不保存当时的 HTTP 正文。本机这两库不存在，实跑退出码 **3**（T）。`received` 链、`bytes_sent`、`external_id` 都无法在本机重导。缺证，不把实施者的 3 PASS 当成我的复验。

即便库在，`bytes_sent: 0` 也是 `effects.mjs:399-402` 对每条 `failed_local` 写入的字段，不是抓包。对照组零字节要靠另一条静态事实：适配器在真实传输前拒绝（既有生产路径，本轮未改）。`effect_draft_to_ready` 只由窄例程 `draftToReady` 写入（`effects.mjs:248-266`）。人工审批链打出 0 行，与源码相符，也只说明库里没有这个码。

固定 `externalId=ext-b-acceptance-001`：`run.mjs:27-29` 写明端点被配置成返回这个 JSON。匹配只证明测试端点契约，不证明 Telegram 发送或仓库写。

用户见证（只核请求头，**未提供 body，本复核不声称核对正文**）：香港 2026-11-20 17:03:51，恰 1 条，217 bytes，请求 ID `81b02edf-5369-4fc0-b559-8509d69964e1`，POST，`application/json`，`x-aegispi-request-kind: submit`，所贴头里没有认证头。与 `upstream-http-child.mjs:15` 只发 `content-type` 和 `x-aegispi-request-kind` 相符（R）。本地报告时刻比见证晚约 1 秒，只能作时间邻近，不能代替正文。

一次性守卫：`run.mjs:67-77` 在 `external-write-real-report.json` 已存在时 exit 4。删掉或换走该文件，同一 script 会再 POST 到仍硬编码的 URL（`run.mjs:63`）。`real-acceptance-run-b.md:30`「第二次提交在结构上不可能」说重了。AT_MOST_ONCE 只约束同一 effect 不重试，不约束新进程。URL「停用」是文书，代码里还在。

## 4. C：次数边界与授权原文

`git diff dd80987..HEAD` 对两份 `ingress-telegram-real-*`：**只有生成时间一行**。旧值 `2026-11-19T15:17:35.018Z`（香港 2026-11-19 23:17:35），入库提交 `dd80987`（2026-11-20 00:37:50 +0800）。新值 `2026-11-20T05:30:02.319Z`。正文、`update_id 500045892`、3 PASS 相同。时间戳是套件写报告的本地时钟，不独立证明网络往返。同一未确认 update 被再读到，与「伪造」和「确实又打了一次」都相容。不认定造假，也不闭项。

T1：D-61 自述 getMe 通过、getUpdates `ECONNRESET`、exit 1，原始 stdout 未留存。按缺失记，不补造。

T2 的 `received_at 2026-11-20T05:30:02.177Z` 只存在于实施者本机 scratch（`telegram-call-ledger-retrospective.md:16,30`）。本机路径 `workspace-state/phase3/ingress-real-update/` **不存在**。缺证。不声称复现。

授权原文（S），按用户口径：**同一 token、开工移交的暗示，不算逐项授权**。

- 开工移交 §2 第 7 项原文是约束：「只对接明确授权的测试源。……但不向真实同事或公开仓库发测试消息。」它要求另有授权，本身没有写 getMe/getUpdates、没有次数、没有日期。追溯文档把这一句加上「Phase 1 同一 token」当作 T0 的授权依据（`telegram-call-ledger-retrospective.md:14,22`）。**按本轮口径，这不成立。**
- D-35、D-47 写「经授权 token」「real（授权 token）3/3」，没有引用主人逐项句子。
- Phase 1 收口的 getMe/getChat 是另一次、另一条 script，不能自动覆盖 11 月 19 日这次 `real.mjs`。
- T2/A/B 的「2026-11-20 书面授权」记录在 D-63 / D-64 与两份执行记录里，授权正文不在仓库。本轮用户明确未再授权新的模型、Telegram、外部 POST。

计数（与追溯 §3 一致，并收紧「可确认」）：

| 口径 | 次数 | 本机能核对的部分 |
| --- | --- | --- |
| 两份成功套件报告各自自称 getMe+getUpdates | 4 | 两份报告，差一行时间；不是 wire log |
| 加上 T1 自述 2 次 | 最少 6 | T1 无原始输出 |
| D-35 与 D-47 若是 T0 之外另一次独立运行 | 可能 8 | 当晚只有一份落盘证据，无法判定 |
| 证据采集之前 | 未知 | 无法排除 |

任何后续 Telegram 调用需要新的逐项书面授权。T0 不能用移交暗示补授权。

## 5. 文档逐项

| 文档 | 核对 |
| --- | --- |
| `phase3-status-and-remaining.md` | A/C 指向 `ec23ef7`，B 指向 `26929a0`，D 写明暂缓且公网不注册、不建隧道。§5 列了本轮未跑的 docker 套件和三条 real 入口。与 diff 一致。§2 把 scratch 库当作复核方可对账的材料；本机没有这些库，该句对云端复核不成立。 |
| `errata-2026-11-20.md` | 勘误 1–4 与冻结文件、活脚本、追加节相符。勘误 2 仍把开工移交 §2.7 写成 T0 授权依据；见上一节，这条依据不采信。 |
| `telegram-call-ledger-retrospective.md` | 最小 6、可能 8、当晚不可判定、禁止补造，这四句与材料边界一致。T2「独立物证」依赖本机没有的 scratch，不能当已复核。 |
| `model-path-and-pi.md` §7 | 缺口 C 改为「一次目录价结清、账单未核对、Pi 未接通」，与证据强度一致。缺口 A/B 从「Phase 5/6」改成「04 没有排期条文，归属待复核」。对照 04 阶段表：Phase 5 是多场景/记忆/多通道，Phase 6 是 RSI/Replay/终态控制台；全文没有把「容器提议模型」或「宿主客户端改用 Pi SDK」排进这两段。原句是推断。更正成立。§1–6 旧句保留，读的人仍会先看到旧归属，以 §7 为准。 |
| `image-transfer-manifest.md` | 三份归档的字节数与 SHA-256 与此前主人给出的记录值同文。本机**没有**这些 tar，未做 `sha256sum`，未 `docker load`。清单自己写「尚未交到审计方」。维持待到件。 |

## 6. D、公网 Host、Phase 4 Observe

主人决定：D 推迟到第一次启用 Telegram 公网 webhook 之前；公网保持关。这不是全部 Phase 4 的统一阻塞。04 Phase 4 入口是「Phase 3 门禁通过，且用户批准一个 repo 和一个主人通知目标」；场景四从 Observe 开始（04 阶段表 Phase 4）。Observe 不要求先打开入站 webhook。

公网 Host 必须改生产代码（R，本轮未改）：

- `apps/daemon/src/console/api.mjs:32` `CONSOLE_BIND = "127.0.0.1"`
- 同文件 `:67-70` `allowedHosts` 只有 ``127.0.0.1:${port}`` 与 ``localhost:${port}``
- 同文件 `:786` `server.listen(port, CONSOLE_BIND, …)`

公网 webhook 的 Host 过不了这张表，进程也不监听公网地址。实施者这句话属实。

出站 Telegram 通知走 `upstream-http` / `im.notify`，不经过入站 webhook 路由。发送仍然要单独授权。B 那一次是 webhook.site 上的内部 JSON，不是 `sendMessage`。

受限 Observe 准入：规范上不被 D 挡住。本轮用户未授权 Phase 4 开工，也未批准 repo 与通知目标。会启动三镜像的执行，等原归档到件后再核。价格与 token 上限未核定之前，Observe 里也不应发真实模型调用。

## 7. 给后续 ADR 的模型链路（不实施）

建议把缺口 A 作为 Phase 4 的第一个实现单元，单独 ADR，不扩大到仓库写、Telegram 发送或公网 webhook。

事实（R / 既有契约）：

- 容器 `docker/agent/src/worker.mjs`：`PI_OFFLINE=1`，`serveCommands` 只接受 `ping`。没有模型提议信封。容器不持有 key。
- 宿主 `model-call-child.mjs:13-15` 对配置 URL 原样 POST `{model, messages}`，读 OpenAI `prompt_tokens` / `completion_tokens`（`model-call.mjs:83-84`）。daemon 不调用 `@earendil-works/pi-coding-agent`。
- Pi 1.5.2 的 `Usage`（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:292-304`）：`input`、`output`、`cacheRead`、`cacheWrite`；`reasoning` 是 `output` 的子集，不是另加一行。`cost.totalFromProvider` 是可选布尔，不是金额（PI-10）。usage 缺失时 Pi 报的零不能当零成本。
- 宿主 `microusdForUsage` 只乘 prompt+completion，没有 cache 价。目录任一侧 null 则返回 null，调用方保持 HELD。超限仍 SETTLED 并冻结（`budget.mjs:318-338`），不是调用前硬拒绝。
- 已定预算：任务 $0.80、日 $5（defaults 800000 / 5000000）。`callUpperMicrousd=1000` 与 null 目录价是占位。下次真实运行前由主人核定实际价和 token 上限。Phase 1 记录价 0.3/1.2 USD/M 只在那次 A 的临时配置里用过，没有写进 defaults。

最小接口：

1. 容器提议只含 `proposalId`、`taskId`、`purpose`（宿主白名单）、`modelId`（宿主白名单，不接受自由 URL）、`maxOutputTokens`、消息或内容哈希。不含 endpoint、不含 key。
2. 宿主先做主体/范围/预算检查，再 `reserve`，再经 **宿主进程里的 Pi 1.5.2 provider** 调用。不并行维护第二套 HTTP 客户端。
3. 结清用 Pi 的 `input/output/cacheRead/cacheWrite`。`reasoning` 已含在 `output`，不另加价、也不漏计。任一 usage 字段缺失或对应目录价为 null：保持 HELD，禁止把 Pi 的零当成免费。
4. 超限行为在 ADR 里写明现行事实（结算后冻结），若要改成调用前拒绝，另作决定。
5. 结果经既有提议通道回到容器。容器仍 `PI_OFFLINE`。

测试要求（本地或夹具，真实调用另授权）：未授权提议零次 provider 调用；reserve 与调用之间杀掉进程则保持 HELD；缺 usage 不结清；cache 价为 null 时不把 cache token 当零；容器镜像内无 key；本单元不打开外部写、不打开公网 bind。

## 8. 安全未决与最小补证

未决：

- A 的 28 microUSD 没有供应商账单。
- A/C 入口没有一次性代码守卫；B 的守卫可被删证据文件绕过，URL 仍在 script 中。
- B 正文未经用户或本复核核对；scratch 库不在本机。
- C 的 T0 授权依据不足；T1 无原始输出；T2 与 T0 只差时间戳；scratch 缺证。次数停在「最少 6，可能 8，更早未知」。
- 公网 Host 硬编码仍在，D 保持关。这是未改代码的现状，不是漏洞修复。
- 原镜像未到件。`image-transfer-manifest.md` 里的 SHA 是实施者复述，本机未复算。

最小补证（到件后由实施方归档，本复核不补造）：

1. 三份原 tar 的无密钥归档。接收后只做 sha256、manifest/config blob、`os=linux`/`amd64`。不把同 context 重建当作原件。
2. 若要独立闭合 T2：只读交出 `ingress-real-update` 的库，或一份不含 token 的 wire 记录。没有则维持缺证。
3. T1 原始 stdout 若实施者机器上已不存在，保持缺失，不要重跑。
4. B 的 body 用户未提供，就不宣称已核。不要为补证把载荷或 URL 再贴进新渠道。
5. 供应商账单或余额截屏只在主人要做 CHARGED_BOUND 时提供；没有它，A 就保持「目录价入账」。
6. 下次真实模型运行前，书面核定目录价、单次 token 上限、`callUpperMicrousd`。在那之前 defaults 保持 null / 1000 占位。

## 9. 本机证据与归档路径

- 本机退出码：`docs/phase3/audits/evidence/rereview-33d6361-exits.txt`（postverify 3，security-unit 0）。
- 预定入库路径：`docs/phase3/audits/AUDIT-PHASE3-REREVIEW-33d6361.md`。
- 副本：`/opt/cursor/artifacts/AUDIT-PHASE3-REREVIEW-33d6361.md`。
- 本地分支：`cursor/phase3-confirm-33d6361-ef3e`（自 `33d6361` 新建，无 upstream）。未 push。未开 PR。既有审计分支未改。
- 原镜像：待到件。本报告不结案。到件后另写续审，不覆盖本文件。
