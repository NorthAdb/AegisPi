# 证据 · 02 Pi exact 1.5.2 安装与真实 lockfile

命令与输出（2026-11-18，工作目录 D:\AegisPi\aegis-pi，npm 为锁定 Node 自带 10.9.9，显式路径调用）：

```
& D:\AegisPi\tools\node-v22.23.5\npm.cmd install
→ added 124 packages, and audited 126 packages in 2m
→ found 0 vulnerabilities
```

随后追加 hono（任务 6 依赖锚点）后再次 install，`package-lock.json` 关键条目（node -e 读取）：

```
node_modules/@earendil-works/pi-coding-agent
  version: 1.5.2
  integrity: sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==
  resolved: https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz
  engines: {"node":">=22.19.0"}

node_modules/hono
  version: 4.13.19
  integrity: sha512-KmXvQAXwcAHV+muzbIwoJ23niEB5nMoDVr9WcRkU8mvjUECm/1+7v4Jgp7P7a+H6MLFrh+vXrGonGrGS+RQfkA==
```

- 声明：`apps/daemon/package.json` exact `"@earendil-works/pi-coding-agent": "1.5.2"`、exact `"hono": "4.13.19"`（无 ^/~）。npm workspaces 布局，根 `package.json` engines `>=22.19.0 <23.0.0`。
- lockfile：`package-lock.json`（58897 字节，SHA-256 `f1364f6e23b29d020f164fa8cf83d50904215ae6c9f7a883a9950585a57f947e`）入库。
- 安装目录结构：`node_modules/@earendil-works/pi-coding-agent/{dist,docs,examples,schemas}`；直接同系依赖（pi-agent-core/pi-ai/pi-codemode/pi-mcp/pi-tui 均 1.5.2）由 lockfile 固定并带 integrity。
- 包结构事实：`exports` 仅开放 `.` 与 `./rpc-entry`；bin 为 `dist/bundle/cli.js`（RPC 探针的子进程入口）；`./package.json` 子路径不可导入（ERR_PACKAGE_PATH_NOT_EXPORTED 实测）。
