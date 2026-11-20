# Phase 3 复审（0a6f89a）整改回应（2026-11-20）

对象：独立复审 `docs/phase3/audits/AUDIT-PHASE3-REREVIEW-0a6f89a.md`（判定 **NOT MET**：F2/F3/F4/F5/F6 原缺陷关闭；F7「缺 token 仍 exit 0」关闭、真实只读未验收；F1/F8 部分关闭；P1×4 + webhook 端点为出口缺口）。原稿字节一致归档（SHA-256 `C6FAEDF5…2263`，提交 `7a5425a`），一字未改。复审分支从未 push，故归档以递交原文件为准。

处理原则（主人指示）：不重开已关闭项；两项勘误照办；四个 P1 属 Phase 3 范围，缺授权只使对应实测记未验收、不解释代码缺席；真实仓库业务闭环仍属 Phase 4、本轮未做；先红证后修复、每单元本机绿再提交；隔离套件在已提交证据上跑绿，不报临时重建计数；零付费模型调用、零真实平台外发、零真实 Telegram 复验（授权未续，如实记未验收）。

整改提交序列（每个提交在其自身树形态实测）：

| 单元 | 提交 | 内容 |
| --- | --- | --- |
| 归档 | `7a5425a` | 复审原稿字节一致入库 |
| F1 | `49f907d` | context 绑定提交内容（`/` 分隔 + LF 规范化）+ 门禁拒绝非 linux/amd64 config（M4 红证）+ 三镜像重建 |
| oracle | `ff30376` | 宿主 oracle 接线（P1） |
| 提交器 | `ba14372` | 真实 HTTP 提交器（P1） |
| worker | `8af0966` | 真实模型 worker 接预算账本（P1） |
| webhook | `5250243` | webhook 端点接线 |
| F8 | `f413046` | 演练缝只能收紧、放宽拒绝启动 |
| 回应 | 本提交 | 本回应、决策轨迹、执行清单、终树全量证据 |

## 1. 复审发现逐项分类

### 1.1 F1（部分关闭 → 本轮修复：已提交证据绑定提交内容，跨 OS 可重算）

**红（本机复现，修正前树）**。`context-os-dependence.mjs`：同批已提交字节按两种分隔符约定得到不同摘要（win32 `be0273e1/810d2b3c/8071bb11` vs posix `32532e45/8abae275/8183df14`——acquisition/execution 的 posix 值与复审在 Linux 的独立计算逐位一致，即「干净 Linux 检出永远过不了自己的门禁」在本机确定性成立）；且 agent 记录值 `be0273e1` 绑定的是工作树 CRLF 字节（`daemon.mjs` 工作树 CRLF、提交 LF，`context-byte-drift.mjs` 逐文件证），任何约定下都无法由提交字节重算——复审的「be0273e1 对不上 Linux 也对不上 win32 模拟」由此补全机理。

**修（两层根因）**。① `image-bind.mjs` staged 路径固定 `/`；② context 哈希与构建暂存统一 **LF 规范化**（`contextFileBytes`）——摘要成为**提交内容**的函数，不受 Windows autocrlf 检出污染（本机正是被该污染击中的实例）；③ 门禁新增 `fetchRegistryConfigBlob`：取 config blob、复验服务字节哈希、断言 `os=linux/architecture=amd64`，非本平台 config 拒绝。

**红证 M4**。向本机 registry 经 HTTP API 推合成 `linux/arm64` config+manifest（内容寻址、幂等），植入 scratch 证据（context 行保持真值，唯 manifest/config 指向合成对）：干净门拒绝；`M4-platform-binding-off` 变异后过门（探针红）；源码逐字节还原后复绿。M1–M3 保持红绿。

