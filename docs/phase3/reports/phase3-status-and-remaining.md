# Phase 3 状态与待办清单（2026-11-20，取代此前口头盘点）

主人 2026-11-20 指令的现行状态清单。**不进入 Phase 4，不宣布常开，不修改生产实现**。本文只记状态与待办；历史原文、执行证据与审计原稿一律不改写，更正走 `errata-2026-11-20.md` 与各文档的追记节。

## 1. 四项真实验收现状

| 项 | 状态 | 提交 | 关键事实 |
| --- | --- | --- | --- |
| A 真实模型 | **已执行，待独立复核** | `ec23ef7` | 恰 1 次 DeepSeek 官方端点调用（完整 URL + 供应商模型名 deepseek-flash），先预留后结清 28 microUSD，无超限无冻结；**授权上限 ≤2（勘误：执行日曾误写 ≤5），实用 1，「仅限本次」已闭合，无剩余额度** |
| B 真实外部写 | **已执行，待独立复核** | `26929a0` | 恰 1 次 POST 内部信封至可丢弃端点，effect SUCCEEDED、`external_id=ext-b-acceptance-001`；**原始运行 exit 1（两处断言词汇错误）与只读 postverify exit 0 分开在案，原始失败输出保留**；主人端点侧见证已录入（HK 17:03:51、217 bytes、请求 ID 81b02edf…、无认证头；主人只核对了请求头）；**回执只证明测试端点响应契约成立，不证明真实 Telegram 发送或真实仓库写**；URL 停用、不探测不重发；**1/1 已消耗** |
| C Telegram 只读 | **已执行，待独立复核** | `ec23ef7` | getMe+getUpdates 恰 2 次、零发送零 offset；**次数账本勘误**：旧「4/4 清零」从未计入 2026-11-19 收口日（dd80987）那次更早的真实只读调用，仓库材料可确认**最少 6 次**（当晚是否另有独立运行不可判定），详见 `telegram-call-ledger-retrospective.md`；**任何后续调用需主人新的逐项书面授权** |
| D 公网 webhook | **主人明确暂缓（2026-11-20 决定）**：未授权、未验收 | 无 | 公网入口保持关闭：不注册 webhook、不建隧道、不申请新 secret；未做任何动作 |

## 2. 独立复核（复核方另做，非实施者职责）

- 材料已备：各报告与证据路径见本文各节；审计原稿在 `docs/phase3/audits/`（字节冻结）。
- **定位澄清**：`test:external-write:postverify` 及一切「只读复核」是**实施者自查**，不构成独立审计；独立复核由复核方另行执行，到达的原稿照例字节归档、回应另写。
- 复核方可零新调用核验：读 `ec23ef7`/`26929a0` 两提交的证据文件、`workspace-state/phase3/`（gitignored）三个 scratch 库只读对账（external-write-real-b/control 的审批链与 bytes_sent=0 审计行；ingress-real-update 的 OBSERVE 行 received_at=2026-11-20T05:30:02.177Z 与证据 generatedAt=05:30:02.319Z 同瞬互证）。

## 3. 原镜像移交（已准备，未执行）

三份原 OCI 归档在 `D:\AegisPi\phase3-image-archives\`；2026-11-20 复验 SHA-256 与交付文档记录值逐位一致；移交清单与接收方核验步骤见 `image-transfer-manifest.md`；**通道待主人定，本轮零上传零重建零覆盖**；原镜像验证与同 context 重建验证继续分开。

## 4. 模型路径现状（`model-path-and-pi.md` §7 追记）

- 缺口 C 更正为「**已发生一次真实宿主调用**（usage × 目录价结清），**供应商账单核对未做**，**Pi SDK/端到端未接通**」。
- 缺口 A（容器→宿主模型提议链路）、缺口 B（Pi SDK 形态宿主客户端）：**归属待复核**（04 §6 无排期条文），保持开放。
- 价格目录与 `callUpperMicrousd=1000` 仍属待核定配置，不因一次成功而可常开。

## 5. 本地测试结果（2026-11-20 本轮复跑，锁定 Node 22.23.5，全部本地/回环，零真实外联）

| 套件 | 计数 | 退出码 |
| --- | --- | --- |
| test:contracts | 15/15 | 0 |
| hono 配对自检（verify-hono-oracle-pair） | lockfile sha 双核对 | 0 |
| test:durability | 164/164 | 0 |
| test:budget | 20/20 | 0 |
| test:acl | 15/15 | 0 |
| test:cancel-approval | 16/16 | 0 |
| test:security:unit | 43/43 | 0 |
| test:restore | 11/11 | 0 |
| test:ingress-telegram（本地） | 7/7 + 1 NOTE | 0 |

**本轮未跑（列明不盲跑）**：`test:offline-jobs`、`test:security:integration`、`test:quota-calibration`（均需 Docker 容器，属镜像类，未获本轮授权口径，保留既存证据不动）；三条 real 入口（`test:ingress-telegram:real`、`test:model:real`、`test:external-write:real`）**一律不重跑**（含缺凭据/模拟模式——避免再次误触真实调用；external-write 入口的一次性守卫本就拒跑）。**真实调用开关核查**：`apps/daemon/config/defaults.json` git diff 0 行，`allowRealExternalWrites=false`、`model.endpoint=null`、`allowRealModelCalls=false`、`upstream.submitUrl=null` 全部保持失败关闭；临时真实值只存在于已废弃的 gitignored workspace test-config，未成为可复用运行配置；`.env` 与密钥零入库。

## 6. 普通残留（复审原判维持，不挡出口）

备份库明文 SQLite、同主机重定向换端口、备份两次读之间的替换窗口、4 GiB 全量写未做、PID 复用窗口、stdout 微秒竞态未稳定复现、短 webhook secret 未捕获异常 exit 1、模型 bearer 经短命子进程 argv。镜像复跑配方的 `docker load` 标签保留限度（确认审计标注）已写入 `image-transfer-manifest.md` §3 第 5 步。

## 7. 待办汇总

1. 独立复核 A/B/C（复核方）；到达的复核原稿归档并另写回应。
2. 原镜像移交执行（主人定通道后，按 `image-transfer-manifest.md`）。
3. D 项维持主人暂缓决定；若未来授权，按 `real-acceptance-plan.md` §D 同窗口口径另行申报。
4. 模型缺口 A/B 归属复核（主人/ADR）；价格目录与单次上限核定（主人）。
5. Phase 4（真实仓库闭环）：**不进入**；须 Phase 3 门禁全过 + 主人批准 repo 与通知目标后另行申报。
