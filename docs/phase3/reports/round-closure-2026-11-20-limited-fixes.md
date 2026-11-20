# 本轮限定修复收口（2026-11-20，基线 3f30b029d1410e925729234f8cb4e4c372e29ac8）

**定位**：实施者本机收口报告。按主人授权「本机通过即作为本机验收依据」，本机验收已完成；复核方负责审核修复、测试与证据，**不写复核方运行了镜像原件**。本轮不进入 Phase 4、不宣布常开、不做泛化整改。

## 根因与修复点

**根因 1：offline-jobs daemon 级用例崩溃（security-integration 的唯一 FAIL 是其内嵌同跑）。**链条：detached worktree 只含已提交内容、无 `node_modules`（上级目录亦无）；`daemon.mjs` 顶部静态 import `console/api.mjs`（hono 控制台），daemon 子进程在 import 期即死于 `ERR_MODULE_NOT_FOUND: Cannot find package 'hono'`（exit 1，job 停留 QUEUED、daemon 零审计行）；套件对 `stdout.txt` 的无守卫读先崩成 ENOENT，把 daemon 的 stderr 与 exit code 一并掩蔽。上轮 D-68 的 exit 1（standalone 与 embedded 各一次）与此机制逐点吻合。**出错层是测试层**：生产 daemon 对缺依赖 fail-fast 且报错清晰，依赖由提交在库的 package-lock 声明、由运行它的树安装；错在测试既未保存子进程现场、又让一次读崩掉整个套件。**修复**（`evals/phase3/offline-jobs/run.mjs`，断言语义不变、不跳过用例、不吞错误、不放宽断言）：case 10/11 先把 daemon 的 argv/cwd/exit/spawn-error/stdout/stderr 落盘为 `daemon-*-scene.txt`，`stdout.txt` 改守卫读——缺失即以现场（含 stderr 首行与 scene 路径）FAIL 并继续跑完余下用例。生产代码零改动。上轮失败证据（`imgverify-11d649a-*`）原样保留；本轮复现记录：原生探针 `daemon-repro-probe-11d649a.txt`（空 data-dir 直起 daemon，取得 pristine 报错）、加固套件在复现面 **12 PASS / 2 FAIL**（两 daemon 用例红、现场在案、其余照常运行）`daemon-repro-hardened-suite-11d649a.txt` + 两份 scene 文件。

**根因 2：当前树与镜像 context 绑定失配。**`package.json` 在 `ec23ef7`/`26929a0` 新增两条 npm script，agent 构建上下文自纪元 1 的 `0eee2b6f…` 漂移至 `72ed2cae…`，image-gate 按设计拒绝（exit 2，上轮已录三件拒绝日志）。**修复**：经主人授权建立**纪元 2**（`tools/build-app-images.mjs` 新增 `--only` 选择性构建；绑定策略不变——不缩 context、不删绑定字段、不绕门禁、不手改哈希）：仅重建 agent（manifest `sha256:b136e04d15b52c5be764d4560c967aa9cb52098295148667dc53bc4dd45622c0`、config `sha256:cbd20576f28d2f783d530a6bcfd33578d3948197eee96f59bac1167aa2bc684c`、context `sha256:72ed2caef518a3eee4c21899a478dc61bd73d9c0b3a40a2e39f7d834635104bf`、tag `phase3-848eba6d539f`、`--self-check` 绿）；acquisition/execution 证明 context 本树复算与纪元 1 逐位一致（`8abae275…`/`8183df14…`）且 manifest 在本地 registry 复解析后**沿用原 digest 与 tag**（未重建）。`image-digest.md` 重写为现行纪元表 + 单一现行 v2 机器块 + 纪元 1 历史节（表格与附注原样保留）；**原三份 OCI tar 与其交付证据未动**，新构建产物与原件分开命名、分开记录。构建网络面如实：基础镜像按 digest 固定且本地在位、构建日志无层拉取（仅 metadata 解析）；deps 阶段沿用既有 Dockerfile 的 `npm ci --omit=dev --ignore-scripts`，经公网 npm registry 取 lockfile 固定依赖（与纪元 1 同通道）；推送仅至既有 loopback registry（127.0.0.1:5000）。

## 最终树验收（锁定 Node v22.23.5，对交付树内容）

| 套件 | 结果 | 退出码 | 原始日志 |
| --- | --- | --- | --- |
| test:offline-jobs | **14/14**（daemon 级用例：daemon exit=0、job=SUCCEEDED/0；disk-warn 用例：daemon exit=5、job=QUEUED、warn 行在案） | 0 | `docs/phase3/evidence/accept-epoch2-offline-jobs.txt` |
| test:security:integration | **29/29**（内嵌 offline-jobs 同绿） | 0 | `docs/phase3/evidence/accept-epoch2-security-integration.txt` |
| test:quota-calibration | **5/5** | 0 | `docs/phase3/evidence/accept-epoch2-quota-calibration.txt` |

image-gate 经三套件隐式放行（门禁失败即 exit 2，三套件均跑满）；只读对账三 context 与记录一致，交付前对终树终算无漂移（docs/evidence 不入任何 context 文件清单）。套件再生成的证据（offline-jobs/quota-calibration/security-integration 的 report/log 与 `quota-calibration.md`）为本轮实测：CPU 比值 2.33 为本轮重测值，其余结论与纪元 1 记录同向。

**回归范围依据**：本轮改动面 = 测试加固（evals）+ 构建工具（tools）+ 文档；`git diff 33d6361..HEAD -- apps docker package.json package-lock.json` 为 **0 行**（生产代码与九套非 docker 套件全绿时逐字节一致，defaults.json 同为 0 行），故未重跑非 docker 套件；三套 docker 套件已覆盖改动面与 daemon 生产路径（真实容器、真实 daemon 子进程）。

## 边界遵守（本轮全程）

未跑任何 real 入口（含 simulate）；未读 `.env`、未注入真实凭据；测试网络仅本机服务与必要内部 Docker 网络；未开公网监听、未改系统级防火墙；`defaults.json` 全程 0 行改动保持失败关闭；未向外部 registry 推送；他项目容器与镜像零影响（终态 `docker ps -a` 仅既有 registry 与他项目容器）；A 供应商账单、B 接收正文、C 历史证据按现有缺证口径归档，未追补未重跑；D 维持延期至首次启用公网 Telegram webhook 前；模型链路 ADR 与 Phase 4 待本验收通过后另行定。复现用 worktree 用后已删；本轮临时验证脚本均在系统临时目录、不入库。

## 未决移交

- offline-jobs 的 daemon 用例在**无 node_modules 的树**上仍会（按设计）FAIL——这是加固后的诚实行为（stderr 首行与现场可读），非缺陷；运行 daemon 的树须先安装 lockfile 依赖。
- 纪元 1 原镜像与交付证据保持不动；复核方对修复、测试与证据的审核另行开展，本报告不代其结论。
