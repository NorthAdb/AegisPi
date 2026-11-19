# Phase 3 todo（开工基线 6f9c93f，2026-11-19）

按移交文档第 5 节可观察拆步，逐格做，每步要命令、退出码、日志和未决项，绿了再做下一步。任何一步不满足时如实记录 `skip: <reason>`，不静默跳过。

- [x] 0. 重跑第 1 节五条验收（durability/budget/acl/contracts/hono 配对，锁定 Node 22.23.5），核对本机 schema 哈希与 Node 22.x 是否仍需改锁。实测：164/164、20/20、15/15、15/15、pair exit 0，全部退出码 0；schema SHA-256 ede73eca…a2995 一致；2026-11-11 安全公告后 22.x 无更新补丁，无需改锁。日志：.audit/phase3-rerun/。
- [x] 1. 真实构建 agent / acquisition / execution，记录三份 digest，并加「无真实 digest 或只有 PIN_REQUIRED 则拒绝进入隔离测试」的门禁。实测：三镜像两次构建（第二次含 runner 信号死亡修复），digest 记录于 docs/phase3/reports/image-digest.md 机器块；image-gate.mjs 值位占位即拒（exit 2）；构建来源如实标注工作树。
- [x] 2. 宿主五个检查点接到生产路径；补 test:cancel-approval 的红绿对（双击、编辑、HEAD、旧 attempt、取消）。实测：16/16（会话+CSRF+JSON-only 生产端点驱动）+ red-proofs 3/3（禁用门禁→探针红→字节级恢复→复绿）。
- [x] 3. 离线无网络 job 的执行 / 超时 / 取消；Agent 与 job 配额隔离。实测：offline-jobs 9/9 + daemon 级 tick 用例（第 10 例），--network none 下 DNS/HTTP 双封、宿主墙钟 deadline、取消、cgroup 限额差异、内存/盘配额强制、孤儿回收；--once 修复为等待容器终态。
- [x] 4. test:security:unit（23/23：验签/时窗/去重、凭据生命周期与审计零泄漏、角色矩阵、错误 fence、预算硬门禁与校正须账单+actor、ACL 闭包召回、审批 hash CAS、SSE 游标与 generation reset）；再做 test:security:integration（21/21：真实容器逃逸矩阵 + 下载滥用八用例 + 组合 offline-jobs 全绿，含三轮红→绿的 PID 1 收割/孤儿 pids 占用/套件自锁修复，边界三轮全成立）。
- [x] 5. 预算硬门禁与真实账单校正路径。实测：security:unit 钉住（未知 usage 不结零、CHARGED_BOUND 保守、correctChargedBound 须 evidence+actor、并发单赢家、冻结拒新留、提额须审批）；dispatcher 收费提交须 HELD 预留（adapter 门禁）。真实 provider 账单未接（未获授权，如实记未决项）。
- [x] 6. 认证控制台：无 token / 错 token / 跨 Origin 不能审批；本机未授权进程不能审批。实测：cancel-approval 16 项中 10 项为控制台面（会话铸造须 bootstrap token、CSRF/415/401/403、bootstrap token 只读、他卡审批人拒绝、撤销 grant 后拒绝、revise 须 approve grant、reconcile 须 admin）。
- [x] 7. 一致性备份维护窗口 + test:restore（待审 / 待发 / Timer），加上磁盘水位。实测：restore 9/9（AES-256-GCM manifest、窗口外/无密钥/错钥拒绝、恢复后三态可再次驱动、删除清单不复活、迁移幂等）；disk-water.mjs 三级水位接入 daemon（warn 阻新 job、critical 只读、变更告警入审计）。
- [x] 8. 明确授权范围内的真实 ingress 验签与凭据撤销演练；默认路径在未授权时必须失败关闭。实测：ingress-telegram 8/8（无 token 拒绝、撤销槽位拒绝、update_id 去重、真实只读 getMe/getUpdates 零发送零消费，token 不出现在任何输出与审计）；HMAC webhook 验签在 security:unit（含失败关闭）。真实 webhook 源未接（无授权的公网端点与密钥，记未决项）。
- [x] 9. 按实测校准容器配额，写清依据；回归 Phase 1/2 套件。实测：quota-calibration 5/5（CPU 双线程比值 2.08、内存脏页 2g OOM、pids 风暴顶 125×2≈250、tmpfs ENOSPC、agent 限额下自证）→ docs/phase3/reports/quota-calibration.md；Phase 1/2 回归：durability 164/164、budget 20/20、acl 15/15、contracts 15/15、pair 0（send_message 注册进可信适配器注册表后复绿）。
- [ ] 10. 阶段交接包（版本/行为/风险/未决项/回归），收口前以最终源码树重建镜像并重记 digest、重跑容器套件，可验证单元做完且验收绿后推 GitHub main。

硬边界：不做 Phase 4/5/6 交付；真实隔离未通过不宣布常开；不编造 digest；密钥只进本机 .env；付费模型调用未获授权零调用；失败不换高权限路径；不向真实同事或公开仓库发测试消息。
