# execution 离线 job 容器：无网络、无会话/票据/凭据、无宿主目录挂载（02 硬边界）。
# 规范占位配额（06 §4）：1 CPU / 2 GiB RAM / pids 256 / 可写盘 4 GiB；deadline 90 秒。
# 基础镜像与 agent 相同（Node 22.23.5-bookworm-slim，RepoDigest 见 docker/agent/Dockerfile 注释）。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN groupadd --system aegis && useradd --system --gid aegis --create-home aegis
USER aegis
WORKDIR /job

ENV NODE_ENV=production

CMD ["node", "--version"]
