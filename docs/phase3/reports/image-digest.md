# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。

- **manifest digest**：推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读出的 OCI manifest 内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；隔离套件只跑 manifest digest。
- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。
- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；staged 路径固定 `/`、文件字节按 LF 规范化，摘要是提交内容的函数——同一提交在 Linux 检出与 Windows autocrlf 检出上重算一致（复审 F1）。image-gate 在每条套件前重算本树哈希，漂移即拒绝；并核验 manifest 内嵌 config blob 声明 linux/amd64，非本平台 config 拒绝。
- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。

## 现行纪元（本纪元重建 agent；acquisition/execution 携带原 digest——context 已在本树复算一致、manifest 已在本地 registry 复解析）

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-c8c4041928ba` | `sha256:08b5ef169f76c808fcea07ab4dad05d3f7005c6eb56adf8335d1c2e66a7bfc2a` | `sha256:19b9e118c163d41073032d6e43f33eeb111082fdde210f0ab55d552a2650650c` | `sha256:f5c5f2b3f8c96d17b4723e17f3a0ec2a59bc866296f42991e59193b3dc22e056` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-7cc85d9de4a2` | `sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c` | `sha256:6d94e022acf79ffb529ca1943d15b73918f8ee00f2301b8e469ef0edef48b02b` | `sha256:36b473094d9b70befe2d5f14935d4fbd0b0bb82effb1e85c530d4e6836c87b3e` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：21/11/2026, 15:35:52（Asia/Hong_Kong）；源码提交：c8c4041928ba；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 7: Unit 4.3 empty-reply uncompleted, KV prefix prompt ordering, and Telegram outbound transport
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v2
agent: sha256:08b5ef169f76c808fcea07ab4dad05d3f7005c6eb56adf8335d1c2e66a7bfc2a
agent.config: sha256:19b9e118c163d41073032d6e43f33eeb111082fdde210f0ab55d552a2650650c
agent.context: sha256:f5c5f2b3f8c96d17b4723e17f3a0ec2a59bc866296f42991e59193b3dc22e056
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
| agent | `127.0.0.1:5000/aegispi/agent:phase3-c8c4041928ba` | `sha256:1e67b441e4f2d113bdf22d0a2a8ad91ec53efd30f7fddb50047faa0c3a643b89` | `sha256:b382d64ac766fcbb200f8d0663a6d49f9217a5af96e4ed0b42c54193c7d0d08d` | `sha256:6bd12f8ce33a5314df388720ae88c622cd5ac2111d6fb50ef279a8a3b8c779c1` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-52502432d21f` | `sha256:98bdcfefcd7acf79450d9d220de10e5ea5822bae486ba32d2baa4eef6b98ba4c` | `sha256:6d94e022acf79ffb529ca1943d15b73918f8ee00f2301b8e469ef0edef48b02b` | `sha256:36b473094d9b70befe2d5f14935d4fbd0b0bb82effb1e85c530d4e6836c87b3e` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：21/11/2026, 15:24:24（Asia/Hong_Kong）；源码提交：c8c4041928ba；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 7: Unit 4.3 empty-reply uncompleted, KV prefix prompt ordering, and Telegram outbound transport
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。
