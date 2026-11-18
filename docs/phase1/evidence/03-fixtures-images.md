# 证据 · 03 夹具与镜像（任务 5/6 汇总指针）

单项证据分散在各报告，此处给审计者一条快速路径（详细数值都在对应文件里）：

| 任务 | 证据文件 | 关键实测值 |
| --- | --- | --- |
| 基础镜像 digest | docs/phase1/reports/image-digest.md | node:22.23.5-bookworm-slim @ sha256:e9f565d3…（docker image inspect RepoDigest） |
| 模型绑定 | docs/phase1/reports/model-binding.md | deepseek/deepseek-flash + thinking high；目录文件路径与价目 |
| hono oracle/manifest | evals/contracts/fixtures/hono-triage/ | oracleId oracles/hono-csrf-textping-bypass-v1；baseline v4.13.19 commit 676c8f80…；target v4.12.24 commit 5fdde5ab…；A1 实测 exit 0（403 拒绝） |
| 事件窗口 | …/hono-triage/events.json | 65 候选 = 45 稳定 release + 20 GHSA（2026-05-18 起，gh api 只读拉取） |
| 标注提案 | …/hono-triage/hono-triage.labels.local.json | 本地不入库（git check-ignore 实证）；PROPOSAL 状态待用户确认 |
| 预算默认 | apps/daemon/config/defaults.json | 800000 microUSD/25 步/900 秒；日 5000000；cacheWarming off；容器占位配额 |
| 驱动选择 | docs/phase1/reports/sqlite-driver.md | node:sqlite 3.54.1 全门禁 PASS |

hono tag 的 commit/tarball 复算命令（审计者可直接重跑）：

```
gh api repos/honojs/hono/git/ref/tags/v4.13.19 --jq .object.sha   # tag 对象
gh api repos/honojs/hono/git/tags/<tag-sha> --jq .object.sha      # commit
Invoke-WebRequest https://codeload.github.com/honojs/hono/tar.gz/refs/tags/v4.13.19 -OutFile t.gz
(Get-FileHash t.gz -Algorithm SHA256).Hash.ToLower()               # tarball sha256
```
