# 单元 4.2 许可 2 广度真实 Repo Observe 验收报告

> **日期**：2026-11-21（Asia/Hong_Kong）  
> **基准提交**：`80db01fd1c53be8c5876291f0cde84d2eeed5afb`（`main`，Epoch 6）  
> **授权来源**：主人 2026-11-21 对单元 4.2 许可 2 七项检查表的书面授权（扩展第三方与个人公开仓库测试，启用 `https://api.deepseek.com` 真实推理，不入库 `defaults.json`，不触发未实现的外发通知；决议留痕 [decision-trail.tsv](../../../.audit/decision-trail.tsv) `D-83`）  
> **运行脚本**：[evals/phase4/repo-observe-real/run.mjs](../../../evals/phase4/repo-observe-real/run.mjs)（`AEGISPI_ALLOW_REAL_OBSERVE_ACCEPTANCE=1`，缺此环境变量 `exit 4`）  
> **运行环境**：Windows 11（Docker Desktop `29.9.2` + Epoch 6 钉住 `agent` / `acquisition` 镜像），锁定 Node `v22.23.5`（`D:\AegisPi\tools\node-v22.23.5\node.exe`）

---

## 一、核心结论

在 **Epoch 6** 未修改任何生产代码与默认策略的前提下，对 **6 个锁定 commit 的公开 GitHub 仓库**与真实 **`https://api.deepseek.com`**（`deepseek/deepseek-flash`，`reasoning: "high"`）执行端到端广度实测，终跑结果 **8 PASS / 0 FAIL（exit 0）**：

- **累计实测结算**：终跑 7 笔已结算调用按高峰上限目录价共计 **`13,948 µ$`（约 `\$0.014`）**，按执行当刻（周六非高峰 5 折时段）实际应付估算约 **`6,976 µ$`（约 `\$0.007`）**；另含 1 笔刻意缺少 `outputPerMTokMicrousd` 的真实 `HELD` 停机对照组。
- **全过程边界完整守住**：`apps/daemon/config/defaults.json` 保持 0 行改动；`apiKey` 全程仅存在内存测试进程，落库与报告密钥扫描 **0 命中**；Docker 与临时解包目录退场清理 **0 残留**；`image-gate` 维持 `IMAGE_GATE_OK`。

---

## 二、测试目标仓库与真实场景覆盖

| 检查项 | 真实目标与固定 commit / ref | 抓取模式与覆盖能力 | 实测结果与成本（高峰目录价 / 非高峰估算） |
| --- | --- | --- | --- |
| `real-aegispi-302-codeload-and-chinese-summary` | `NorthAdb/AegisPi` `@8943a108df5fceb0a98a91771b23464e50c34dfb` | `tar`（真实 `github.com` → `302 codeload.github.com` 跨主机白名单重定向）+ 中文架构分析 | **PASS**：`SUCCEEDED` / `SETTLED`，`1088 µ$`（`~544 µ$`），`in=141 out=817 cache=10880`，`totalFromProvider=false`，`derived_from` 血缘完备 |
| `real-hono-v4-13-19-third-party-tar-observe` | `honojs/hono` `@676c8f80fcafc49e6e74c847a8f0d9c44cc7faee`（`v4.13.19`） | `tar`（第三方公仓包导出与多文件源码剖析） | **PASS**：`SUCCEEDED` / `SETTLED`，`930 µ$`（`~465 µ$`），`in=229 out=675 cache=8448` |
| `real-pi-agent-north-monorepo-and-sequential-ledger` | `NorthAdb/pi-agent-north` `@ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`（1947 blobs / 23.00 MB） | `tar`（大 monorepo 归档 + 单 target `maxDownloadBytes=32 MiB`）+ 同工作区先后双发调用验证非双倍分账 | **PASS**：两任务均 `SUCCEEDED` / `SETTLED`，`1798 µ$` + `559 µ$`（`cache=5376` ×2），日账 `1178 µ$` + 两任务账 `1179 µ$` = `2357 µ$`，无冻结 |
| `real-openpi-input-cap-truncation-settles-cleanly` | `NorthAdb/openpi` `@6c43f92756a93129abe282e587b6afdf0f7e99b0` | `tar` + 刻意收紧 `maxInputBytes=8192`（原选文 > 58 KB 触发 `fitPromptToMaxInputBytes` 安全截断） | **PASS**：`truncated=true`，`2515 µ$`（`~1258 µ$`），`in=145 out=2048 cache=2176`，`replyLen=3672` |
| `real-hermes-and-piper-single-file-observe` | ① `NorthAdb/hermes-agent` `@ddb56d0aa126` (`agent/AGENTS.md`)<br>② `NorthAdb/Piper` `@4484231e1913` (`packages/durable/src/index.ts`) | `mode: "file"`（直连 `raw.githubusercontent.com`，免拉取 182 MB / 50 MB 整仓） | **PASS**：`hermes` `501 µ$`（`out=350`）；`piper` `6557 µ$`（`in=249 out=5395 cache=1280`） |
| `real-failclosed-redirect-and-oversize-tar-stop-before-model` | ① `hono` tar（未授权 `codeload` 跳转）<br>② `hermes-agent` tar（182.57 MB，设 `2 MiB` 上限） | 真网反证：`acquisition` 容器阻止未授权 302 跳转并流式截断超大归档 | **PASS**：均于 `acquisition_failed` 终止，`agent` 与 DeepSeek **0 启动 / 0 调用** |
| `real-missing-price-keeps-held-and-stops-observe-task` | `NorthAdb/openpi` `@6c43f92756a9`（刻意设 `outputPerMTokMicrousd: null`） | 真模返回 `usage`（`in=179 out=134 cache=11392`）时验证欠价停机契约 | **PASS**：请求与账本保持 `HELD`，任务落 `FAILED(settlement_held_uncompleted)` + `observe_stopped_settlement_held` |
| `defaults-untouched-fail-closed-and-zero-key-leakage` | [defaults.json](../../../apps/daemon/config/defaults.json) 与本轮 telemetry | 持久化与密钥隔离自检 | **PASS**：默认配置维持全失败关闭，遥测与证据无任何 API key 残留 |

