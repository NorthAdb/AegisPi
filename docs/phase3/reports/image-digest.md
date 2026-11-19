# Phase 3 应用镜像 digest 证据

三个应用镜像的真实构建记录（04 Phase 3 入口硬条件）。基础镜像与 Phase 1 记录一致：`node:22.23.5-bookworm-slim`，index digest `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`（见 docs/phase1/reports/image-digest.md）。digest 为推送到本机构建 registry（127.0.0.1:5000，registry:2）后由 ``docker image inspect --format '{{json .RepoDigests}}'`` 读取的真实内容摘要，并经 ``docker pull <ref>@<digest>`` 回拉核验；任何 `PIN_REQUIRED` 或缺失 digest 都必须被 evals/phase3/lib/image-gate.mjs 拒绝。

| 镜像 | tag | 真实 digest（OCI） | 构建冒烟 |
| --- | --- | --- | --- |
| agent | `127.0.0.1:5000/aegispi/agent:phase3-6f9c93fe789b` | `sha256:5355348ad93e1e9be4380531ab78265fac8a77fed89a2dc6181de98062bc1bf5` | self-check exit 0 |
| acquisition | `127.0.0.1:5000/aegispi/acquisition:phase3-6f9c93fe789b` | `sha256:e045e9670a804e9f3ab97b48e69e9c09047b1c05f0877bdaf72b39588f756c97` | fail-closed fetch + report |
| execution | `127.0.0.1:5000/aegispi/execution:phase3-6f9c93fe789b` | `sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8` | no-network job completed clean |

- 构建时间：19/11/2026, 21:20:37（Asia/Hong_Kong）；构建 Node：v22.23.5；Docker：Docker version 29.9.2, build a82e528。
- **构建来源如实记录**：最终构建（即本文件机器块的当前 digest）上下文为 **6f9c93fe789b 之上的 Phase 3 收口工作树**（docker/*/src 容器入口 + apps/daemon 产物），与收口提交内容一致；tag 中的 sha 只标识开工基线。隔离与配准套件已在最终 digest 上复跑全绿（docs/phase3/reports/phase3-closure.md §2）。
- 冒烟记录：agent `--self-check` 退出码 0（容器内自证 Pi exact 1.5.2、cacheWarming=off 映射、无凭据 env、无 ~/.pi、无 docker socket）；execution 在 ``--network none`` 下真实执行一个 job（result.json 干净完成）；acquisition 对不可达 URL 失败关闭并写出 report.json。
- 隔离与逃逸测试必须跑在这些 digest 上（`docker run … 127.0.0.1:5000/aegispi/<name>@<digest>`），不得使用浮动 tag。配额校准（06 §4 占位值）见 docs/phase3/reports/quota-calibration.md。

机器可读块（image-gate.mjs 解析，勿手改格式）：

<!-- app-image-digests v1
agent: sha256:5355348ad93e1e9be4380531ab78265fac8a77fed89a2dc6181de98062bc1bf5
acquisition: sha256:e045e9670a804e9f3ab97b48e69e9c09047b1c05f0877bdaf72b39588f756c97
execution: sha256:59f9a3577e2fdb7fb5c2c1e029251605ed093feb30d40a6cc0157cd1fa223cf8
-->
