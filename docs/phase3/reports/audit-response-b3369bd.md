# Phase 3 审计整改回应（b3369bd，2026-11-19/20）

对象：独立审计 `docs/phase3/audits/AUDIT-PHASE3-b3369bd.md`（判定 **NOT MET**，F1–F8）与证据 PR #1（21 文件，仅 fetch 只读，未合并、未以其替代产品整改）。原稿字节一致归档（SHA-256 `AF3616DC…B01BCBB8`，与附件及 PR 内 blob `528199d` 逐字节相同），未改动一字。

处理原则（主人指示）：范围以原开工移交为准；真实 ingress 与预算接线属 Phase 3，不写成 Phase 4 遗留，且必须区分「实现完成、待授权验证」与「尚未实现」；每项先复现再根因修复，每项配可证伪回归门禁；对不接受的说法给代码位置与实跑反证；原始环境/修正环境、fake/真实结果分开报告；缺环境或授权记未验收，不用跳过刷绿；小单元绿后提交推送。全程零付费模型调用、零向真实同事或公开仓库外发、零特权升级。**不进 Phase 4，不宣布常开。**

整改期间发现并同步修复的一个新缺陷（同审计 F4 的「错因也算过」形态）：Dockerfile 预建 `/job/work` 后，实测发现 runc 对已存在挂载点的 tmpfs 根是 `root:root 0755`（镜像内目录属性不带入），job 写入得 EACCES；而旧镜像没有该目录时 docker 运行时自建挂载点才是可写的——旧断言按退出码 9 把 EACCES 误放行为 ENOSPC。修复：执行器与全部套件的 tmpfs 显式声明挂载契约 `mode=1777`（实测 `drwxrwxrwt` 可写），offline-jobs 与 quota 的断言收紧为**必须 ENOSPC**（任何其他错误码=挂载契约破坏，非配额命中）。

## 0. 整改提交与命令

提交表见 §12（绿后分组提交，逐组在其树形态实测）。命令与计数（锁定 Node `D:\AegisPi\tools\node-v22.23.5\node.exe`，整改终树全量；计数较收口时点只增不减）：

```
# 审计回应新增/收紧的验收
node evals/phase3/image-gate/red-proofs.mjs            → M1/M2/M3 全过 EXIT=0
node evals/phase3/security-unit/run.mjs                → 28/28 PASS, EXIT=0   （收口 23）
node evals/phase3/restore/run.mjs                     → 11/11 PASS, EXIT=0   （收口  9）
node evals/phase3/ingress-telegram/run.mjs             →  7/7 PASS, EXIT=0   （本地；真实另列）
node evals/phase3/ingress-telegram/real.mjs            →  3/3 PASS, EXIT=0   （授权 token 真实只读）
node evals/phase3/ingress-telegram/real.mjs --simulate-no-token → EXIT=3（未验收，不冒充）
node evals/phase3/offline-jobs/run.mjs                → 11/11 PASS, EXIT=0   （收口 10+新增 warn 演练；tmpfs 断言收紧为必须 ENOSPC）
node evals/phase3/security-integration/run.mjs        → 29/29 PASS, EXIT=0 （收口 21；电池 12 探针全 BLOCKED、bridge 对照证探针可见泄漏、镜像所有权门禁、acquisition 十二用例）
node evals/phase3/quota-calibration/run.mjs           →  5/5 PASS, EXIT=0   （pids 断言 ≤256；tmpfs 必 ENOSPC；CPU 比值本机复跑 3.75，门槛为 >1.3 的可测效应）
# 回归
node evals/phase3/cancel-approval/run.mjs              → 16/16 PASS, EXIT=0
node evals/phase3/cancel-approval/red-proofs.mjs       → 3 组变异红证 EXIT=0
node evals/phase2/durability/run.mjs                   → 164/164 PASS, EXIT=0
node evals/phase2/budget/run.mjs                       → 20/20 PASS, EXIT=0
node evals/phase2/acl/run.mjs                          → 15/15 PASS, EXIT=0
node evals/contracts/run-contracts.mjs                → 15/15 PASS, EXIT=0
node evals/contracts/tools/verify-hono-oracle-pair.mjs → EXIT=0（含未安装快照 exit 2 两行断言）
```

## 1. F1（高）digest 门禁不绑定源码，记录值不可运行

**意见**。image-gate 只匹配 `sha256:`+64 hex；记录三值在审计环境 `not found`；按树重建 manifest 不同；agent 上下文在 96c8c93 后增 2326 行而证据未更新；套件跑的镜像不核对层与 git 树。

