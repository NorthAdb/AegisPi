# Phase 3 状态与待办清单（2026-11-20，取代此前口头盘点）

主人 2026-11-20 指令的现行状态清单。**不进入 Phase 4，不宣布常开，不修改生产实现**。本文只记状态与待办；历史原文、执行证据与审计原稿一律不改写，更正走 `errata-2026-11-20.md` 与各文档的追记节。

## 1. 四项真实验收现状

| 项 | 状态 | 提交 | 关键事实 |
| --- | --- | --- | --- |
| A 真实模型 | **已执行，待独立复核**（复核 33d6361：目录价算术成立，供应商账单未核对） | `ec23ef7` | 恰 1 次 DeepSeek 官方端点调用（完整 URL + 供应商模型名 deepseek-flash），先预留后结清 28 microUSD，无超限无冻结；**授权上限 ≤2（勘误：执行日曾误写 ≤5），实用 1，闭合无剩余额度**。**入口无一次性守卫（复核指出）：`model-real` 缺 key 时 exit 3，带 key 重跑会再次真实调用——闭合是文书口径+执行纪律，不是代码保证** |
| B 真实外部写 | **已执行，待独立复核**（复核 33d6361：exit 1 与 postverify 分开属实；守卫表述已更正） | `26929a0` | 恰 1 次 POST 内部信封至可丢弃端点，effect SUCCEEDED、`external_id=ext-b-acceptance-001`；原始运行 exit 1（两处断言词汇错误）与只读 postverify exit 0 分开在案；主人端点侧见证已录入（只核请求头）；回执仅证明测试端点契约；**守卫更正（复核）：exit 4 守卫依赖证据文件存在，删除该文件后同脚本仍可再执行、URL 仍硬编码于脚本——「停用」与「仅限一次」是文书口径；URL 停用、1/1 已消耗** |
| C Telegram 只读 | **已执行，待独立复核**（复核 33d6361：次数边界写对，不闭项） | `ec23ef7` | getMe+getUpdates 恰 2 次、零发送零 offset；账本勘误：**最少 6 / 可能 8 / 更早未知是既有报告与自述的计数口径，非独立证实的网络往返**；**T0 授权依据按复核更正为「依据不足」（移交条款是约束非授权，token 非授权，无主人逐项原文）**；T2 网络事实维持缺证不闭项（scratch 最小只读导出已入库）；**任何后续调用需主人新的逐项书面授权** |
| D 公网 webhook | **主人决定延期至首次启用公网 Telegram webhook 前**（2026-11-20）：未授权、未验收 | 无 | 公网入口保持关闭：不注册 webhook、不建隧道、不申请新 secret；未做任何动作；`console/api.mjs` 的 `CONSOLE_BIND`/`allowedHosts` 硬编码现状未动（这是未改代码的现状，非漏洞修复） |

## 2. 独立复核（复核方另做，非实施者职责）

- **已归档的复核原稿**：`AUDIT-PHASE3-REREVIEW-3cd0652`（判定五项收口成立）与 **`AUDIT-PHASE3-REREVIEW-33d6361`（2026-11-20 到达，字节归档；判定：本轮文档收口成立附残留，A 账单未核对、B 正文未核、C 历史次数与 T2 网络事实缺证不闭项、原镜像待到件——阶段出口维持 MET WITH RESIDUAL RISKS）**。回应另见 `audit-response-rereview-33d6361.md`。
- **限定修复验收（2026-11-20 到达，字节归档）**：`AUDIT-PHASE3-LIMITED-FIXES-44b3514`（SHA-256 `69f3e7a936f30afca6f7598246ec6aa8bcaff69831bcb663581fa9ac8dcc7cae`，6040 字节，与源逐位一致）判定两项**通过、限定修复关闭**、无 P0/P1 实证回归；常开/Phase 4 开工/真实运行不发放；其「下一步」给出模型链路 ADR 的五条验收要点（宿主复用 Pi provider 不写平行客户端、容器只提议走白名单、先 reserve 后四字段结清且缺证 HELD、目录价与上限真实调用前由主人核定、本单元不开外部写不改 CONSOLE_BIND）。
- 材料已备：各报告与证据路径见本文各节；审计原稿在 `docs/phase3/audits/`（字节冻结）。
- **定位澄清**：`test:external-write:postverify` 及一切「只读复核」是**实施者自查**，不构成独立审计；独立复核由复核方另行执行，到达的原稿照例字节归档、回应另写。复核方机器无本机 scratch 库（其 postverify 实测 exit 3 缺库）；`scratch-readonly-export-2026-11-20.md` 是实施者本机的只读最小导出，属「实施者本机实测」，**不写复核方收到或运行了任何原件**。
- 复核方可零新调用核验：读 `ec23ef7`/`26929a0` 两提交的证据文件与上述只读导出。

## 3. 原镜像移交（已准备，未执行）

