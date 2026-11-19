# SQLite 驱动选择报告（Phase 1 任务 2）

**结论：选 `node:sqlite`（Node 22.23.5 内置，SQLite 3.54.1），不引入 better-sqlite3。**

## 判据（规范 06 §1 / README）

探针：`evals/contracts/probes/sqlite-node.mjs`（锁定 Node 22.23.5）。机器结果见 `docs/phase1/evidence/contracts-report.json` 的 SQLITE 节。全部为可失败断言；本报告 2026-11-19 按第一轮审计整改后的绿报告重写（旧版写的 `reference-schema-loads`/`27 tables` 已被探针演进取代）。

- SQLite >= 3.39：实测 3.54.1 ✓（`sqlite-version-gte-3-39`）
- FTS5 + trigram：实测建虚拟表成功，CJK（"语义检索"）与拉丁（"affect"）子串 MATCH 均命中 ✓（`fts5-trigram-cjk-substring` / `fts5-trigram-latin-substring`）
- 参考兼容：设计包 `docs/reference/schema.sql`（SHA-256 `ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`，引用原包不复制）在 `:memory:` 执行成功 ✓（`reference-schema-user-tables-27`：**非 FTS 用户表恰 27 张**——与包验证器基线一致；2 张 FTS5 虚拟表 `fts_messages_lex`/`fts_messages_tri` 为 external-content 表、各带 4 张影子表（`_config/_data/_docsize/_idx`，共 8 张），`sqlite_master` 表总量 37）
- 触发器：`trg_msg_ai/ad/au` 三件套在位 ✓（`reference-schema-triggers-present`）
- 外键：`PRAGMA foreign_key_check` 干净 ✓（`reference-schema-fk-clean`）
- 运行约定：`foreign_keys=ON` ✓、`journal_mode=WAL` ✓（`wal-mode`）、**`synchronous=FULL` 以读回断言**（`synchronous-full`：`PRAGMA synchronous` = 2）✓、`integrity_check=ok` ✓

## 依据快照（2026-11-19 实测命令与输出摘录）

```
node evals\contracts\run-contracts.mjs --only=sqlite
  PASS sqlite-version-gte-3-39        process.versions.sqlite = 3.54.1 (bundled in Node v22.23.5)
  PASS fts5-trigram-cjk-substring / fts5-trigram-latin-substring
  PASS reference-schema-user-tables-27 user (non-FTS) tables = 27 (expected exactly 27, the pack validator baseline)
  PASS reference-schema-fk-clean / fts-present / triggers-present
  PASS wal-mode                        journal_mode = wal
  PASS synchronous-full                PRAGMA synchronous = 2 (2 = FULL)
  PASS integrity-check                 integrity_check = ok
```

## 决定理由

- 满足全部能力门禁 → 规范原文"满足则优先用内置"。
- 少一个原生编译依赖（better-sqlite3 需平台预编译二进制），与"新增依赖先审来源与必要性"一致。
- 风险与对策：`node:sqlite` 是 Node 实验性 API 标记（`DatabaseSync`），随 Node 版本演进——发布与 CI 锁定 22.23.5 已把该风险钉死；Node 22 系内升级需重跑本探针。

## 留痕说明（第一轮审计 N8 整改）

探针尾部的 `driver-selection` 结论 note **只在本次运行全部门禁 PASS 时陈述"已满足"**；任一门禁 FAIL 时改写为"未结论 + 失败门禁清单"，记录永远不承载未验证的宣称。该 note 是结论性陈述（非可失败断言），证据本体是上列可失败检查；套件退出码由它们决定（纯 note 探针会令套件退出码 1，见 run-contracts.mjs 的门禁）。

后续（Phase 2）：迁移器基于 `schema_migrations` 管理演进；校验和算法 SHA-256、输入为规范化 SQL 的 UTF-8/LF 字节（06 §1），实现时以本报告的驱动为底座。
