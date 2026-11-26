# 历史交接归档：Phase 5 收官基线 → 自用过渡与 v1 封存裁定

> **原交接日期**：2026-11-24（当时基线 `724018a`）
> **当前状态（2026-11-25 闭环更新）**：**已归档历史过渡档**。本文提出的个人自用改进项后续已在 `289bd42`–`1b847e7` 中落地验证；旧“未来重启 Phase 6 / 路线 A·B·C 讨论”亦已由 [../V1-CLOSURE-AND-V2-MIGRATION.md](../V1-CLOSURE-AND-V2-MIGRATION.md)（标签 `v1-zero-trust-baseline`）完成最终裁定——**v1 正式封存，不再启动旧 Phase 6，后续转向纯 TypeScript 的 v2 主线**。

---

## 一、历史基线入口（仅供追溯）

1. [AGENTS.md](../../AGENTS.md)：仓库级硬约束（Node 版本锁、Pi 精确版本、严禁读取/输出/提交 `.env` 密钥、evidence 纪律）。
2. [README.md](../../README.md) 与 [docs/README.md](../README.md)：当前 v1 封存定位与统一文档索引。
3. [docs/V1-CLOSURE-AND-V2-MIGRATION.md](../V1-CLOSURE-AND-V2-MIGRATION.md)：**现行最终收官与 v2 迁移处置文档**。
4. [docs/phase5/reports/phase5-final-closure.md](https://github.com/NorthAdb/AegisPi/blob/v1-zero-trust-baseline/docs/phase5/reports/phase5-final-closure.md)：Phase 5 终局收口报告（单元 5.6 许可 2 实盘与 CalDAV 延后裁定）。
5. [docs/phase4/reports/user-value-report.md](https://github.com/NorthAdb/AegisPi/blob/v1-zero-trust-baseline/docs/phase4/reports/user-value-report.md)：全量聚合报告（**327/327 PASS**）。
6. [docs/phase3/reports/image-digest.md](https://github.com/NorthAdb/AegisPi/blob/v1-zero-trust-baseline/docs/phase3/reports/image-digest.md)：现行 OCI 镜像 digest（随后续自用改造更新至 `agent:phase3-357d3a70e2ea`）。
7. [.audit/decision-trail.tsv](https://github.com/NorthAdb/AegisPi/blob/v1-zero-trust-baseline/.audit/decision-trail.tsv) 末尾 `D-102`、`D-103`：Phase 5 终局裁定与实测费用记录。
8. 设计包规范（仓库外）：`D:\AegisPi\aegis-pi-design-pack-v1.4.1\docs\04-Frontend-Console-UX-and-6-Phase-Taskbook.md` 第 6 节。

---

## 二、Phase 5 收官时点基线快照（`724018a`，历史实测）

- **运行时、锁文件与 Schema 指纹**：锁定 Node `D:\AegisPi\tools\node-v22.23.5\node.exe`（`v22.23.5`）、`@earendil-works/pi-coding-agent` / `pi-ai` exact `1.5.2`、`hono` exact `4.13.19` + 内置 `node:sqlite`、canonical `schema.sql` 27 表 + 10 FTS + 3 触发器；`apps/daemon/config/defaults.json` 保持全失败关闭（`$0.80 / $5.00` 硬上限）。
- **时点回归**：`report:user-value` **327/327 PASS**（`defaultsFailClosed=true`，零密钥扫描 clean）；单元 5.6 实盘通过 Telegram `getUpdates` 隔离与邮箱 IMAP → DeepSeek（483 microUSD）→ 4310 审批 → SMTP 恰 1 封回信；真实 CalDAV 登记 `DEFERRED / NOT VERIFIED`。*(注：在 `1b847e7` 自用改造封存基线上，`evals/phase5/selfuse/run.mjs` 另增至 `31/31 PASS`，`agent` 镜像亦已随 `apps/daemon/src` 改动更新。)*

---

## 三、当时识别的自用限制与最终闭环状态

> 下表原为 Phase 5 刚收官时的自用缺口评估；右侧“后续闭环状态”已按最终封存基线（`25fe3ea` / `v1-zero-trust-baseline`）逐条对齐，**已做完的不再标为未做，承诺不做的不再标为待做**。

| 类别 | `724018a` 时点现状 | 最终闭环状态（以 `v1-zero-trust-baseline` 为准） |
| --- | --- | --- |
| **通用会话多轮上下文** | `daemon.mjs` 原按单条 `modelRequest` 提问回答，无上下文历史拼接 | **【已部分升级 + 终局由 v2 替代】**：`357d3a7` 已加入同域多轮历史拼接（`buildScopedThreadMessages`）与 `/api/chat` 多轮对话；容器内多步工具自动循环已裁决在 v1 停步，v2 改用 `pi-durable@1.6.0` 原生内核 |
| **首次自用部署与配置脚手架** | 缺少私有配置模板、初始化脚手架与界面设置入口 | **【已于 `289bd42` / `1b847e7` 完成】**：已交付 `scripts/selfuse.mjs start` 零参数冷启动、自动生成 `selfuse.local.json`、Web Console `⑤ 设置与接入` 界面配置、连通性测试与运行时原地热重载（`selfuse 31/31 PASS`） |
| **邮件分诊 vs 通用自动草稿** | 仅 `mail-triage.mjs` / `briefing-followup.mjs` 特定入口打通，未与统一自用分发串接 | **【已于 `289bd42` 完成】**：已通过 `selfuse-dispatch.mjs` 统一接通邮件分诊、规则内自动起草审批卡及晨报跟进 |
| **CalDAV 真实通道** | `CALDAV_*` 未配置，仅通过 Permit 1 环回夹具 | **【长期后置】**：继续作为按需后置项，不在 v1 阻塞或补做 |
| **Telegram 公网 Webhook** | 公网入口关闭，走路线 1 `getUpdates` 长轮询 | **【随 v1 封存抛弃】**：v1 固定走 `getUpdates` 长轮询，公网 Webhook 不再在 v1 实现 |
| **平台与 P3 已知小瑕疵** | ① `adapters.mjs` 与 `mail-triage.mjs` 对 `allowedRecipients` 大小写不一致；② `briefing-followup.mjs:174,218` 读错 `content_hash` 及死辅助 `enqueuePlain`；③ Windows `proposals` ACL 粒度受限 | **【①② 已于 `289bd42` 修复；③ 维持平台边界】**：大小写已归一化、`briefing-followup.mjs` 已修复、死辅助已清除；Windows `icacls` 仅作为本机账号级平台边界保持 |

---

## 四、关于旧 Phase 6 与路线讨论的最终归档

- 本文原先的 **“第四节 暂缓启动 Phase 6，未来重启参考”** 与 **“第五节 新对话推荐讨论路线 A / B / C”**，现已**全部完结并由 [../V1-CLOSURE-AND-V2-MIGRATION.md](../V1-CLOSURE-AND-V2-MIGRATION.md) 取代**：
  - 路线 A 与路线 B 中的个人自用配置脚手架、Web 控制台设置页、多轮历史对话和 P3 小瑕疵均已完成；
  - 其余未尽设计项已统一按 **“v2 新架构替代 / 随 v1 封存抛弃 / 长期后置 / 吸收进 v2 主线”** 分类裁决完毕，**v1 不再重启旧 Phase 6**。

---

## 五、归档约束保留记录

- Node 显式锁定 `D:\AegisPi\tools\node-v22.23.5\node.exe`；
- `apps/daemon/config/defaults.json` 全程保持失败关闭；
- 密钥仅存本机 `.env`，严禁入库或输出至公共日志；
- 本文已随 `v1-zero-trust-baseline` 正式归档至 `docs/v1/HANDOFF-PHASE5-TO-SELFUSE.md`。
