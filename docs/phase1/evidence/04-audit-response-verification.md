# 证据 · 04 第一轮审计整改的复跑与变红验证（2026-11-19）

对应 `docs/phase1/reports/audit-response.md`。所有命令在锁定 Node v22.23.5（`D:\AegisPi\tools\node-v22.23.5\node.exe`，Windows 11）上执行。

## 1. 整改后全量复跑

```
& D:\AegisPi\tools\node-v22.23.5\node.exe evals\contracts\run-contracts.mjs
→ 15 probe(s): no FAIL        （PI-01..PI-13 + FRAMING + SQLITE 全 PASS）
→ 退出码 0
→ docs/phase1/evidence/contracts-report.json 重新生成（nodeVersion v22.23.5，含整改后全部断言名）
```

关键新断言的机器证据（contracts-report.json findings 摘录）：

- PI-02：`runtime-path-route-single-argument`（arguments.length=1）、`ext-path-route-receives-ctx`（arguments.length=2，ctx.modelRegistry present=true）、`ext-path-ctx-resolves-physical-model`（find 返回 deepseek-flash）、`dts-two-route-signatures`、`runtime-single-param-wrapper`、`loader-two-param-wrapper`（对 model-runtime.js:712 与 loader.js:418 的原文匹配）。
- PI-07：`dialog-timeout-not-dependable`（confirm timeout:1500 在 4 秒后仍 pending）、`restart-loads-extension`（重启进程 get_commands 列出 probe_ui）、`no-dialog-replay-after-restart`（4 秒零未请求 dialog、被杀 dialog id 零复现）。
- PI-10：`cost-totalFromProvider-is-boolean-false`（typeof boolean，值 false）、`missing-usage-reports-zeros-not-unknown`（usage 与 cost 全零）。
- PI-13：`decision-event-type-declared`（types.d.ts `on(event: "cache_warming_decision"` + cache-warmer.d.ts `type:` 声明）、`explicit-off-respected-by-settings-path`（inMemory off 读回 off）、`defaults-json-sets-off`（defaults.json 含 off 值）。
- FRAMING：`input-chunked-utf8-buffered`（切点在「哈」e5 93 88 字节内部）、`readline-equals-byte-frames-on-locked-node`（行数与字节帧相等、0 解析失败）、`input-u2028-single-frame-accepted`、`input-overlong-1-5mib-accepted`。
- SQLITE：`reference-schema-user-tables-27`（非 FTS 恰 27；2 FTS 虚拟 + 8 影子 = 37 总量）、`synchronous-full`（PRAGMA synchronous = 2）。

## 2. mutation 变红验证（"字面量 true 改成 false 时必须变红"的等价门禁）

整改后已无字面量 true 可改，故用真实断言做等价证明——把 `synchronous-full` 的期望从 `===2` 改为 `===3`：

```
（修改 evals/contracts/probes/sqlite-node.mjs：syncMode.synchronous === 3）
& D:\AegisPi\tools\node-v22.23.5\node.exe evals\contracts\run-contracts.mjs --only=sqlite
→ === sqlite-node ===
→ FAIL  SQLITE — 1 failing check(s)
→ 1 probe(s): FAILURES PRESENT
→ MUTATION-EXIT=1

（还原 ===2）
& D:\AegisPi\tools\node-v22.23.5\node.exe evals\contracts\run-contracts.mjs --only=sqlite
→ PASS  SQLITE — 0 failing check(s)
→ REVERT-EXIT=0
```

破坏真实断言 → 探针变红、退出码 1；还原 → 复绿、退出码 0。门禁成立。

## 3. 字面量 true 清零的静态证明

```
node <grep 譳据脚本：/probe\.check\(\s*\n?\s*["'][^"']+["'],\s*true[,)]/ over evals/contracts/probes/*.mjs>
→ NO literal-true probe.check remains
```

（v1 同一脚本列出 12 处：framing×4、pi07×1、pi09×1、pi10×1、pi11×1、pi12×1、pi13×2、sqlite×1。）

## 4. 包验证器复核（入口证据新鲜度）

```
（工作目录 D:\AegisPi\aegis-pi-design-pack-v1.4.1）
python -X utf8 validation/validate_pack.py
→ … PASS links_tree_and_versions / state_enums_and_audit_mapping / historical_HTML_byte_preservation
→ CONNECTIONS_LEFT=0
→ SUMMARY passed=14 failed=0
```

schema.sql SHA-256 复核：`ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`（与审计环境一致）。

## 5. hono 双 oracle 的隔离快照实测（P1-3/P1-4 证据）

隔离安装（npm 10.9.9 / Node 22.23.5，每快照独立目录）：

```
hono@4.13.19 → 隔离 lockfile sha256 e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e
              → lock 内 integrity sha512-KmXvQ…fkA==（与 registry 一致）
hono@4.12.24 → 隔离 lockfile sha256 db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4
              → lock 内 integrity sha512-I36D1s+HgQc55KbhEr4iybfxv/9o1zdpw+XEM6dJa91LqQD0HCoSGdxpRJCZE+aavs87j4V3Ls2OJzq8c/U4iw==
              → 与 npm view hono@4.12.24 dist.integrity（registry）一致
```

检查执行（**把检查脚本复制进各快照安装目录后运行**——ESM 按脚本位置解析 hono；在仓库里跑会解析到仓库 4.13.19 得假结果，v1 踩过此坑）：

```
[baseline hono@4.13.19] csrf-textping-check.mjs → {"status":403,"rejected":true} exit=0
[baseline hono@4.13.19] cors-credential-check.mjs → {"acao":"*","acac":"true","reflected":false} exit=0
[target   hono@4.12.24] csrf-textping-check.mjs → {"status":200,"rejected":false} exit=1
[target   hono@4.12.24] cors-credential-check.mjs → {"acao":"https://attacker.example","acac":"true","reflected":true} exit=1
```

A1（baseline 成立）/A2（target 受影响）两对全部实测闭合，与审计独立测量一致（其记录 4.13.19→403/0、4.12.24→200/1）。

## 6. GHSA-88fw 全量重拉核实（P1-3）

```
gh api "repos/honojs/hono/security-advisories?per_page=100"
→ total fetched: 61
→ in window [2026-05-18, 2026-11-18): 30   outside: 31
→ GHSA-88fw-hqm2-52qc present: severity high, CVE-2026-54290,
   published 2026-06-09, range < 4.12.25,
   summary "CORS Middleware reflects any Origin with credentials when `origin` defaults to the wildcard"
```

重建后 events.json：75 候选（45 release + 30 advisory；severity 27 medium / 1 high / 2 low）。