原始证据：[repo-observe-real-report.json](../../phase3/evidence/repo-observe-real-report.json) 与 [repo-observe-real-log.md](../../phase3/evidence/repo-observe-real-log.md)。

---

## 三、实测捕获的两项真实工程现象与后续建议

1. **首轮 `4096` 输出上限被 `reasoning: "high"` 思考链打满（如实留痕）**
   - 首轮运行（配 `maxOutputTokens=4096`、`callUpperMicrousd=25000`）获 **7 PASS / 1 FAIL**：前 7 组全过，唯一失败的 `Piper` 单文件导出列表任务在思考阶段耗尽全部 `4096` token（`actual=5374 µ$`、`out=4096`、`replyLen=0`）。将测试上限调整为 `maxOutputTokens=8192`、`callUpperMicrousd=50000` 后，同一提示词实际使用了 `5395` output tokens 完成思考与输出，全套 **8/8 PASS**。
   - **代码层面启发**：当前 [model-requests.mjs](../../../apps/daemon/src/model-requests.mjs) 的 `commitModelCallWriteback` 在模型真花费 token（正确 `SETTLED`）但返回 `reply === ""`（如因输出上限耗尽思考链）时仍会把 `tasks` 标为 `SUCCEEDED`。建议后续小版本把“账本按真实 `usage` `SETTLED`”与“交付态 `reply` 非空检查（空正文拒绝标 `SUCCEEDED`）”进一步解耦。
2. **目录价采用口径说明**
   - `model-binding.md`（`PI-10`）实测与本次全部实测一致：`api.deepseek.com` 不在 SSE 载荷里返回账单金额（`totalFromProvider: false`），宿主只能靠 `usage × priceCatalog` 自算金额并做预算冻结与扣减。任何正数 token 类若目录价为 `null`（如 `cacheReadTokens > 0` 而 `cacheReadPerMTokMicrousd=null`），按安全关闭原则必卡死 `HELD`。本次大量用例实测触发了 `2176–11392` 的 `cacheReadTokens`，验证了四类价格全部核定（或明确按高峰价 `300000 / 1200000 / 6000`、非高峰 `150000 / 600000 / 3000` 配置）的必要性。
3. **Telegram 能力边界诚实核定**
   - 此前延期的 **D 项是 Telegram 公网入站 webhook**（接收推送更新）。
   - 出站通知方面：当前 [ingress-telegram.mjs](../../../apps/daemon/src/ingress-telegram.mjs) 为只读构造（仅 `getMe`/`getUpdates`），[adapters.mjs](../../../apps/daemon/src/adapters.mjs) 与 `upstream-http` 仅发送通用 JSON POST 至内部测试端点，**仓库尚未实现调用 `api.telegram.org/sendMessage` 的真实 Bot 出站适配器**。因此本轮严格未虚构或外发 Telegram 消息，仅落本地持久化证据。如需真正具备 Telegram 主动推送能力，可另立一项小单元实现专用出站传输器并经 `policy.allowRealExternalWrites` + `credentials.im` 门禁放行。
