# Phase 1 开工检查单执行状态

来源：`D:\AegisPi\phase1-kickoff-checklist.md` 的「开工顺序」，步骤原文保留，逐步附实际证据与产物路径。skip 行必须带理由。

- [x] 0. 本地初始化 `D:\AegisPi\aegis-pi`，wire origin（https://github.com/NorthAdb/AegisPi），推送首个提交证实写入链路。证据：git push 输出见 docs/phase1/evidence/00-repo-init.md。
- [x] 1. 落地 Node 22.23.5 并记录版本与来源 SHA。证据：docs/phase1/evidence/01-node-lock.md。
- [ ] 2. 隔离目录安装 pi-coding-agent exact 1.5.2，生成真实 lockfile，记录完整性字段。
- [ ] 3. PI-01 至 PI-13 逐项探针：导出与类型读取、RPC LF 分帧夹具（U+2028/U+2029、分片 UTF-8、超长帧、stderr 分离）、UI 停车能力、provider 路由（本地 fake 端点验证形状）、取消次序。
- [ ] 4. node:sqlite 在 22.23.5 上测 FTS5/trigram，出驱动选择报告。
- [ ] 5. 拉取 Node 22.23.5 官方基础镜像，记录真实 digest 与 Dockerfile 构建上下文。
- [ ] 6. 用 honojs/hono 真实 release/advisory 样本写 oracle 与 environment manifest 夹具，标注集经用户确认（标注为提案状态，待用户收口确认）。
- [ ] 7. 任何契约不成立，按 ADR 模板报批后改适配与文档，不编造方法名。（条件步骤，逐项核验时触发）
- [ ] 8. 自审 + 产出移交审计 agent 的报告（用户要求，检查单之外的交付）。
