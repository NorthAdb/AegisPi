# Phase 3 收口确认（3cd0652）

预定入库路径：`docs/phase3/audits/AUDIT-PHASE3-REREVIEW-3cd0652.md`。可交付副本：`/opt/cursor/artifacts/AUDIT-PHASE3-REREVIEW-3cd0652.md`。本文件只在本地审计分支，未推送。落笔前再次 fetch，`origin/main` 仍是 `3cd065247c6f9b52c622308ca216730cc50c879d`。

标记：已测事实（T）、静态判断（R）、未验收（U）。没有改产品代码，没有调用 Telegram，没有付费模型，没有真实平台外发，没有执行四项验收计划。

## 结论

本轮五项收口成立，附带下面写明的限度。Phase 3 出口仍是 **MET WITH RESIDUAL RISKS**。常开：否。Phase 4：否。四项真实验收保持未授权；计划可以提交给主人看，但按原文直接执行会在端点形态和次数上限上越出当前代码与已发生的事故。

`3cd0652` 是 `11d649a` 之上的一个提交。`apps/`、`docker/`、`package.json`、`package-lock.json`、`tools/` 与 `11d649a` 逐字节相同（T）。生产调度、授权和预算代码没有改。改动在测试、`real.mjs` 的文案分支，以及文档。

## 环境

锁定 Node v22.23.5，官方包 `node-v22.23.5-linux-x64.tar.xz` 对照 SHASUMS256 为 OK。Docker 29.1.3。工作树 `/tmp/aegis-3cd0652`，detached 在该提交。无 `.env`，环境里无 Telegram / API token。

上一轮报告归档 SHA-256 `05aa99580c594a184a2c9c36c5e2ea022018427988b0f427bb099940648d3a0b`，与本机 artifact 和仓库文件一致；git blob `982902c6…` 与本地提交 `9d39702` 的同一路径相同（T）。

## 1. 时序

修法在 `evals/phase3/security-unit/run.mjs`：`decideApproval` 的 `now` 从播种时刻加 100ms 改为播种时刻，另留 `decideAt`。生产代码里，审批把 `next_attempt_at` 写成决策时刻，dispatcher 在 `next_attempt_at > now` 时拒绝（`effects.mjs` 第 312 行）。「T 批准即 T 到期、到期前 1ms 拒绝、到期即可以提交」是现有比较，不是把到期条件放宽（R）。本提交没有改这行。

本机 `test:security:unit` exit 0，**43 pass / 0 fail**（T）：

- 授权生产 tick：`SUCCEEDED`，本地服务看到提交。
- 未授权生产 tick：`FAILED`，零字节，`adapter_refused`。
- 决策钉在未来 60 秒、配置为授权：效果保持 `READY`，到期还剩约 59909ms，零 `effect_submitting`，零字节。
- dispatcher 受控时钟：到期前 1ms 拒绝且行仍是 READY；到期时刻 `SUCCEEDED`，fake 传输 deliveries=1。

后一条用的是 fake 传输，钉的是到期门，不是 HTTP 适配器。授权与零字节仍由前两条生产 tick 覆盖。播种时刻即到期的用例不再靠 sleep；未到期不派发由单独的未来到期点用例保住，本机实测仍能拦住。

## 2. 原镜像归档

`docs/phase3/reports/image-delivery.md` 里的三枚归档 SHA-256 与用户交付的数字一致（大小写不计），字节数也一致（T，对照的是文档，不是文件）：

| 归档 | 字节 | SHA-256 |
| --- | --- | --- |
| agent `1bed0ab1663f…` | 105477120 | `a569d4557a4edb7644f3cb93568155e81d9c1e2efee29177b9c6ccb808aed42c` |
| acquisition `3c5b4dba28b5…` | 79900160 | `723a03953dde4ad1283519310a9795c34e4fc80e8a660df1ffd25044e950487b` |
| execution `202dfcd4fca2…` | 112399360 | `1661868dc22a3adada29a2f2c5af722d4d2ea24da730e97597e33edf27a2b111` |

