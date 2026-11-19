# Phase 1 开工检查单执行状态

来源：`D:\AegisPi\phase1-kickoff-checklist.md` 的「开工顺序」，步骤原文保留，逐步附实际证据与产物路径。skip 行必须带理由。

- [x] 0. 本地初始化 `D:\AegisPi\aegis-pi`，wire origin，推送首个提交证实写入链路。证据：docs/phase1/evidence/00-repo-init.md（root-commit 5afc3c9，push 成功）。
- [x] 1. 落地 Node 22.23.5 并记录版本与来源 SHA。证据：docs/phase1/evidence/01-node-lock.md（v22.23.5 / SQLite 3.54.1 / npm 10.9.9 / SHA256 4a191082…；开工日复核 latest-v22.x 无补丁，锁定不变）。
- [x] 2. 隔离目录安装 pi-coding-agent exact 1.5.2，生成真实 lockfile，记录完整性字段。证据：docs/phase1/evidence/02-pi-install.md（integrity sha512-mUWI04…，engines >=22.19.0；hono 4.13.19 exact 一并锁定）。
- [x] 3. PI-01 至 PI-13 逐项探针。证据：docs/phase1/evidence/contracts-report.json（15/15 PASS）+ docs/phase1/reports/PI-contract-report.md（逐项结论、RPC LF 分帧夹具实测、扩展 UI 三偏差、readline 双版本复测）。
- [x] 4. node:sqlite 在 22.23.5 上测 FTS5/trigram，出驱动选择报告。证据：docs/phase1/reports/sqlite-driver.md（选内置 node:sqlite 3.54.1）。
- [x] 5. 拉取 Node 22.23.5 官方基础镜像，记录真实 digest 与 Dockerfile 构建上下文。证据：docs/phase1/reports/image-digest.md（RepoDigest=OCI index sha256:e9f565d3… + amd64 清单 digest sha256:47725aca… 记录及复核状态；三个 Dockerfile 入库；应用镜像首次构建时回填 digest）。
- [x] 6a. 用 honojs/hono 真实 release/advisory 样本写 oracle 与 environment manifest 夹具。证据：evals/contracts/fixtures/hono-triage/（**两对 oracle**：csrf text/ping + CORS 凭据反射；A1/A2 均在锁定 Node 隔离快照实测：4.13.19 → 403/不反射 exit 0，4.12.24 → 放行/反射 exit 1；events.json 75 候选=45 release+30 advisory，全量 per_page=100 拉取并窗口过滤）。
- [x] 6b. **标注集经用户确认**。证据：owner 复核确认（2026-11-19，本地 owner-baseline.local.md §3 记录：12 条 uncertain 对照官方发行说明复核后全部转「可忽略」，终态 该关注 39 / 可忽略 36 / uncertain 0）；labels 文件实测与该记录逐项一致（本地 gitignored）；第四轮外部审计的收口条件「owner 自己确认标注」至此满足。1→4 轮审计判定链见 docs/phase1/reports/audit-history.md。
- [x] 7. 任何契约不成立，按 ADR 模板报批后改适配与文档，不编造方法名。证据：PI-contract-report.md「ADR 状态」节——零 ADR（发现的偏差均属宿主适配细节，不触报批线，实测事实已入 findings）。2026-11-19 第一轮审计整改后维持零 ADR（route 双路径、字面量断言、GHSA-88fw 数据修正均未改安全边界，见 audit-response.md）。
- [x] 8. 自审 + 移交审计报告。证据：docs/phase1/AUDIT-HANDOFF.md；四轮外部审计史与逐轮映射：docs/phase1/reports/audit-history.md（轮 1 audit-response.md / 轮 2 re-review-response.md / 轮 3 audit-e7b93b7-response.md / 轮 4 原稿归档 docs/phase1/audits/，判定**技术整改通过**）。**Phase 1 于 2026-11-19 按 owner 授权收口**：收口声明 docs/phase1/reports/phase1-closure.md（出口门禁逐项对照 + 最小验收实测全绿 + 如实边界）；DeepSeek 最小推理与 Telegram getMe/getChat 均实测通过（evidence/07）；75 条标注 owner 确认（6b 勾选）。Phase 2 未开工，入口条件见收口声明第 5 节。
