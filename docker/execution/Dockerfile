# execution 离线 job 容器：无网络、无会话/票据/凭据、无宿主目录挂载（02 硬边界）。
# 规范占位配额（06 §4，Phase 3 校准）：1 CPU / 2 GiB RAM / pids 256 / 可写盘 4 GiB；deadline 90 秒。
# 网络隔离在 docker run 时以 --network none 施加（镜像本身不声明网络能力）。
# 基础镜像：node:22.23.5-bookworm-slim，实测 RepoDigest（2026-11-18 拉取）：
#   sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
# 构建上下文（tools/build-app-images.mjs 分台）：本 Dockerfile + src/runner.mjs。
# 运行契约：/job/input/manifest.json（宿主生成，只读）、/job/work（有界临时）、
# /job/output（结果与证据）。退出码不是 Task 结论（06 §2）。
# 挂载所有权契约（审计 F2）：/job/output 由本镜像以 uid 999(aegis) 预建，
# 宿主用 named volume 挂载（空 volume 以镜像内目录初始化），任何引擎、
# 任何宿主 umask 下 runner 都可写自己的证据；宿主不做全局 chmod 777。
# git 来自 bookworm 源（随源浮动；基础镜像仍按 digest 固定）：镜像内真实存在
# git，逃逸电池的 git -c 探针才是可证伪的边界演示，而不是空断言（审计 F5）。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# The apt step retries a bounded number of times: this build host's egress
# proxy intermittently 502s individual debian mirror requests (measured,
# same flakiness on transparent and explicit proxy paths). A transient
# mirror failure must not be mistaken for a broken image contract, and the
# git --version assertion makes a silent retry-exhaustion a loud failure.
RUN for i in 1 2 3 4 5; do apt-get update && break || sleep 6; done \
 && for i in 1 2 3 4 5 6; do apt-get install -y --no-install-recommends --fix-missing git && break || sleep 6; done \
 && git --version \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system aegis \
 && useradd --system --gid aegis --create-home aegis \
 && mkdir -p /job/input /job/work /job/output \
 && chown aegis:aegis /job/input /job/work /job/output
USER aegis
WORKDIR /job

COPY src/runner.mjs /app/runner.mjs

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/runner.mjs"]