这些 tar 不在本环境。没有做 `sha256sum`，没有 `docker load`（U）。本机 registry 对三枚机器块 manifest 仍是 HTTP 404，image-gate exit 2，失败点是 registry，不是 context（T）。

终树 context 与机器块匹配（T）：agent `0eee2b6f…`、acquisition `8abae275…`、execution `8183df14…`。`3cd0652` 没有改构建输入，这三枚 digest 与 `11d649a` 的机器块相同。文件名里的 `5250243` 是构建时 HEAD，不是另一套 context。

校验步骤里，归档 SHA-256 加上解包后 `blobs/sha256/<manifest>` 的哈希等于文件名、再对 config blob 看 `linux/amd64`，足够让拿到文件的人核对「这份 tar 里有机器块指名的 manifest 和 config」。它不证明层内容来自 context 哈希；那一步要 load 进 registry 后再跑 image-gate。文档后半的复跑命令把同一 tag `docker tag` 到自己身上，若 `docker load` 没有恢复 `phase3-52502432d21f` 这个标签，push 不会发生。自证哈希步骤成立，套件复跑配方依赖标签被 load 保留（R）。

实施者写入的 offline 14/14、integration 29/29、quota 5/5 是他们机器上的证据刷新（日志时间 2026-11-20T04:55:42Z 起）。本侧没有执行那三枚原镜像，也不把缺归档重开成 context 漂移。上轮同 context 的本机重建（agent `f5977991…`、acquisition `7bbf414d…`、execution `ee512211…`）描述的是同一份构建输入；本轮没有再重建。

## 3. 人读行与 simulate 文案

`image-digest.md` 已改成两纪元：构建当时 HEAD 是 `5250243`，字节是当时工作树里已有的 `f413046` 的 `daemon.mjs` / `config.mjs`。git 时间与此相符（T）：`5250243` 为 2026-11-20 11:00:11 +0800，`f413046` 为 11:16:06 +0800，文档中的构建时刻 11:07:49 落在两者之间。机器块 context 等于含 `f413046` 源码的树。`11d649a` 与 `3cd0652` 都不改这份构建输入。

`--simulate-no-token` 先读 `.env` 再分支。本机没有 `.env`：该入口 exit 3，文案是「本机 .env 本就未配置 TELEGRAM_BOT_TOKEN」（T）。无旗标 real 入口同样 exit 3，文案承认未配置，且在读到 token 之前返回，没有出网（T）。有 token 机器上的另一句文案本机无法走到（U）。

## 4. 模型路径文档

`docs/phase3/reports/model-path-and-pi.md` 与代码一致（R）：宿主路径是授权、预留、固定 URL、按目录结清或 HELD；daemon 不 import Pi SDK；容器 `PI_OFFLINE=1`。文档把缺口 A（容器向宿主提议模型调用未接）、缺口 B（宿主不是 Pi SDK provider）、缺口 C（真实 provider 未调用）写成未完成，并写明容器自检绿不是端到端。没有把这三项标成已交付。02 §4 表里它标成「已实现」的是宿主侧四条义务，提议侧单独放在缺口 A。这个分法与上轮判定相符。

## 5. 四项计划（未执行）

计划写明逐项授权前不执行，Phase 4 不在计划内。范围和回滚大体分得开。按原文授权执行之前，有三处要改口径：

