# agent 工作容器（02 §1：固定版本 Pi + 向宿主提议工具的窄通道）。
# 基础镜像：node:22.23.5-bookworm-slim，实测 RepoDigest（2026-11-18 拉取）：
#   sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# 规范占位配额（06 §4，Phase 3 校准）：1 CPU / 1 GiB RAM / pids 256 / 可写盘 2 GiB。
# 本镜像不含任何宿主凭据、会话票据、Docker socket 或 ~/.pi 目录（AGENTS 不可跨信任边界）；
# 模型调用由宿主代理，容器内 PI_OFFLINE=1，模型凭据永不进入本信任区。
# 构建上下文（tools/build-app-images.mjs 分台）：
#   本 Dockerfile + 仓库根 package.json/package-lock.json（npm ci --omit=dev --ignore-scripts，
#   不含 devDependencies）+ apps/daemon 产物 + apps/containers/agent/worker.mjs。
# deps 阶段以 root 跑 npm ci（构建期）；产物阶段 USER aegis 运行。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/daemon/package.json apps/daemon/package.json
RUN npm ci --omit=dev --ignore-scripts

FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /workspace
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY package.json package-lock.json ./
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/daemon/config apps/daemon/config
COPY apps/daemon/src apps/daemon/src
COPY apps/containers/agent/worker.mjs apps/containers/agent/worker.mjs
RUN groupadd --system aegis && useradd --system --gid aegis --create-home aegis
USER aegis
ENV NODE_ENV=production PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
WORKDIR /workspace/apps/containers/agent
ENTRYPOINT ["node", "worker.mjs"]
