# Telegram 真实调用账本追溯（2026-11-20，主人指令）

主人 2026-11-20 指令：不能仅凭「事故 2 + 本轮 2 = 4/4」宣布历史账本完整；仅用 git 历史、本地日志与既存材料追溯各次真实调用的时间、次数与授权依据；找不到原始材料就如实记缺失，禁止补造或重新调用来补证。本文全程零新调用（不重跑任何 real 入口、不探测任何端点）。

## 0. 使用的材料（全部既存，无新增外部动作）

| 材料 | 内容 |
| --- | --- |
| git 历史 | `git log --follow` + `git show`：`docs/phase3/evidence/ingress-telegram-real-{log.md,report.json}` 首次入库于 `dd80987`（提交时间 2026-11-20 00:37:50 +0800）；`git diff dd80987..HEAD` 显示两文件相对旧版**仅生成时间一行不同**（正文与 update_id 500045892 完全相同） |
| 旧版证据原文 | `dd80987` 版：generatedAt `2026-11-19T15:17:35.018Z`（HKT 2026-11-19 23:17:35），3 PASS（@aegispibot / 队列读 1 条无 offset / update 500045892 OBSERVE），dataSources 注明「主人授权 bot token 的只读调用…simulate-no-token=false」 |
| 现版证据原文 | HEAD（`ec23ef7`）版：generatedAt `2026-11-20T05:30:02.319Z`（HKT 13:30:02），正文与旧版逐字相同 |
| 决策日志 | D-35（2026-11-19，证据列：「telegram 真实只读（getMe/getUpdates 零发送零消费）经授权 token 实证」）、D-47（2026-11-19：「real（授权 token）3/3（@aegispibot、1 update 读后即止、OBSERVE、零发送零确认）」）、D-61（事故申报）、D-62/D-63（≤4 账本口径来源） |
| 收口报告 | `phase3-closure.md` §2（收口时点描述「真实只读源（主人授权 bot，Phase 1 同一凭据）：getMe 确认…getUpdates 只读取队列…一条真实 update 以 OBSERVE 落入本地演练库」） |
| 开工移交 | `D:\AegisPi\PHASE3-KICKOFF-HANDOFF.md` §2 第 7 项：「真实 ingress 与凭据生命周期…**只对接明确授权的测试源**…不向真实同事或公开仓库发测试消息」（real.mjs 头注所指 "handoff section 2.7" 即此授权依据） |
| 入口脚本源码 | `evals/phase3/ingress-telegram/real.mjs`：getMe ×1 + getUpdates ×1（limit:1, timeout:0）、断言全程无 offset 参数（capturedUrls 检查）、第三检查把首条 update 以 OBSERVE 落入 scratch 库（`makeWorkspace("ingress-real-update")`） |
| 本地 scratch 库（只读） | `workspace-state/phase3/ingress-real-update/db/aegis.db`：inbox 行 `inb:telegram:500045892`，verdict OBSERVE、state DONE，**received_at `2026-11-20T05:30:02.177Z`** |

## 1. 各次真实调用：时间、次数、授权依据

| # | 时间（HKT） | 调用 | 授权依据 | 证据 |
| --- | --- | --- | --- | --- |
| T0 | 2026-11-19 23:17:35 | getMe ×1 + getUpdates ×1（3 PASS，读到 1 条 update，OBSERVE，零发送零 offset） | 开工移交 §2 第 7 项「只对接明确授权的测试源」+ Phase 1 同一主人授权 bot token（收口报告 §2 原文如上） | dd80987 入库的证据两件（generatedAt 15:17:35.018Z）；D-47 行「real（授权 token）3/3」 |
| T1（事故） | 2026-11-20（文案验证时误触） | getMe ×1（通过）+ getUpdates ×1（网络层 ECONNRESET，exit 1） | **无**（未授权，误操作，D-61 如实申报） | 无独立落盘证据：原始 stdout 未留存（如实记缺失）；被覆盖的工作树证据文件当时已 `git checkout` 还原为 dd80987 版 |
| T2 | 2026-11-20 13:30:02 | getMe ×1 + getUpdates ×1（3 PASS，读到同一 update 500045892，OBSERVE，零发送零 offset） | 主人 2026-11-20 逐项书面授权（仅限本次，恰 2 次） | HEAD（ec23ef7）证据两件 + **scratch 库 OBSERVE inbox 行**（received_at 05:30:02.177Z）+ D-63 行 |

