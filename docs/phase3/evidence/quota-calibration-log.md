# 容器配额校准（06 §4 占位值实测，不宣称最优）

生成：2026-11-20T02:41:15.059Z；Node v22.23.5；suite `quota-calibration`。

| 状态 | 检查 | 证据 |
| --- | --- | --- |
| PASS | cpu-quota-has-measurable-effect | 2 worker threads: --cpus 1 实测 1690ms vs --cpus 2 实测 686ms (ratio 2.46) |
| PASS | memory-2gib-placeholder-enforced-with-dirty-pages | 1.5GiB dirty -> exit 0 OK; 3GiB dirty -> exit 137 killed |
| PASS | pids-256-placeholder-bounds-spawn-storm | spawn storm topped out at 249 (limit 256) |
| PASS | tmpfs-work-volume-bounds-disk-writes | 512MiB bound: 8x64MiB ok (exit 0); 12x64MiB -> ENOSPC (exit 9) — the SIZE bound must be the killer, any other code means the mount contract broke |
| PASS | agent-1cpu-1gib-placeholder-runs-self-check | agent self-check under 1 CPU / 1 GiB / pids 256 -> exit 0 |

合计：5 PASS / 0 FAIL。

数据源：真实 docker 容器（execution/agent 按记录 digest 运行）；测量值见 measurements 字段。
