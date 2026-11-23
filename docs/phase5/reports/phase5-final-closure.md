# Phase 5 终局收口报告（第 3 批：单元 5.6 许可 2 实盘验收 + `report:user-value` 升级 + 终局收口）

> **日期**：2026-11-23（Asia/Hong_Kong）
> **起始基线**：`cbdc86d`（`main` 与 `origin/main` 对齐；第 1/2 批 5.1–5.5 已全部经独立审计 `PASS`，`D-96`/`D-101`）
> **许可级别**：本批含**许可 2 实盘**（Telegram `getUpdates`、真实邮箱 IMAP/SMTP、DeepSeek 草稿、`127.0.0.1:4310` 审批），全部经 `AEGISPI_ALLOW_REAL_PHASE5_ACCEPTANCE=1` 显式授权执行；真实 CalDAV 按主人裁定延后（见 §五）。其余全部离线。
> **范围裁定**：主人 `D-102`（本批开工前拍板，记入 `.audit/decision-trail.tsv`）：实盘范围=①Telegram 路线 1 Pull（每运行 ≤3 轮）+ ②真实邮箱恰 1 封回信；③真实日历延后不阻塞；本批完成仅本地提交，不 `push`，等待独立终局对抗审计。
> **文档性质**：实施与验收记录。实盘结论均为本机锁定 Node `v22.23.5` 实测，未混入任何外部研究数字。

---

## 一、一句话结论

单元 5.6 许可 2 实盘验收在裁定范围内全部完成：真实 `@aegispibot` 私聊 Canary 与私有测试群隔离、`telegram_pull_offset` 落盘、CP4 击杀跨群泄露提案全部实测通过；真实邮箱从 IMAP 只读拉取到 DeepSeek 草稿（四字段预算结清）、4310 控制台 session+CSRF 审批、SMTP over TLS **恰 1 封**测试回信 `external_id` 入账全链路实测通过；真实 CalDAV 如实登记 `DEFERRED / NOT VERIFIED`；`report:user-value` 升级为 12 套必检 + 分场景/分 purpose 归因后 **327/327 全绿（`defaultsFailClosed=true`、零密钥扫描 clean）**；D-101 两项非阻断瑕疵修复；终树全量回归（`probe-evidence-holds`、Hono 预检、12 项本地、6 套 Docker、6 个 `*-real` 缺省 `exit 4`）全部通过。

## 二、实盘执行与失败台账（如实登记，零美化）

实盘共执行 4 次运行（每次 `getUpdates` ≤3 轮，累计 12 轮）。前 3 次为失败试跑，**每次失败均发生在任何外发字节之前**（累计真实发信在成功运行前保持 0，"恰 1 封"额度未受污染）：

| 运行 | 结果 | 失败根因（全部为脚本侧缺陷或主人窗口未及操作，均当场定位修复） |
| --- | --- | --- |
| 第 1 次 | 20/23 | ①主人未在 5 分钟窗口内发出 Canary 私聊（`pulled=0`）→ Telegram 组 4 项失败；②审批卡 ID 直接拼 URL 未做二次百分号编码（D-98 审计探针同款坑），控制台会话未铸出；③`/api/session` 需同时携带 `Authorization: Bearer <bootstrap>`（过检套件的正确形状），脚本只放了 body token；④审批 ID 内嵌邮箱明文进了一条证据细节，被明文 tripwire 当场击中 |
| 第 2 次 | 21/23 | 主人重发消息后 Telegram 全绿；URL 编码已修；**`/api/session` Bearer 头缺陷**仍未定位（session 401 → 审批未消费 → dispatch 拒绝） |
| 第 3 次 | 22/23 | session 修复经本机诊断库零副作用验证（`session 200`、`encode` 路径 200 + `decisionMaterials` 可见）后，审批全链路通过；**`MAIL_TEST_RECIPIENT` 首字母大写**：`mail-triage` 校验层小写化放行提案，`createAdapterUpstream` 的 `validateIntent` 精确比较原始大小写 → 分发失败关闭（零字节外发） |
| 第 4 次 | **23/23 全 PASS** | 全链路通过，**SMTP 真实发送恰 1 封**，`external_id` 入账；但进程在收尾段崩溃：`rmSync` 先于 DB `close`，Windows 打开的 SQLite 句柄锁文件 → `EBUSY`，证据重写与退出码 0 未及完成 |

