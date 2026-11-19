# Phase 2 开工检查单执行状态

来源：`D:\AegisPi\PHASE2-KICKOFF-HANDOFF.md` 第 5 节「建议的可观察拆步」，步骤原文保留，逐步附实际命令、退出码与产物路径。skip 行必须带理由。

- [x] 1. 修正 `AUDIT-HANDOFF.md` 第 4、5 节过时措辞，并重跑第 1 节两条最小验收。证据：`node evals/contracts/run-contracts.mjs` 15/15 PASS 退出码 0（2026-11-19 本会话复跑）；`node evals/contracts/tools/verify-hono-oracle-pair.mjs` 退出码 0（含未安装快照 exit 2 两行）；AUDIT-HANDOFF.md 第 4 节 Telegram 条、第 5 节要点与宣称范围三处已按 evidence/07 与 phase1-closure.md 收口事实改写；schema.sql LF 校验和实测 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995` 与移交要求一致。
- [ ] 2. 迁移器 + 排他锁 + 连接初始化；用规范 schema 建空库。
- [ ] 3. inbox 接收/去重/`dispatch_key`，ACK 必须发生在事务提交之后。
- [ ] 4. Task/attempt/lease/fence，含心跳条件与租约过期回收。
- [ ] 5. HELD 账本与八种 purpose；补一条「缺 usage 不得 SETTLED 为零」的失败测试。
- [ ] 6. effect / Outbox / UNKNOWN 与四种 retry_mode（fake 远端）。
- [ ] 7. Timer（含到期与回信竞争、错过周期合并一次补跑）。
- [ ] 8. 启动恢复扫完 06 §9 的崩溃矩阵，尤其是 SUBMITTING 后 UNKNOWN。
- [ ] 9. ACL + FTS 三触发器 + `recall.sql` 的 45 条无权候选测试。
- [ ] 10. daemon 入口正式接入 `load-pi-settings.mjs`；加一条「绕过加载器则保温配置读成 idle / 测试变红」的门禁。
- [ ] 11. 最小任务/对账/恢复诊断台（本机）。
- [ ] 12. 收口：`test:durability` / `test:acl` / `test:budget` 三脚本全绿留日志；Phase 1 契约套件与 hono 配对自检回归全绿；按 PRE-READ「阶段交接包」写交付清单（版本/行为/风险/未决项/回归），不写笼统「全绿」。

## 阶段约束（每步执行时对照）

- 唯一状态规范：设计包 06 + schema.sql（SHA ede73eca…，LF）。不另造冲突状态表。
- 时间 Unix 毫秒；金额整数 microUSD；WAL + FULL synchronous + foreign_keys；OS 排他锁防双启动。
- 八种 purpose 全入账；先预留再调用；未知 usage 保持 HELD；超时 CHARGED_BOUND；未对账不释放。
- fake 远端与录制数据；不接真实平台回调；密钥与本地文件不入库（改代码前 `git check-ignore` 复核）。
- 停止条件：静默丢事件、越权召回、预算旁路、UNKNOWN 盲重试、无鉴权控制台、真实外部副作用。
