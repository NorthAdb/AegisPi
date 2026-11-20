# Phase 3 复审（0a6f89a）整改执行清单

依据：docs/phase3/audits/AUDIT-PHASE3-REREVIEW-0a6f89a.md（NOT MET；F1/F8 部分关闭；P1×4 + webhook 端点）与主人指示。不重开已关闭项（F2–F7 原缺陷、F7 真实只读记未验收）。不进 Phase 4，不宣布常开。

## 单元 0（归档）

- [x] 复审报告原样归档入库（提交 7a5425a，SHA-256 C6FAEDF5…，字节一致），PR #1 未动

## 单元 1（F1：已提交证据必须过门禁）

- [x] 红：本机复现——已提交 context 是 OS 的函数（同批字节 win32/posix 两摘要；agent 记录值两约定都对不上），acquisition/execution 的 posix 重算与复审 Linux 值逐位一致，agent 记录值绑定的是工作树 CRLF 字节而非提交字节
- [x] 修：image-bind stagedRel 统一 `/`；context 哈希与构建暂存统一 LF 规范化（摘要成为提交内容的函数，不受 autocrlf 检出影响）
- [x] 修：门禁取 config blob（验服务字节哈希）并拒绝非 linux/amd64
- [x] 红证 M4：合成 arm64 config+manifest 推入本机 registry，干净门拒绝、M4 变异过门（探针红）、还原复绿
- [x] 三镜像重建：acquisition/execution manifest 逐位不变（3c5b4dba/202dfcd4，字节未变），agent 重绑 2b894a59（镜像内 daemon.mjs 归一 LF）
- [x] 验收：重算 context 逐位等于复审 Linux 值（agent 32532e45 / acquisition 8abae275 / execution 8183df14）
- [x] 验收：M1–M4 红证、offline-jobs 11/11、security-integration 29/29、quota 5/5 在已提交证据上全绿（无 exit 2）
- [x] 提交 49f907d

## 单元 2（宿主 oracle，P1，02 §5）

- [x] 红：真实容器 exit 0 + 绑定 oracle 的 requiredOutputHash 与实际 stdout 不符 → 现树记 SUCCEEDED（oracle-red.mjs 四案全红，输出已录）
- [x] 红：真实容器 exit 0、停止后 docker cp 植入伪 result.json（timedOut / cancelled / signal 三案）→ 现树分别记 TIMED_OUT / CANCELLED / FAILED(signal)
- [x] 修：job-oracle.mjs（规范包 oracle.schema.json v1 形状校验 + 绑定断言评估）；submitJob 强制 oracle 并经 putObjectContent 持久化（删除 exit-code-evidence-only 默认）；不可读 oracle 拒绝成功
- [x] 修：exit 0 → 宿主按绑定断言核对（退出码 + stdout 哈希）才 SUCCEEDED；不符记 FAILED+job_oracle_mismatch 审计；evidence 字段只作证据输入（124/125/126/137 可信退出码约定与宿主事实保留）；finishJob 显式 state
- [x] 门禁（offline-jobs 新增 4 例）：无 oracle 提交即拒、exit0+矛盾 oracle 拒成功、三案伪证不改写终态（且断言伪证确实送达宿主）
- [x] agent 镜像重建（a33b6b25…）+ 证据刷新 + offline-jobs 14/14 / security-integration 29/29
- [x] 提交 ff30376

## 单元 3（真实 HTTP 提交器，P1）

- [x] 红：无旗标生产 tick 对本地 submit 服务零请求、READY 停留「no upstream adapter is wired」（submitter-red.mjs，传输不存在）
- [x] 修：upstream-http.mjs + upstream-http-child.mjs（同形结果集；短命子进程单次往返保持派发事务同步，崩溃窗口=06 UNKNOWN 行；连接前失败 failed_local、超时 unknown、拒绝 fault-injection mode）
- [x] 修：daemon 生产路径 transportKind "real" 接线（submitUrl 配置即接线）；--config 旗标；credentials 槽位标记经 defaults/config（密钥本体永不入库）
- [x] 门禁：http-transport-carries-bytes-and-maps-outcomes（含 dead→failed_local、slow→unknown 实测）；authorized-production-tick 本地服务收到 businessKey 且 effect SUCCEEDED；默认策略零字节+adapter_refused 审计
- [x] allowRealExternalWrites 默认保持 false；测试配置只覆写部署值（06 预算数字不动）
- [x] security-unit 31/31
- [x] agent 镜像重建（e81c33f7…）+ 隔离电池 14/14、29/29、5/5
- [x] 提交 ba14372

