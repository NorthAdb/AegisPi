# 证据 · 03 夹具与镜像（任务 5/6 汇总指针，2026-11-19 修订）

单项证据分散在各报告，此处给审计者一条快速路径（详细数值都在对应文件里）：

| 任务 | 证据文件 | 关键实测值 |
| --- | --- | --- |
| 基础镜像 digest | docs/phase1/reports/image-digest.md | node:22.23.5-bookworm-slim @ RepoDigest（OCI index）sha256:e9f565d3…；amd64 清单 digest sha256:47725aca…（审计核验值，本地复验待网络） |
| 模型绑定 | docs/phase1/reports/model-binding.md | deepseek/deepseek-flash + thinking high；目录文件路径与价目；真实推理契约未验证（用户侧收口项） |
| hono oracle/manifest（两对） | evals/contracts/fixtures/hono-triage/ | ① oracles/hono-csrf-textping-bypass-v1（GHSA-46wx，<4.13.16）；② oracles/hono-cors-credential-reflection-v1（GHSA-88fw，high，<4.12.25）。快照对：baseline v4.13.19（commit 676c8f80…，tarball e1a19a8a…，隔离 lock sha256 e5d0c57e…）/ target v4.12.24（commit 5fdde5ab…，tarball 4ce62f3e…，隔离 lock sha256 db2bb134…，integrity sha512-I36D1s…U4iw== 与 registry 一致）。**A1/A2 均实测**：4.13.19 → 403 / 不反射（exit 0）；4.12.24 → csrf 放行 / CORS 反射 attacker origin（exit 1） |
| 事件窗口 | …/hono-triage/events.json | 75 候选 = 45 稳定 release + 30 GHSA（[2026-05-18, 2026-11-18) 端点排他；advisory 全量 per_page=100 共 61 条后过滤；severity: 27 medium/1 high/2 low，含 GHSA-88fw） |
| 标注提案 | …/hono-triage/hono-triage.labels.local.json | 本地不入库（git check-ignore 实证）；PROPOSAL 状态待用户确认；含检查单 High 锚点 GHSA-88fw |
| 预算默认 | apps/daemon/config/defaults.json | 800000 microUSD/25 步/900 秒；日 5000000；cacheWarming off；容器占位配额 |
| 驱动选择 | docs/phase1/reports/sqlite-driver.md | node:sqlite 3.54.1 全门禁 PASS（非 FTS 表恰 27、synchronous=FULL 断言） |

复现检查的**正确姿势**（第二轮复审后）：检查脚本以安装目录为显式参数（`node checks/<x>.mjs <安装目录>`，createRequire 从该目录加载 hono，与 cwd/脚本位置无关）；快照的 `package.json` + `package-lock.json` 已入库（`snapshots/hono-4.13.19/`、`snapshots/hono-4.12.24/`），lockfileHash 可直接复算、`npm ci` 可复现安装。一键配对自检：`node evals/contracts/tools/verify-hono-oracle-pair.mjs`（断言 0/1 矩阵 + 解析来源 + 哈希复算，实测全 OK 退出码 0）。

hono tag 的 commit/tarball 复算命令（审计者可直接重跑）：

```
gh api repos/honojs/hono/git/ref/tags/v4.13.19 --jq .object.sha   # tag 对象
gh api repos/honojs/hono/git/tags/<tag-sha> --jq .object.sha      # commit
Invoke-WebRequest https://codeload.github.com/honojs/hono/tar.gz/refs/tags/v4.13.19 -OutFile t.gz
(Get-FileHash t.gz -Algorithm SHA256).Hash.ToLower()               # tarball sha256
& D:\AegisPi\tools\node-v22.23.5\npm.cmd view hono@4.12.24 dist.integrity   # registry integrity
```
