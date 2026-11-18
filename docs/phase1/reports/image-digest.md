# 容器证据：官方 Node 22.23.5 基础镜像（Phase 1 任务 2/5）

## 基础镜像（已拉取，真实 digest）

| 项 | 值 |
| --- | --- |
| 镜像 | `node:22.23.5-bookworm-slim` |
| RepoDigest（实测） | `sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee` |
| 拉取命令 | `docker pull node:22.23.5-bookworm-slim` |
| 架构 | `amd64`（本机 docker 实测） |
| 拉取时间 | 2026-11-18（Asia/Hong_Kong） |
| Docker | Docker Desktop 29.9.2，守护进程运行中 |

取 digest 命令与输出：

```
docker image inspect node:22.23.5-bookworm-slim --format '{{json .RepoDigests}}'
→ ["node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee"]
```

三个应用镜像的 Dockerfile 以该 digest 固定基础镜像（`docker/{agent,acquisition,execution}/Dockerfile`），全部非 root（`aegis` 系统用户）、`PI_OFFLINE=1`、无宿主凭据/会话/Docker socket 挂载。

## 应用镜像状态

agent、acquisition、execution 三个应用镜像**尚未构建**（Phase 1 无产品代码可装入）。按规范（00 §4、04 Phase 1）：“应用镜像在首次构建时记录真实 digest，三者都锁定是 Phase 3 隔离测试与常开的入口条件”。当前 Dockerfile 已把构建上下文源文件入库，`PIN_REQUIRED` 类占位一律不出现——首次构建回填真实 digest 前，任何门禁必须拒绝以本文件冒充已锁定。

## 容器占位配额（记录，Phase 3 校准）

见 `apps/daemon/config/defaults.json` 的 `containerPlaceholders`（agent 1 CPU/1 GiB/pids 256/盘 2 GiB；execution 1 CPU/2 GiB/pids 256/盘 4 GiB），来源 06 §4，标注为占位上限。

## Phase 1 不做逃逸测试（规范明文），本文件不含任何未实测声明。
