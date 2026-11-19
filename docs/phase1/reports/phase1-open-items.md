# Phase 1 未决项（2026-11-19 按三轮审计修订）

按规范要求逐项列出已做/未做，不写笼统“全绿”。

## 阻塞 Phase 1 收口的用户侧准备项（开工检查单已知，不阻塞开工）

1. ~~DeepSeek API key 安全录入 + 一次最小推理契约~~ **已完成（2026-11-19 第三轮）**：key 安全录入 `.env`（不入库）；锁定 Node 上经 Pi 1.5.2 对真实 `api.deepseek.com` **单次**最小推理（deepseek/deepseek-flash + thinking high）通过——`stopReason=stop`、回复 "OK"、usage 461+2=463、目录价 cost.total $0.0001407、无重试未换模型。脱敏证据 `evidence/07-real-connections.md`；脚本 `evals/phase1-closure/verify-deepseek-minimal.mjs`。
2. **通知渠道**：渠道已选定（Telegram Bot DM，@aegispibot，owner 已 /start——owner-baseline.local.md §1，本地文件）；**机器侧 getMe/getChat 核验因本机网络对 `api.telegram.org:443` TCP 不通未完成**（连接层失败，非凭据问题；未发送任何消息）。待可达网络/代理环境重跑 `evals/phase1-closure/verify-telegram-identity.mjs` 收口。打扰范围：owner 基线三句话已定（发现需关注的发布或安全公告时私聊通知，日常不发）。
3. **人工基线三句话**：owner 已填入 owner-baseline.local.md §2（关注范围只盯 NorthAdb/AegisPi、默认只读、发现需关注事件才通知）。**75 条标注草案已按该基线原则全量生成**（本地 labels 文件：30 公告该关注 + 9 修复版该关注 + 12 拿不准[uncertain:true，仍标该关注] + 24 可忽略；逐条带理由；含"评测夹具 ≠ 服务监控范围"声明）。**owner 逐条复核仍未完成**——尤其 12 条 uncertain 项；确认前 6b 不勾选、不宣布收口。

## 工程未决项

4. **三个应用镜像未构建**：Phase 1 无产品代码，Dockerfile 源文件与基础 digest 已入库；首次构建（Phase 3 前置）时记录真实应用 digest。
5. **容器占位配额未校准**：按 06 §4 属 Phase 3 真实压测任务。
6. **宿主 HELD 账本未实现（Phase 2）**：PI-10 已实测"缺 usage = 数字全零且无 totalFromProvider 键、零值不可区分 provider 未上报"的形状，但**记账门禁本身属宿主账本代码**——Phase 1 未实现、不宣称完成；Phase 2 落地前不得把缺 usage 响应当零成本结清。
7. **探针未覆盖项（如实列出）**：cacheWarming 的真实 warm 请求周期（需 TTL 级等待 + 真实计费，Phase 4 证据）；codemode 256MB OOM 行为（文档值，不做安全边界）；两对 hono oracle 的容器化 security_repro job（方向性证据已实测闭合：4.12.24 上 csrf 放行 exit 1、cors 反射 exit 1，配对自检工具在库；容器化重跑仍按规范留在 Phase 4）。

## 与开工检查单的实测差异（2026-11-19 修订：撤回 v1 的一处错误“纠错”）

- **GHSA-88fw 实存**：v1 曾写“检查单描述的 GHSA-88fw CORS 凭据反射（High，<4.12.25）在 advisory API 不存在”——**该结论错误**，根因是 v1 拉取用了 `per_page=20` 被分页静默截断（GHSA-88fw 发布于 2026-06-09，排在截断点外）。全量拉取（per_page=100，共 61 条）核实：GHSA-88fw-hqm2-52qc（high，CVE-2026-54290，<4.12.25，CORS 默认通配 origin + credentials 时反射任意 Origin）真实存在。**检查单的三分类示例意图全部成立**，且已为它建立第二对 oracle（oracle.hono-cors.json，A1/A2 实测闭合）。教训入 D-09。
- 检查单预估窗口约 47 个候选事件；实测 **75 个**（45 稳定 release + 30 advisory，[2026-05-18, 2026-11-18) 端点排他）。
- 检查单记忆的“readline 拆 U+2028”现象在锁定 Node 22.23.5 不复现（v24 系才复现）；字节 LF 分帧契约维持不变，理由已写入 PI 契约报告（现为可失败断言）。
