# 模型绑定记录：「DeepSeek Flash High」（Phase 1）

## 绑定（真实 ID，无编造）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 显示名（规范） | DeepSeek Flash High | 设计包 00/05/AGENTS |
| provider | `deepseek` | Pi 1.5.2 内置目录 |
| model ID | `deepseek-flash` | 同上 |
| thinking level | `high` | 目录 thinkingLevelMap 含 `"high": "high"` |
| 目录条目显示名 | DeepSeek V4.1 Flash | 目录原文 |
| 上下文/输出 | 1,000,000 / 384,000 tokens | 目录 |
| 计价（USD/M tokens） | input 0.3 / output 1.2 / cacheRead 0.006 | 目录（PI-10 用此价目实算成本） |

真值文件：`node_modules/@earendil-works/pi-ai@1.5.2/dist/providers/data/deepseek.json`（随 exact 1.5.2 安装，2026-11-18 读取）。provider 下仅两个 chat 模型（`deepseek-flash`、`deepseek-v4-pro`），无第二个分类/摘要模型被引入——规范“首版只用一个主推理模型，不虚构第二个模型名”成立。分类/摘要模型待后续阶段核验后再定（当前不引入）。

## 探针侧验证

- PI-09：以隔离 models.json 把 `deepseek` 的 baseUrl 重定向到本地 fake 端点（目录元数据保留），凭 `DEEPSEEK_API_KEY` 环境变量实测认证与请求形状；绑定模型形状与目录一致。
- PI-10：脚本化 usage（100/50 token）按 0.3/1.2 价目实算 cost，误差 < 1e-12。
- 凭据环境变量名：`DEEPSEEK_API_KEY`（docs/providers.md 实测行 36）。

## 最小推理契约（未完成项）

规范要求“一次最小推理契约，绑定 DeepSeek Flash High 的真实模型 ID”。前置条件是 DeepSeek API key 经安全方式录入本地（开工检查单准备项 2；不阻塞开工，只影响 Phase 1 收口）。**该项在本次交付时未执行**：没有真实 key 就没有真实推理，不做模拟冒充。收口前补做：真实 `api.deepseek.com` 一次最小 prompt，记录请求/响应/usage/费用与退出码，作为契约证据归档。

## 配置落位

`apps/daemon/config/defaults.json` 的 `model` 节已写入上述绑定（display/provider/modelId/thinkingLevel + 证据指针），预算默认（800000 microUSD/25 步/15 分钟、日 5000000 microUSD、保温 off）同文件落位，来源 06 规范默认。
