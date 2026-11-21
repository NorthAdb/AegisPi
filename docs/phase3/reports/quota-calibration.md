# Phase 3 容器配额校准（06 §4 占位值实测）

依据：evals/phase3/quota-calibration/run.mjs 在记录 digest 的 execution/agent 镜像上实测（evidence/quota-calibration-report.json）。

| 维度 | 占位值 | 实测 | 结论 |
| --- | --- | --- | --- |
| CPU（job/agent 各 1） | 1 CPU | 双 worker 线程各 2e8 加法：--cpus 1 实测 2309ms；--cpus 2 实测 784ms（比值 2.95） | 限额真实生效；保留占位值 |
| 内存（job） | 2 GiB | 脏页 1.5 GiB 正常完成；脏页 3 GiB 被 cgroup OOM 终止（exit 137） | 强制生效；保留占位值。注意：零填充不触碰页面不计入 cgroup，压测必须脏页 |
| pids | 256 | spawn 风暴实测峰值 249（含 runner 自身） | 强制生效；保留占位值 |
| 可写盘（job work tmpfs） | 4 GiB | 在 512 MiB 同机制实测：8×64MiB 正常、12×64MiB ENOSPC | 机制强制生效；4 GiB 全量写会压开发机 Docker VM 内存，推迟到 Phase 4 真实 job 校准 |
| agent 限额 | 1 CPU / 1 GiB / pids 256 | 同限额下 self-check 退出码 0 | 边界自证通过 |

不宣称性能最优：本轮只证明占位上限的强制性与量级；是否下调/上调取决于 Phase 4 真实仓库 job 的实测画像（由可信验证器统计 p95 用量后再定）。

宿主与下载器配额独立配置，未借用 job 的盘/网限额（02 §1、06 §4）；acquisition 容器在本阶段测试中以其自身限额运行，下载有大小与解压双上限（见 test:security:integration 的下载滥用用例）。
