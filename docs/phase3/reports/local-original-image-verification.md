# 本机原镜像验证（2026-11-20，主人授权：本机验证通过即视为该项通过）

主人 2026-11-20 指令：三份原 OCI tar 的验证在**实施者本机**完成即可闭项，不要求移交第三方；使用 `D:\AegisPi\phase3-image-archives\` 原件（`audit-transfer` 压缩副本目录不存在，未使用任何副本）；不重建替代原件、不 pull、不 push 外部 registry、原 tar 不修改不删除不上传。**定位如实**：本文全部内容是「实施者本机实测」；**复核方未收到、也未运行过任何原件**（复核 33d6361 的「待到件」判定维持在其机器上成立）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 仓库 | origin/main `33d63611327c131935666d7dfd5f8bf2afecf15f`（验证全程未改，收尾 git diff `apps/daemon/config/defaults.json` 0 行） |
| Node | v22.23.5（锁定路径 `D:\AegisPi\tools\node-v22.23.5\node.exe`，全部脚本经其执行） |
| Docker | client/server 均 29.9.2，server os=linux arch=amd64（Windows 宿主经 Docker Desktop） |
| registry | 既有容器 `aegispi-build-registry`（registry:2，Up 23 小时，仅绑 `127.0.0.1:5000`——本轮未创建、未重建、未删除） |

## 2. 归档身份核验（不依赖外部服务；`evals/phase3/image-gate/verify-original-archives.mjs`，27/27，exit 0）

对每份 tar：传输完整性（字节数 + SHA-256 对 `image-transfer-manifest.md` §1）→ 解包到临时目录（原件只读）→ OCI 布局逐项内容哈希。**manifest digest 与 config/image ID 全程分列，不混用**：

| 镜像 | tar bytes / SHA-256（=文档值） | manifest digest（registry 内容摘要） | config digest（image ID，另一标识） | 层自证 | 平台 |
| --- | --- | --- | --- | --- | --- |
| agent | 105,477,120 / `a569d455…aed42c` | `sha256:1bed0ab1663f…3d35319` | `sha256:e5d995189768…ef81cd5` | 14/14 层哈希=各自 digest | linux/amd64 |
| acquisition | 79,900,160 / `723a0395…950487b` | `sha256:3c5b4dba28b5…0f7d658` | `sha256:665f9c54d5f7…c1a89e83f` | 8/8 | linux/amd64 |
| execution | 112,399,360 / `1661868d…f27a2b111` | `sha256:202dfcd4fca2…a21f5050` | `sha256:9f2ec84e696f…a1e21f8e` | 8/8 | linux/amd64 |

细节如实记：docker-compat `manifest.json` 的 `Config` 字段以**路径形式**（`blobs/sha256/<digest>`）书写，digest 与记录值一致；其 `RepoTags` 为**空**——按 digest 钉住导出的预期形态（image-delivery.md §3 早已为此预留 re-tag 步骤，即复核标注的已知限度），标签在 daemon 侧核验（见 §3）。原始输出：`docs/phase3/evidence/imgverify-identity-output.txt`。

## 3. docker 侧身份一致（load 前后镜像 ID 不变）

- **load 前记录**：三标签 `127.0.0.1:5000/aegispi/<name>:phase3-52502432d21f` → image ID 分别为 `sha256:1bed0ab1…`/`sha256:3c5b4dba…`/`sha256:202dfcd4…`（本机 containerd 镜像存储的显示 ID 即 manifest digest）。
- **`docker load -i <原tar>` ×3**：输出 `Loaded image ID: sha256:<同一 manifest digest>`；**load 前后标签→ID 不变**——加载的是同一对象，**未覆盖任何不同镜像**（主人指令的停止条件未触发）。
- **registry 解析**：对既有 loopback registry `docker push` 三标签（本地操作，非外部 registry），push 返回 digest 逐位等于文档记录的三个 manifest digest（内容寻址相等）——门禁经该 registry 解析原 manifest 的条件成立（既有本地基础设施、零拉取、零重建；同机其他项目容器全程未受影响）。

## 4. 套件运行（各恰一次，不重试，不强行刷绿）

**当前树（33d6361）三套件被 image-gate 拒绝，exit 2（设计行为，未绕过）**：`package.json` 在 `ec23ef7`/`26929a0` 新增两条 npm script 后构建上下文漂移（agent：证据 `0eee2b6f…` → 当前树 `72ed2cae…`），门禁按设计拒绝「记录 digest 不再命名本源码树构建的镜像」。按指令**不重建、不放宽门禁**，原始输出存 `imgverify-current-tree-refusal-*.txt` 三件。

**记录构建上下文树（`11d649a`，其 context 列即构建纪元内容哈希 `0eee2b6f…`/`8abae275…`/`8183df14…`）**：detached 临时 worktree（`git worktree add`，用后已删），门禁三重绑定自然成立（context=记录值、registry manifest=原 digest、config=记录值+linux/amd64），三套件在此树上各跑一次：

| 套件 | 结果 | 退出码 |
| --- | --- | --- |
| test:quota-calibration | **5/5 PASS**（CPU 比值 2.58、内存脏页 OOM、pids 249/256、tmpfs ENOSPC、agent 限额下自检 exit 0） | 0 |
| test:offline-jobs | 9 PASS（执行器级全部真实容器用例：执行/退出码/DNS+HTTP 双封/超时收尸/取消/cgroup 双台差/内存+盘配额强制/孤儿回收/坏 manifest 拒）后，**daemon 级用例崩溃**：`readFileSync(output/stdout.txt)` ENOENT；job 行停留 QUEUED、daemon 零审计行（进程在 tick 起效前退出），其 stderr 已被套件捕获但**未及打印**即崩；余下用例未运行 | 1 |
| test:security:integration | 28/29：逃逸电池、对照泄漏可见性、agent 只读提议面、acquisition 滥用十一用例、output-mount 契约**全部 PASS（均跑在原镜像上）**；唯一 FAIL 为其内嵌 offline-jobs 子运行 exit 1（同一根因） | 1 |

**失败如实记录（不闭项、不重试）**：daemon 级用例失败在本环境确定性复现（独立与内嵌各一次）；同一用例在 D-57（同机同镜像、主树）曾 14/14 通过；无 daemon stderr 留存，根因未隔离，列为**未决**（候选：daemon 启动序某步在本 worktree 环境早退；套件 `run.mjs:528` 的无守卫读先于断言打印崩溃，属测试稳健性缺口，本轮零代码改动未修）。逃逸/隔离/配额对**原镜像**的验证本体不受该用例影响。原始输出存 `imgverify-11d649a-*-output.txt` 三件。

## 5. 清理与边界

- 本轮创建且可明确识别的资源已清：解包临时目录（脚本自清）、`11d649a` worktree（`git worktree remove --force`，`git worktree list` 仅余主树）；docker 侧未新建容器（一次 `docker run` 因重名冲突无害失败），未删除任何他项目容器/镜像/卷（linkforge 系列等全程在运行、未受影响）。
- **三份原 tar 在全流程结束后复验哈希逐位不变**（未修改、未删除、未上传）；registry 为既有容器、内容现即原 manifest；无 docker pull、无外部 registry push、无重建、无 `.env` 加载、无任何 real 入口（含 simulate）、无新公网监听、无防火墙改动、无生产代码与门禁改动。
- 审计指令的镜像对应关系：套件容器均按 `127.0.0.1:5000/aegispi/<name>@<manifest digest>` 解析运行——该 digest 即第 2/3 节从原 tar 逐位验得并 push 相等者，**证明测试对象是从原 tar 加载的原件，不是同源码重建品**。

## 6. 当前树门禁恢复的最小准备方案（不绕过、待授权）

1. 经主人授权后在当前树跑 `tools/build-app-images.mjs` 开**新构建纪元**并提交刷新的机器块证据（原镜像与重建验证继续分列，不以新 digest 冒充原件）；
2. 或继续按本节方式在「记录上下文树」上复跑隔离套件验证原件；
3. 或由主人/ADR 另定绑定策略。本轮未执行其中任何一项。

## 7. 交付定位

本报告及所列证据全部为**实施者本机实测**；复核方侧的原件核验（若其需要）仍属复核方，未发生、也不被本文宣称。