**处理决定**。证据升级 v2 三值绑定：`manifest`（registry 内容摘要，套件运行引用）+ `config`（manifest 内嵌摘要）+ `context`（构建上下文确定性字节哈希，`evals/phase3/lib/image-bind.mjs` 与构建工具同源同清单）。`image-gate.mjs` v2 四重核验：格式、上下文漂移（改树未重建即拒）、registry 实解析并复核服务字节哈希（证明是 manifest 而非 config）、config 对账；v1 块直接拒绝并指路重建。构建改 `--provenance=false --sbom=false`。终树三镜像重建，`docs/phase3/reports/image-digest.md` 机器块 v2 为唯一权威。

**本机实测的加重事实（接受并归档）**。旧记录三值在本机 registry 逐一取回，`mediaType=application/vnd.oci.image.index.v1+json`、`INDEX(2 manifests)`——它们是 BuildKit 的 attestation **index digest**，从来不是证据表声称的「OCI manifest」。审计环境解析失败与重建值不同的原因由此补全：跨引擎 index/manifest 组成不同，且旧值绑定的本来就不是收口树。

**红绿证据**。
- 红（修复前，本机实跑）：scratch 探针对 v1 门禁写入伪造 digest 块 → `CURRENT GATE ACCEPTED a fabricated digest block`（hex 全零/全一/全二均通过）。
- 绿：终树重建后 `probe-evidence-holds`（manifest+config+context 全绑定）通过；`image-gate/red-proofs.mjs` 三组变异红证全过——M1 关闭 registry 解析则伪造 digest 过门（探针红）、M2 关闭上下文比对则改树不红（探针红，源码逐字节还原）、M3 关闭 config 对账则「真 manifest+矛盾 config」过门（探针红）。M3 探针初版测错层（config digest 在 manifests 端点 404 先于对账被拒）已改为由 cross-check 独活捕获的形态。
- 终树 v2 证据：agent `e21ce351…`/`d40bd37d…`/`a91d97dd…`，acquisition `3c5b4dba…`/`665f9c54…`/`810d2b3c…`，execution `202dfcd4…`/`9f2ec84e…`/`8071bb11…`（manifest/config/context）。构建机为 Docker Desktop 29.9.2；跨引擎复跑须按 image-bind 的清单在本机 registry 重建后更新机器块——这正是上下文哈希要保证的「先重建再跑套件」流程。

## 2. F2（高）Linux 默认 umask 下作业写不了输出挂载

**意见**。镜像用户 uid=999；执行器 `mkdirSync` 按进程 umask 建 0755 挂载目录；Linux 上 runner 写 `result.json.tmp` 得 `EACCES`，`test:security:integration` 在断言前 `ENOENT` 崩溃。不得用全局 chmod 777 掩盖。

**处理决定**。所有权契约归镜像：execution/acquisition Dockerfile 以 uid 999 预建并 chown `/job/input`、`/job/work`、`/job/output`、`/plan`、`/downloads`；宿主挂 **named volume**（空卷以镜像内目录初始化），证据经 `docker cp` 在容器移除前回收（执行/超时/取消/LOST/孤儿全路径收编并清理 volume）。无任何 chmod 777。

**红绿证据**。
- 红（本机）：WSL Ubuntu-24.04（docker server 29.9.2，真实 Linux bind 语义）0755 目录挂载 → 容器内 `uid=999(aegis)`、`touch /probe/x` → **Permission denied**。与审计 Linux 实测互证。
- 绿：`execution-image-owns-its-output-mount`（security-integration）——任意引擎上新 volume 于 `/job/output`，容器内 `id -u`=999 且 `test -w` 可写；offline-jobs 执行/超时/取消/孤儿与执行冒烟全部经 volume+cp 路径通过（见 §0 计数）。

## 3. F3（高）备份不认证数据库字节；AES-256-GCM 只封 manifest

**意见**。`.db` 是明文 SQLite；manifest 只记 `backupBytes`；等长替换 canary 后恢复接受、新值入库；「整份备份已加密」的读法失真。

**处理决定**。manifest v2 增 `dbSha256`（镜像字节哈希，封在 AES-256-GCM 内）；`restoreFromBackup` 先哈希后开库，等长替换必拒；v1 无 dbSha256 的 manifest 一律拒收。加密范围如实标注：**镜像 .db 本身是明文**，认证（而非加密）来自封好的 manifest；若威胁模型含备份目录被读取，明文暴露记为剩余风险，不用措辞掩盖。