**验收（复审原文标准）**。重算 context 逐位等于复审 Linux 值：agent `32532e45…`、acquisition `8abae275…`、execution `8183df14…`——由 Windows 机器上的修正函数算出复审在 Linux 独立算出的同一摘要，跨机对账成立。三镜像重建：acquisition/execution 字节未变、manifest 逐位保持（`3c5b4dba…`/`202dfcd4…`，同字节同 manifest 的确定性证明），agent 重绑（镜像内 `daemon.mjs` 归一 LF）。**image-gate 红证 M1–M4、offline-jobs、security-integration、quota 在不改写证据的已提交树上全绿，无 exit 2**（`49f907d` 树实测：红证 4/4、14/14、29/29、5/5）。

**勘误采纳**。另一次构建得到不同 digest 不作伪造证明；旧三值仍按「attestation index digest（`INDEX(2 manifests)`，本机实测）」表述，非编造字符串。F1 的关闭依据是「已提交 context 可在干净检出重算 + 门禁强制平台」，不是旧值对比。

### 1.2 宿主 oracle（P1 实现缺口 → 本轮修复：绑定验收定义决定成功）

**红（本机复现，四案全红，`oracle-red.mjs`）**。A：真实容器 exit 0 + 绑定 oracle 的 `requiredOutputHash` 与实际 stdout 矛盾 → 记 `SUCCEEDED`（oracle 只写不读）；B1–B3：真实容器 exit 0、停止后 `docker cp` 植入伪 `result.json`（`timedOut`/`cancelled`/`signal`）→ 分别记 `TIMED_OUT`/`CANCELLED`/`FAILED(signal)`——篡改通道与孙进程抢写同信任位置（输出卷），且确定性。

**修**。`job-oracle.mjs`（新）：按规范包 `oracle.schema.json` v1 校验（断言种类枚举、`expectedExitCode`、`requiredOutputHash`、`resultClassRules`）并拒绝无可机检断言的定义（纯散文不能门禁成功）；`evaluateJobOracle` 以可信事实（守护进程报告的容器退出码）与收集证据（stdout 字节）比对绑定断言。`submitJob` 强制 oracle 并经 `putObjectContent` 持久化（删除 `exit-code-evidence-only` 默认——没有验收定义的作业一律拒绝执行，不留「未验成功」态）；oracle 不可读即拒绝成功。`pollOnce` 终态全部宿主自有：result.json 三字段收回状态权（runner 可信退出码约定 124/125/126/137 与宿主墙钟/取消记录已覆盖全部情形）；exit 0 必须过绑定断言评估，不符记 `FAILED` + `job_oracle_mismatch` 审计（失败断言 id 列名）；`finishJob` 显式 `state`。

**门禁（offline-jobs，真实容器）**。`job-without-oracle-refused-nothing-executed`、`exit0-with-contradicting-oracle-is-not-success`（FAILED/oracle_mismatch、exit_code 0、恰一条 mismatch 审计）、`tampered-result-json-cannot-rewrite-terminal-state`（三案伪证均断言「已送达宿主、状态分毫未改」，SUCCEEDED/0）。套件 9 处调用与两处手播种 QUEUED 全部携带真实 oracle。

**残留（如实）**。孙进程在 runner 写完证据、容器退出前的微秒竞态理论上仍可改写 `stdout.txt`（同容器同 uid）；与两轮审计记录一致、未稳定复现；伪造 result.json 改写终态的通路已闭合并有永久门禁。

### 1.3 真实 HTTP 提交器（P1 实现缺口 → 本轮修复）

**红**。`submitter-red.mjs`：无旗标 `daemon --once` 对就绪端点零请求、READY 效果停留、日志自认「no upstream adapter is wired」——无旗标、无配置键、无代码路径能把传输交给 daemon。

**修**。`upstream-http.mjs` + `upstream-http-child.mjs`：真实 base transport（fake-remote 同形结果集：连接前失败 `failed_local`、超时 `unknown`、2xx `succeeded`；拒绝 fault-injection mode——只有 fake 模拟结局）。单次往返经短命子进程（与 docker 调用同型），派发事务保持同步：SUBMITTING 提交、调用、记录，其间崩溃留 SUBMITTING → 恢复置 UNKNOWN（06 的崩溃行）。daemon 生产路径在 `upstream.submitUrl` 配置即接线（transportKind "real" 由调用方声明，非标签嗅探）；`--config=<path>` 让测试与部署共用同一配置通道；`credentials` 槽位标记经 defaults/config（密钥本体只经宿主凭据服务，永不入此文件）。

