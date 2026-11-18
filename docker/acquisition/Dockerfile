# acquisition 下载容器：受限下载（不执行源码），不携带宿主凭据。
# 基础镜像与 agent 相同（Node 22.23.5-bookworm-slim，RepoDigest 见 docker/agent/Dockerfile 注释）。
# 配额与网络隔离在 Phase 3 真实测试时校准；下载与任意代码执行分离是硬边界（02）。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN groupadd --system aegis && useradd --system --gid aegis --create-home aegis
USER aegis
WORKDIR /downloads

ENV NODE_ENV=production PI_OFFLINE=1 PI_TELEMETRY=0

CMD ["node", "--version"]
