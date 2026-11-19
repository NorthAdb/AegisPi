# 第一轮审计整改记录（audit-response）

日期：2026-11-19（Asia/Hong_Kong）。对应审计稿：`/tmp/aegis-audit/AUDIT-PHASE1.md`（审计环境 Ubuntu 24.04.5，锁定 Node 22.23.5 复跑 test:contracts 退出码 0、validate_pack.py 14/14）。

原则：审计指出的每一条先在本机独立核实（不盲信审计文本，也不盲信自己 v1 的结论），核实属实的整改，整改后复测并把"故意破坏断言必须变红"作为门禁。以下逐条映射。

## P1-1 route 被写成了全局单参数 —— 属实，已整改

**核实**（本机实测）：
- `dist/core/model-runtime.js:712`：`route: (request) => definition.route(request)` — ModelRuntime 注册路径单参。
- `dist/core/extensions/loader.js:418`：`route: (request) => model.route(request, runtime.createContext())` — 扩展注册路径双参带 ctx。
- `dist/core/extensions/types.d.ts:1447`：`ExtensionVirtualModel.route(request, ctx: ExtensionContext)` 与 `ctx.modelRegistry`（types.d.ts:245）均有声明——**d.ts 并没有"漏掉"扩展路径**，v1 报告的"文档不符"结论是错的。

**整改**：`evals/contracts/probes/pi02-virtual-models.mjs` 重写为双路径探针。新增断言：`dts-two-route-signatures`（两个签名都在 d.ts）、`runtime-single-param-wrapper`（model-runtime.js 包装行原文匹配）、`loader-two-param-wrapper`（loader.js 包装行原文匹配）、`runtime-path-route-single-argument`（实测 `arguments.length===1`）、`ext-path-route-receives-ctx`（实测 `arguments.length===2` 且 ctx.modelRegistry 存在）、`ext-path-ctx-resolves-physical-model`（`ctx.modelRegistry.find('deepseek','deepseek-flash')` 返回该模型）、`ext-path-dispatch-records-physical-model`。报告 PI-02 行改写为双路径结论。**Phase 2 的宿主路由器两种入口都要支持**。仍未需 ADR（未改安全边界）。

## P1-2 多条 PASS 写成了字面量 true —— 属实，12 处已清零

**核实**：本机 grep 出 12 处（framing×4、pi07×1、pi09×1、pi10×1、pi11×1、pi12×1、pi13×2、sqlite×1；另 framing `agent-settled-emitted` 为守卫式 true）。

**整改**（全部转可失败断言或降级 note，`summarizeProbe` 同步收紧为"无 PASS 判据不得判 PASS"）：

| 原 check | 整改后 |
| --- | --- |
| framing `agent-settled-emitted` (true) | `settled === true`（waitFor 超时走 catch 变红） |
| framing `readline-behavior-recorded-on-locked-node` (true) | `readline-equals-byte-frames-on-locked-node`：`lines === lfFrames.length && badParse === 0` 实测断言；v24 危险改 note 并指向可独立复跑的 readline-repro.mjs |
| framing `input-u2028-verdict` (true) | `input-u2028-single-frame-accepted`：断言实测 `success===true` |
| framing `adapter-must-cap-frames` (true) | 实测断言 `input-overlong-1-5mib-accepted`（1.5MiB 成功）；"宿主须设上限"是规范要求，降级 note |
| framing 分片切点 `length-2`（落在 ASCII `}` 上） | 切点改为 `promptCmd.indexOf(哈的3字节)+1`，**切在 e5 93 88 字符内部** |
| pi07 `no-ui-persistence-across-restart` (true) | 重启复验：同 agent 目录起全新进程 → `restart-loads-extension`（get_commands 列出 probe_ui）+ `no-dialog-replay-after-restart`（4 秒零未请求 dialog、被杀 dialog id 零复现）。两断言均可失败 |
| pi07 timeout 表述 8 秒 | 修正为 4 秒（与机器证据一致），报告同步 |
| pi10 `no-totalFromProvider-dependency` (true，“字段不存在”) | `cost-totalFromProvider-is-boolean-false`：实测断言 `typeof==="boolean" && value===false`；“账本自行求和”降级 note |
| pi13 `decision-event-surface-exists` (true) | `decision-event-type-declared`：types.d.ts `on(event: "cache_warming_decision"` + cache-warmer.d.ts `type: "cache_warming_decision"` 静态断言 |
| pi13 `warming-off-for-aegispi` (true) | `explicit-off-respected-by-settings-path`（inMemory({off}) 读回 off）+ `defaults-json-sets-off`（读文件断言含 off）；**运行时强制未落地如实记录**；预算规则降级 note |
| pi09 `worker-cannot-override-url` (true) | note（规范宿主边界，非 Pi 可测属性） |
| pi11 `host-validation-still-mandatory` (true) | note（同上） |
| pi12 `limits-not-security-boundary` (true) | note（同上） |
| sqlite `driver-selection` (true) | note（结论跟随同探针的可失败门禁）；新增 `synchronous-full`（实测 PRAGMA synchronous=2）与 `reference-schema-user-tables-27`（实测非 FTS 表恰 27） |