三份原 OCI 归档在 `D:\AegisPi\phase3-image-archives\`。**主人 2026-11-20 决定：本机验证通过即视为该项通过，不需移交第三方。已执行**（`local-original-image-verification.md`，实施者本机实测）：身份核验 27/27（三 tar 传输哈希逐位=文档值、manifest/config blob 与全部 30 层自证、linux/amd64、manifest digest 与 config/image ID 分列）；docker load 前后镜像 ID 不变（未覆盖任何不同镜像）；loopback registry 三重绑定成立。隔离套件各恰一次：当前树被 image-gate 按设计拒绝（exit 2，`package.json` 增两行 script 后 context 漂移，未绕过未重建）；在记录上下文树 `11d649a` 上 quota-calibration **5/5 exit 0**、offline-jobs **9 PASS 后 daemon 级用例崩溃 exit 1（根因未隔离，未决；同用例 D-57 曾过）**、security-integration **28/29 exit 1（唯一 FAIL 为内嵌 offline-jobs 同根因；逃逸/滥用/配额全 PASS 且跑在原镜像上）**。原 tar 全程未改未传（结束复验哈希不变）；复核方未收到、未运行原件。

**纪元 2 追记（2026-11-20 限定修复轮）**：上段两个开放残留均已闭合——daemon 级用例根因已定位并修复（无 `node_modules` 的树上 daemon 在 import 期死于 hono `ERR_MODULE_NOT_FOUND`，旧无守卫读把 stderr 掩蔽成 ENOENT；修复落测试层——现场落盘 + 守卫读，生产代码零改动），加固套件在复现面实测 12 PASS / 2 FAIL、失败现场在案；经主人授权建**纪元 2**（仅重建 agent：manifest `b136e04d…`、config `cbd20576…`、context `72ed2cae…`、tag `phase3-848eba6d539f`；acquisition/execution 证明 context 一致后沿用原 digest 与 tag），门禁在当前树恢复放行，终树三套件全绿（14/14、29/29、5/5 全 exit 0）。收口报告：`round-closure-2026-11-20-limited-fixes.md`。

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

**本轮未跑（列明不盲跑）**：三条 real 入口（`test:ingress-telegram:real`、`test:model:real`、`test:external-write:real`）**一律不重跑**（含缺凭据/模拟模式——避免再次误触真实调用；external-write 入口的 exit 4 守卫依赖证据文件存在，属可绕过文书层，见 B 行更正）。**真实调用开关核查**：`apps/daemon/config/defaults.json` git diff 0 行，`allowRealExternalWrites=false`、`model.endpoint=null`、`allowRealModelCalls=false`、`upstream.submitUrl=null` 全部保持失败关闭；临时真实值只存在于已废弃的 gitignored workspace test-config，未成为可复用运行配置；`.env` 与密钥零入库。

**原镜像验证轮（2026-11-20 追记，同锁定 Node，零真实外联）**：归档身份核验 27/27 exit 0（`imgverify-identity-output.txt`）；docker 三套件在当前树被 image-gate 设计拒绝 exit 2 ×3（`imgverify-current-tree-refusal-*.txt`）；在 `11d649a` 记录上下文树各恰一次：quota-calibration 5/5 exit 0、offline-jobs exit 1（9 PASS 后 daemon 级用例 ENOENT 崩溃，`imgverify-11d649a-offline-jobs-output.txt`）、security-integration 28/29 exit 1（唯一 FAIL 为内嵌 offline-jobs；`imgverify-11d649a-security-integration-output.txt`）；quota 输出 `imgverify-11d649a-quota-calibration-output.txt`。不重试、不强行刷绿。

**限定修复轮（2026-11-20 追记，同锁定 Node，零真实外联）**：daemon 级用例根因（无 `node_modules` 树上 daemon import 期死于 hono，旧无守卫读掩蔽 stderr）已定位修复，加固套件在复现面实测 12 PASS / 2 FAIL（`daemon-repro-*` 四件证据）；经主人授权建纪元 2（仅重建 agent，acquisition/execution 携带核验后沿用原 digest，`build-epoch2-agent-log.txt`）；终树三套件全绿：offline-jobs **14/14 exit 0**（含 daemon 级与 disk-warn 用例）、security-integration **29/29 exit 0**、quota-calibration **5/5 exit 0**（`accept-epoch2-*.txt` 三件）。回归依据：生产代码自 33d6361 全绿轮 0 行改动，非 docker 套件所测对象逐字节未变故未重跑。

## 6. 普通残留（复审原判维持，不挡出口）

备份库明文 SQLite、同主机重定向换端口、备份两次读之间的替换窗口、4 GiB 全量写未做、PID 复用窗口、stdout 微秒竞态未稳定复现、短 webhook secret 未捕获异常 exit 1、模型 bearer 经短命子进程 argv。镜像复跑配方的 `docker load` 标签保留限度（确认审计标注）已写入 `image-transfer-manifest.md` §3 第 5 步。

## 7. 待办汇总

1. 独立复核 A/B/C 后续（复核方）：**33d6361 已归档并回应**（`audit-response-rereview-33d6361.md`）；其「未闭项」清单（A 账单、B 正文、C 历史次数与 T2 网络事实）维持缺证口径，等待复核方裁量。
2. 原镜像：**本机验证已完成（主人口径：通过即闭项）**。上轮两个开放残留已在本轮限定修复中闭合：daemon 级用例崩溃根因已定位修复（无 `node_modules` 树 + 测试层掩蔽；加固后失败现场可读，生产零改动）；当前树门禁经**纪元 2**（仅重建 agent，携带核验后沿用未受影响镜像）恢复放行，终树三套件全绿（`round-closure-2026-11-20-limited-fixes.md`）。原三 tar 与交付证据未动。
3. D 项按主人决定**延期至首次启用公网 Telegram webhook 前**；届时按 `real-acceptance-plan.md` §D 同窗口口径另行申报。
4. 模型缺口 A/B **设计归属已闭**：ADR-0001 按主人指令成稿待审（`docs/adr/0001-model-path-pi-host-execution.md`，容器提议 + 宿主复用 Pi 1.5.2 执行的最小方案，审计五条验收要点逐条落实；本轮零实现）；实施排入受限开工草案单元 4.1（`docs/phase4/phase4-restricted-kickoff-draft.md`）。价格目录与单次上限仍属首跑检查表（主人核定，任何真实调用前）。
5. Phase 4（真实仓库闭环）：**实施不进入**；受限开工草案已交付待主人方案审核（单元 4.1 模型链路实现、单元 4.2 真实仓库 Observe；首跑检查表七项待逐项书面确认，方案建议不构成运行授权）。
