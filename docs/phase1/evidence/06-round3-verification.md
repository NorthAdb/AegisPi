# 证据 · 06 第三轮复审（e7b93b7）整改的验证（2026-11-19）

对应 `docs/phase1/reports/audit-e7b93b7-response.md`；审计原稿归档于 `docs/phase1/audits/AUDIT-PHASE1-REREVIEW-e7b93b77612674f4759bfb47f42a01ec3a82b042.md`。所有命令在锁定 Node v22.23.5（`D:\AegisPi\tools\node-v22.23.5\node.exe`，Windows 11）上执行；npm 为锁定的 10.9.9。

## 1. N9：解析遏制——未安装快照必须拒绝（exit 2）

整改前假绿复现（审计同法）：参数 = 仓库内未安装快照 `evals\contracts\fixtures\hono-triage\snapshots\hono-4.12.24`，旧版双检查 exit 0（仓库 4.13.19 顶替）。整改后同一命令：

```
node evals\contracts\fixtures\hono-triage\checks\csrf-textping-check.mjs <repo>\...\snapshots\hono-4.12.24
  {"infra_error":"hono resolved OUTSIDE the requested install dir — refusing to run
   (audit round 3 N9). requested=...\snapshots\hono-4.12.24
   resolvedHono=D:\AegisPi\aegis-pi\node_modules\hono\dist\cjs\index.js
   resolvedCsrf=D:\AegisPi\aegis-pi\node_modules\hono\dist\cjs\middleware\csrf\index.js"}
  N9-csrf-uninstalled-EXIT=2
node evals\contracts\fixtures\hono-triage\checks\cors-credential-check.mjs <同上>
  同类 infra_error（resolvedCors=...\middleware\cors\index.js）
  N9-cors-uninstalled-EXIT=2
```

真实上溯路径被打印（`node_modules\hono\dist\cjs\index.js` = 仓库 npm ci 的 4.13.19）——假绿变红证。

仓库外空目录（自带 package.json、无父级 node_modules/hono）：

```
N9-csrf-emptydir-EXIT=2   {"infra_error":"... Cannot find module 'hono' ..."}
N9-cors-emptydir-EXIT=2
```

## 2. N9：已安装矩阵保持 + 配对工具全绿

```
node evals\contracts\tools\verify-hono-oracle-pair.mjs   （cwd = 仓库根；配对工具先从入库快照 npm ci 两套临时安装）
[baseline hono@4.13.19] csrf exit=0 (expected 0) resolution=resolved-inside-target OK
[baseline hono@4.13.19] cors exit=0 (expected 0) resolution=resolved-inside-target OK
[target   hono@4.12.24] csrf exit=1 (expected 1) resolution=resolved-inside-target OK
[target   hono@4.12.24] cors exit=1 (expected 1) resolution=resolved-inside-target OK
[uninstalled snapshot hono-4.13.19] csrf exit=2 (expected 2 — resolution must refuse) OK
[uninstalled snapshot hono-4.13.19] cors exit=2 (expected 2 — resolution must refuse) OK
[uninstalled snapshot hono-4.12.24] csrf exit=2 (expected 2 — resolution must refuse) OK
[uninstalled snapshot hono-4.12.24] cors exit=2 (expected 2 — resolution must refuse) OK
hono-4.13.19 lockfile sha256 e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e
hono-4.12.24 lockfile sha256 db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4
PAIR-EXIT=0
```

resolution 判定现核对 `honoFrom`（真实解析文件路径）落在安装目录内的遏制关系，不再比较参数字符串；两个 lock 哈希与 manifest 逐字一致（保留未动）。

## 3. N10：--only 零命中必须退出码 1

```
node evals\contracts\run-contracts.mjs --only=does-not-exist
  --only matched no probes (does-not-exist) — nothing ran, nothing was asserted
  0 probe(s): NOTHING RAN (empty --only match)
N10-empty-only-EXIT=1
```

既有门禁未回退：纯 note 探针仍 SKIP → 退出码 1（evidence/05 红证维持有效）；随后全量 15 探针复跑退出码 0。

## 4. N11：九字段全零谓词——双突变变红

突变 A（cost 组字段）：`u.cost.total === 0` → `=== 1`（临时改 `pi10-usage.mjs`，备份还原）：

```
FAIL  PI-10 — 1 failing check(s) — usage contract deviates; see findings.
FAIL probes: PI-10
1 probe(s): NOT GREEN (fail/skip/no-evidence present)
MUT1-cost-total-EXIT=1
（报告 JSON 内变红检查名：missing-usage-shape-zeros-no-provider-total）
```

突变 B（usage 组字段）：`u.totalTokens === 0` → `=== 1`：

```
FAIL  PI-10 — 1 failing check(s) — usage contract deviates; see findings.
MUT2-totalTokens-EXIT=1
（同一检查名变红）
```

还原：`Get-FileHash` 与备份逐字节相等（True）。还原后 `--only=pi10` → PASS，退出码 0。谓词现断言九个数字字段（usage input/output/cacheRead/cacheWrite/totalTokens + cost input/output/cacheRead/cacheWrite/total）逐项 `=== 0` 且 `!("totalFromProvider" in u.cost)`；审计反例 `{input:0, output:0, cost:{total:999}}` 不再可能通过（cost.total 被钉死）。

## 5. 整改后全量复跑（锁定 Node）

```
node evals\contracts\run-contracts.mjs
  15 个探针全部 PASS（含 PI-10 九字段谓词、PI-13 加载器断言、SQLITE 条件化 note）
  15 probe(s): all PASS with falsifiable evidence
SUITE-EXIT=0
（contracts-report.json generatedAt=2026-11-19T03:5x:xxZ，nodeVersion=v22.23.5）
```

规范包自检（收口例行）：`python -X utf8 validation/validate_pack.py`（包目录）14/14、CONNECTIONS_LEFT=0（见 evidence/00 与前两轮复核；本轮未改任何受包约束文件）。