**红绿证据**。
- 红（修复前，本机实跑）：等长替换 `AUDITTOKEN-AAAA`→`AUDITTOKEN-BBBB`（size 不变）→ `CURRENT RESTORE ACCEPTED the tampered image; canary in restored db = AUDITTOKEN-BBBB`。
- 绿：`restore-rejects-equal-length-db-tampering`（restore 套件，终树 PASS，拒绝理由为字节哈希不符）+ 原有 9 条不回归；错误密钥/坏信封等旧拒绝路径不变。

## 4. F4（高）acquisition 在 Linux 引擎不成立；fetch 失败刷绿穿越项；重定向不限主机

**意见**。测试源 `host.docker.internal` 无 `--add-host` 在 Linux `ENOTFOUND`，八用例七死于 `unexpected: fetch failed`；穿越项在 `fetch failed` 时仍 PASS；`fetchTo` 跟随任意 http 跨主机 302。

**处理决定**。可达性：acquisition 运行加 `--add-host=host.docker.internal:host-gateway`（双引擎通用）。断言诚实化：每个 abuse 用例必须匹配**具体拒绝原因**，`fetch failed` 一律 FAIL 并单列 `acquisition-dead-source-is-not-a-security-refusal` 用例把「不可达=死源，非安全拒绝」钉进门禁。重定向主机集：默认仅计划主机同名（任意端口），跨主机必须经宿主生成计划的 `allowedRedirectHosts` 显式放行；重定向目标嵌凭据即拒。

**红绿证据**。
- 红 A（本机）：死源（port 9）实测满足旧穿越谓词 → `CURRENT traversal predicate passes on a DEAD source: true`。
- 红 B（本机）：源站 302 至另一主机名，旧 `fetchTo` 取回 secret-bytes 32 字节（`cross-host redirect followed ok: true`）；修复后同一探针 `ok: false`。
- 绿：acquisition 十一用例（好档解出、穿越按 tar/树拒绝原因、软链、设备、炸弹、超限、换协议、环、**跨主机拒**、**放行跟随**、同主机跟随）+ 死源用例，终树计数见 §0。

## 5. F5（中）逃逸电池三项断言弱于标题；metadata/TOCTOU 无探针

**意见**。host_ports 未等连接即报 BLOCKED 且无断言读它；直 HTTP 打 TEST-NET 任何错误都算 BLOCKED；git 不在镜像 `IN_SANDBOX=false` 仍 PASS；metadata 与 TOCTOU 只在注释。

**处理决定**。探针全部改为**读实测结果**：direct_http/host_ports/env_manipulation 改打本套件真实监听源（响应即 LEAK/CONNECTED，错误带 errno）；新增 `metadata`（169.254.169.254 必须不可达）与 `toctou_input`（重写只读 manifest 必拒）探针并断言；git 夹具诚实化：执行镜像装 git（bookworm 源浮动，基础镜像仍 digest 固定），断言要求 `EXECUTED_IN_SANDBOX alias=true` 且 `/escape-marker` 不存在，`GIT_ABSENT` 即红；**bridge 对照容器**（同镜像同 caps 仅网络不同）必须报 CONNECTED/RESOLVED，证探针可见泄漏、非同义反复；pids 断言收紧 ≤256；absolute_paths 加 `/etc/shadow:BLOCKED`。

**红绿证据**。修复前的形态即审计 M/对照实测（对照容器下 direct HTTP 取回 secret、端口探针对监听端口仍报 BLOCKED）。绿：`escape-probes-detect-reachability-under-bridge-control` + 电池十二探针断言全过（终树计数见 §0）；电池内 `--network none` 保持，任何探针被弱化成恒 BLOCKED 都会在对照阶段翻红。

## 6. F6（中）生产 tick 用常量 300 microUSD 结清 fake worker

**意见**。无旗标 daemon tick 预留后恒 `settle({actualMicrousd:300})`，既非未知用量保守占额、也无真实账单可依。

**处理决定**。fixture 隔离：claim→completeTask 全段仅存在于 `--fake-upstream`，结清 usage 带 `source:"fake-worker-fixture"` 与 `basis` 标注（审计行可辨真伪）；无旗标路径**零结清零预留**并如实打印「无执行路径接线」。账本 API 的未知用量/CHARGED_BOUND/账单校正语义未动（Phase 3 预算硬门禁本体，security-unit 既有检查保持）。真实 HTTP 提交器**仍未实现**——按主人更正记为 Phase 3 范围内的实现缺口（非 Phase 4 归属）：失败关闭下零字节外发，验证需主人对调用类型与预算的授权。

