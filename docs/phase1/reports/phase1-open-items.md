# Phase 1 未决项（2026-11-19 收口版）

按规范要求逐项列出已做/未做，不写笼统“全绿”。**Phase 1 已按 owner 授权收口**（声明见 phase1-closure.md）：下述用户侧四项全部闭合；工程项按规范属后续阶段安排，不构成 Phase 1 阻塞。

## 用户侧收口项（全部闭合，2026-11-19）

1. ~~DeepSeek API key 安全录入 + 一次最小推理契约~~ **完成**：单次真实推理通过（stopReason=stop、回复 "OK"、usage 463、cost.total $0.0001407、无重试未换模型）。evidence/07 §1；脚本 `evals/phase1-closure/verify-deepseek-minimal.mjs`。
2. ~~通知渠道机器侧核验~~ **完成**：Telegram getMe/getChat 复测退出码 0（@aegispibot、is_bot、private、idMatchesOwner、startConfirmed=true；经 owner 自配的本机系统代理）。evidence/07 §2。
3. ~~基线三句话~~ **完成**：owner 填入本地 owner-baseline.local.md §2（只盯 NorthAdb/AegisPi、默认只读、需关注事件才通知）。
4. ~~75 条标注确认~~ **完成**：owner 复核确认（12 条 uncertain 对照官方发行说明复核后转「可忽略」，终态 39/36/0），labels 文件实测与记录一致（本地不入库）。

## 工程未决项（后续阶段安排，非 Phase 1 阻塞）

4. **三个应用镜像未构建**：Phase 1 无产品代码，Dockerfile 源文件与基础 digest 已入库；首次构建（Phase 3 前置）时记录真实应用 digest。
5. **容器占位配额未校准**：按 06 §4 属 Phase 3 真实压测任务。
6. **宿主 HELD 账本未实现（Phase 2）**：PI-10 已实测"缺 usage = 数字全零且无 totalFromProvider 键、零值不可区分 provider 未上报"的形状，但**记账门禁本身属宿主账本代码**——Phase 1 未实现、不宣称完成；Phase 2 落地前不得把缺 usage 响应当零成本结清。
7. **探针未覆盖项（如实列出）**：cacheWarming 的真实 warm 请求周期（需 TTL 级等待 + 真实计费，Phase 4 证据）；codemode 256MB OOM 行为（文档值，不做安全边界）；两对 hono oracle 的容器化 security_repro job（方向性证据已实测闭合：4.12.24 上 csrf 放行 exit 1、cors 反射 exit 1，配对自检工具在库；容器化重跑仍按规范留在 Phase 4）。

## 与开工检查单的实测差异（2026-11-19 修订：撤回 v1 的一处错误“纠错”）

- **GHSA-88fw 实存**：v1 曾写“检查单描述的 GHSA-88fw CORS 凭据反射（High，<4.12.25）在 advisory API 不存在”——**该结论错误**，根因是 v1 拉取用了 `per_page=20` 被分页静默截断（GHSA-88fw 发布于 2026-06-09，排在截断点外）。全量拉取（per_page=100，共 61 条）核实：GHSA-88fw-hqm2-52qc（high，CVE-2026-54290，<4.12.25，CORS 默认通配 origin + credentials 时反射任意 Origin）真实存在。**检查单的三分类示例意图全部成立**，且已为它建立第二对 oracle（oracle.hono-cors.json，A1/A2 实测闭合）。教训入 D-09。
- 检查单预估窗口约 47 个候选事件；实测 **75 个**（45 稳定 release + 30 advisory，[2026-05-18, 2026-11-18) 端点排他）。
- 检查单记忆的“readline 拆 U+2028”现象在锁定 Node 22.23.5 不复现（v24 系才复现）；字节 LF 分帧契约维持不变，理由已写入 PI 契约报告（现为可失败断言）。
