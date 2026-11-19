# Phase 1 外部审计史（四轮：问题 → 整改 → 改进）

生成：2026-11-19（Phase 1 收口时）。本文件是四轮外部审计/复审的单一编年记录：每轮的被审对象、判定、暴露的问题、整改落点与沉淀的工程改进。逐轮映射文档（整改细节与红绿证据）各自独立，见每节指针。审计原稿按被审 SHA 归档于 `docs/phase1/audits/`（判断依据：响应文档若无可查原稿，对第三方就是不可验证的宣称；原稿只含 SHA/行号/日志路径，无密钥）。

## 总览

| 轮次 | 被审 SHA | 判定 | 响应提交 | 原稿归档 |
| --- | --- | --- | --- | --- |
| 1 | `4d59f68…` | Phase 1 未完成（P1-1..P1-5、P2） | `87aa728` | **原稿已不在本地磁盘**——发现经 audit-response.md 与第二轮复审的独立核验保留，如实记录 |
| 2 | `87aa728…` | 整改未通过（N1..N8） | `e7b93b7` | `audits/AUDIT-PHASE1-REREVIEW-87aa728c12ff54c00ad36d43c33403a783abb028.md`（SHA-256 65BDF0AF…） |
| 3 | `e7b93b7…` | 整改未通过（N9 新假绿、N10、N11） | `ff6e497` | `audits/AUDIT-PHASE1-REREVIEW-e7b93b77612674f4759bfb47f42a01ec3a82b042.md`（SHA-256 49DB996B…） |
| 4 | `ff6e497…` | **技术整改通过**；Phase 1 剩用户侧两项 | （本轮无代码整改） | `audits/AUDIT-PHASE1-REREVIEW-ff6e497d066a875acb50e65b3acce45985bb4b20.md`（SHA-256 6E471427…） |

第四轮之后（同日）：owner 完成剩余两项——75 条标注逐条复核确认（12 条 uncertain 对照官方发行说明复核后转「可忽略」，终态 39/36/0，记录在本地 owner-baseline §3，labels 文件实测一致）与 Telegram getMe/getChat 复测（退出码 0，startConfirmed=true，evidence/07）。Phase 1 按 owner 授权收口（见 `phase1-closure.md`）。

## 第一轮（对象 4d59f68，判定：Phase 1 未完成）

映射文档：`audit-response.md`。

| 发现 | 问题实质 | 整改 | 沉淀的改进 |
| --- | --- | --- | --- |
| P1-1 route 断言失真 | 把"单参数、ctx undefined"写成全局事实，实为 ModelRuntime 单参 + 扩展双路径两态 | 探针改双路径实测（arguments.length 1 vs 2，loader.js:418 对照） | 结论必须来自实测形状，不是文档转述 |
| P1-2 不可失败的 PASS ×12 | `probe.check("…", true, …)` 字面量断言让套件"绿"不代表结论被测过 | 12 处清零：转可失败断言或降级 note；mutation 实测变红（evidence/04） | **D-10**：不可失败检查不得计为 PASS |
| P1-3 GHSA-88fw 被误 retract | advisory 拉取用 per_page=20 被静默截断，错误断言"检查单写错了" | 全量 per_page=100 重拉（61 条，窗口 30 条）；建第二对 oracle 并实测（4.12.24 反射 exit 1） | **D-09**：分页截断是数据完整性失败模式；advisory 拉取必须全量+窗口过滤 |
| P1-4 target 锁指向 4.13.19 | 目标快照的 lock/integrity 未实测回填 | 隔离安装实测 4.12.24（integrity 与 registry 一致） | 夹具哈希必须来自实测安装，不可约定 |
| P1-5 任务勾选超前 | 6b 在 owner 未确认时被勾 | todo 拆分，确认项保持未勾 | 用户确认项不由实施侧勾选 |
| P2（低） | 版本锁定靠默认路径、engines 过宽 | `AEGISPI_NODE_BIN` 覆盖 + 子进程版本校验；engines 收紧 "22.23.5" | 环境开关 + 子进程自证 |

## 第二轮（对象 87aa728，判定：整改未通过）

映射文档：`re-review-response.md`。

