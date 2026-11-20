# Phase 3 复审 11d649a 逐项回应与收口报告

生成：2026-11-20。对象：独立复审 `AUDIT-PHASE3-REREVIEW-11d649a`（判定 MET WITH RESIDUAL RISKS）。复审原稿已逐字节归档于 `docs/phase3/audits/AUDIT-PHASE3-REREVIEW-11d649a.md`，SHA-256 `05aa99580c594a184a2c9c36c5e2ea022018427988b0f427bb099940648d3a0b`，与移交一致，原文一字未改；本回应另写，勘误不覆盖审计原文。

## 0. 结论（不变）

维持复审判定 **MET WITH RESIDUAL RISKS**。本轮只做收口整改：不改任何生产调度、授权或预算语义，不重开已关闭项（F2-F8 保持关闭），不扩大功能范围。常开：否。Phase 4：否。真实模型账单、真实外部写、公网 webhook、Telegram 真实只读仍为授权待验，四项最小验收计划见 `docs/phase3/reports/real-acceptance-plan.md`，提交即等待逐项授权，未执行。

## 1. 收口项逐项回应

### 1.1 security-unit 两条 HTTP 时序用例（复审实测 39/2）

- 复审失败机理（复审已定位）：审批决策把 `next_attempt_at` 设到播种后 100ms（`approvals.mjs` 的 consume CAS 以决策 `now` 写 `next_attempt_at`），快机器首次 `--once` tick 落在到期点之前，daemon 的到期筛选（`state='READY' AND next_attempt_at<=?`）不选中该行，停在 READY、零请求。到期后生产路径成立（复审独立探针已证）。
- 修法（控制时钟，不加大 sleep、不削弱语义）：`seedReadyEffect` 的审批决策时刻改为播种时刻——生产形态本就是「人在 T 批准即 T 到期」，spawn 的 tick 真实时钟必然晚于播种时刻，竞态结构性消除，与机器速度无关。决策时刻保留 `decideAt` 参数以钉未来到期点。
- 新增两条确定性回归（41 → 43 judged），把原先被竞态偶然触碰的调度语义变成正反双向钉死：
  - `not-yet-due-effect-is-not-dispatched-even-when-authorized`（daemon 层）：决策时刻钉在未来 60s，**授权配置**下生产 tick 零字节、效果行保持 READY、无 `effect_submitting` 审计——授权不等于到期。
  - `dispatcher-refuses-before-due-time-and-commits-at-it`（dispatcher 层）：受控时钟下到期前 1ms 的 CAS 拒绝（零审计行、行仍 READY），到期即提交、传输恰见一次 delivery。
- 生产代码零改动。断言未削弱：(b)/(c) 原断言保持，(d)/(e) 只加强。
- 结果：修复前本机基线 41/41 exit 0——本机较慢，未复现快机竞态，与复审 39/2 实测不矛盾（竞态是机器速度的函数，本轮消除的正是这个依赖）；修复后 43/43 exit 0（锁定 Node 22.23.5）。

### 1.2 原镜像可交付证据（F1 交付半边，不重开 F1）