## 单元 4（真实模型 worker，P1）

- [x] 红：现树无旗标 tick 对待办任务零预留零结清且自称「later wiring」（worker-red.mjs）
- [x] 修：生产 tick 接 config.model.endpoint——先预留、后调用、按 tokens×价格目录结清；usage 缺失或价格未授权保持 HELD（不得结 0）；非 loopback 端点须 allowRealModelCalls；调用后各步记调用后墙钟；task_result 经 putObjectContent 持久化（实测暴露哈希-only 行读不回）
- [x] 门禁：本地假模型服务四案——预留先于请求（同钟对账 created_at≤收到≤settled_at）、结清 100 microUSD 实算、无 usage 不结清 HELD、未授权端点零请求零预留
- [x] 授权清单列入回应报告 §3（端点、凭据槽、价格目录、单次上限、回滚）
- [x] agent 镜像重建（57a8fe3f…）+ 隔离电池 14/14、29/29、5/5
- [x] 提交 8af0966

## 单元 5（webhook 端点）

- [x] 红：现树无路由（webhook-disk-red.mjs，403 于 host 中间件、无路由可达）
- [x] 修：mapTelegramUpdate 独立导出；console 挂 POST /ingress/telegram/webhook（/api 外、guard 即鉴权、失败关闭阶梯 503/503/403、合法签名 OBSERVE 入队不消费、update_id 去重）；daemon 经 AEGISPI_TELEGRAM_WEBHOOK_SECRET 传入（未设 503、设而畸形拒绝启动）
- [x] 门禁：本地请求四案（无 secret / 坏签名 / 合法含去重与零派发 / 只读模式）+ ingress 本地 7/7
- [x] agent 镜像重建（64e282f5…）+ 隔离电池 14/14、29/29、5/5
- [x] 提交 5250243

## 单元 6（F8 磁盘演练不变量）

- [x] 红：warn=0.001 现被接受；critical=25（高于生产 warn）现被接受（webhook-disk-red.mjs）
- [x] 修：注入值只准更严（free 门槛只升，低于生产即 ConfigError）且有效 critical ≤ 有效 warn；daemon 对 ConfigError 干净拒绝启动 exit 2
- [x] 门禁：0.001/5/25 单项拒、25+12 收紧对接受、daemon exit 2 含原因；既有 critical 演练改双门槛同升保序后照常实测触警（exit 3、真实 statfs 463GiB）
- [x] agent 镜像重建（1bed0ab1…）+ 隔离电池 14/14、29/29、5/5
- [x] 提交 f413046

## 单元 7（文档与全量验证）

- [x] 回应报告 docs/phase3/reports/audit-response-rereview-0a6f89a.md：逐项对应复审发现（已关闭 / 本轮修复 / 实现缺口→已修 / 授权缺失 / 普通残留），含勘误采纳与授权清单
- [x] decision-trail D-48..D-55（UTF-8 安全追加，55 行、列数校验 0 错）；收口报告 §8 附记（追加不改写）
- [x] 终树全量：image-gate 红证 M1–M4、offline-jobs 14/14、security-integration 29/29、quota 5/5、security-unit 41/41、restore 11/11、ingress 本地 7/7 + real --simulate-no-token exit 3、cancel-approval 16/16 + 红证、durability 164/164、budget 20/20、acl 15/15、contracts 15/15、hono-pair exit 0（全部在 f413046 已提交树、已提交证据上）
- [x] Telegram 真实只读不复验（授权未续，如实记未验收；零发送零 offset）
- [x] 回应文档终树计数与镜像行回填
- [x] 提交并推送 origin/main（最终 SHA 见提交记录与本文件）
- [ ] 交独立复审；不进 Phase 4，不宣布常开