| 发现 | 问题实质 | 整改 | 沉淀的改进 |
| --- | --- | --- | --- |
| N1（高）纯 note 套件仍退出码 0 | `result("PASS")` 可升格纯 note 探针——第一轮"不可失败绿"的套件级形态 | summarizeProbe 重排（无 PASS 判据 → SKIP 先于 finalStatus）+ 运行器三条件门禁；纯 note 红证（evidence/05） | **D-12**：套件"绿" = 每探针有可失败判据且全过 |
| N2（高）defaults.json 的 off 读出 idle | Pi 只读顶层 cacheWarming，嵌套键不达；原探针用"手写顶层对象"绕过真实路径 | 唯一映射加载器 `load-pi-settings.mjs`（D-11）；文件直读=idle 作为**危险断言**、经加载器=off 作为断言（删加载器/改键形即红） | 配置断言必须走真实路径；危险本身可以被断言 |
| N3（中）缺 usage 的结清假绿 | `cost.total===0` 出现在 PASS 条件里，零值被当结清 | 按实测形状断言（无 totalFromProvider 键）；HELD 明确为 Phase 2 未实现项 | 零值不是结算证据；未实现的门禁不用 note 冒充 |
| N4（中）hono 检查 cwd 假绿 | 头注释"cwd must resolve hono"与 ESM 实际解析相反 | argv + createRequire 显式解析（后被第三轮 N9 证明仍不充分——见下） | 自证要看真实解析行为 |
| N5-N8（低） | lockfile 哈希不可复算、文档旧快照、engines 句、FAIL 时 note 仍称全满足 | 快照 package.json+lock 入库可复算；文档按绿报告重写；note 条件化 | 文档必须与现行绿报告一致 |

## 第三轮（对象 e7b93b7，判定：整改未通过于 N9 新假绿）

映射文档：`audit-e7b93b7-response.md`；红绿证据 evidence/06。

| 发现 | 问题实质 | 整改 | 沉淀的改进 |
| --- | --- | --- | --- |
| N9（中）上溯假绿 | `createRequire` 向父目录上溯：参数指到仓库内**未安装**快照时被仓库 4.13.19 顶替出 exit 0；`honoFrom=参数目录` 的字符串自证不成立 | **解析遏制**：`require.resolve` 真实路径必须落在参数目录内否则 exit 2；`honoFrom` 输出真实模块路径；配对工具核对真实路径 + 未安装快照必须 exit 2 两行；三复现点全测（含同前缀兄弟目录场景——第四轮独立复测补充） | **D-13**：自证必须基于真实解析路径 + 遏制断言，字符串相等不是自证 |
| N10（低）空 --only 假绿 | `--only` 拼错时 0 探针 0 断言却报成功 | `emptyMatch` → 退出码 1（`NOTHING RAN`）；实测在案 | **D-14**：零探针运行永远不算通过 |
| N11（低）谓词过窄 | 九个数字字段只钉了两个，`{cost:{total:999}}` 类反例可假通过 | 九字段逐项 `=== 0` + 键缺失；双突变实测变红（cost.total / totalTokens） | **D-15**：形状断言覆盖实测对象的每个字段 |

同轮（按 owner 当轮授权）：DeepSeek 最小推理契约实测通过（一次真实调用）；Telegram 直连被网络阻断如实开放；75 条草案全量生成（30 公告 + 9 修复版 + 12 uncertain + 24 可忽略）。

## 第四轮（对象 ff6e497，判定：技术整改通过）

原稿归档 `audits/AUDIT-PHASE1-REREVIEW-ff6e497…md`。N9/N10/N11 由审计方在 git archive 副本上独立红绿实测关闭（含路径规范化、同前缀兄弟目录、空目录、未安装快照全部 exit 2；双突变复现；配对工具退出码 0）。**无新技术阻塞**。判定 Phase 1 未完成仅余：① owner 对标注（含 12 条 uncertain）的确认未发生；② Telegram getMe 无成功记录。二者随后由 owner 完成/修正并复测通过（evidence/07 §2/§3）。同轮明确：`load-pi-settings.mjs` 接入 daemon 是 Phase 2 实现工作，不是 Phase 1 缺陷。

## 跨轮教训（四轮反复出现的三条主线）

1. **假绿的形态是无穷的，堵法只有一种**：字面量 true（一轮）→ 纯 note 升格（二轮）→ 空选择（三轮）→ 解析字符串自证（三轮 N9）。每一轮审计都在上一轮"修复的自证方式"里找到新的洞。工程答案不是更多措辞，而是让每条 PASS 都对应一个**可破坏的判据**，且破坏被实测变红过。
2. **自证必须是真实值的函数**：参数字符串、文档转述、手写对象都不是证据；`require.resolve` 的真实路径、实测对象形状、隔离安装的 lock 哈希才是。
3. **数据完整性先于结论**：GHSA-88fw 的误 retract 源头是一次 per_page=20 截断——工具输出"成功"不等于数据完整，分页类拉取必须全量。

## 留痕

- 决策链：`.audit/decision-trail.tsv`（D-01..D-15，含每条的动机/证据/影响）。
- 逐轮映射：`audit-response.md` / `re-review-response.md` / `audit-e7b93b7-response.md`（历史文档不回改，后被取代的表述由后轮文档记录取代关系）。
- 红绿证据：`evidence/04`（一轮 mutation）、`evidence/05`（二轮 note-only）、`evidence/06`（三轮 N9/N10/N11）、`evidence/07`（真实连接）。
- 收口声明：`phase1-closure.md`。