**门禁（security-unit，本地可控服务须独立进程——spawnSync 阻塞父事件循环，套件内嵌服务永不应答）**。`http-transport-carries-bytes-and-maps-outcomes`（submit 成功取回 externalId、lookup 强一致、head 可查、死端点 `failed_local` 零字节、挂起端点超时后 `unknown`）；`authorized-production-tick-submits-over-real-http-transport`（无旗标生产 tick、测试配置授权：本地服务收到 businessKey、effect `SUCCEEDED` 带 external_id）；`unauthorized-production-tick-sends-zero-bytes-through-real-transport`（默认策略：adapter_refused 审计、effect FAILED `local_error`、服务零请求）。`allowRealExternalWrites` 默认保持 false：无授权的失败关闭现在是**策略结局**而非传输缺席。测试配置从仓库真实 06 默认派生、只覆写部署值（预算数字不动）。

### 1.4 真实模型 worker（P1 实现缺口 → 本轮修复；账单实测=授权缺失）

**红**。`worker-red.mjs`：无旗标 tick 零预留零结清、日志自认「later wiring」。

**修**。`model-call.mjs` + `model-call-child.mjs`：调用走宿主配置端点（URL 永不来自模型拼接），单次同步往返（同 spawnSync 型），返回回复与 provider 自身的 token 记账；bearer 经宿主凭据槽位 `model` 调用时解析，只存在于短命子进程 argv，不进库/日志/审计。daemon 无旗标分支：端点已配置且授权即运行真实 worker——claim → heartbeat → **预留** → workerStep → 调用 → 按实额结清/保持 HELD → 证据 → completeTask → delivery ack/done；调用后各步记录**调用后的墙钟**（账本可证调用发生在预留与结清之间）。`microusdForUsage` 只按宿主价格目录计价，任一侧费率 null 即不计价。usage 缺失或价格未授权 → 预留保持 HELD + `model_usage_not_settled` 审计（**未知用量不得当 0**，账本既有纪律未动）；调用失败 → 尝试留租约（收割者置 LOST、任务重排队，06 原语义）、预留走保守超时。task_result 证据经 `putObjectContent` 持久化（哈希-only 行读不回内容——实测暴露后修复）；resultClass `not_applicable`（06 §2.1：非仓库分诊）。非 loopback 端点须 `allowRealModelCalls`（默认 false），未授权在任何调用之前拒绝。无端点配置时保持诚实日志（零 claim、零预留）。

**门禁（security-unit，本地模型服务独立进程）**。`worker-reserves-before-call-and-settles-real-usage`（SETTLED **100 microUSD** = 500k/250k token × 宿主目录，非 1000 上限非 0 非夹具 300；`source=model-http-transport`；`reservation.created_at ≤ 服务收到时刻 ≤ settled_at` 同钟对账；task `SUCCEEDED/not_applicable`；回复为持久对象）；`worker-no-usage-keeps-reservation-held-never-zero`；`worker-unauthorized-price-catalog-keeps-reservation-held`；`worker-refuses-unauthorized-endpoint-before-any-call`（非 loopback 未授权：零 claim 零预留 + 诚实日志）。无端点默认路径的既有零结清检查保持绿。

**真实验收（未做，授权缺失）**。授权清单见 §3；未授权不发生任何真实模型调用或真实账单。

### 1.5 webhook 端点（实现缺口 → 本轮修复；公网部署=授权缺失）

**红**。`webhook-disk-red.mjs`：`POST /ingress/telegram/webhook` 无路由（guard 已实现、有单测、无调用方）。

