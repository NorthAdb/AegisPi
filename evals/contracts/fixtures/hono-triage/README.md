# honojs/hono triage fixture (Phase 1 task 6)

监控对象 `honojs/hono`（本仓库 daemon 的 HTTP 宿主框架，锁定 exact 4.13.19，见 `apps/daemon/package.json`）。本目录是 Phase 1 的 oracle 与 environment manifest 夹具，全部数值为实测，无占位。

## 文件

- `events.json`：候选事件窗口 **[2026-05-18, 2026-11-18)（端点排他）**，45 个稳定 release + 30 条 GHSA，共 **75 个候选**。来源为 GitHub REST API 只读全量拉取（`gh api "repos/honojs/hono/security-advisories?per_page=100"`，61 条全量 + `/releases`）。生成脚本 `evals/contracts/tools/build-hono-events.mjs`（对 release 与 advisory 都做窗口过滤）。
- `oracle.hono-triage.json` + `manifest.hono-triage.json`：**csrf() text/ping hyperlink auditing 绕过**（GHSA-46wx-v44x-9hh2，<4.13.16）。A1/A2 均已在锁定 Node 22.23.5 实测：baseline 4.13.19 → 403/exit 0；target 4.12.24 → 200 放行/exit 1。
- `oracle.hono-cors.json` + `manifest.hono-cors.json`：**CORS 凭据反射**（GHSA-88fw-hqm2-52qc / CVE-2026-54290，**high**，<4.12.25）。A1/A2 均已实测：baseline 4.13.19 → `acao:"*"` 不反射/exit 0；target 4.12.24 → `acao:"https://attacker.example"` 反射/exit 1。源码级根因：4.12.24 在默认 `origin:"*"` + credentials 下 `findAllowOrigin` 返回 `(origin) => origin || null`。
- `checks/csrf-textping-check.mjs`（fixtureHash sha256 4e89f269…）与 `checks/cors-credential-check.mjs`（sha256 e1a328e1…）。
- manifest 的快照值：baseline = v4.13.19（commit 676c8f80…，tarball sha256 e1a19a8a…，隔离安装 lockfile sha256 e5d0c57e…）；target = v4.12.24（commit 5fdde5ab…，tarball sha256 4ce62f3e…，隔离安装 lockfile sha256 db2bb134…，npm integrity `sha512-I36D1s…U4iw==` 与 registry 一致）。两对 manifest 共用同一快照对。

## 复现方式（重要，2026-11-19 第二轮复审后更新）

每个快照的 `package.json` + `package-lock.json` 已**字节原样入库**于 `snapshots/hono-<version>/`——lockfileHash 可直接复算（SHA-256 与 manifest 一致），`npm ci` 即按 lock 复现安装。检查脚本以**安装目录为显式参数**解析 hono（`createRequire`，与 cwd、脚本位置完全无关）：

```
node checks/csrf-textping-check.mjs <安装目录>   # 从任何位置跑，hono 都从该目录加载
node checks/cors-credential-check.mjs <安装目录>
```

在仓库目录对 4.12.24 目标跑必须得到 exit 1（实测在案）；旧的"复制脚本进快照目录"法仍兼容（无参数时按脚本所在目录解析）。一键自检：

```
node evals/contracts/tools/verify-hono-oracle-pair.mjs
→ 从入库快照 npm ci 两套安装 → 四项检查 → 断言 0/1 矩阵 + 解析来源 + 复算两个 lockfile 哈希
```

第二轮复审 N4 的教训在案：第一版检查头注释写"cwd must resolve hono"与实际相反（ESM 按脚本位置解析），照做会在仓库里命中 4.13.19 得到 target 假绿——已删除该注释并改为显式参数解析，输出含 `honoFrom` 自证解析来源。

## 与开工检查单的差异记录（2026-11-19 修正）

1. 检查单写“10 条 GHSA，High 一条（GHSA-88fw CORS 凭据反射，<4.12.25）”。**第一版夹具错误地声称 GHSA-88fw 不存在**——原因是初版拉取用了 `per_page=20`，GitHub API 默认分页把列表截断在最近 20 条，而 GHSA-88fw 发布于 2026-06-09、恰好排在截断点之外。用 `per_page=100` 全量拉取后：61 条 advisory 总量、窗口内 30 条，**GHSA-88fw-hqm2-52qc 实存**（high，CVE-2026-54290，2026-06-09，<4.12.25，CORS 中间件在默认通配 origin + credentials 下反射任意 Origin）。**检查单的记忆是对的，本夹具第一版的“纠错”才是错的**。教训已入决策表 D-09：分页截断是数据完整性失败模式，任何“列表里没有 X”的结论必须先证明拉取是全量的。
2. 检查单预估窗口约 47 个候选事件；实测 **75 个**（45 稳定 release + 30 advisory，窗口 [2026-05-18, 2026-11-18)）。
3. 两对 oracle 的 A2（target 4.12.24 表现出漏洞行为）不再是“Phase 4 才测的约定”，已在锁定 Node 上隔离实测成立（exit 1）。Phase 4 的 security_repro job 仍待容器化执行，但命题的方向性证据已闭合。

## 标注状态

`hono-triage.labels.local.json` 是标注提案（正/负/未知三类），**只留本地不入库**（labels 属于主人私密判断，.gitignore 已排除）。GHSA-88fw 已按 High 锚点补入提案（unaffected，4.13.19 > 4.12.25）。待用户三项准备齐（通知渠道、基线三句话）后确认或修正全部 75 个候选的标注。