崩溃后处置（可重入设计，任务明文要求的路径）：由于第 4 次运行已消耗"恰 1 封"发信额度，**任何完整重跑都会发出第二封、违反硬红线**，因此为脚本补上 `--finalize-kept-workspace` 恢复模式：对保留工作区（崩溃时 `rimraf` 在第一个被锁文件即抛出，工作区零损失）做**只读**重推，全部可由状态验证的断言重判 12/12 PASS，流程型时刻（守卫探针、轮次预算、控制台会话流、SMTP 计数）如实引用原始日志 `.audit/batch3-real-run-4.log`；零网络/零模型/零 SMTP 调用。主流程收尾顺序同步修复（证据先于清理落盘、`close` 先于 `rmSync`、清理失败降级为 NOTE 永不崩溃）。

失败台账中的三处脚本缺陷与收尾时序缺陷均已修复进主流程，后续任何重跑（含审计官自跑）不会再踩。

## 三、实盘验收结果（裁定范围逐项）

### ① Telegram 路线 1 Pull（真实 `api.telegram.org`，经本机 `127.0.0.1:7897` CONNECT 代理出网）

| 验收项 | 实测结果 |
| --- | --- |
| `allowRealPull` 失败关闭探针 | 缺省配置零 `getUpdates` 调用（计数 runner 实证 0 轮） |
| 私聊 Canary 入库 | 主人私聊含 `CNRY-AEGISPI-8v7jsqz4cobi` 消息按真实流程幂等入库至 `dm:telegram:<owner>` 域（恰 1 个 payload 对象） |
| 私有测试群隔离 | 群消息入库 `group:telegram:<group>` 域；群载荷 Canary 命中 **0**；全工作区对象文件扫描 Canary 恰 **1** 处（其私聊宿主文件） |
| 群任务读不到私聊 | 主人作为群读者（仅群域 read 授权）：L1 图展开服务其群载荷（1 对象）、对私聊 Canary 对象被拒（`objects=0, skipped=1`） |
| CP4 红线 | 群任务提案引用私聊 Canary 对象向群外发 → **建行即 `EffectCp4Blocked`**，`im.notify` effect 行 0，`cp4_recipient_scope_leak_blocked` 审计 1，零外发字节 |
| 游标 | `telegram_pull_offset` 落盘 `system_state`（0 → 500045908），重放轮 `pulled=0 admitted=0` 游标稳定 |
| 轮次预算 | 每运行 3 轮（冲刷/窗口/重放），≤3 轮上限在检查中断言 |
| 回执脱敏 | 全部审计 `details_json` 零 Canary、零 bot token；两条证据文件 + 4 份运行日志经 9 个真实秘密独立扫描 clean |

### ② 真实邮箱（IMAP over TLS → DeepSeek → 4310 控制台审批 → SMTP over TLS）

| 验收项 | 实测结果 |
| --- | --- |
| 读/发失败关闭探针 | `allowRealMailRead=false` 零 IMAP 调用；`allowRealMailSend=false` 发送门 `authorized=false`（零字节） |
| IMAP 只读拉取 | 真实 `LOGIN/SELECT INBOX/UID SEARCH/UID FETCH` 拉取 10 封；测试邮件=最新一封，发件人入运行时白名单（仅落 gitignored `workspace-state`，脱敏快照存证） |
| 信封身份分诊 | `ingestInboundMail` 仅按信封发件人准入，脱敏摘要落库，线程键自 References 根 |
| DeepSeek 草稿 | `deepseek/deepseek-flash`（`reasoning:"high"`）恰 1 次调用：in/out=175/358，四字段目录价结清 **483µ$**（≤ 单调用上界 $0.05，任务账户 $0.80 / 日 $5.00 账本不变） |
| 草稿先行停车 | `WAITING_APPROVAL` + `attempt=PARKED`、租约清空、fence 不增、`AT_MOST_ONCE`、4h 审批卡 |
| 控制台审批 | 真实 TCP `127.0.0.1:4310`：bootstrap 只读视图无决策材料、bootstrap decide 401、session+CSRF 消费恰一次（`CONSUMED`）、effect `READY`、task `WAITING_EFFECT`；审批卡 ID 按 D-98 教训做二次百分号编码 |
| SMTP 发送 | **恰 1 次 submit、恰 1 封**（计数 upstream 实证；全库 `mail.send` 行=1 且 `SUCCEEDED`=1），`external_id` 在 effect 行与 `effect_succeeded` 审计两处一致入账 |
| 预算四字段 | 预留→结清状态机全绿：`SETTLED`，`actual=483µ$`，目录价算术一致，`totalFromProvider` 按产品契约为布尔存在（false=pi-ai 按 token 自算成本；流占位符才缺键） |
| 收尾 | 控制台 server 关闭、`4310` 无监听、无测试容器残留、实盘工作区已清理 |

