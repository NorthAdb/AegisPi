# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。

- **manifest digest**：推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读出的 OCI manifest 内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；隔离套件只跑 manifest digest。
- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。
- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；staged 路径固定 `/`、文件字节按 LF 规范化，摘要是提交内容的函数——同一提交在 Linux 检出与 Windows autocrlf 检出上重算一致（复审 F1）。image-gate 在每条套件前重算本树哈希，漂移即拒绝；并核验 manifest 内嵌 config blob 声明 linux/amd64，非本平台 config 拒绝。
- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。

## 现行纪元（本纪元重建 agent/acquisition；execution 携带原 digest——context 已在本树复算一致、manifest 已在本地 registry 复解析）

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-7cc85d9de4a2` | `sha256:20d51fb34e3a28f2d76aefe179649fced81c7f0d8c29d602bb4a8865bfa3f904` | `sha256:57b87b449b1a6cc830e2a2c9ae23f66a766fcac78b934593eee9b9cf16cf6061` | `sha256:764ca000404b0998c1156eb73b53a6dee1449c95781cfd893056533aa7745498` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-7cc85d9de4a2` | `sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c` | `sha256:6d94e022acf79ffb529ca1943d15b73918f8ee00f2301b8e469ef0edef48b02b` | `sha256:36b473094d9b70befe2d5f14935d4fbd0b0bb82effb1e85c530d4e6836c87b3e` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：21/11/2026, 12:30:52（Asia/Hong_Kong）；源码提交：7cc85d9de4a2；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 6 (Phase 4.2 Permission 1 offline repo-observe): rebuilt agent and acquisition (sha256 double-digest fix, acquisition launcher, token caps, heartbeat alignment, P2 hardening); execution verified context-identical and carried over.
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）；acquisition 对不可达 URL 失败关闭并经 volume 写出 report.json（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v2
agent: sha256:20d51fb34e3a28f2d76aefe179649fced81c7f0d8c29d602bb4a8865bfa3f904
agent.config: sha256:57b87b449b1a6cc830e2a2c9ae23f66a766fcac78b934593eee9b9cf16cf6061
agent.context: sha256:764ca000404b0998c1156eb73b53a6dee1449c95781cfd893056533aa7745498
acquisition: sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c
acquisition.config: sha256:6d94e022acf79ffb529ca1943d15b73918f8ee00f2301b8e469ef0edef48b02b
acquisition.context: sha256:36b473094d9b70befe2d5f14935d4fbd0b0bb82effb1e85c530d4e6836c87b3e
execution: sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050
execution.config: sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e
execution.context: sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab
-->

## 前序纪元（历史，表格与附注原样保留；其机器块已移除——本文件只保留一个现行 v2 块，完整原文见 git 历史）

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-9b1d5fda8cc4` | `sha256:5be3082db79d4d0f20163bce8bf452c37cfc041c621b6a467727fdebe13e8bde` | `sha256:68478dea9ceac793c857b58e8d33c3bac0253bccb368ec16f29f2ceeaf1738fe` | `sha256:c4ded878e5b3a2da407ce799f3745e527e65a56df589b03043a81caf1dde03df` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-52502432d21f` | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | `sha256:8abae27516f116bc0805481b5ad5b65c904303cc4dcf2b417700267edd2f7012` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：21/11/2026, 08:50:46（Asia/Hong_Kong）；源码提交：9b1d5fda8cc4；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 5 (Phase 4.1 hardening): agent rebuilt with final scanPendingProposals empty-tasksToVisit fix, post-launch container lease heartbeat, and graceful receipt wait window; acquisition/execution verified context-identical and carried over.
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。
