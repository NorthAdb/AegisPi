# Phase 3 审计回应（AUDIT-PHASE3-b3369bd）执行清单

来源：主人指示 + `docs/phase3/audits/AUDIT-PHASE3-b3369bd.md`（F1–F8）。
范围：原开工移交（`D:\AegisPi\PHASE3-KICKOFF-HANDOFF.md`）。不进 Phase 4，不宣布常开。
纪律：每项先复现，再根因修复与可证伪回归门禁；对不接受的说法给代码位置与实跑反证。
Node 锁 22.23.5。原始环境/修正环境、fake/真实结果分开报告；缺环境或授权记未验收，不准用跳过刷绿。
保留审计原稿；逐项回应另写。不合并审计 PR。小单元绿后提交并推送。

## 第 0 步 基线（先做，已完成）

- [x] 审计原稿移入 `docs/phase3/audits/AUDIT-PHASE3-b3369bd.md`（SHA256 AF3616DC… 与附件/PR 逐字节一致；PR 报告 blob 528199d）
- [x] 完整读审计报告与证据 PR #1（21 文件：报告 + 20 份独立转录，已 fetch 只读未合并）
- [x] 锁定 Node 重跑 Phase 2 出口五条（durability 164/0=50s；budget 20/0=5s；acl 15/0=17s；contracts 15/0=41s；hono-pair exit 0=26s）

## 复现矩阵（每项红在先，本机实测）

- [x] F1 本机复现：伪造 digest 过门（probe 输出 `CURRENT GATE ACCEPTED a fabricated digest block`）
- [x] F2 本机复现：WSL（Ubuntu-24.04 真实 bind 语义，docker server 29.9.2）挂载 0755 宿主目录 → `uid=999(aegis)` `touch: Permission denied`（WRITE-DENIED）
- [x] F3 本机复现：等长篡改备份库 → 恢复接受、篡改值入库（probe 输出 `CURRENT RESTORE ACCEPTED the tampered image`）
- [x] F4 本机复现 A：不可达源（port 9）满足现行穿越谓词（`CURRENT traversal predicate passes on a DEAD source: true`）
- [x] F4 本机复现 B：跨主机 302 被现行 fetchTo 跟随（`cross-host redirect followed ok: true bytes: 32`；修复后同 probe `ok: false`）
- [x] F6 本机复现：无 --fake-upstream 的 daemon --once 仍以裸 usage 300 结清（probe 输出 `worker settlements on the NO-AUTHORIZATION path: [{"actualMicrousd":300}]`）
- [x] F7 本机复现：隐藏 token 跑 ingress 套件 → 5/5 + NOTE，EXIT=0（与 8/8 不可区分；.env 移开前后 SHA256 一致，未读内容）
- [x] F8-SSE 本机复现：越权 scope 事件对 bootstrap 可见（probe 输出 `foreign-scope event visible to ungranted bootstrap caller: true`）
- [x] F8-保留期/水位：结构性缺口（retentionDays 仅 config 引用；无演练通道）——已由新增实现与演练补上

## 修复后（本树实测，全部锁定 Node）

- [x] restore 11/11（新增等长篡改必拒 + 保留期清理）EXIT=0
- [x] security-unit 28/28（新增 SSE scope 过滤、双路 daemon 结清、critical/transition 水位演练）EXIT=0
- [x] ingress-telegram 本地 7/7 EXIT=0（新增 offset-缺席/队列不消费、webhook guard；真实验收已拆分并在 NOTE 声明）
- [x] ingress-telegram:real --simulate-no-token → EXIT=3（缺凭据=未验收，不冒充）
- [x] ingress-telegram:real（授权 token）3/3 EXIT=0（getMe @aegispibot；getUpdates 读 1 条无 offset；OBSERVE 落库；零发送）
- [x] cancel-approval 16/16 + red-proofs 3 组 EXIT=0
- [x] image-gate red-proofs M1/M2/M3 EXIT=0（M3 探针一度测错层：config digest 在 manifests 端点 404 先拒，改为「真 manifest+矛盾 config」由 cross-check 独活捕获）
- [x] 三镜像重建（v2 证据；--provenance=false 推平台 manifest；agent e21ce351…/acquisition 3c5b4dba…/execution 49b51991…）冒烟全过
- [x] offline-jobs 11/11 EXIT=0——但暴露 Dockerfile 回归：镜像内新建的 /job/work 未 chown，runc 把挂载点属主带给 tmpfs 根，job 写入得 EACCES 而旧断言按 exit 9 误放行。已修（chown aegis /job/work）并把 offline-jobs 与 quota 的 tmpfs 断言收紧为必须 ENOSPC（EACCES=挂载契约破坏，非配额）
- [x] offline-jobs 11/11 EXIT=0（最终树；DISK_BOUND_HIT:ENOSPC 实证；warn 演练 exit 5）
- [x] tmpfs 回归根因修正：实测 runc 对已存在挂载点不继承镜像属性（root:root 0755），执行器/全部套件显式 `mode=1777`（实测 drwxrwxrwt 可写）；agent 因此重绑 87e8c195…（门禁对自己改树也拒绝过一次：exit 2，按设计工作）
- [x] security-integration 29/29 EXIT=0（电池 12 探针、bridge 对照、镜像所有权门禁 uid=999、acquisition 十二用例含跨主机拒/放行/死源不算拒绝；初跑 27/29 的两个 FAIL 均为套件侧 bug：id -u 解析、allowlist 用 localhost 在容器内指向自身，已修）
- [x] quota-calibration 5/5 EXIT=0（必 ENOSPC；pids ≤256；CPU 比值 3.75 本机复跑）
- [ ] Phase 1/2 全量回归（durability/budget/acl/contracts/hono-pair，进行中）