## 2. 旧成功记录与本轮记录的关系；本轮的独立依据

- **旧成功记录（T0）不是本轮的产物**：它是 2026-11-19 收口时点一次更早真实运行的入库证据，事故后被 checkout 还原保住，本轮（T2）重跑时才被新生成时间覆盖。git diff 已核实新旧两版**只差生成时间一行**。
- **同一 update_id 500045892 出现在 T0 与 T2 证据**：两轮都以 `limit:1, timeout:0` 只读队列且**从不带 offset 参数、从不确认消费**（real.mjs 断言在案），未消费的 update 对后续读取持续可见。因此同一 update_id 既**不能**据此认定本轮伪造（T0/T1/T2 任何一轮都可能读到同一条），也**不能**反过来证明本轮执行——这个判据中性。
- **本轮（T2）的独立生成依据**，除证据文件的新时间戳外还有一件结构物证：gitignored scratch 库 `workspace-state/phase3/ingress-real-update/db/aegis.db` 中的 OBSERVE inbox 行 `inb:telegram:500045892`，**received_at `2026-11-20T05:30:02.177Z`**，与证据文件 generatedAt `05:30:02.319Z` 相隔 142ms——同一次执行过程写下的两个独立落盘痕迹（库行 + 报告），且 `makeWorkspace` 先删后建，该行只能来自最后一次运行（T2），不可能是 T0 遗留。
- **T0 自身的 scratch 库行已不可考**：同一工作区标签被后续运行复用（rmSync 重建），T0/T1 的库行无法保留——如实记缺失。T1 的原始输出同样未留存（D-61 已申报）。

## 3. 账本是否遗漏更早调用；哪些事实无法确认

**「≤4、已用 2、剩 2」口径的来源与盲区**：该口径出自确认审计 `AUDIT-PHASE3-REREVIEW-3cd0652`（第 5、6 节，字节冻结不改）对 C 项的框定，随后进入计划 C 表（`real-acceptance-plan.md`）、回应映射（`audit-response-rereview-3cd0652.md`）、D-62/D-63 决策行与 `real-acceptance-run-a-c.md`。它只计了 T1（事故 2 次）+ T2（计划内 2 次），**从未计入 T0 的 2 次**——收口日那次更早的真实只读调用从未进入任何账本。

**仓库材料可确认的最小总数**：**6 次真实只读调用**（T0 2 + T1 2 + T2 2，三轮各 getMe+getUpdates）。

**仍无法确认的事实**（如实列缺失，不以新调用补证）：

1. **2026-11-19 当晚的真实运行次数**：仓库只有一份该日的落盘证据（23:17:35 那次），但决策日志有三处文字指向该验证（D-35 证据列、D-47、收口报告 §2）。若 D-35 所述收口期验证与 D-47 所述整改期验证是**两次独立运行**，当日调用为 4 次、总数升至 8 次；若是同一次，则为 2 次、总数 6 次。会话过程日志不在仓库内，脚本无逐次 wire 日志，**无法从既存材料判定**。
2. 是否存在更早（证据采集开始之前）的调用：无任何 artifact，无法证实也无法排除。
3. T1 的原始输出（缺失，见 D-61）；T0 的 scratch 库行（被复用标签覆盖，缺失）。
4. 「≤4」上限的**原始意图范围**是否本应涵盖 T0：上限写作时未与开工移交口径对账，材料无法还原当时意图——只能如实记录：按字面「≤4 总额」计，事实总数（≥6）已越过该框定；但 T0 的授权依据是另一份文书（开工移交 §2.7），不是 C 项计划。上限的解释权归主人。

**处置**：本文不修改任何字节冻结件（审计原稿、旧证据）；`real-acceptance-run-a-c.md` 与 `errata-2026-11-20.md` 以勘误另记。**任何后续 Telegram 调用都需要主人新的逐项书面授权**——T0 的移交依据已随 Phase 3 交付闭合，T1 无依据，T2 仅限本次已用尽。本轮追溯未发起任何新调用。
