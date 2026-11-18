# AegisPi

自托管、事件驱动的个人常驻 Agent 系统（实现仓库）。当前处于 **Phase 1：用户基线与底座契约**。

## 规范来源

唯一规范是本机的 `aegis-pi-design-pack-v1.4.1` 资料包（`D:\AegisPi\aegis-pi-design-pack-v1.4.1`）。该包不随本库分发，避免公开设计全文与规范多副本漂移；本库只记录其版本、入口证据与指针。需要修订契约时读原包，不在本库复制其规范正文。

入口证据（2026-11-18）：`python -X utf8 validation/validate_pack.py` 在包目录运行，14 项全 PASS，CONNECTIONS_LEFT=0，SQLite 3.45.3（Python 侧）、27 表、FTS5+trigram 可用。

## 锁定版本

| 项 | 值 | 证据 |
| --- | --- | --- |
| Node.js | 22.23.5 LTS（Jod），显式路径 `D:\AegisPi\tools\node-v22.23.5\node.exe` | nodejs.org/dist/index.json 2026-11-18 复核，v22.x 最新无补丁；安装 zip SHA256 4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3 |
| Pi 底座 | `@earendil-works/pi-coding-agent` exact 1.5.2 | package-lock.json 完整性字段 |
| SQLite | Phase 1 先测 `node:sqlite`（内置 3.54.1）是否满足 FTS5+trigram；不满足才改 better-sqlite3 实测版本 | evals/contracts 驱动选择报告 |
| 主推理模型 | 显示名「DeepSeek Flash High」，绑定 Pi 1.5.2 实际模型列表中的真实 ID，不编造标识符 | Phase 1 模型绑定记录 |

## 目录

```text
apps/daemon/          宿主 daemon（Phase 1 只放依赖与探针入口，产品代码属后续阶段）
evals/contracts/      test:contracts：PI-01..PI-13 探针、RPC LF 分帧夹具、SQLite 驱动探针
docker/               agent / acquisition / execution 三个镜像的 Dockerfile（Phase 1 记录基础镜像 digest）
docs/phase1/          Phase 1 报告：逐项契约结论、模型绑定、驱动选择、镜像 digest、ADR
.audit/               决策留痕（TSV）与开工检查单执行状态
```

`workspace-state/`（原始数据、DB、对象、备份）与私密人工判断标注一律不入库，仓库是公开的。

## Phase 1 边界

不接真实外部写（唯一例外：本仓库自身经授权的 git 推送，用于证实写入链路）。不发外部消息，不进入常开，不做容器逃逸测试（Phase 3）。契约不成立时按设计包 ADR 模板报批后改适配与文档，不编造方法名。
