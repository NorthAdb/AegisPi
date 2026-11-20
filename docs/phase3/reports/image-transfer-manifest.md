# Phase 3 原镜像移交准备清单（2026-11-20，主人指令：先准备，不执行移交）

三份原 OCI 归档**尚未实际交到审计方**。本文整理现有路径、字节数、SHA-256、manifest/config digest、标签与已有验证结果，并给出接收方核验步骤；移交通道由主人另定。**本轮零上传、零 registry push、零重建、零覆盖**——归档字节保持交付时原样。

## 1. 交付物现状（2026-11-20 本机复验）

存放路径：`D:\AegisPi\phase3-image-archives\`（仓库外目录，不进 git）。**本轮已重新计算三份归档的 SHA-256，与 `docs/phase3/reports/image-delivery.md` §1 表内记录值逐位一致**——即当前磁盘字节与交付文档记录时点完全相同，未被改动。

| 归档文件 | 字节数 | 归档 SHA-256（2026-11-20 复验 = 交付文档原值） | manifest digest（机器块原值） | config digest | 标签 |
| --- | --- | --- | --- | --- | --- |
| `aegispi-agent_phase3-5250243_1bed0ab1663f.tar` | 105,477,120 | `a569d4557a4edb7644f3cb93568155e81d9c1e2efee29177b9c6ccb808aed42c` | `sha256:1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319` | `sha256:e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5` | `phase3-52502432d21f` |
| `aegispi-acquisition_phase3-5250243_3c5b4dba28b.tar` | 79,900,160 | `723a03953dde4ad1283519310a9795c34e4fc80e8a660df1ffd25044e950487b` | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | 同上 |
| `aegispi-execution_phase3-5250243_202dfcd4fca2.tar` | 112,399,360 | `1661868dc22a3adada29a2f2c5af722d4d2ea24da730e97597e33edf27a2b111` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | 同上 |

manifest/config digest 与 `docs/phase3/reports/image-digest.md` 机器块为同一套绑定值；构建输入（context）清单见 `evals/phase3/lib/image-bind.mjs`（无 `.env`、无密钥）。

## 2. 已有验证结果（既存记录，未重做）

- **自证哈希**（D-57，2026-11-20 实施者机实测）：三份归档各自解包 `blobs/sha256/<manifest-digest>` 后 sha256 等于文件名（即等于机器块 manifest 列）；config blob 哈希等于机器块 config 列且声明 `os=linux`、`architecture=amd64`。
- **原 manifest 上的套件复跑**（D-57）：`test:offline-jobs` 14/14 在原 manifest 上全绿（image-gate 三重绑定全过，容器按 digest 拉取）；同批其余套件计数见 `docs/phase3/reports/audit-response-rereview-11d649a.md` §6。
- **context 一致性**（D-57/D-48）：终树 context 重算三枚与机器块一致。
- 审计方在本机的**同 context 重建**曾得不同 manifest digest（agent `f5977991…`、acquisition `7bbf414d…`、execution `ee512211…`）——按 `image-delivery.md` §4 的区分原则，**重建 digest 不同不构成伪造判据，也不是原镜像验证**；原镜像验证只能在归档移交后于接收方环境闭合。

## 3. 接收后的核验步骤（照抄 `image-delivery.md` §3，接收方可零信任本仓库执行）

1. **传输完整性**：`sha256sum <归档>` 必须等于第 1 节表内归档 SHA-256。
2. **解包**：`mkdir out && tar -xf <归档> -C out`（标准 OCI image layout：`index.json`/`oci-layout`/`manifest.json`/`blobs/sha256/*`）。
3. **manifest 自证**：`sha256sum out/blobs/sha256/<manifest-digest>` 必须等于文件名本身，且等于 `image-digest.md` 机器块对应行。
4. **config 平台核验**：manifest 指向的 config blob 必须声明 `"os":"linux","architecture":"amd64"`。
5. **可选复跑隔离套件**：`docker load -i <归档>` → 本机 `registry:2` push（内容寻址，digest 不变）→ 按仓库 AGENTS 锁定 Node 跑 `test:offline-jobs` / `test:security:integration`，image-gate 会重算本树 context 并核 registry 三重绑定。**已知限度（确认审计标注）**：`docker load` 后若 `phase3-52502432d21f` 标签未被保留，先 `docker tag <manifest digest 对应 image id> 127.0.0.1:5000/aegispi/<name>:phase3-52502432d21f` 再 push——该说明可由 `image-delivery.md` §3 命令形态推得，此处按审计口径明示。

## 4. 本轮边界

- 不上传、不 push registry、不重建、不覆盖原归档；**通道另定**（移动介质或私人同步，见 `image-delivery.md` §1；若主人改选授权 registry 通道，另行授权后执行）。
- **原镜像验证与同 context 重建验证继续分开**：本清单交付的是前者；后者已在审计方本机发生过，不得混称。
- 归档内不含任何凭据（构建输入清单可复核）。