- 根因：复审环境的 registry 404 是因为原镜像从未推送到审计机——三枚 manifest 字节一直在实施者机的构建 registry（`127.0.0.1:5000`，容器 `aegispi-build-registry`），digest 与机器块逐一相符（agent `sha256:1bed0ab1…`、acquisition `sha256:3c5b4dba…`、execution `sha256:202dfcd4…`）。
- 交付方式：`docker save` 按 digest 钉住引用导出三份 **OCI image layout 归档**至实施者机 `D:\AegisPi\phase3-image-archives\`（仓库外目录，不进 git，构建上下文清单内无任何凭据）；文件移交通道由主人自选，未公开上传、未部署任何服务、未上传任何凭据。归档 SHA-256/字节数/独立环境校验步骤（blob 内容寻址自证 → docker load → 自建 loopback registry 复跑隔离套件）写入 `docs/phase3/reports/image-delivery.md`。
- 自证实测（2026-11-20）：三归档解包后 manifest blob 哈希等于文件名且等于机器块 manifest 列；config blob 哈希等于机器块 config 列且声明 `os=linux architecture=amd64`；终树 context 重算三枚一致（`0eee2b6f…`/`8abae275…`/`8183df14…`）。
- 原镜像验证 vs 同 context 重建验证已在交付文档明确区分：复审机的隔离与红证跑在**同 context 的本机重建**（agent `f5977991…`、acquisition `7bbf414d…`、execution `ee512211…`）上，属重建验证；不要求、也不应期待不同构建产生相同 manifest digest，digest 差异不构成伪造判据，绑定判据是 context 一致 + 归档自证哈希。
- 本轮在**原 manifest** 上直接复跑补齐行为证据：offline-jobs 14/14、security-integration 29/29、quota-calibration 5/5，均 exit 0，image-gate 三重绑定（context/registry/config+平台）全过。

### 1.3 文档事实更正（不覆盖历史，git 原文可查）

- `image-digest.md` 人读行对齐：提交时间戳链实测为 5250243=11:00:11 → 构建 11:07:49 → f413046=11:16:06（HKT）。构建时 HEAD 为 `5250243`（tag 字符串与人读「源码提交」沿用其短 SHA），但工作树已含其后 `f413046` 的 `daemon.mjs`/`config.mjs` 改动——三枚 manifest 字节由该内容构建，机器块 context 列即该内容哈希。人读行已改为两纪元表述：本行 manifest/config/context 是 `f413046` 内容的构建记录（`11d649a` 相对 `f413046` 仅改 `docs/`，镜像输入与终树一致）；`f413046` 之前一轮记录（manifest `64e282f5…`、context `6ac4f3dc…`）对应 `8af0966`→`5250243` 期间的树。绑定一律以机器块 digest 为准。
- `--simulate-no-token` 文案更正：入口先探测本机 `.env` 实况再分流——有 token 的机器如实说「存在于本机（本次演练缺凭据路径）」，无 token 的机器改说「本就未配置（演练的即真实状态）」，不再在无 token 机器上声称「token 存在于本机」；两种入口退出码维持 3（复审实测的无旗标 exit 3 行为不变，本机 simulate 实测 exit 3 且文案与实况相符）。
- 39/2 实测与修复结果的记录方式：复审实测数字由归档审计原文保存（历史不改写）；本轮 `evidence/security-unit-log.md` 由重跑刷新为 43/43。

### 1.4 模型路径与 Pi 的关系（单列报告）

`docs/phase3/reports/model-path-and-pi.md`，要点：

- 02 §4「模型」适配器行的宿主义务——授权检查、价格检查、预留检查、固定端点、全部响应计费、限制输出——逐条对照实现位置（daemon.mjs 调用链 file:line）并附实测。
- Pi 的三重角色分清：①Phase 1 契约对象（PI-09/PI-10 + 一次真实最小推理，契约知识在库）；②容器内离线 agent 运行时（PI_OFFLINE=1，自检绿只证边界不变量）；③宿主推理客户端是最小 OpenAI 形状直连（`model-call.mjs`），daemon 不 import Pi SDK——设计未强制宿主调用走 Pi SDK，但 Pi 契约知识当前未进生产路径。
- 缺口如实开放：**A**（容器→宿主的模型调用提议链路未接，02 §4「Agent提出模型和purpose」的提议侧未实现，容器 worker 通道现仅 announce/receipt）；**B**（Pi SDK 形态的宿主调用未接，是否替换由后续阶段 ADR 定夺）；**C**（真实 provider 未调用，归入验收计划 A 项）。不以自检绿宣称 Pi 端到端，未另建平行 agent 循环。

### 1.5 最小真实验收计划（提交即等待，未执行）

`docs/phase3/reports/real-acceptance-plan.md`：真实模型（DeepSeek 官方端点，≤2 次调用、总额 ≤$0.01）、真实外部写（1 个 effect、主人自有可丢弃目标、次数上限 1）、Telegram 只读（getMe+getUpdates ≤4 次、零费用）、公网 webhook（setWebhook/deleteWebhook 各 ≤1、测试消息 ≤3）。逐项列端点、凭据槽（仅槽名，值只进本机 `.env`/宿主凭据服务）、动作范围、费用/次数上限、通过与回滚标准；失败即停不自动重试。Phase 4 仓库业务闭环不在计划内。

## 2. 事故申报（执行边界违规，如实记录）

2026-11-20 整改中，实施 agent 在验证 `--simulate-no-token` 文案修复时误运行了无旗标的 `test:ingress-telegram:real` 一次，越过本轮「不复验 Telegram」的执行边界，构成一次计划外的真实只读调用：getMe 通过（@aegispibot 身份）、getUpdates 网络层 ECONNRESET、套件 exit 1。无 sendMessage、无 offset 确认、零费用、token 未进任何日志。该次运行覆盖的 `evidence/ingress-telegram-real-*` 已 `git checkout` 还原为提交版本。已记入决策日志 D-61 与验收计划 C 项事故栏，是否计入 C 项次数由主人裁量。

## 3. 本轮重跑矩阵（锁定 Node 22.23.5；Windows 构建机；Docker 29.9.2）

| 套件 | 计数 | 退出码 | 备注 |
| --- | --- | --- | --- |
| security-unit（修复前基线） | 41/41 | 0 | 本机较慢，未复现快机竞态；复审机 39/2 见归档审计 |
| security-unit（修复后） | 43/43 | 0 | 新增 (d)(e) 两条到期门回归 |
| security-unit（最终树确认重跑） | 43/43 | 0 | 全部整改落盘后在同一锁定 Node 复跑 |
| offline-jobs | 14/14 | 0 | 原 manifest；image-gate 三重绑定过 |
| security-integration | 29/29 | 0 | 原 manifest；含 offline-jobs 再跑与桥接对照 |
| quota-calibration | 5/5 | 0 | 原 manifest |
| cancel-approval | 16/16 | 0 | 审批/取消回归（含 model.inference 适配器门禁） |
| ingress-telegram（本地） | 7/7 | 0 | |
| ingress-telegram real `--simulate-no-token` | NOT VERIFIED | 3 | 文案与本机实况相符 |
| ingress-telegram real（无旗标） | 本轮未运行 | — | 边界内不运行；唯一一次误运行见第 2 节 |

镜像证据来源：原三枚 manifest 字节（实施者机 registry + OCI 归档 + blob 自证，见 1.2 与 image-delivery.md）；context 哈希在最终提交树重算三枚一致。

## 4. 未验收项与残留（保持复审原判，不改称已解决）

**授权待验**（计划见 real-acceptance-plan.md）：真实模型端点、`model` 凭据槽、真实价格目录与单次上限；`allowRealExternalWrites=true` 指向真实平台及对应凭据槽；公网 webhook 的 Host 绑定与真实 secret；Telegram 真实只读；原镜像字节向独立环境的实际移交（归档已备好，通道待主人指定）。

**普通残留**（复审清单原文保持，未新增未消项）：备份库为明文 SQLite（密封的仅 manifest）；同主机重定向允许换端口；备份先哈希后复制的替换窗口；4 GiB 全量写未做（quota 用有界用例）；PID 复用窗口；stdout 微秒竞态未稳定复现；`image-digest.md` 构建输入树与人读/tag 字符串的两纪元关系（本轮已对齐表述）；短 webhook secret 未捕获异常 exit 1；模型调用 bearer 经短命子进程 argv；缺口 A/B/C（模型路径报告第 5 节）。

## 5. 出口

Phase 3 维持 **MET WITH RESIDUAL RISKS**：复审点名的套件时序、镜像交付、文档偏差已收口；模型路径与 Pi 的关系已按设计对照写明并保留缺口。不重开 F1-F8，不进入 Phase 4，不宣布常开。四项真实验收等待主人逐项授权；本报告与全部整改证据入库，最终提交 SHA 见 git log。
