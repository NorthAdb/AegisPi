# SQLite 驱动选择报告（Phase 1 任务 2）

**结论：选 `node:sqlite`（Node 22.23.5 内置，SQLite 3.54.1），不引入 better-sqlite3。**

## 判据（规范 06 §1 / README）

- SQLite >= 3.39：实测 3.54.1 ✓
- FTS5 + trigram：实测建虚拟表成功，CJK（“语义检索”）与拉丁（"affect"）子串 MATCH 均命中 ✓
- 参考兼容：设计包 `docs/reference/schema.sql`（SHA-256 ede73ecaa7b98b85…，引用原包不复制）在 `:memory:` 执行成功，27 表、外键检查干净、FTS 触发器三件套（trg_msg_ai/ad/au）在位 ✓
- 运行约定：PRAGMA foreign_keys=ON、journal_mode=WAL、synchronous=FULL 全部实测设置成功，integrity_check=ok ✓

探针：`evals/contracts/probes/sqlite-node.mjs`（探针运行于锁定 Node 22.23.5）。机器结果见 `docs/phase1/evidence/contracts-report.json` 的 SQLITE 节。

## 依据快照（2026-11-18 实测命令与输出摘录）

```
node -e "console.log(process.versions.sqlite)"      → 3.54.1
node evals\contracts\run-contracts.mjs --only=sqlite
  PASS sqlite-version-gte-3-39   process.versions.sqlite = 3.54.1 (bundled in Node v22.23.5)
  PASS fts5-trigram-cjk-substring / fts5-trigram-latin-substring
  PASS reference-schema-loads     27 tables
  PASS reference-schema-fk-clean / fts-present / triggers-present
  PASS wal-mode                   journal_mode = wal
  PASS integrity-check            integrity_check = ok
```

## 决定理由

- 满足全部能力门禁 → 规范原文“满足则优先用内置”。
- 少一个原生编译依赖（better-sqlite3 需平台预编译二进制），与“新增依赖先审来源与必要性”一致。
- 风险与对策：`node:sqlite` 是 Node 实验性 API 标记（`DatabaseSync`），随 Node 版本演进——发布与 CI 锁定 22.23.5 已把该风险钉死；Node 22 系内升级需重跑本探针。

后续（Phase 2）：迁移器基于 `schema_migrations` 管理演进；校验和算法 SHA-256、输入为规范化 SQL 的 UTF-8/LF 字节（06 §1），实现时以本报告的驱动为底座。
