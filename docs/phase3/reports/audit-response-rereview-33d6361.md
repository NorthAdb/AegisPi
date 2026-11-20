# Phase 3 复核 33d6361 回应（原稿已字节归档，本文另写）

生成：2026-11-20。对象：复核原稿 `AUDIT-PHASE3-REREVIEW-33d6361.md`，已原样归档于 `docs/phase3/audits/`（文件 SHA-256 `83d4c023f7dd25c6c5cef965f2a4f89c8ce9a50f16c343c2935b8b4469b08556`，16769 字节，一字未改）。本轮按主人 2026-11-20 指令执行：只做文档纠正、既存材料只读核对与本机原镜像验证；不改生产实现、不开工 Phase 4、不宣布常开；D 延期至首次启用公网 Telegram webhook 前。**`test:external-write:postverify` 及一切只读复核仍是实施者自查，本文不称其为独立审计。**

## 1. 判定表逐项

| 复核判定 | 本轮落实 |
| --- | --- |
| 文档收口成立附残留 | 采纳，无异议 |
| A：目录价算术成立，供应商账单未核对 | **维持原表述**（`model-path-and-pi.md` §7 与状态清单均未写账单已核对）；**「无守卫」事实入状态清单 A 行**：`model-real` 缺 key 时 exit 3、无证据守卫，本机带 key 重跑会再打付费 API——「仅限本次」闭合是文书口径+执行纪律，不是代码保证 |
| B：exit 1 与 postverify 分开属实；守卫被说重了 | **「第二次提交在结构上不可能」已按复核口径更正**（`real-acceptance-run-b.md` 勘误追记节）：守卫依赖 `external-write-real-report.json` 存在，删除/移走该文件后同脚本仍可再执行，URL 仍硬编码于脚本；`AT_MOST_ONCE` 只约束同一 effect，不约束新进程。按主人指令：不删证据、不以重跑验证此点；「停用」同样标注为文书口径 |
| C：次数边界写对但不能闭项；T0 依据不采信 | **T0 授权依据更正为「依据不足」**（`telegram-call-ledger-retrospective.md` 勘误追记节 1；`errata-2026-11-20.md` 勘误 2 加追记）：移交 §2 第 7 项是约束非授权、token 非授权、Phase 1 是另一次另一条 script、仓库无主人逐项原文——不补造。计数口径收紧为「既有报告与实施者自述」（追记节 2）；T2 网络事实维持缺证不闭项（追记节 3） |
| D 不是统一阻塞 | 主人已定：**延期至首次启用公网 Telegram webhook 前**，公网保持关；`console/api.mjs` 的 `CONSOLE_BIND`/`allowedHosts` 硬编码现状未动 |
| 常开：否 | 维持 |
| 原镜像待到件 | 主人改口径：**本机验证通过即闭项**。已执行，见 §3 |

## 2. scratch 只读导出（复核 §8.2 的实施者侧对应物）

`docs/phase3/evidence/scratch-readonly-export-2026-11-20.md`：三库 + WAL 文件哈希、精确 SQL、最小脱敏行集（B 授权库审批链与 effect 行、对照库 `adapter_refused`+`bytes_sent=0`、C 库 OBSERVE 行 received_at=05:30:02.177Z）；不导消息正文、不重播种、不重跑、库留原位不入库。**如实定位**：行与时间戳是实施者本机自生成痕迹，与已入库证据互证，不构成独立网络证据；复核方机器缺库（复核实测 postverify exit 3）维持成立。

## 3. 本机原镜像验证（复核 §8.1「到件后由实施方归档」→主人改为本机闭项）

完整报告：`docs/phase3/reports/local-original-image-verification.md`（环境、27/27 身份核验、docker load 前后一致、loopback registry 三重绑定、套件各恰一次）。要点如实：

- 三 tar 传输哈希与文档值逐位相等；manifest/config blob 与全部 30 层自证；linux/amd64；manifest digest 与 config/image ID 全程分列。原始输出 `imgverify-identity-output.txt`。
- 当前树三套件被 image-gate **按设计拒绝**（exit 2：`package.json` 增两行 script 后 context 漂移 `0eee2b6f…`→`72ed2cae…`），未绕过、未重建、未放宽。
- 在记录上下文树 `11d649a`（detached 临时 worktree，用后已删）各跑一次：quota-calibration **5/5 exit 0**；offline-jobs 9 PASS 后 **daemon 级用例崩溃 exit 1**（job 停留 QUEUED、daemon 零审计行、stderr 被套件无守卫读吞掉；根因未隔离，未决；同用例 D-57 曾过）；security-integration **28/29 exit 1**（唯一 FAIL 为内嵌 offline-jobs 同根因；逃逸/滥用/配额/挂载契约全 PASS 且均跑在原镜像上）。不重试、不强行刷绿。
- 全程原 tar 未修改未上传（结束复验哈希不变）；零 pull、零外部 push、零 `.env`、零 real 入口（含 simulate）；他项目容器未受影响。
- **复核方未收到、未运行原件**；本文所记为实施者本机实测。

## 4. 复核 §8 最小补证逐条对账

1. 三份原 tar 无密钥归档 → 本机验证完成（如上）；未向第三方移交。
2. T2 独立闭合 → 已提供只读最小导出；库不出本机；复核方如需仍可另行裁量。
3. T1 原始 stdout → 实施者机器上已不存在，**维持缺失，未重跑补证**。
4. B body → 用户未提供即不宣称已核；本轮未把载荷或 URL 贴进任何新渠道（零新渠道）。
5. 供应商账单/余额 → 未做 CHARGED_BOUND；A 保持「目录价入账」。
6. 目录价、token 上限、`callUpperMicrousd` → **保持 null/1000 占位**，待主人下次真实运行前书面核定。

## 5. 复核 §7 模型链路 ADR 建议

**采纳记录，本轮不实施**（零生产代码改动）：最小接口五条（提议字段白名单、宿主内 Pi 1.5.2 provider、`input/output/cacheRead/cacheWrite` 结清且 `reasoning` 含于 output 不另计、缺 usage/缺 cache 价保持 HELD、超限行为按现行事实入 ADR）与测试要求（未授权提议零调用、reserve 与调用间崩溃保持 HELD、容器镜像无 key、本单元不开外部写/公网 bind）已在案，供未来授权的 ADR 与 Phase 4 首实现单元使用；归属维持「待复核」，不自行开工。

## 6. 本轮行为边界（与复核原稿的口径一致）

未重测 A/B/C、未核销或续用任何旧额度；未跑任何 real 入口（含 simulate）；未读 `.env`；未改生产代码、门禁或防火墙；未 push 外部 registry；未开/改/合并 PR；`defaults.json` 全程 0 行改动，失败关闭默认保持。