**红绿证据**。
- 红（修复前，本机实跑）：无旗标 `daemon --once` 后审计行 `worker settlements on the NO-AUTHORIZATION path: [{"actualMicrousd":300}]`（裸 usage）。
- 绿：`no-flag-daemon-tick-settles-no-fabricated-usage`（settlements=0、worker 预留=0）与 `fixture-daemon-tick-settlement-is-labeled-fixture`（恰 1 笔、带 fixture 标注）两条 daemon 实跑断言；budget 套件 20/20 不回归。

## 7. F7（中）ingress 真实只读未复现仍算套件通过

**意见**。缺 token 时 5 judged + NOTE、exit 0，与收口「8/8」不可区分；`getUpdates` 无 offset 而断言不查；HMAC 注释把 Telegram webhook 头验证说成同一件事。

**处理决定**。验收拆分：本地 `test:ingress-telegram` 7 条（含**新增** offset-缺席断言、队列不消费断言、webhook guard 行为断言），NOTE 声明真实验收在别处；`test:ingress-telegram:real` 独立脚本——缺 token **exit 3** 明确记未验收（`--simulate-no-token` 在有凭据机器演练同一路径）；注释改真：ingress-verify.mjs 是通用 HMAC 原语，Telegram 的 `X-Telegram-Bot-Api-Secret-Token` 常时比较已实现为 `createTelegramWebhookGuard`（未接公网端点，如实标注，不宣称已对真实 webhook 验收）。

**红绿证据**。
- 红（修复前，本机实跑）：移开 `.env`（前后 SHA-256 一致，未读内容）跑旧套件 → `5 pass, 0 fail` + NOTE、`EXIT=0`。
- 绿：本地 7/7；`--simulate-no-token` → **EXIT=3 NOT VERIFIED**；真实只读（既有授权 bot）3/3——`getMe` 确认 @aegispibot（id 掩码）、`getUpdates` 读 1 条且出网请求**无 offset 参数**、真实 update 以 OBSERVE 落库；零发送、零确认、token 不出现在任何输出。

## 8. F8（低）SSE 无 scope 过滤；保留期与磁盘触警未演练

**意见**。SSE SQL 只有 `seq>?` 而注释称 scope-filtered；`retentionDays` 无实现；`statfs` 真但从未触警。

**处理决定**。SSE 按 caller 可见 scope 过滤（principal 自有 + 活跃 grant + service 域），bootstrap 亦绑定 owner principal；保留期落地 `pruneExpiredBackups`（新备份落地时清理过期对并写审计）；磁盘触警注入演练缝 `AEGISPI_DISK_DRILL_{WARN,CRITICAL}_GIB`（只能更严、不能关闭水位，非法值即拒），并把「launch policy 卡死 --once」修成有界等待（越 deadline 界 exit 5）。

**红绿证据**。
- 红（修复前，本机实跑）：bootstrap caller 于 SSE 读到既非自有也无 grant 的 scope 事件（`foreign-scope event visible to ungranted bootstrap caller: true`）。
- 绿：`sse-filters-to-caller-scopes-until-granted`（越权不可见、grant 后可见）；`backup-retention-prunes-expired-pairs`；`disk-watermark-critical-drill-opens-read-only`（真实 statfs 读健康盘 466GiB、注入阈值触发 → 只读 exit 3）；`disk-watermark-alerts-once-per-level-transition`（告警恰一次）；offline-jobs `disk-warn-drill-blocks-new-job-launches`（warn 注入下 QUEUED 不发车、daemon exit 5、无容器残留）。

## 9. 接受但按主人更正归属；以及部分接受项

- **真实 ingress 与预算接线属 Phase 3（接受主人更正）**：审计把两者笼统归入 Phase 4 的表述不准确。如实归类为——预算**硬门禁**（HELD/CHARGED_BOUND/未知不结零/账单校正须可信账单+actor/收费提交须活预留）已实现并以 fake+本地实证（budget 20/20、security-unit 相关检查、cancel-approval 末条）；真实 ingress 已实现且**已验收**（§7 的 3/3，主人授权 bot 只读）；真实 HTTP 提交器与真实账单校正是「实现缺口/待授权验证」，记为 Phase 3 内未竟项而非 Phase 4 遗留——**尚未实现的不写成已完成**，已完成的不再被推给下一阶段。
- **收件人空数组语义（部分接受，不改代码）**：`mail.send` 空收件人名单逐个拒绝是失败关闭（未配置授权名单即不外发），与 `allowedRepos` 空数组的「不做额外白名单」是**方向相反的两种默认**：读类放行需显式收紧，写类拒绝需显式放行。保留行为，注释已区分；此差异不是缺陷。
- **审计「不能单独写成当时造了假 digest」的谨慎（接受并被本机证据补全）**：旧三值确为本机真实推送的 index digest（§1），非编造；失真是「绑定与标签」，不是「伪造」。

