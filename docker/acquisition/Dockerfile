# acquisition 下载容器：受限下载（不执行源码），不携带宿主凭据（02 §1）。
# 下载器只按宿主生成的白名单计划（/plan/plan.json）拉取 http/https 对象，
# 校验大小、hash、tar 路径穿越/设备文件/越界软链，不执行任何生命周期或仓库程序。
# 基础镜像与 agent 相同（Node 22.23.5-bookworm-slim，RepoDigest 见 docker/agent/Dockerfile 注释）。
# 构建上下文（tools/build-app-images.mjs 分台）：本 Dockerfile + src/downloader.mjs。
# 挂载所有权契约（审计 F2）：/downloads 由本镜像以 uid 999(aegis) 预建，
# 宿主用 named volume 挂载；宿主 umask 不决定可写性，不用全局 chmod 777。
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN groupadd --system aegis \
 && useradd --system --gid aegis --create-home aegis \
 && mkdir -p /plan /downloads \
 && chown aegis:aegis /downloads
USER aegis
WORKDIR /downloads

COPY src/downloader.mjs /app/downloader.mjs

ENV NODE_ENV=production PI_OFFLINE=1 PI_TELEMETRY=0

ENTRYPOINT ["node", "/app/downloader.mjs"]
