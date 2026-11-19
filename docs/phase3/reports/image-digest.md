# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件），按 v2 证据格式绑定源码树。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。

- **manifest digest**：推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读出的 OCI manifest 内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；隔离套件只跑 manifest digest。
- **config digest**：同一 manifest 从 registry 读回的内嵌 image config 摘要（本地 image/config id 与 manifest digest 是不同命名空间，不可互换）。
- **context digest**：构建上下文（Dockerfile + 分台源码，见 evals/phase3/lib/image-bind.mjs 的文件清单）的确定性字节哈希；image-gate 在每条套件前重算本树哈希，漂移即拒绝（审计 F1：digest 必须绑定构建它的源码）。
- 输出挂载为镜像所有的 named volume（镜像内 /job/output、/downloads 属 uid 999），宿主 umask 不再决定可写性（审计 F2）；不使用全局 chmod 777。

| 镜像 | tag | manifest digest | config digest | context digest | 构建冒烟 |
| --- | --- | --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-b3369bd05e2c` | `sha256:87e8c195145fdff304d1c3409396876ee49556855f9a1727e1f8617fc52d79b6` | `sha256:d360dd5ae7854176e570175dde83887459f4f81c3f2701dbc7c9f449dd05b26f` | `sha256:be0273e13e8ee1007d3497d25237d808c1668aa53b6723659d2b12e3a18337b9` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-b3369bd05e2c` | `sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658` | `sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f` | `sha256:810d2b3c2cf23af5a30aedf9353064fcca4d95593be696fd7a105131626b81d5` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-b3369bd05e2c` | `sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050` | `sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e` | `sha256:8071bb11348440956ac2428ce33d577f054c49585b399091573c29a1e6597bcb` | no-network job completed clean |

- 构建时间：20/11/2026, 00:17:28（Asia/Hong_Kong）；源码提交：b3369bd05e2c；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。apt 安装的 git 随 bookworm 源浮动（执行镜像内的 git -c 边界夹具，审计 F5）；基础镜像仍按 digest 固定。
- 冒烟记录：agent `--self-check` 退出码 0；execution 在 ``--network none`` 下经 volume 输出真实执行一个 job（result.json 干净完成）；acquisition 对不可达 URL 失败关闭并经 volume 写出 report.json。
- 隔离与逃逸测试必须跑在 manifest digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v2
agent: sha256:87e8c195145fdff304d1c3409396876ee49556855f9a1727e1f8617fc52d79b6
agent.config: sha256:d360dd5ae7854176e570175dde83887459f4f81c3f2701dbc7c9f449dd05b26f
agent.context: sha256:be0273e13e8ee1007d3497d25237d808c1668aa53b6723659d2b12e3a18337b9
acquisition: sha256:3c5b4dba28b503bbb2075fd95ab0fbf0c55ecbb356d85a717e8370e300f7d658
acquisition.config: sha256:665f9c54d5f764cafd77e91c43ffc6a8ad11464fcde01a39572fd40c1a89e83f
acquisition.context: sha256:810d2b3c2cf23af5a30aedf9353064fcca4d95593be696fd7a105131626b81d5
execution: sha256:202dfcd4fca204b1ed69298d31b724a7fbe21de0346afeaf2ee82ab2a21f5050
execution.config: sha256:9f2ec84e696f07584abe5d54f3661ea0d923f1dd9a65aae335c0b649a1e21f8e
execution.context: sha256:8071bb11348440956ac2428ce33d577f054c49585b399091573c29a1e6597bcb
-->
