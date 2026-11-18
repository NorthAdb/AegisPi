# 证据 · 01 Node 锁定

命令与输出（2026-11-18）：

```
& D:\AegisPi\tools\node-v22.23.5\node.exe --version
→ v22.23.5

& D:\AegisPi\tools\node-v22.23.5\node.exe -e "console.log(process.versions.sqlite); console.log(process.versions.v8)"
→ 3.54.1
→ 12.4.254.21-node.57

& D:\AegisPi\tools\node-v22.23.5\npm.cmd --version
→ 10.9.9
```

- 安装位置：`D:\AegisPi\tools\node-v22.23.5\node.exe`（显式路径调用；未改系统 PATH，未触碰现有 v24.17.0）。
- 来源 zip：https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip，SHA256 `4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3`（与官方 SHASUMS256.txt 及发布页双重一致，开工检查单 2026-11-18 核验结论沿用）。
- 开工时复核 official latest-v22.x：`https://nodejs.org/dist/index.json` 拉取于 2026-11-18，v22 系最新即 v22.23.5（2026-11-11 安全版，LTS Jod，npm 10.9.9，无更新补丁）→ **锁定版本无需追补**（AGENTS 条件要求满足）。
- 环境位：git 2.54.0.windows.1；gh 2.95.0（NorthAdb，keyring，scopes repo/workflow）。
