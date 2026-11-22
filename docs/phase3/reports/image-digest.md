# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。

- **manifest digest**：推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读出的 OCI manifest 内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；隔离套件只跑 manifest digest。
- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。
- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；staged 路径固定 `/`、文件字节按 LF 规范化，摘要是提交内容的函数——同一提交在 Linux 检出与 Windows autocrlf 检出上重算一致（复审 F1）。image-gate 在每条套件前重算本树哈希，漂移即拒绝；并核验 manifest 内嵌 config blob 声明 linux/amd64，非本平台 config 拒绝。
- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。

## 现行纪元（本纪元重建 agent；acquisition/execution 携带原 digest——context 已在本树复算一致、manifest 已在本地 registry 复解析）

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-008f247ea133` | `sha256:21897255ca38ff77c8444cb9932471fe98e3c9a62bfd3ea1b1587b4d2dd034a1` | `sha256:018e67653e2085760b7de6d37ecb96e405bc4d475c5538f21181694b23b14dd3` | `sha256:1bde74ba9f3fd22430a9936cfde7537db7779e17013a50a8067c0e344228d2f2` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-2c612c810ddc` | `sha256:488cb3da47f98009fac76e76245dbb2f0dcfe57250f06100e82d41b5ca50d174` | `sha256:e7e4567514f1c8703d2c134f7435174127bdf0dac8ffcb3cc3c149ccdacf7fc3` | `sha256:88b5f512021048bd116e8f5fcaeaecd44af368ee5ae3a9be223aeaf11a3cdb52` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：22/11/2026, 17:44:24（Asia/Hong_Kong）；源码提交：008f247ea133；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 13: Phase 5 Batch 1 rework
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v2
agent: sha256:21897255ca38ff77c8444cb9932471fe98e3c9a62bfd3ea1b1587b4d2dd034a1
agent.config: sha256:018e67653e2085760b7de6d37ecb96e405bc4d475c5538f21181694b23b14dd3
agent.context: sha256:1bde74ba9f3fd22430a9936cfde7537db7779e17013a50a8067c0e344228d2f2
acquisition: sha256:488cb3da47f98009fac76e76245dbb2f0dcfe57250f06100e82d41b5ca50d174
acquisition.config: sha256:e7e4567514f1c8703d2c134f7435174127bdf0dac8ffcb3cc3c149ccdacf7fc3
acquisition.context: sha256:88b5f512021048bd116e8f5fcaeaecd44af368ee5ae3a9be223aeaf11a3cdb52
execution: sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050
execution.config: sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e
execution.context: sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab
-->

## 前序纪元（历史，表格与附注原样保留；其机器块已移除——本文件只保留一个现行 v2 块，完整原文见 git 历史）

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-008f247ea133` | `sha256:a6b4196f2facc045df0ce151f542ab6099e9ffec7094e90651cee3ca39eb94c8` | `sha256:905a68d2109514121d559b7c7b59506c03ce4ccb6339541418e0b5bb1b846d9a` | `sha256:164acbd1f52f46fb0980042b2706b8029a10cb93e7ea53989632983e65799027` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-2c612c810ddc` | `sha256:488cb3da47f98009fac76e76245dbb2f0dcfe57250f06100e82d41b5ca50d174` | `sha256:e7e4567514f1c8703d2c134f7435174127bdf0dac8ffcb3cc3c149ccdacf7fc3` | `sha256:88b5f512021048bd116e8f5fcaeaecd44af368ee5ae3a9be223aeaf11a3cdb52` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-52502432d21f` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8183df14ff9b9de920d9bd297468c7c3418a38a0286b4effbc9811dbb95cc2ab` | no-network job completed clean |

- 构建时间：22/11/2026, 17:05:04（Asia/Hong_Kong）；源码提交：008f247ea133；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 纪元说明：Epoch 13: Phase 5 Batch 1 rework (P0/P1/P2 fixes)
- 冒烟记录（本纪元）：agent `--self-check` 退出码 0（本纪元实测）。
- 携带镜像的 tag 与冒烟列沿用其原纪元记录（同一 digest 字节未变；context 复算不一致或 manifest 不可解析即拒绝携带，必须重建）。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。
