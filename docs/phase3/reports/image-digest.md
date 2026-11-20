# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。

- **manifest digest**：推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读出的 OCI manifest 内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；隔离套件只跑 manifest digest。
- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。
- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；staged 路径固定 `/`、文件字节按 LF 规范化，摘要是提交内容的函数——同一提交在 Linux 检出与 Windows autocrlf 检出上重算一致（复审 F1）。image-gate 在每条套件前重算本树哈希，漂移即拒绝；并核验 manifest 内嵌 config blob 声明 linux/amd64，非本平台 config 拒绝。
- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-52502432d21f` | `sha256:1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319` | `sha256:e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5` | `sha256:0eee2b6fd6f3ff7bc1c2454390b529306e7d113c593854291900f9fdc4bb0d32` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-52502432d21f` | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | `sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：20/11/2026, 11:07:49（Asia/Hong_Kong）；源码提交：52502432d21f；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 冒烟记录：agent `--self-check` 退出码 0；execution 在 ``--network none`` 下经 volume 输出真实执行一个 job（result.json 干净完成）；acquisition 对不可达 URL 失败关闭并经 volume 写出 report.json。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v2
agent: sha256:1bed0ab1663fbd0d549ef9742b7190d582b80eb550906d1e5f3f07c7b3d35319
agent.config: sha256:e5d9951897686e35602ae12e2583aad70fc91856e478591852ef68898ef81cd5
agent.context: sha256:0eee2b6fd6f3ff7bc1c2454390b529306e7d113c593854291900f9fdc4bb0d32
acquisition: sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658
acquisition.config: sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f
acquisition.context: sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012
execution: sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050
execution.config: sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e
execution.context: sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab
-->
