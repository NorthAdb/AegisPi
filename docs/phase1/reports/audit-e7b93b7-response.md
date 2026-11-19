# 第三轮复审整改记录（audit-e7b93b7-response）

日期：2026-11-19（Asia/Hong_Kong）。对应审计原稿：`docs/phase1/audits/AUDIT-PHASE1-REREVIEW-e7b93b77612674f4759bfb47f42a01ec3a82b042.md`（被审 SHA `e7b93b77612674f4759bfb47f42a01ec3a82b042`；归档件 SHA-256 `49DB996B86F64FD8B0635A3C1C8DE3DBDDED6BE9E8C91B57D27214336CBDD0BE`，与提交前的本地原稿逐字节一致）。审计判定"整改未通过"，唯一原因是一条新假绿 N9，另有 N10、N11。三项均已在本机先核实后整改，红/绿证据在 `docs/phase1/evidence/06-round3-verification.md`。

## N9（中）未安装快照目录在仓库树内时检查假绿，honoFrom 不反映真实模块 —— 已按最小修复闭合

**核实（本机复现审计的方法）**：参数指向仓库内未安装的 `snapshots/hono-4.12.24`（只有 package.json + lock），`createRequire` 上溯到仓库 `node_modules\hono`（4.13.19），双检查 exit 0——假绿成立，与审计观察一致。上溯路径实证：`D:\AegisPi\aegis-pi\node_modules\hono\dist\cjs\index.js`。

**整改（逐条对应审计的最小修复）**：
- 两个检查脚本（csrf/cors）在加载后以 `require.resolve` 取 `hono` 与子模块（`hono/csrf` / `hono/cors`）的**真实路径**，用 `path.relative` 判定必须落在参数目录**之内**；否则打印真实解析到的地方并 **exit 2**，绝不给出 0/1 结果。
- `honoFrom` 字段改为输出**真实解析到的文件路径**（不再是参数目录字符串）；另加 `csrfFrom` / `corsFrom` 字段输出子模块真实路径。
- 配对工具 `verify-hono-oracle-pair.mjs` 的 resolution 判定改为**核对真实解析路径的遏制关系**（`insideDir`），不再比较参数字符串；并新增两行断言：对仓库内两个**未安装**快照目录（4.13.19 与 4.12.24），双检查都必须 exit 2。

**证据**（锁定 Node 22.23.5，命令与退出码见 evidence/06）：
1. 未安装快照（仓库树内）：csrf exit **2**、cors exit **2**，输出含真实上溯路径。
2. 已安装 4.12.24（配对工具 npm ci 复现）：csrf exit **1**、cors exit **1**，resolution=resolved-inside-target。
3. 已安装 4.13.19：csrf exit **0**、cors exit **0**，resolution=resolved-inside-target。
4. 仓库外空目录（自带 package.json、无父级 node_modules/hono）：双检查 exit **2**（Cannot find module）。
5. 配对工具全绿退出码 0，两个 lockfile 哈希复算与 manifest 一致（`e5d0c57e…` / `db2bb134…`，保留未动）。

## N10（低）--only 匹配不到探针时退出码 0 —— 已闭合

**核实**：`--only=does-not-exist` → 0 探针 → 退出码 0（假绿成立）。

**整改**：`run-contracts.mjs` 门禁新增第四条件 `emptyMatch = results.length === 0` → 退出码 1，汇总行打印 `NOTHING RAN (empty --only match)` 与匹配串。纯 note、note+`result("PASS")` 的退出码 1 行为未动（N1 关闭保持）。

**证据**：`--only=does-not-exist` → 退出码 **1**（evidence/06）；随后全量 15 探针复跑退出码 0。

## N11（低）缺 usage 谓词窄于"数字全零" —— 已按实测对象补齐

**核实**：原谓词只断言 `input/output` 为零 + cost 存在 + 键缺失；审计的反例 `{input:0, output:0, cost:{total:999}}` 确实会通过。

**整改**：谓词改为对**九个实测数字字段逐项 `=== 0`**——usage 的 `input/output/cacheRead/cacheWrite/totalTokens` + cost 的 `input/output/cacheRead/cacheWrite/total`——并保留 `!("totalFromProvider" in u.cost)`。检查名不变（`missing-usage-shape-zeros-no-provider-total`），detail 明确"无可信结算证据"，`cost.total===0` 仍不在任何"结清成功"语义里；HELD 台账维持 open-items 未实现项（不用 note 冒充）。有 usage 路径的 `cost-totalFromProvider-is-boolean-false` 保持未动。