**变红验证**：整改后故意把 sqlite 探针的 `synchronous-full` 期望从 `===2` 改为 `===3`，单探针运行即 FAIL、退出码 1；还原后复绿。输出存 `docs/phase1/evidence/04-audit-response-verification.md`。

## P1-3 GHSA-88fw 纠错不成立 —— 属实，已撤回错误结论

**核实**（本机重拉）：`gh api "repos/honojs/hono/security-advisories?per_page=100"` 共 61 条；窗口 [2026-05-18, 2026-11-18) 内 30 条；**GHSA-88fw-hqm2-52qc 实存**（high，CVE-2026-54290，2026-06-09 发布，<4.12.25，"CORS Middleware reflects any Origin with credentials when origin defaults to the wildcard"）。v1 的“检查单写错了”不成立——错的是 v1 的 `per_page=20` 拉取被分页静默截断（GHSA-88fw 发布于 6 月、正好排在截断点外）。GHSA-wwfh（serve-static 路径穿越）与 GHSA-46wx（csrf text/ping）也真实存在，这部分维持。

**整改**：
- `evals/contracts/tools/build-hono-events.mjs`：输入改为全量 dump（per_page=100），对 release 与 advisory **都做窗口过滤 [start, end)**。
- `events.json` 重建：**75 候选**（45 release + 30 advisory，severity: 27 medium / 1 high / 2 low），GHSA-88fw 在窗。
- 恢复 `checks/cors-credential-check.mjs`（按 advisory 描述场景：`cors({credentials:true})` 默认 origin），新增 `oracle.hono-cors.json` + `manifest.hono-cors.json`，**A1/A2 均实测**：4.13.19 → `acao:"*"` 不反射/exit 0；4.12.24 → `acao:"https://attacker.example"` 反射/exit 1（源码根因：4.12.24 的 `findAllowOrigin` 在默认 `"*"` + credentials 下返回 `(origin)=>origin||null`）。
- 标注提案补入 GHSA-88fw（unaffected，high 置信，4.13.19 > 4.12.25），修正 GHSA-8j4g 的"最接近 CORS 反射”错误备注（真正的反射条目是 GHSA-88fw）。
- 决策表新增 D-09 记录此数据完整性教训（分页截断），D-05 的错误理由行内勘误。

## P1-4 target manifest 指向已修复版本 —— 属实，已回填真实值

