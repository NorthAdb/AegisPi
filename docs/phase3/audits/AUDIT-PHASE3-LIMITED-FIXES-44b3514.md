# 限定修复验收：44b3514

目标：`origin/main` = `44b35141815bc890873f861ec34590654559faf9`（结论前再次 fetch，仍是该 SHA）。两提交：`848eba6d539fccff49a3cffae30c6394d3f82584`、`44b3514`。对照 `3f30b029d1410e925729234f8cb4e4c372e29ac8` 与 `33d6361`。

本轮只验收两项。未改产品，未跑镜像，未跑 real（含 simulate），未读 `.env`。A 账单、B 正文、C 历史网络事实保持既有残留，不追加补证。原镜像行为按主人「本机通过即闭项」采信实施者日志。

## 判定

| 项 | 结果 |
| --- | --- |
| 1. offline-jobs daemon case 10/11 加固 | **通过** |
| 2. `--only` 选择性构建与纪元 2 绑定 | **通过** |
| 本轮限定修复 | **关闭**。无 P0/P1 实证回归。 |
| 常开 / Phase 4 开工 / 真实运行 | 本验收不发放。模型链路 ADR 与受限 Phase 4 开工书可以写。 |

`git diff 33d6361..44b3514 -- apps docker package.json package-lock.json apps/daemon/config/defaults.json` 为空。defaults blob 仍是 `23d9f66d8856ba89c47fa653ce48bc83bf279d49`。`image-gate.mjs` / `image-bind.mjs` 无改动。

## 1. daemon 用例：通过

`evals/phase3/offline-jobs/run.mjs`：`saveDaemonScene` 在读 `stdout.txt` 之前写入 argv、cwd、node、exit、spawn-error、stdout、stderr。`stdout.txt` 缺失时置 `null`，检查失败并带 stderr 首行与 scene 路径。`suite.check` 只记 FAIL（`harness.mjs:33-38`），不抛。断言仍是 daemon exit 0、job SUCCEEDED/0、无残留容器、stdout 含 `daemon tick job`、输出含 `-> SUCCEEDED`。case 11 同样先落 scene，exit 须为 5 且 job 保持 QUEUED。

红证据 `daemon-repro-hardened-suite-11d649a.txt`：`12 pass, 2 fail, 14 judged`。两条 FAIL 是 daemon exit=1、job=QUEUED、`job-stdout-seen=false`，随后三条 PASS 仍跑完。scene 文件保留根错误：`ERR_MODULE_NOT_FOUND` … `Cannot find package 'hono'`（`daemon-repro-scene-tick-11d649a.txt:13`，diskwarn 同文）。探针 `daemon-repro-probe-11d649a.txt` 是同一条 import 错误。这是无 `node_modules` 的诚实失败，不是生产阻塞。装齐 lockfile 依赖是运行前置。

绿证据 `accept-epoch2-offline-jobs.txt`：`14 pass, 0 fail, 14 judged`。daemon 行：exit=0、SUCCEEDED/0、scene 已写。disk-warn：exit=5、QUEUED、warn-line=true。`suiteExit` 在 fail=0 且 judged>0 时返回 0（`harness.mjs:55-61`），`run.mjs:811` 以此退出。日志里没有再贴一层 shell `$?`。

旧失败件 `imgverify-11d649a-*` 相对 `3f30b029` diff 为空。

## 2. `--only` 与纪元 2：通过

交付日志 `build-epoch2-agent-log.txt`：先 carrying acquisition、carrying execution，再 building agent，tag `phase3-848eba6d539f`。manifest `b136e04d…22c0`，config `cbd20576…684c`，context `72ed2cae…04bf`，smoke `self-check: green (pi 1.5.2)`。push 目标只有 `127.0.0.1:5000/aegispi/agent`。基础镜像行是 `load metadata` / `resolve` 已固定 digest，无 `Pulling`。`npm ci --omit=dev --ignore-scripts` 在镜像内取了 lockfile 依赖（构建日志有 npm notice）。这是构建供应链，与业务 API 分开记，不构成新阻塞。

`image-digest.md` 只有一个 `app-image-digests v2` 块。现行表与机器块一致。acquisition/execution 的 manifest、config、context、tag `phase3-52502432d21f` 与纪元 1 历史表相同。纪元 1 表与附注留在机器块之后，没有第二个 v2 块。

本机在 **44b3514 终树**重算 context（只读 `image-bind.mjs`，未构建）：

- agent `sha256:72ed2caef518a3eee4c21899a478dc61bd73d9c0b3a40a2e39f7d834635104bf`
- acquisition `sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012`
- execution `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab`

与现行机器块逐位一致。`848eba6..44b3514` 只改文档与证据，context 输入未变。

参数解析（本机对 argv 切片，未启动构建）：无 `--only` 或裸 `--only` 重建三张；`--only=agent` 只重建 agent、携带其余两张；未知名进入 `die`。`--only=` 会解析成空集合并走向携带分支，交付日志没有走它。携带仍要求 context 复算相等且本地 registry 复解析（`build-app-images.mjs` carry 循环），绑定字段未删。空旗标未在交付中发生，不升格为不通过。

终树套件打印：security-integration `29 pass, 0 fail, 29 judged`（内嵌 offline-jobs exit=0）；quota-calibration `5 pass, 0 fail, 5 judged`（CPU ratio 2.33）。同样由 `suiteExit` 得退出码 0。本机未重跑这三套镜像套件。

## 证据限制

- 镜像行为与 registry 复解析来自实施者日志，本机未 load、未重建、未 pull、未 push。
- 三套件退出码由「0 fail 打印 + `suiteExit` 返回 0」得出，日志未另存 shell `$?`。
- 无 `node_modules` 的 hono 失败已由 scene 解释。本机这次重算 context 只用 Node 内置模块，没有 `npm ci`。依赖安装仍是跑 daemon 的前置，不是新未决项。

## 下一步（不实施，不授权真实运行）

模型链路 ADR 与受限 Phase 4 开工书可以推进。开工书不得包含真实模型、Telegram、外部 POST 或公网 webhook 的授权。ADR 验收要点：

1. 宿主复用 Pi 1.5.2 provider，不另写平行 HTTP 客户端。
2. 容器只提议：`purpose` 与 `modelId` 走宿主白名单；无 key，无自由 URL；容器保持 `PI_OFFLINE`。
3. 先 reserve 再调用。结清用 Pi 的 input/output/cacheRead/cacheWrite。`reasoning` 已含在 output 中。缺 usage 或对应目录价为 null 则保持 HELD，禁止把零当成免费。
4. 任务 $0.80、日 $5 已在 defaults。实际目录价与 token 上限在任何真实调用前由主人核定。
5. 本单元不打开外部写，不改 `CONSOLE_BIND`。

## 归档

预定路径：`docs/phase3/audits/AUDIT-PHASE3-LIMITED-FIXES-44b3514.md`。副本：`/opt/cursor/artifacts/AUDIT-PHASE3-LIMITED-FIXES-44b3514.md`。本地分支不 push，不新开、不更新、不合并 PR。由实施方归档。