## 单元 1（容器侧 + 镜像门禁）

- [x] F1 `evals/phase3/lib/image-bind.mjs`：上下文清单/确定性哈希/registry manifest 解析（构建工具与门禁同源）
- [x] F1 `tools/build-app-images.mjs`：记录 manifest/config/context 三摘要；`--provenance=false --sbom=false`（否则 29.9.2 推的是 attestation index，实测证实旧记录三值均为 index digest）
- [x] F1 `evals/phase3/lib/image-gate.mjs` v2：格式 + 上下文绑定 + registry manifest 实解析（含 index 拒绝）+ config 对账；异步 refuse→exit 2
- [x] F1 红证脚本 `evals/phase3/image-gate/red-proofs.mjs`（M1 伪 digest / M2 上下文漂移 / M3 config 冒充 manifest；探针走 scratch 报告副本，源码逐字节还原）
- [x] F2 execution/acquisition Dockerfile：镜像自有 /job/output、/downloads（uid 999）+ 执行镜像含 git（F5 诚实化）
- [x] F2 `container-executor.mjs`：输出改镜像所有 named volume + docker cp 收证（取消/超时/孤儿/LOST 各路径均收编 volume；无全局 chmod 777）
- [x] F4 `downloader.mjs`：重定向限计划主机集（默认原主机名任意端口；allowedRedirectHosts 显式放行）+ 重定向目标带凭据拒绝
- [x] F5 `security-integration/run.mjs`：电池改打本机真实源 + host_ports/metadata/toctou 探针实测结果断言；bridge 对照容器证探针可见泄漏；acquisition `--add-host=host-gateway`；fetch failed 记 DEAD SOURCE 不算拒绝；git 探针要求 EXECUTED_IN_SANDBOX
- [x] F5 quota pids 断言收紧 ≤256
- [ ] 重建三镜像（新工具，v2 证据）→ security-integration/offline-jobs/quota 在新 digest 上绿 → 提交（构建进行中：agent manifest e21ce351… 已产出平台级 manifest）

## 单元 2（宿主侧）

- [ ] F3 `backup-window.mjs`：manifest 带 dbSha256（v2）；恢复先验哈希再开库；明文库如实标注（密文仅封 manifest）
- [ ] F3 restore 套件新增「等长篡改必拒」红绿检查
- [ ] F8 SSE 按 scope 过滤（owned/granted/service）；security-unit 新增越权 scope 不可见红绿检查
- [ ] F8 `pruneExpiredBackups` 实现保留期清理（daemon 接线 + restore 检查）
- [ ] F8 磁盘触警演练缝（AEGISPI_DISK_DRILL_*）+ critical 只读（unit）与 warn 阻新 job（integration/offline-jobs）实跑
- [ ] F6 daemon tick：fake worker 仅在 --fake-upstream；结清带 fixture 标记；真实路径不造任何用量
- [ ] F6 security-unit：无旗标零结清 + 有旗标带标记两检查
- [ ] F7 `ingress-telegram.mjs` 注释改真 + webhook secret-token 头验证实现（未接公网端点，如实标注）
- [ ] F7 本地套件加 offset-缺席/队列不消费断言；真实只读拆出 `test:ingress-telegram:real`（缺 token exit 3）
- [ ] F7 重跑真实只读（既有授权，零发送）
- [ ] 回归：cancel-approval/security-unit/restore/ingress + Phase 1/2 全套 → 提交（含 agent 镜像重建）

## 单元 3（交付物）

- [x] `docs/phase3/reports/audit-response-b3369bd.md`：F1–F8 逐项表（复现/根因/修复/红绿/环境真相）、接受与部分接受项、剩余风险
- [x] 收口报告加更正附记（§7，八项被证伪表述逐条列出，原文保留）
- [x] decision-trail D-40..D-47（UTF-8 安全追加，47 行、列数校验 0 错）
- [x] 证据刷新（phase1/2 回归 + phase3 全套件终树证据 + ingress-real 新证据）
- [x] Phase 1/2 全量回归终跑：durability 164/0、budget 20/0、acl 15/0、contracts 15/0、hono-pair exit 0
- [x] 三次提交（审计归档 `ccfcfe5` → 整改单元 `dd80987` → 回应与轨迹）+ 推送 origin/main，最终 SHA 见回应文档与本记录
- [ ] 等独立复审；不自行进 Phase 4