### ③ 真实日历（CalDAV）——如实登记边界

**`DEFERRED / NOT VERIFIED（未配置 CALDAV_*，主人裁定不阻挡 Phase 5）`**。本机 `.env` 无任何 `CALDAV_*` 键；场景二（CalDAV 晨报 + `If-Match` ETag + 条件 Timer + L3 Dreaming）已由 Permit 1 环回 TLS 夹具 `eval:scenarios` **89/89** 验收在案（纪元 16 终树复跑）。`eval:scenarios:real` 已实现可选分支：未来 `.env` 补齐 `CALDAV_*` 时执行**一次只读拉取**并如实记录结果（永不伪装通过、本批裁定下不做任何 `calendar.write`）；缺省路径由 `calendar-registration-honest-never-faked` 检查判定为 `DEFERRED / NOT VERIFIED`。本批真实 `CALDAV` 零字节、零调用。

## 四、交付清单与全量回归（终树，锁定 Node `v22.23.5`）

### 4.1 代码与文档变更

| 变更 | 说明 |
| --- | --- |
| `evals/phase5/scenarios-real/run.mjs`（新增）+ `package.json` `eval:scenarios:real` | 许可 2 实盘验收入口：守卫先于 `.env`（缺省 `exit 4`）、缺键 `exit 3`、统一 `scrub()` 脱敏、写后明文 tripwire、`--finalize-kept-workspace` 崩溃恢复模式 |
| `evals/phase4/report-user-value/run.mjs`（升级） | 9 套必检（+memory-lifecycle/cross-channel/scenarios）+ scenarios-real 可选（present 且 fail>0 时强制聚合 FAIL）；分场景块（收益/拦截断言计数/live 状态）+ 分 purpose 归因（未测=null/未测）；`defaultsFailClosed` 扩至 telegram-pull/mail/calendar 键；零密钥模式扫描（token 形态/sk- 键/带密键值的 JSON/非夹具邮箱） |
| `evals/phase5/scenarios/run.mjs`（D-101 修 A） | 夹具控制 socket 改为 `while` 消费同包全部完整行、残段留待下个 data 事件，彻底消除 TCP 同包粘连偶发卡死（终树 89/89 单跑即过） |
| `apps/daemon/src/briefing-followup.mjs`（D-101 修 B） | 晨报 effect 的 `evidenceManifestHash` 改为对同一份 `digest` 内容串自算 SHA-256，真正绑定 `briefing_payload` 行的 `content_hash`（原 `digestObject.content_hash` 为 undefined，`insertObjectRow` 返回形状两个键都没有，P3-1 兜底只是不崩、实际未绑定任何 manifest——**与 D-101 备忘"改 contentHash"的字面修法不同，以实际返回形状为准**）；镜像重建至**纪元 16**（`agent` `phase3-cbdc86d5fe60`，`sha256:99938a36…`） |

### 4.2 终树全量回归（全部锁定 Node `v22.23.5` 实跑）

