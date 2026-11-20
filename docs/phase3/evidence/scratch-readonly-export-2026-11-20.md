# Scratch 库只读导出（2026-11-20，复核 33d6361 §8.2 / 主人指令一.4）

对 `workspace-state/phase3/`（gitignored）三个既存 scratch 库做**只读**最小导出：不重新播种、不重跑任何 real 入口、不改库文件（含 WAL）。导出脚本一次性运行于锁定 Node v22.23.5，导出时刻 `2026-11-20T10:15:54.239Z`（本机进程时钟）。**定位如实**：以下行与时间戳是实施者机器上的自生成痕迹，可与已入库证据互证，但**不构成独立网络证据**；复核方机器上没有这些库（复核 33d6361 已实测 postverify exit 3 缺库）。

## 库文件哈希（导出时点）

| 库 | aegis.db（字节数 339968） | aegis.db-wal |
| --- | --- | --- |
| external-write-real-b | `b6adf19444baa4dfea731f67229a94e203aa63b6c3e93d9f69e90a23a76df561` | `fe825ac212e10de6655de69f707f1d42670b1e577159243ba5b06da2c69e0f9e` |
| external-write-real-control | `3050af74166983e4a9d83f253dc5061439cca2b3f287a262fe50c75f72b3de42` | `56c0df3244e50b6146cff939385c69b395cc1595fba7b4a344c6e3fe792ac5db` |
| ingress-real-update | `349db2c80183065b3e366b04d9bd065c14d075ebec33c9aec56eb01d1146cda7` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（空文件哈希，WAL 已清空） |

## B 授权库（external-write-real-b）

```sql
SELECT id, state, external_id, business_key, attempt_count, last_error FROM effects;
SELECT seq, code, created_at, details_json FROM audit_log ORDER BY seq;
```

- effects 行：`id=efx:notify%3Adm%253atelegram%253a6101%3Acase-external-write-real-b`，**state=SUCCEEDED**，**external_id=ext-b-acceptance-001**，business_key=`notify:dm%3atelegram%3a6101:case-external-write-real-b`，attempt_count=1，last_error 无。
- 审计链（seq 1→9，全部同一 effect_id）：`ingress_received → task_dispatched → task_claimed → acl_granted → task_parked_for_approval → effect_proposed → approval_consumed → effect_submitting(2026-11-20T09:03:44.212Z, attempt=1) → effect_succeeded(external_id=ext-b-acceptance-001)`。
- 与主人端点侧见证（HK 17:03:51 = 09:03:51Z）与执行证据 generatedAt（09:03:52.804Z）时间相容：`effect_submitting` 的 tick 时钟 09:03:44.212Z 先行，请求到达端点约 7 秒后——本地时钟是进程时刻，不是 wire 时刻。

## B 未授权对照库（external-write-real-control）

- effects 行：state=**FAILED**，attempt_count=1，last_error=`local_error: adapter refused: real external writes are not authorized in this ph…`。
- 审计链 seq 1→10：`… → effect_submitting(09:03:52.585Z, attempt=1) → adapter_refused(09:03:52.611Z) → effect_failed_local(bytes_sent=0)`。零字节证据是该审计行的 `bytes_sent:0` 字段（`effects.mjs` 对每条 failed_local 写入），不是抓包。

## C 库（ingress-real-update）

```sql
SELECT id, source, source_event_id, verdict, state, received_at FROM inbox;
```

- inbox 行（不含消息正文，按指令不导出无关内容）：`id=inb:telegram:500045892`，source=telegram，source_event_id=500045892，verdict=**OBSERVE**，state=DONE，**received_at=1795152602177（2026-11-20T05:30:02.177Z）**——与已入库 T2 证据 generatedAt `05:30:02.319Z` 同瞬（142ms），为同一次执行写下的两个独立落盘痕迹。

## 边界

- 三个库文件保留原位不入库；本导出不含任何 token/密钥/消息正文；时间来源均为本机进程时钟（SQLite created_at/received_at 毫秒值）。
- 复核方要独立闭合 T2 网络事实，仍需仅凭本导出之外的手段（如无 token 的 wire 记录）；没有则维持缺证口径（复核 33d6361 §8.2）。
