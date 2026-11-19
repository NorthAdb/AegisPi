# execution 离线 job 容器：无网络、无会话/票据/凭据、无宿主目录挂载（02 硬边界）。
# 规范占位配额（06 §4，Phase 3 校准）：1 CPU / 2 GiB RAM / pids 256 / 可写盘 4 GiB；deadline 90 秒。
# 网络隔离在 docker run 时以 --network none 施加（镜像本身不声明网络能力）。
# 基础镜像：node:22.23.5-bookworm-slim，实测 RepoDigest（2026-11-18 拉取）：
#   sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# 构建上下文（tools/build-app-images.mjs 分台）：本 Dockerfile + src/runner.mjs。
# 运行契约：/job/input/manifest.json（宿主生成，只读）、/job/work（有界临时）、
# /job/output（结果与证据）。退出码不是 Task 结论（06 §2）。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN groupadd --system aegis && useradd --system --gid aegis --create-home aegis
USER aegis
WORKDIR /job

COPY src/runner.mjs /app/runner.mjs

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/runner.mjs"]