| 门禁 | 结果 |
| --- | --- |
| `probe-evidence-holds.mjs` | **rc=0**（manifest+config+context 绑定纪元 16 提交树） |
| `verify-hono-oracle-pair.mjs` | **rc=0** |
| 12 项本地套件 | contracts 15 probes / durability 164 / acl 15 / budget 20 / cancel-approval 20 / restore 11 / ingress-telegram 7 / security-unit 68 / memory-lifecycle 47 / cross-channel 25 / **scenarios 89/89** / report:user-value —— 全 **rc=0** |
| 6 套 Docker 套件 | model-proposal 15/15、repo-observe 7/7、eval:triage 7/7、offline-jobs 14/14、security:integration 29/29、quota-calibration 5/5 —— 全 **rc=0** |
| 6 个 `*-real` 入口缺省守卫 | model-real / external-write-real / ingress-telegram:real / repo-observe-real / triage-real / **scenarios-real（新）** 未设任何 `AEGISPI_ALLOW_*` 实测全 **`exit 4`** |
| `report:user-value` | **PASS 327/327**（154 既有 + memory-lifecycle 47 + cross-channel 25 + scenarios 89 + scenarios-real 12），`defaultsFailClosed=true`，**零密钥扫描 clean**（11 个证据文件模式扫描） |
| 实盘收尾 | workspace-state 实盘目录已清理、`4310` 无监听、无 aegispi 测试容器残留 |

### 4.3 不变项（零放宽核对）

`defaults.json` **0 行放宽**（model/telegram/mail/calendar/credentials/adapters 全失败关闭，`report:user-value` 断言）；`schema-source.json`、canonical `schema.sql` 27 表、`recall.mjs`、既有 5 个 `*-real` 守卫零改动；D 项公网 webhook 维持关闭；零新增 npm 依赖（`pi-coding-agent` exact 1.5.2、`hono` exact 4.13.19 不动）；单任务 $0.80 / 日 $5.00 硬预算不变（实盘单调用上界 $0.05，实际 483µ$）。

## 五、非阻断备忘（移交后续，如实登记）

1. `insertObjectRow(content:)` 的两个调用点（`dispatchEffect` 的 `effect_response`、`insertMailDraftEvidence` 的 `mail_draft`）为**哈希绑定的空心引用行**：行落库、哈希绑定，但内容字节从不落盘（`storage_ref` 为 NULL，读取返回 null）。回执/草稿正本均完整持久在 `action_json` 与审计行中，既有离线套件同形状验收在案；后续如需按对象分页读取这两类证据，需在调用点补 `putObjectContent`。
2. `createAdapterUpstream` 的 `validateIntent` 对 `config.allowedRecipients` 做精确比较，而 `mail-triage` 校验层对同一白名单小写化——混合大小写的部署配置会在分发层失败关闭（本批实盘即触发，安全方向）。备忘：后续可在配置边界统一归一化 `adapters.allowedRecipients`；本批未改产品代码（裁定外），实盘脚本在读入 `.env` 时即归一化。
3. 晨报 effect 证据绑定的修复（§4.1 D-101 修 B）只对**新产生**的晨报 effect 生效；历史上已按 P3-1 空清单常量落账的行不回填。

## 六、推送纪律

本批**仅本地提交，未 `git push`**。按 `D-102` 推送裁定：等待独立终局对抗审计（`/poteto-mode` 多路对抗 + `comment-sicko`）对本地提交树验收通过后，由主人指令统一推送。

## 七、证据索引

- 实盘证据：`docs/phase5/evidence/scenarios-real-report.json`、`scenarios-real-log.md`（finalize 12/12 + `finalization` 来源链）+ 原始运行日志 `.audit/batch3-real-run-{1,2,3,4}.log`（4 次运行全量 stdout，含第 4 次 23/23）+ finalize 日志 `.audit/batch3-finalize-2.log` + 诊断探针 `.audit/batch3-diagnosis/`（控制台 URL/收件人大写两处缺陷的零副作用定位记录）
- 聚合证据：`docs/phase3/evidence/user-value-report.json` + `docs/phase4/reports/user-value-report.md`（327/327，分场景/分 purpose）
- 镜像纪元：`docs/phase3/reports/image-digest.md`（纪元 16 v2 机器块）
- 决策留痕：`.audit/decision-trail.tsv` `D-102`（范围裁定 + 实盘执行 + 失败台账 + 证据链）