**证据**（evidence/06）：
1. 突变 A：把 `u.cost.total === 0` 改为 `=== 1` → 恰 `missing-usage-shape-zeros-no-provider-total` FAIL，套件退出码 **1**；还原后复绿。
2. 突变 B：把 `u.totalTokens === 0` 改为 `=== 1` → 同一检查 FAIL，退出码 **1**；还原后复绿（还原以哈希相等证明逐字节一致）。
3. 全量复跑（15/15 PASS，退出码 0）中该检查 PASS，detail 贴出实测全零对象。

## 加载器无产品入口（审计 §3 要求写明）

如实陈述：`piSettingsFromDefaults` 的引用方目前只有 PI-13 探针、加载器模块自身及说明文档；`apps/daemon` **没有**运行入口，`apps/daemon/package.json` 没有 `main`。配置路径已可测（文件 → 加载器 → `getCacheWarmingMode()` = off；删除/绕过/改键形均实测变红），但 **daemon 运行时是否真的调用加载器是 Phase 2 的接线义务**——在接线落地之前，"探针调用了加载器"不等于"运行时已强制 off"。`raw-defaults-json-reads-idle-hazard` 断言记录的是"危险仍存在"（直读 = idle），它单独不证明 off 已生效；off 由 `defaults-json-off-reaches-pi-via-loader` 承担，且该断言已被上一轮审计打红验证过。`SettingsManager.create` 读 settings.json 的行为与 `inMemory` 一致（审计已测）；探针未覆盖 `create()`，如实记录。

## 剩余清单第 4 条（不勾选、不宣称、不开工）

- 通知渠道、基线三句话、75 条标注的**用户确认**、DeepSeek 最小推理——前三项的**用户侧材料**已由 owner 填入本地 `owner-baseline.local.md`（不入库，`.gitignore` 已加规则）；本轮完成了 DeepSeek 最小推理与 75 条草案生成（见下），**但"标注确认"仍开放，6b 保持未勾选**。
- 不宣布 Phase 1 完成；不开工 Phase 2 实现；daemon 将来加载 `defaults.json` 必须经 `load-pi-settings.mjs`（D-11，接线属 Phase 2）。

## 本轮同时完成的用户侧收口项（按本轮任务授权）

1. **DeepSeek 最小推理契约：完成**。锁定 Node 上经 Pi 1.5.2 SDK 对真实 `api.deepseek.com` **单次**推理（provider `deepseek`、model id `deepseek-flash`、thinkingLevel high）：`stopReason=stop`，回复恰为 "OK"，usage input 461 / output 2 / totalTokens 463，目录价计费 cost.total $0.0001407（totalFromProvider=false），耗时 904ms，脚本退出码 0。一次调用、无重试、未换模型。密钥仅在本机进程内从 `.env` 加载（`setRuntimeApiKey` 内存态），未打印、未入库。脚本：`evals/phase1-closure/verify-deepseek-minimal.mjs`；脱敏证据：evidence/07。
2. **Telegram 渠道验证：本机网络不可达，如实开放**。`TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_OWNER_USER_ID` 均已配置（仅核验变量名，未读取输出值）；`getMe` 因 `api.telegram.org:443` TCP 不通（连接层失败，DNS 解析到不可达地址，shell 无代理配置）无法完成——这是本机网络环境事实，不是凭据问题。未发送任何消息（脚本只做只读调用）。脚本：`evals/phase1-closure/verify-telegram-identity.mjs`；网络可达的网络/代理环境下重跑即可完成收口。
3. **75 条标注草案：已生成，待 owner 复核**。按 owner-baseline §3 原则全量生成（30 公告全部"该关注" + 9 个修复版"该关注" + 24 "可忽略" + 12 条 `uncertain:true` 按原则 4 仍标"该关注"），逐条带理由；含范围声明（hono 75 条是评测夹具，与 AegisPi 服务监控范围不混同）。草案在本地 labels 文件（gitignored），owner-baseline §3 已填草案路径与差异说明，**确认结果未写"全部同意"**。
4. 基线三句话：owner 已写入 owner-baseline.local.md §2（本地文件，不入库），内容与规范无冲突，维持原状。

## 未改动项（按审计指示保留）

N1、N2、N5、N6、N7、N8 未为措辞重改；已安装目录上的 4.12.24/4.13.19 行为矩阵与两个 lock 哈希保留并复算一致；`re-review-response.md` 与 `audit-response.md` 作为历史映射保持原样（本文件记录其对 N9 的取代关系）。

## 阶段门禁对照（审计 §4）

1. 技术整改：N9/N10/N11 全部以可红断言 + 红/绿证据闭合（evidence/06）；本轮无新增假绿类问题。
2. Phase 1 不宣布完成：75 条标注的 owner 确认仍开放；Telegram getMe 待网络可达环境补验。
3. Phase 2 不开工。本提交无任何 Phase 2 产品代码（inbox/Task/lease/daemon 入口均未写）。