**修**。`mapTelegramUpdate` 独立导出（拉取适配器委托）；console 挂 `POST /ingress/telegram/webhook`——**置于 `/api/*` 之外**（Telegram 服务器拿不到 console bearer，guard 即鉴权），失败关闭阶梯：只读维护 → 503；未配置 secret → 503 `webhook_not_configured`；头缺失/不符 → 403 零处理（常时比较）；合法签名才映射入队，**OBSERVE（读非消费）**：`state=DONE/verdict=OBSERVE`、webhook 自身不派发任何 task、按 `update_id` 经 `receiveEvent` 去重。host/origin 白名单仍约束该路由。daemon 经 `AEGISPI_TELEGRAM_WEBHOOK_SECRET` 传入：未设 = 503；设而畸形（<16 字符）= 拒绝启动。

**门禁（security-unit，本地请求）**。无 secret 503 零入队；缺/错头 403 零入队；合法签名 202 且重复投递去重为一行、零任务派发；只读模式 503。ingress 本地套件 7/7 保持绿。

**真实验收（未做，授权缺失）**。公网端点与真实 secret 属主人授权项；本轮全部为本地请求证据，不宣称「已对真实 webhook 源验证」。

### 1.6 F8 磁盘演练不变量（部分关闭 → 本轮修复）

**红**。`webhook-disk-red.mjs`：`WARN=0.001`（低于生产 20）与 `CRITICAL=25`（单项高于生产 warn、倒序）均被接受，与注释宣称的「只能更严」不符。

**修**。`resolveDiskThresholds`：注入值是 free 字节**门槛**、门槛只准**升**——低于生产阈值即 `ConfigError`；有效 critical 不得超过有效 warn（倒序拒绝，含单项注入情形）；收紧方向全保留。daemon 对 `ConfigError` 干净拒绝启动（exit 2、留明原因、不取锁不起循环）。

**门禁**。`disk-drill-seam-may-only-tighten-never-loosen`（0.001 拒、5 拒、25 单项拒、25+12 收紧对接受）；`daemon-refuses-to-start-on-loosened-drill-seam`（exit 2 + 原因行）；既有 critical 演练改为**双门槛同升**（warn 2,000,000 ≥ critical 1,000,000）保持升级序后照常实测触警（`--check` exit 3、真实 statfs free=463GiB）；offline-jobs 的 warn 单项收紧照旧合法。

### 1.7 F2/F3/F4/F5/F6/F7：确认关闭，未重开

复审判定关闭，本轮未重开、未改动其语义；F7 真实只读未复验（授权未续，维持「未验收」记录，不冒充）。回归证据见 §4。

## 2. 普通残留（按复审指示如实保留，不扩范围）

同主机重定向换端口或 http/https 互跳（02 §4 下仍放行、计划宿主生成、容器侧只读）；备份库明文（认证非加密，F3 关闭时已如实标注）；`dbSha256` 校验与随后 `copyFileSync` 非同一次读取（备份目录并发写入才可触及，容器挂不到）；4 GiB 全量 tmpfs 写未做（512 MiB 同机制 ENOSPC 实测，终值待 Phase 4 实画像）；PID 复用窗口（D-18）。另加本轮新证实的残留：孙进程对 `stdout.txt` 的微秒竞态（§1.2，未稳定复现，状态改写通路已闭合）。

## 3. 授权清单（等主人授权后的真实验收，本轮一律未做）

**真实模型调用**。需要：① `model.endpoint` 设为真实 provider 端点；② `model.allowRealModelCalls=true`；③ 凭据槽位 `model` 注册并录入密钥（宿主秘密存储，经 `credentials.mjs`，不入库不入库备份）；④ `model.priceCatalog` 填入真实 input/output 每百万 token microUSD 单价；⑤ `model.callUpperMicrousd` 核定单次调用预留上限。动作：生产 tick 对真实任务的推理调用与按 token 结清。费用上限：单次 `callUpperMicrousd`、任务 800000、日 5000000（06 §4，既有硬门禁不变）。回滚：`allowRealModelCalls=false` + 槽位 revoke 即时失败关闭；错误价格只导致 HELD/CHARGED_BOUND 保守占额，不产生超额支出（账本既有 overcharge 审计）。