- **A 真实模型。** `callModelOnce` 把 `{model, messages}` POST 到配置的 URL 本身（R，`model-call-child.mjs`）。计划把端点写成 `https://api.deepseek.com`，模型写成 Pi 目录 ID `deepseek/deepseek-flash`。当前客户端不会自动补 `/chat/completions`，也不会把 Pi ID 翻译成供应商的模型名。另外 `budget.mjs` 在实际金额大于预留上限时仍然 `SETTLED`，并记一笔超限告警；`$0.01` 与 `callUpperMicrousd=1000` 不是代码里的硬拒绝。授权前应写上完整 URL、供应商模型名，并说明超限时代码会入账而不是自动停。
- **B 真实外部写。** 现有 HTTP 传输提交的是内部 JSON（`kind` / `businessKey` / `operation`），不是 GitHub PR 请求（R）。计划里的「草稿 PR」读起来像仓库写，那是 Phase 4。若要授权，动作应限定为向主人指定的可丢弃 HTTP 端点 POST 一次这份内部载荷，次数 1，`allowRealExternalWrites` 随后回到 false。
- **C Telegram 只读。** 次数、零费用、无 send、无 offset 写清楚。见下节：事故已经打过 getMe 和一次失败的 getUpdates。计划写「授权后仍按上表全量再跑一次」，会把事故叠加在 ≤4 次之外。
- **D 公网 webhook。** setWebhook / deleteWebhook 各一次、绑定从 `127.0.0.1` 放开、测完 deleteWebhook 并绑回，范围是 Phase 3 的入口验收，也是四项里唯一改变监听面的一项。回滚依赖 deleteWebhook 成功。应在同一次操作里完成注册和摘除，不要留着隧道。

本审计不开始其中任何一项。

## 6. Telegram 事故

叙述在 D-61、回应报告、验收计划 C 项和 `.audit/phase3-closure-11d649a.todo.md` 中一致：无旗标 `test:ingress-telegram:real` 被误跑一次，getMe 通过，getUpdates `ECONNRESET`，exit 1，无 sendMessage，无 offset 确认，零费用，token 未写入仓库（R，只核对这些文字）。

`docs/phase3/evidence/ingress-telegram-real-log.md` 与 `ingress-telegram-real-report.json` 相对 `11d649a` 字节相同（T）。仓库里没有这次 ECONNRESET 的原始输出；留下的 real 证据仍是更早一次成功记录（`@aegispibot`，simulate-no-token=false）。「已还原为提交版」与 diff 为空相符。事故细节不能用仓库字节复核，只能当作实施者申报。

无旗标入口在有 token 时会调用 `getMe` 和 `getUpdates`，源码里没有 `sendMessage`（R）。这次越过了本轮「不复验 Telegram」的边界。建议计入 C 项上限：getMe 1 次加 getUpdates 尝试 1 次，已用 2 次；若主人维持 ≤4，授权后的复跑只剩 2 次额度，而不是在事故之外再给满 4 次。本轮没有为核实它再去调用 Telegram。

## 出口

| 问题 | 判定 |
| --- | --- |
| 时序收口 | 成立。生产语义未改；本机 43/43，含未到期零派发和到期前 1ms 拒绝 |
| 原镜像可交付 | 文档与所报 SHA 一致；档案不在本机，原镜像未在本侧执行。context 仍匹配，不重开 F1 |
| 人读行与 simulate | 成立。两纪元与 git 时间一致；无 token 机器不再声称 token 存在 |
| 模型 / Pi 文档 | 成立。缺口 A/B/C 保持开放 |
| 四项计划 | 已提交、未执行。A/B 的端点形态和 C 的次数要先改口径 |
| 事故 | 越界一次只读。叙述一致，原始输出不在仓库。建议计入 ≤4 |
| Phase 3 出口 | 仍是 MET WITH RESIDUAL RISKS |
| 常开 / Phase 4 | 否 / 否 |

普通残留与上轮相同：备份明文、同主机换端口重定向、哈希后复制、4 GiB 未写满、PID 复用、stdout 微秒竞态、真实账单与真实平台写未做。

## 证据

- `docs/phase3/audits/evidence/rereview-3cd0652-exits.txt`
- 本机原始输出在 `/tmp/aegis-audit-3cd0652/`（security-unit、simulate、real、gate、cancel、budget、durability、contracts）。套件改写过的 `docs/**/evidence` 已按被审提交还原。
