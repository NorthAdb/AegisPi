# 证据 · 05 第二轮复审整改的验证（2026-11-19）

对应 `docs/phase1/reports/re-review-response.md`。所有命令在锁定 Node v22.23.5（`D:\AegisPi\tools\node-v22.23.5\node.exe`，Windows 11）上执行；配对自检在锁定 npm 10.9.9。

## 1. N1：纯 note 探针必须让套件退出码 1

summarizeProbe 七条规则单元核验（直接调用，node --input-type=module）：

```
notes only                       -> SKIP
notes + result(PASS)             -> SKIP      （升格路径已封死）
notes + result(FAIL)            -> FAIL
one FAIL finding                -> FAIL
one PASS finding                -> PASS
one PASS + one SKIP             -> PASS
one PASS + result(PASS)         -> PASS
```

套件级红证（复审者的方法）：临时把 `sqlite-node.mjs` 换成只含 `probe.note` 的模块：

```
=== sqlite-node ===
SKIP  SQLITE — 0 failing check(s) — note-only placeholder
SKIP (no falsifiable PASS evidence) probes: SQLITE
probes without any PASS finding: SQLITE

1 probe(s): NOT GREEN (fail/skip/no-evidence present)
NOTE-ONLY-EXIT=1
```

还原后同探针复绿（`--only=sqlite,pi10,pi13` 三探针全 PASS，退出码 0）。运行器现行门禁：FAIL、SKIP、无任何 PASS finding 任一存在 → 退出码 1。

## 2. N2：defaults.json 真实路径（危险与修复都作为断言）

本机实测矩阵（锁定 Node，SettingsManager 直调）：

```
inMemory(JSON.parse(defaults.json))   -> idle     ← 危险：budget 嵌套不达 Pi 顶层键
inMemory({budget:{cacheWarming:off}}) -> idle
inMemory({cacheWarming:"off"})         -> off
inMemory({})                           -> idle
```

整改后 PI-13 新断言（全量绿报告中 PASS）：

```
[PASS] raw-defaults-json-reads-idle-hazard
  SettingsManager.inMemory(JSON.parse(defaults.json)) = idle — the nested
  budget.cacheWarming does NOT reach the top-level key Pi reads; loading the
  file without the mapping loader silently enables default warming (hazard
  recorded as an assertion)

[PASS] defaults-json-off-reaches-pi-via-loader
  JSON.parse(defaults.json) -> piSettingsFromDefaults() -> SettingsManager
  .inMemory(...).getCacheWarmingMode() = off; mapped settings =
  {"cacheWarming":"off"} — the shipped file's off value reaches Pi's runtime
  settings path through the single loader
```

若删除 `apps/daemon/config/load-pi-settings.mjs` 或改映射/键形，第二个断言变红；若 Pi 改为读取嵌套键，第一个（危险）断言变红并触发重审。

## 3. N3：缺 usage 路径按实测形状断言

```
[PASS] missing-usage-shape-zeros-no-provider-total
  usage with provider omission: {"input":0,"output":0,"cacheRead":0,
  "cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,
  "cacheWrite":0,"total":0}} — numbers are all zero AND cost has no
  totalFromProvider key (absent, not false, not a number). Nothing here
  proves a zero-cost outcome; the host ledger (Phase 2, not yet implemented)
  must hold such responses un-settled (HELD) until a trustworthy usage or
  bill arrives (06 §8)
```

零值不再出现在 PASS 条件的"结清成功"语义里；HELD 台账明确为 Phase 2 未实现项（open-items #6）。

## 4. N4/N5：hono 显式解析 + 入库快照可复算

从**仓库目录**以安装目录为参数运行（与 cwd/脚本位置无关）：

```
[baseline hono@4.13.19] csrf exit=0 (expected 0) resolution=target-dir OK
[baseline hono@4.13.19] cors exit=0 (expected 0) resolution=target-dir OK
[target   hono@4.12.24] csrf exit=1 (expected 1) resolution=target-dir OK
[target   hono@4.12.24] cors exit=1 (expected 1) resolution=target-dir OK
```

一键自检（从入库快照 npm ci 复现安装）：

```
node evals\contracts\tools\verify-hono-oracle-pair.mjs
→ [baseline hono@4.13.19] csrf exit=0 … OK / cors exit=0 … OK
→ [target hono@4.12.24]   csrf exit=1 … OK / cors exit=1 … OK
→ hono-4.13.19 lockfile sha256 e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e
→ hono-4.12.24 lockfile sha256 db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4
PAIR-EXIT=0
```

两个 lockfile 哈希与 manifest 值逐字一致，快照 `package.json`+`package-lock.json` 已入库（`evals/contracts/fixtures/hono-triage/snapshots/`），任何第三方可直接复算。误导性的 "cwd must resolve hono" 注释已从两个检查脚本删除。

## 5. N8：driver-selection note 条件化

sqlite 探针尾部的结论 note 现按本次运行实际判据输出：无 FAIL 门禁 → "satisfied every asserted gate **in this run**"；有 FAIL 门禁 → "driver-selection NOT concluded + 失败门禁清单"。记录不再承载未验证的宣称。

## 6. 整改后全量复跑

见 `contracts-report.json`（本文件落盘时的最新 generatedAt 版本）：15 探针全部 PASS、每探针至少一条可失败 PASS 判据、退出码 0。汇总行措辞为 `all PASS with falsifiable evidence`。