**真实外部提交**。需要：① `upstream.submitUrl` 设为真实端点；② `policy.allowRealExternalWrites=true`；③ `credentials` 对应槽位（mail/repo/im）接线。动作：经审批的 READY 效果真实提交。费用上限：不适用（非模型调用）。回滚：旗标回 false + 槽位撤线即时失败关闭，效果保持 READY 重派或 FAILED 可重排队。

**真实 webhook 公网部署**。需要：① 公网入口（反向代理或隧道）指向 console 的 `/ingress/telegram/webhook`，并放宽该部署的 host 白名单为一项明确的部署配置；② 主人授权的 secret（≥16 字符）经 `AEGISPI_TELEGRAM_WEBHOOK_SECRET` 录入；③ Telegram setWebhook 指向公网地址。动作：真实平台推送 update 入队（OBSERVE）。回滚：unset secret 即 503 失败关闭；撤公网入口即物理断开。

**真实 Telegram 只读复验**。需要主人对本轮的明确续期授权（上一轮的授权不自动延续）；期间零发送、零 offset 确认。

## 4. 验证与计数（锁定 Node 22.23.5；隔离套件全部跑在已提交证据上）

```
# 终树全量（f413046 提交树实测；隔离类在其已提交机器块上直接过门，无临时重建改写）
node evals/phase3/image-gate/red-proofs.mjs             → M1–M4 全过 EXIT=0
node evals/phase3/offline-jobs/run.mjs                 → 14/14 EXIT=0（11 原有 + oracle 3 新门禁）
node evals/phase3/security-integration/run.mjs          → 29/29 EXIT=0
node evals/phase3/quota-calibration/run.mjs            → 5/5 EXIT=0
node evals/phase3/security-unit/run.mjs                → 41/41 EXIT=0（28 起；+提交器 3、worker 4、webhook 4、演练不变量 2）
node evals/phase3/restore/run.mjs                      → 11/11 EXIT=0
node evals/phase3/ingress-telegram/run.mjs              → 7/7 EXIT=0（本地）
node evals/phase3/ingress-telegram/real.mjs --simulate-no-token → EXIT=3 NOT VERIFIED（授权未续，不冒充）
node evals/phase3/cancel-approval/run.mjs              → 16/16 EXIT=0
node evals/phase3/cancel-approval/red-proofs.mjs       → 3 组变异红证 EXIT=0
# Phase 1/2 回归
node evals/phase2/durability/run.mjs                   → 164/164 EXIT=0
node evals/phase2/budget/run.mjs                       → 20/20 EXIT=0
node evals/phase2/acl/run.mjs                          → 15/15 EXIT=0
node evals/contracts/run-contracts.mjs                 → 15/15 EXIT=0
node evals/contracts/tools/verify-hono-oracle-pair.mjs  → EXIT=0
```

全部命令锁定 Node 22.23.5（`D:\AegisPi\tools\node-v22.23.5\node.exe`）。真实 Telegram 只读未复验：本轮授权未续，仅演练缺凭据路径（exit 3），零发送、零 offset 确认。

## 5. 终树镜像证据（v2 机器块）

本轮六次重建中：acquisition/execution 字节未变，manifest **逐位保持** `3c5b4dba…` / `202dfcd4…`（同字节同 manifest 的确定性复现）；agent 随每单元源码演进重绑，终树 `1bed0ab1…`。跨引擎复跑仍须先按 image-bind 清单在本机 registry 重建后更新机器块——这是上下文哈希保证的「先重建再跑套件」流程，属设计行为。

| 镜像 | manifest digest | config digest | context digest |
| --- | --- | --- | --- |
| agent | `sha256:1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319` | `sha256:e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5` | `sha256:0eee2b6fd6f3ff7bc1c2454390b529306e7d113c593854291900f9fdc4bb0d32` |
| acquisition | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | `sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012` |
| execution | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` |

机器块唯一权威：`docs/phase3/reports/image-digest.md`（image-gate 解析）。

Phase 3 整改不构成常开声明，也不构成 Phase 4 授权；等待独立复审。未通过前不进入 Phase 4。