## 10. 环境与数据源真相

| 项 | 原始环境（审计） | 修正环境（本机） | fake/真实 | 状态 |
| --- | --- | --- | --- | --- |
| Node | 官方 22.23.5（SHASUMS 校验） | 22.23.5 锁定路径 | — | 两侧一致 |
| Docker | Ubuntu 24.04.5 / dockerd 29.1.3 | Docker Desktop 29.9.2（build a82e528）+ WSL Ubuntu-24.04 复现 Linux bind 语义 | — | 跨引擎差异如实记录 |
| 镜像 | 审计环境重建 manifest 与本机不同 | 三镜像 v2 绑定重建于终树 | — | 门禁按上下文哈希强制「先重建再跑」 |
| 备份/恢复 | 等长篡改被接受（M/T） | 同样复现后修复 | 本地 SQLite | 已验收 |
| offline-job 执行 | umask 022 崩溃 / umask 000 过 | volume+cp 路径 | 真实容器 | 已验收 |
| acquisition | Linux 不可达死源刷绿 | host-gateway + 主机集门禁 | 真实容器+本机源 | 已验收 |
| ingress | 无 token，5/5+NOTE 记 U | 授权 bot 只读 3/3；缺凭据路径 exit 3 | 真实（只读、零发送） | 已验收（真实部分限本机凭据） |
| 预算结清 | 裸 300 结清（R） | fixture 隔离 | fake 传输 | fake 侧已验收；真实账单**未验收（无授权）** |
| webhook 真实源 | 无公网端点 | 同 | — | **未验收（授权缺口，如实）** |
| 4 GiB tmpfs 全量写 | 未做 | 未做（512MiB 同机制 + ENOSPC 专属断言） | 真实 cgroup | 记未验收，Phase 4 实画像后定终值 |
| 磁盘实压 | 未降阈值 | 注入阈值实跑触警 | 真实 statfs | 已验收（注入式，缝只能收紧） |

## 11. 剩余风险（整改后仍在，如实保留）

1. 同容器 `result.json` 可伪造（02 §5 明文承认）：宿主以容器退出码与证据字段定 job 终态，伪造仅损其自证；oracle 的**宿主侧比较仍未接线**（offline-jobs NOTE 与收口附记已改为如实表述）。
2. runner 落盘后孙进程改写 `result.json` 的竞态未稳定复现（审计 U 保留）；即便发生，`SUCCEEDED` 仍要求容器退出码 0。
3. PID 复用窗口（D-18）单人单机接受。
4. 备份 `.db` 明文（认证不加密）：备份目录被读取的场景下内容可读——威胁模型升级须再做整库认证加密（记录，不默认实施）。
5. apt 层随 bookworm 浮动 + 构建机代理对 deb.debian.org 随机 502（有界重试收敛，`git --version` 断言兜底）；基础镜像仍 digest 固定。
6. 4 GiB 全量 tmpfs 写、真实账单校正、真实 webhook、真实仓库写闭环：授权或实画像后进行（移交 §0/§4 原文如此，未越界）。

## 12. 提交与推送

| 单元 | 提交 | 内容 |
| --- | --- | --- |
| A 归档 | `ccfcfe5` | 审计原稿字节一致入库（SHA-256 `AF3616DC…`，与 PR #1 报告 blob `528199d` 相同），一字未改 |
| B 整改 | `dd80987` | F1–F8 根因修复 + 门禁 + 自发现 tmpfs 修正 + 三镜像 v2 证据 + 全套件终树证据与 Phase 1/2 回归证据（53 文件） |
| C 回应 | 本提交 | 本回应、收口更正附记、decision-trail D-40..D-47、执行清单、基线摘要 |

推送：整改三提交推送至 `origin/main`（推送后 `origin/main` 指向本回应提交）。Phase 3 整改不构成常开声明，也不构成 Phase 4 授权；等待独立复审。
