# 第二轮复审整改记录（re-review-response）

日期：2026-11-19（Asia/Hong_Kong）。对应复审稿：`AUDIT-PHASE1-REREVIEW.md`（只读复审，对象 commit `87aa728`，判定"整改未通过"）。复审判定的两项高严重度新发现（N1 套件退出码、N2 cacheWarming 真实路径）与 N3～N8 均在本机先核实后整改。逐条映射如下。

## N1（高）只有 note 时套件仍退出码 0 —— 属实，已关死

**核实**：临时把 sqlite 探针换成纯 note 模块 → 状态 SKIP，套件退出码 **0**（复现）；直接调用确认 `result("PASS")` 会把纯 note 探针升格为 PASS（升格路径在案）。

**整改**：
- `summarizeProbe`（probe-utils.mjs）重排：FAIL 判据 → FAIL；`finalStatus==="FAIL"` → FAIL；**无任何可失败 PASS 判据 → SKIP（先于 finalStatus 判定）**；有 PASS 判据才允许 finalStatus/PASS。
- `run-contracts.mjs` 退出码门禁：任一探针 FAIL、**SKIP**、或**无任何 PASS finding** → 退出码 1，汇总行打印具体原因。
- **红证**（复现复审者的方法）：纯 note 探针 → `SKIP (no falsifiable PASS evidence) probes: SQLITE` → 退出码 **1**；还原后全绿退出码 0。七条 summarizeProbe 规则单元核验：纯 note→SKIP、note+`result("PASS")`→**SKIP**（升格封死）、note+`result("FAIL")`→FAIL、FAIL 判据→FAIL、PASS 判据→PASS、PASS+SKIP→PASS、PASS+`result("PASS")`→PASS。

## N2（高）defaults.json 的 off 走运行时路径读出 idle —— 属实，已按"真实路径"整改

**核实**（本机与复审一致）：`inMemory(JSON.parse(defaults.json))` = **idle**（`budget.cacheWarming` 嵌套键不达 Pi 读的顶层键）；原探针的两个断言（文件正则 + 手写顶层 off 对象）互不相连，绿不能证明文件本身可达。

**整改**：
- 新建唯一映射加载器 `apps/daemon/config/load-pi-settings.mjs`：`budget.cacheWarming` → Pi 设置顶层 `cacheWarming`，映射集中一处、显式单向；Phase 2 daemon 必须经它加载该文件（模块 docstring 在案）。
- PI-13 重写断言组：`raw-defaults-json-reads-idle-hazard`（**把文件直读 = idle 这个危险本身作为断言**——若未来 Pi 改为读取嵌套键，此断言变红并触发重审）、`defaults-json-off-reaches-pi-via-loader`（`JSON.parse(文件) → piSettingsFromDefaults() → inMemory(...).getCacheWarmingMode() = off` 实测）、`defaults-json-sets-off`（文件形状 sanity）。复审要求的"期望 off、走这条路径、断言可红"完全就位——**若删掉加载器或文件键改形，探针变红**。
- defaults.json 保持 06 规范的嵌套形状（不为了过 Pi 而改规范形状）；映射职责归加载器（决策 D-11）。

## N3（中）缺 usage 路径的形状与判定 —— 属实，已按实测形状断言

**核实**（绿报告原文）：缺 usage 的对象 = 全零数字 + cost 全零 + **没有 `totalFromProvider` 键**（pi-ai 只在 usage 在场路径赋该布尔）。原检查把 `cost.total===0` 列进 PASS 条件，命名与文案有"结清成功"倾向。

**整改**：断言改为 `missing-usage-shape-zeros-no-provider-total`——数字全零 **且** `!("totalFromProvider" in cost)`（实测形状）；名称与 detail 明确写"此处无可信结算证据"，不再把零成本当成功条件。HELD 是宿主义务：note 里明确"宿主侧 HELD 门禁 Phase 1 未实现、不宣称完成"，并保留在 open-items（未实现清单），不用 note 冒充宿主门禁。

## N4（中）检查脚本留在仓库目录时 4.12.24 假绿 —— 属实，解析已改显式