**核实**（本机隔离安装实测）：
- baseline 隔离 `npm install hono@4.13.19`（npm 10.9.9 / Node 22.23.5）→ lockfile sha256 `e5d0c57e9d576d5430cf0964deb3ccf228f862f8a9e809556f3cbf9d6247ba5e`。
- target 隔离 `npm install hono@4.12.24` → lockfile sha256 `db2bb1344fd16b2b2db9c2197a877bc9f3f853393706b6c62c5c5747ab95dad4`，lock 内 integrity `sha512-I36D1s+HgQc55KbhEr4iybfxv/9o1zdpw+XEM6dJa91LqQD0HCoSGdxpRJCZE+aavs87j4V3Ls2OJzq8c/U4iw==`，与 registry 一致（`npm view hono@4.12.24 dist.integrity` 双核对）。
- v1 manifest 的 target.lockfileHash 确为仓库自身 lock（锁 4.13.19），target 的 hash 字段是一段英文说明文字——按 schema 只要求非空所以混过去了，性质属实。

**整改**：两个 manifest（csrf 对 + 新 CORS 对）的 baseline/target lockfileHash 分别换成各自隔离安装的真实 lock 哈希，target 的 hono integrity 回填 registry 实值，占位文字删除。**两对 oracle 的 A2 都从"约定”升级为实测**（隔离安装 4.12.24 上：csrf 检查 200/exit 1、cors 检查反射/exit 1，与审计的独立测量一致）。manifest 增加 `installNote`：复现必须把检查脚本复制进快照安装目录运行（ESM 按脚本位置解析 `hono`，不是 cwd——本机实测踩坑后写入，v1 若照抄文档 cwd 说法会得到假绿）。

## P1-5 任务 1 被勾成完成 —— 属实，已拆分

`.audit/phase1.todo.md` 任务 6 行拆为两行：夹具建立 [x]（含双 oracle 实测），**标注集经用户确认 [ ]**（通知渠道、基线三句话、正式标注均未收口，与开工检查单的用户侧准备项一致）。任务 1 的用户基线三项维持"未完成"状态不变（见 open-items）。

## P2 项处置

| 项 | 处置 |
| --- | --- |
| LOCKED_NODE 写死 Windows 路径 | `AEGISPI_NODE_BIN` 环境变量覆盖 + `assertChildNodeLocked`（RPC 探针校验子进程 `--version`，指向错误版本会变红）。审计用 shim 的做法从此有正式开关 |
| 根 engines 允许 22.19–23 | 收紧为 `"22.23.5"`（runner 运行时仍强制校验） |
| 镜像 digest 是多架构 index | `image-digest.md` 补记：RepoDigest 为 OCI index（本机 Descriptor.mediaType 实证）；linux/amd64 清单 digest `sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc`（审计对 registry 核验值）；本机 2026-11-19 registry 直连超时，amd64 清单待网络恢复本地复核（如实标注） |
| Markdown 超出 JSON 三处 | timeout 8s→4s、totalFromProvider“不存在”→“可选布尔 false”、sqlite "27 表"→"非 FTS 恰 27 + 2 FTS 虚拟 + 8 影子 = 37 且全部断言"——三处均已修正并对齐机器证据 |
| schema.sql SHA | 复核一致：`ede73ecaa7b98b850dfaa85f322472b50728ac3afbc70a8da3cee6bbccaa2995`（本机 Get-FileHash 与审计一致），Phase 2 开工者持包核验入口不变 |
| 深seek 真实调用未测 | 维持“未验证”状态（用户侧收口项，不做模拟冒充） |

## 阶段门禁对照（审计要求 → 当前状态）

- P1-1..P1-4 整改完成：是（本文件逐条）。
- v22.23.5 再跑 test:contracts 退出码 0：是（2026-11-19 全量复跑 15/15，见 evidence/04）。
- 字面量 true 改成 false 必须变红：是（mutation 实测变红并还原，见 evidence/04；且 12 处字面量已清零，grep 证明存档）。
- 开工者持有 SHA 对应的 v1.4.1 包：schema.sql SHA 复核一致，包路径与入口验证命令不变（D-01：包不随库分发）。
- 用户确认渠道/基线三句话/标注：**未收口，维持待办**——Phase 1 宣布完成前的硬性用户侧项，不由本次整改代劳。
