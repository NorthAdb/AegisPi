# Phase 3 原镜像交付与校验说明（复审 11d649a 授权项）

生成：2026-11-20；导出环境：Windows 构建机（实施者环境），Docker 29.9.2，构建 registry `127.0.0.1:5000`（容器 `aegispi-build-registry`）。本文件回应复审 11d649a 的交付缺口：原三枚 manifest 在审计环境的本机 registry 为 404——因为原镜像从未推送到审计机，字节一直在实施者的构建 registry 里。本文件给出离库归档与逐字节校验方式；不公开上传、不经授权部署任何服务、归档内不含任何凭据（镜像构建输入见 `evals/phase3/lib/image-bind.mjs` 的清单：Dockerfile、package*.json、daemon 源码、worker/runner 源码，无 `.env`、无密钥）。

## 1. 交付物

三份 OCI image layout 归档（tar），存放于实施者机器 `D:\AegisPi\phase3-image-archives\`（仓库外目录，不进 git）。文件移交通道由主人自选（移动介质或私人同步），未做任何公网发布。

| 镜像 | manifest digest（机器块原值） | config digest | 归档文件 | 字节数 | 归档 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| agent | `sha256:1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319` | `sha256:e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5` | `aegispi-agent_phase3-5250243_1bed0ab1663f.tar` | 105,477,120 | `a569d4557a4edb7644f3cb93568155e81d9c1e2efee29177b9c6ccb808aed42c` |
| acquisition | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | `aegispi-acquisition_phase3-5250243_3c5b4dba28b.tar` | 79,900,160 | `723a03953dde4ad1283519310a9795c34e4fc80e8a660df1ffd25044e950487b` |
| execution | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `aegispi-execution_phase3-5250243_202dfcd4fca2.tar` | 112,399,360 | `1661868dc22a3adada29a2f2c5af722d4d2ea24da730e97597e33edf27a2b111` |

归档尺寸小于 `docker images` 表列尺寸是正常现象：BuildKit 构建的层在导出时保持压缩形态，表列尺寸按解压层计。

## 2. 归档结构（已在实施者机上解包核验）

`docker save`（Docker 29.9.2，按 digest 钉住引用导出）产出标准 OCI image layout：

- `index.json`：OCI index，`manifests[0].digest` 即上表 manifest digest，附 `config.digest` 注记。
- `oci-layout`：layout 标记。
- `manifest.json`：`docker load` 兼容层。
- `blobs/sha256/<内容哈希>`：内容寻址 blob。manifest 本身与 config blob 都在其中，哈希即文件名，自证不需任何第三方信任。

实施者机已实测（2026-11-20）：三份归档各自解包 `blobs/sha256/<manifest-digest>` 后 `sha256sum` 等于文件名（即机器块 manifest 列）；config blob 哈希等于机器块 config 列且声明 `os=linux`、`architecture=amd64`。

## 3. 独立环境校验步骤（零信任本仓库，只对照 digest）

```bash
# 0) 传输完整性：归档文件哈希等于上表归档 SHA-256
sha256sum aegispi-agent_phase3-5250243_1bed0ab1663f.tar

# 1) 解包（任一归档）
mkdir out && tar -xf aegispi-agent_phase3-5250243_1bed0ab1663f.tar -C out

# 2) manifest 自证：哈希必须等于文件名，且等于 docs/phase3/reports/image-digest.md 机器块 agent 行
sha256sum out/blobs/sha256/1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319

# 3) config 平台核验：manifest 的 config.digest 指向的 blob 必须声明 linux/amd64
cat out/blobs/sha256/e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5 | head -c 200
# 期望含 "os":"linux","architecture":"amd64"
```

acquisition / execution 归档同理，digest 与路径按表替换。

### 可选：在独立环境复跑隔离套件

```bash
docker load -i aegispi-agent_phase3-5250243_1bed0ab1663f.tar   # 三份各自 load
docker run -d -p 127.0.0.1:5000:5000 --name aegispi-build-registry registry:2
docker tag 127.0.0.1:5000/aegispi/agent:phase3-52502432d21f 127.0.0.1:5000/aegispi/agent:phase3-52502432d21f
docker push 127.0.0.1:5000/aegispi/agent:phase3-52502432d21f   # 三镜像各自 push，内容寻址，digest 不变
# 然后按仓库 AGENTS 锁定 Node 22.23.5 跑 npm run test:offline-jobs / test:security:integration
# image-gate 会重算本树 context（须等于机器块 context 列）并核 registry manifest/config 三重绑定
```

## 4. 原镜像验证与同 context 重建验证的区分（不得混称）

- **原镜像验证**：以本文件归档的 manifest 字节为对象。复审审计机此前对其本机 registry 404，其隔离套件无法在原镜像上运行，红证与隔离行为证据来自同 context 的本机重建（该机重建 digest 为 agent `f5977991…`、acquisition `7bbf414d…`、execution `ee512211…`）。归档移交后，原镜像验证即可在独立环境闭合。
- **同 context 重建验证**：在任意机器用 `tools/build-app-images.mjs` 对同一提交内容重建。context digest 是内容的函数（LF 规范化、`/` 分隔路径），跨机跨检出一致；manifest digest 不是——不同构建纪元、不同基础层推送历史会产生不同字节。因此**不要求、也不应期待不同构建有相同 manifest digest**；digest 不同不构成伪造判据，context 与机器块一致 + 归档自证哈希才是绑定判据。
- 实施者机（原镜像所在处）的复跑记录见第 5 节与 `docs/phase3/evidence/`；本轮在原 manifest 上直接跑绿隔离套件。

## 5. 实施者机在原 manifest 上的复跑（本轮实测）

- `test:offline-jobs`（锁定 Node 22.23.5，image-gate 三重绑定全过，容器按 `127.0.0.1:5000/aegispi/<name>@<manifest digest>` 拉取）：计数与退出码见 `docs/phase3/evidence/offline-jobs-log.md`（本轮重跑刷新）。
- 同批重跑的其余受影响套件计数见复审回应报告 `docs/phase3/reports/audit-response-rereview-11d649a.md` 第 6 节。

## 6. 边界

- 归档不含密钥（构建上下文清单可复核）；移交是文件级动作，不部署服务、不开公网 registry、不上传任何凭据。
- 若主人选择「经授权可拉取的 registry」作为替代交付方式，另行授权后执行；本文件不预设该通道。