**核实**：脚本头注释"cwd must resolve hono"与 manifest installNote 相反，照文件头操作会假绿（复审实测 cwd 法两检查均 0）。

**整改**：两个检查脚本重写——`node checks/<x>.mjs <install-dir>`，用 `createRequire(join(dir,"package.json"))` **显式从目标安装目录加载 hono**，与 cwd、脚本位置完全无关；删除误导注释；输出记录 `honoFrom`（解析来源自证）。**从仓库目录对 4.12.24 跑实测 exit 1**（csrf 与 cors 均 1）、对 4.13.19 跑 exit 0。新增自检工具 `evals/contracts/tools/verify-hono-oracle-pair.mjs`：默认从入库快照 `npm ci` 复现两套安装，断言 0/1 矩阵 + 解析来源 = 目标目录；实测全 OK 退出码 0。两个 manifest 的 `installNote` 与两个 oracle 的 A2 描述同步改写。

## N5（低）隔离 lockfile 全文哈希不可复算 —— 已入库快照，可复算

**整改**：把两个隔离安装的 `package.json` + `package-lock.json` **字节原样**入库：`evals/contracts/fixtures/hono-triage/snapshots/hono-4.13.19/`（lock SHA-256 `e5d0c57e…`）与 `snapshots/hono-4.12.24/`（lock SHA-256 `db2bb134…`）。第三方现在可直接 `Get-FileHash` 复算，或在快照目录 `npm ci` 复现安装（安装即按 lock 的 registry integrity 落地）。manifest 的 lockfileHash 字段含义改为"入库快照 lock 的 SHA-256（可复算）"；registry integrity 维持（`npm view` 双核对一致）。verify-hono-oracle-pair 每次运行都复算并打印两个哈希。

## N6（低）sqlite-driver.md 旧快照 —— 已重写

用现行绿报告重写：检查名 `reference-schema-user-tables-27`（非 FTS 恰 27、2 虚拟 + 8 影子 = 37 总量）、`synchronous-full` 读回断言在摘录中；旧 `reference-schema-loads`/"27 tables"清除；附 N8 整改说明。

## N7（低）安装证据旧 engines 句 —— 已修正

`evidence/02-pi-install.md` 改为根 engines `"22.23.5"`，并注明与 Pi 包自身 `>=22.19.0` 的区分。

## N8（低）driver-selection note 在 FAIL 时仍称全满足 —— 已条件化

探针尾部结论 note 改为**按本次运行实际判据输出**：无 FAIL 门禁才陈述"satisfied every asserted gate in this run"；有 FAIL 门禁时改写为"driver-selection NOT concluded + 失败门禁清单"。记录不再承载未验证的宣称。

## 复审已独立证实、本轮未改动的部分

P1-1 双路径、P1-3 GHSA-88fw/75 候选、P1-4 integrity 与行为、`AEGISPI_NODE_BIN` 开关（复审以它全套复跑，指错版本会红）、镜像 index/amd64 双 digest（复审对 registry 核验一致）、labels 排除、字面量清零、分帧切点、PI-07 重启复验、mutation 变红——维持。amd64 清单 digest 的"本机未复验"一句由复审补上了 registry 核验，已在 image-digest.md 注明。

## 阶段门禁对照（复审 §5/§6）

1. ✅ 运行器：SKIP/无 PASS 判据 → 退出码 1；纯 note 红证在案；`result("PASS")` 升格封死（单元核验）。
2. ✅ PI-13 走真实路径：文件直读 = idle（危险断言在案），经唯一加载器 = off（断言在案）。
3. ✅ PI-10 缺 usage 按实测形状断言（无 totalFromProvider 键），不把零当结清；HELD 不用 note 冒充。
4. ✅ hono 检查 argv 显式解析；从仓库对 4.12.24 跑 exit 1 实测；快照 lock 入库可复算；误导注释删除。
5. ✅ 全套复跑（见 evidence/05，退出码保留）；sqlite-driver.md 与 02-pi-install.md 已同步；driver-selection note 条件化。
6. ✅ 未勾选：通知渠道、基线三句话、75 条标注确认、DeepSeek 最小推理；不宣布 Phase 1 完成；不开工 Phase 2 实现。
