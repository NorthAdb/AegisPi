# Phase 3 真实验收执行记录：B（真实外部写），2026-11-20

主人 2026-11-20 书面授权「仅限本次」执行计划 B 项（真实外部写，恰 1 次 POST）；D（公网 webhook）、Telegram、新的真实模型调用均**未授权、未执行**。本文件是执行后交付的简要结果；详细断言与输出在 `docs/phase3/evidence/`。全程锁定 Node 22.23.5。

## 执行摘要

- **次数**：恰 **1 次** POST 到主人指定的可丢弃端点 `https://webhook.site/7b38d120-9947-4427-8d1e-86434713190a`（授权 =1，已消耗）。载荷为真实传输的内部 JSON 信封 `{kind:"submit", businessKey, idempotencyKey, operation, at}`，`operation` 为适配器字段 `{operation:"im.notify", targetResource:"im:dm:6101", expectedHead:null}`。无认证头（仅 `content-type: application/json` 与 `x-aegispi-request-kind: submit`），载荷零凭据，无平台 API 客户端，无任何 GitHub/仓库/PR 写。
- **effect 终态**：`SUCCEEDED`，`external_id = ext-b-acceptance-001`（端点配置响应返回的真值，与预期一致）。
- **businessKey**：`notify:dm%3atelegram%3a6101:case-external-write-real-b`（供主人在端点页面核对载荷用；`idempotencyKey` 为 null，如实）。
- **入口脚本退出码**：`test:external-write:real` **exit 1**（3 项检查 1 PASS / 2 FAIL）——两个 FAIL 是**脚本断言词汇错误，不是行为失败**，详见下节；五项通过标准全部成立，由只读复核 `test:external-write:postverify` exit 0（3 PASS）对同一对 scratch 库重新核实。
- **执行前探测**：无（按主人指令未先探测；执行前对该端点请求数为 0）。

## 通过标准逐项对照（主人授权口径）

| # | 标准 | 结果 |
| --- | --- | --- |
| ① | effect SUCCEEDED 且 external_id 为端点返回真值 | **成立**：SUCCEEDED，`ext-b-acceptance-001` |
| ② | 端点侧恰好收到 1 份载荷 | **成立（本地侧证明 + 主人人工核对）**：`effect_submitting` 审计恰 1 行（本效果 1/全库 1），AT_MOST_ONCE 终态无重试路径；请主人在 webhook.site 页面人工核对恰 1 份 |
| ③ | 无第二次提交 | **成立**：submit 审计 1 行、attempt_count=1、无 `effect_failed_local/failed_remote/unknown`；一次性守卫复核 exit 4（证据文件已存在时入口拒跑，零网络） |
| ④ | 未授权对照仍零字节 | **成立**：同宿主链路新 scratch、policy=false，effect FAILED（`local_error: adapter refused: real external writes`），`adapter_refused` 审计 1 条，`effect_failed_local` 审计行自带 `bytes_sent: 0`；对照零外部字节 |
| ⑤ | 审批链在案 | **成立**：`effect_proposed → approval_consumed（CAS 审批）→ effect_submitting → effect_succeeded` 逐行在案（完整顺序见 postverify 证据） |

## 入口 exit 1 的如实说明

入口脚本两个断言用了代码不产生的审计词汇：其一要求 `effect_draft_to_ready ≥ 1`——该码只属「预批准窄例程」路径（effects.mjs：人工审批效果从不以 DRAFT 创建，READY 翻转在 CAS 审批事务内完成）；其二要求对照组 `effect_submitting = 0`——而 dispatcher 设计上是先 CAS 提交 SUBMITTING（1 行提交承诺）再过适配器门，门拒绝后的 `effect_failed_local` 审计行自带 `bytes_sent: 0`，零字节证据在该行里。修正后的断言已回写入库脚本（`evals/phase3/external-write-real/run.mjs`），并由 `postverify.mjs` 对**同一对已执行 scratch 库**只读重核（零网络、零新字节）：3 PASS，`external-write-real-postverify-*` 证据在案。原始执行输出 `external-write-real-*` 保持一字未改，供独立复核比对。

## 开关与默认值收口（执行后立即恢复）

- 仓库 `apps/daemon/config/defaults.json` **全程未改**（git diff 0 行）：`policy.allowRealExternalWrites` 保持 false、`upstream.submitUrl` 保持 null（失败关闭默认）。真实端点/开关值只存在于临时工作区 test-config（`workspace-state/`，gitignored）。
- **一次性守卫已验证**：再次运行入口脚本 exit 4 拒跑、零网络——第二次提交在结构上不可能；重跑需新的书面授权。
- `credentials.im` 在本路径只是宿主侧槽标记（配置值即标记，传输子进程无任何认证头），全程无密钥值参与；密钥扫描（`sk-`/Bearer/token 形态）对全部新证据零命中。
- 两个 scratch 工作区保留在 `workspace-state/phase3/external-write-real-{b,control}`（gitignored，只读供独立复核），test-config 随工作区留在本地不入库。

## 边界重申

- 未做：D（公网 webhook）、任何 Telegram 调用、任何新真实模型调用、任何 GitHub/仓库/PR 写、任何平台 API 客户端。
- 本记录**不**构成真实仓库闭环或 Phase 4 开始；Phase 4 不进入，常开不宣布。
- 费用：零（一次普通 HTTPS POST）。

## 证据

- `docs/phase3/evidence/external-write-real-log.md` / `external-write-real-report.json`：入口执行原始输出（1 PASS / 2 FAIL，如实保存）。
- `docs/phase3/evidence/external-write-real-postverify-log.md` / `external-write-real-postverify-report.json`：只读复核（3 PASS，含两个库的完整审计顺序）。
- 入口与复核脚本：`evals/phase3/external-write-real/run.mjs` / `postverify.mjs`（npm：`test:external-write:real`，缺库时 postverify exit 3）。

本记录与证据入库后，等待主人安排独立复核。
