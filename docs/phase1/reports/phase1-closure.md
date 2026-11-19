# Phase 1 收口声明（2026-11-19）

Owner 授权收口（当日对话：「我复核好了，id值也改好了……没问题的话第一阶段应该就可以结束了」）。技术侧由第四轮外部审计判定**通过**（对象 `ff6e497`，N9/N10/N11 独立红绿实测关闭，无新技术阻塞）；用户侧四项由 owner 完成/确认并经机器复测。本文按规范 `docs/04` 的 Phase 1 出口门禁逐项对照，并如实声明边界。

## 1. 出口门禁逐项对照

| 门禁项（规范 04） | 状态 | 证据 |
| --- | --- | --- |
| 用户选真实 repo 与通知渠道并建立标注样本 | ✅ | repo：https://github.com/NorthAdb/AegisPi（第 0 项起持续推送）；渠道：Telegram Bot DM @aegispibot（getMe 机器证实，is_bot=true）；标注样本：75 条全量（owner 确认终态 该关注 39 / 可忽略 36 / uncertain 0，本地 labels 文件实测一致，确认记录在本地 owner-baseline §3 不入库） |
| 锁定 Node 22.23.5 核验 exact Pi 1.5.2、LF 分帧、SQLite | ✅ | 15 探针套件 15/15 PASS 退出码 0（收口时点全量复跑；Pi exact 1.5.2 integrity sha512-mUWI04…；FRAMING 字节 LF 分帧断言；SQLITE node:sqlite 3.54.1 全门禁） |
| 绑定「DeepSeek Flash High」不编造 ID | ✅ | provider `deepseek` / model id `deepseek-flash` / thinking high（目录原文），**真实 API 单次最小推理实测接受**（stopReason=stop，回复 "OK"，usage 463，cost.total $0.0001407）——reports/model-binding.md + evidence/07 |
| 记录已取得的基础镜像真实 digest | ✅ | node:22.23.5-bookworm-slim，OCI index RepoDigest sha256:e9f565d3… + amd64 清单 sha256:47725aca…（registry 核验）——reports/image-digest.md |
| 用 oracle/manifest 夹具起步 | ✅ | 两对 hono oracle（csrf text/ping + CORS 凭据反射）A1/A2 全实测；配对自检工具（矩阵 + 解析遏制 + 未安装快照 exit 2 + 哈希复算）退出码 0；快照 lock 入库可复算 |
| 缺命令、空实现、skip 不能当通过 | ✅ | 套件退出码门禁四条件（FAIL/SKIP/无 PASS 判据/零探针 → 退出码 1），四类破坏均实测变红（evidence/04/05/06） |
| Phase 2 入口 = Phase 1 契约和 schema 审查通过 | ✅（就绪） | 四轮审计史见 audit-history.md；第四轮判定技术整改通过；开工者须持 schema.sql SHA `ede73eca…` 对应的 v1.4.1 包 |

## 2. 用户侧四项（全部闭合，含机器证据或 owner 记录）

1. **DeepSeek 最小推理**：单次真实调用通过，退出码 0（evidence/07 §1；单发授权已用尽，不重放）。
2. **通知渠道**：Telegram getMe/getChat 复测通过，退出码 0，startConfirmed=true（evidence/07 §2；经本机 owner 自配系统代理）。
3. **基线三句话**：owner 填入本地 owner-baseline §2（只盯 NorthAdb/AegisPi、默认只读、发现需关注事件才私聊通知）。
4. **75 条标注确认**：owner 复核确认（12 条 uncertain 对照官方发行说明复核后转可忽略；终态 39/36/0；确认记录 owner-baseline §3；labels 文件本地不入库，per-item reason 属人工判断）。

## 3. 收口时点的最小验收（全部实测）

```
node evals\contracts\run-contracts.mjs          → 15/15 PASS, SUITE-EXIT=0
node evals\contracts\tools\verify-hono-oracle-pair.mjs → 全 OK, PAIR-EXIT=0
python -X utf8 validation\validate_pack.py（包目录）→ 14/14, CONNECTIONS_LEFT=0, PACK-EXIT=0
node evals\phase1-closure\verify-telegram-identity.mjs → ok=true, TELEGRAM-EXIT=0
（DeepSeek 不重放：单发授权；第四轮审计已独立核对脚本结构与目录价算式）
```

## 4. 如实边界（不随收口消失）

- **保留给后续阶段（非阻塞，按规范安排）**：宿主 HELD 账本（Phase 2）；`load-pi-settings.mjs` 接入 daemon 运行时（Phase 2 接线义务，第四轮审计明示这不算 Phase 1 缺陷）；三个应用镜像构建与容器配额校准（Phase 3）；hono oracle 的容器化 security_repro、cacheWarming 真实 warm 周期计费（Phase 4）。
- **本地不入库（维持 .gitignore）**：owner-baseline.local.md、labels 文件、.env——审计已核验三者在任何提交的 tree 里无 blob。
- **不宣称**：AegisPi 服务已实现/已被监控（hono 夹具是评测样本，不是服务监控范围）；任何缓存/性能数字或用户收益；安全实测（逃逸测试属后续阶段）。

## 5. Phase 2 最小入口条件（不随本收口自动开工）

1. 技术门禁已满足（第四轮判定）；开工前重跑第 3 节前两条最小验收。
2. schema/状态/事务唯一规范 = 本机设计包 06 与 schema.sql（D-01：包不随库分发）。
3. daemon 加载 defaults.json 必须走 `load-pi-settings.mjs`（D-11）。
4. 本收口由 owner 授权 + 四轮外部审计史构成；如需第五轮外部审计复核后再开工 Phase 2，入口证据见 AUDIT-HANDOFF.md 与 audit-history.md。
