# Phase 1 开工检查单执行状态

来源：`D:\AegisPi\phase1-kickoff-checklist.md` 的「开工顺序」，步骤原文保留，逐步附实际证据与产物路径。skip 行必须带理由。

- [x] 0. 本地初始化 `D:\AegisPi\aegis-pi`，wire origin，推送首个提交证实写入链路。证据：docs/phase1/evidence/00-repo-init.md（root-commit 5afc3c9，push 成功）。
- [x] 1. 落地 Node 22.23.5 并记录版本与来源 SHA。证据：docs/phase1/evidence/01-node-lock.md（v22.23.5 / SQLite 3.54.1 / npm 10.9.9 / SHA256 4a191082…；开工日复核 latest-v22.x 无补丁，锁定不变）。
- [x] 2. 隔离目录安装 pi-coding-agent exact 1.5.2，生成真实 lockfile，记录完整性字段。证据：docs/phase1/evidence/02-pi-install.md（integrity sha512-mUWI04…，engines >=22.19.0；hono 4.13.19 exact 一并锁定）。
- [x] 3. PI-01 至 PI-13 逐项探针。证据：docs/phase1/evidence/contracts-report.json（15/15 PASS）+ docs/phase1/reports/PI-contract-report.md（逐项结论、RPC LF 分帧夹具实测、扩展 UI 三偏差、readline 双版本复测）。
- [x] 4. node:sqlite 在 22.23.5 上测 FTS5/trigram，出驱动选择报告。证据：docs/phase1/reports/sqlite-driver.md（选内置 node:sqlite 3.54.1）。
- [x] 5. 拉取 Node 22.23.5 官方基础镜像，记录真实 digest 与 Dockerfile 构建上下文。证据：docs/phase1/reports/image-digest.md（RepoDigest sha256:e9f565d3…；三个 Dockerfile 入库；应用镜像首次构建时回填 digest）。
- [x] 6. 用 honojs/hono 真实 release/advisory 样本写 oracle 与 environment manifest 夹具，标注集经用户确认。证据：evals/contracts/fixtures/hono-triage/（oracle/manifest/events/检查脚本，全部实测值）；标注提案 hono-triage.labels.local.json 留本地，**待用户确认**（准备项未齐，见 open-items）。
- [x] 7. 任何契约不成立，按 ADR 模板报批后改适配与文档，不编造方法名。证据：PI-contract-report.md「ADR 状态」节——零 ADR（发现的偏差均属宿主适配细节，不触报批线，实测事实已入 findings）。
- [x] 8. 自审 + 移交审计报告。证据：docs/phase1/AUDIT-HANDOFF.md。
