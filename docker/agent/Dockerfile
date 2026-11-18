# agent 工作容器（Phase 1 记录基础镜像与构建上下文源文件；应用镜像 digest 在首次构建时记录）。
# 基础镜像：node:22.23.5-bookworm-slim，实测 RepoDigest（2026-11-18 拉取）：
#   sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# 规范占位配额（06 §4，Phase 3 用真实构建压测校准）：1 CPU / 1 GiB RAM / pids 256 / 可写盘 2 GiB。
# 本镜像不含任何宿主凭据、会话票据或 Docker socket（AGENTS 不可跨信任边界）。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN groupadd --system aegis && useradd --system --gid aegis --create-home aegis
USER aegis
WORKDIR /workspace

# Phase 3 构建上下文：apps/daemon 产物 + 运行时依赖（不含 devDependencies、不含 ~/.pi 凭据目录）。
# COPY 目标树在首次真实构建时填充；本文件先作为源记录入库。
ENV NODE_ENV=production PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0

CMD ["node", "--version"]
