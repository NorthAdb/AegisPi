# Phase 1 未决项（2026-11-18）

按规范要求逐项列出已做/未做，不写笼统“全绿”。

## 阻塞 Phase 1 收口的用户侧准备项（开工检查单已知，不阻塞开工）

1. **DeepSeek API key 安全录入 + 一次最小推理契约**。模型绑定（deepseek/deepseek-flash + high）已在目录层完成并落配置；真实推理证据待 key 录入后补拍（见 model-binding.md）。密钥经安全方式录入本地，不在聊天粘贴。
2. **通知渠道名称与可接受打扰范围**。hono 夹具的 release 事件标注（如 v4.13.18 安全修复线）依赖此输入。
3. **人工基线三句话**（手工筛查流程描述、漏报代价、打扰容忍）。全部 65 个候选事件的完整标注集等这三句话确认后收口；当前只有提案样本（本地 labels 文件）。

## 工程未决项

4. **target 侧 hono@4.12.24 integrity 回填**：security_repro 对的 target 快照需在 Phase 4 前隔离安装 `hono@4.12.24` 记录真实 npm integrity，manifest 中已留待回填说明（拒绝占位符是 gate 规则）。
5. **三个应用镜像未构建**：Phase 1 无产品代码，Dockerfile 源文件与基础 digest 已入库；首次构建（Phase 3 前置）时记录真实应用 digest。
6. **容器占位配额未校准**：按 06 §4 属 Phase 3 真实压测任务。
7. **探针未覆盖项（如实列出）**：cacheWarming 的真实 warm 请求周期（需 TTL 级等待 + 真实计费，Phase 4 证据）；codemode 256MB OOM 行为（文档值，不做安全边界）；`totalFromProvider` 类聚合字段不存在（PI-10 已证 usage 逐字段，账本自行求和）。

## 与开工检查单的实测差异（数据修正，非偏差）

- 检查单描述的“GHSA-88fw CORS 凭据反射（High，<4.12.25）”在 GitHub advisory API 中不存在；`<4.12.25` 的实际条目为 GHSA-wwfh-h76j-fc44（medium，serve-static Windows 路径穿越），CORS 相关最近条目为 GHSA-8j4g-w8fx-2239（medium，CORS ReDoS，<4.12.34）。夹具 README 已记录，标注提案保留检查单的三分类意图。
- 检查单预估窗口约 47 个候选事件；实测 65 个（45 稳定 release + 20 advisory，2026-05-18 起）。
- 检查单记忆的“readline 拆 U+2028”现象在锁定 Node 22.23.5 不复现（v24 系才复现）；字节 LF 分帧契约维持不变，理由已写入 PI 契约报告。
