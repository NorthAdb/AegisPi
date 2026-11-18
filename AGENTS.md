# AGENTS · AegisPi 实现仓库工程约束

本文件约束在本仓库内实施的 agent。规范正文不在本库，唯一来源是本机 `D:\AegisPi\aegis-pi-design-pack-v1.4.1`（先读其 README、PRE-READ、00、06、02，再动代码；05 是契约核验清单）。本文件只列仓库级硬约束，不复制规范正文。

1. **版本锁定**。Pi `@earendil-works/pi-coding-agent` exact 1.5.2，Node 22.23.5 显式路径调用（`D:\AegisPi\tools\node-v22.23.5\node.exe`，npm 10.9.9）。分帧、SQLite、镜像测试必须在锁定 Node 上复测。新增依赖先审来源与必要性，提交真实 lockfile 与 digest，`PIN_REQUIRED`/示例 SHA 不是有效锁定。
2. **Phase 边界**。Phase 1 只做契约核验与夹具，不实现四场景，不接真实外部写（本仓库 git 推送除外），不做逃逸测试。契约不成立走 ADR，不编造 SDK 方法名或模型 ID。
3. **敏感内容**。本仓库公开。人工判断标注、Bad Case、基线样本只留本地（`.gitignore` 已排除 labels），入库只放指针或脱敏副本。密钥不进代码、日志、prompt 和 URL。
4. **证据格式**。每项完成附实际命令、输出与环境版本；外部研究数字、项目目标、资料包验证与产品实测分别标注，不混写。
5. **不越界**。宿主持有 ACL、预算、审批、epoch、凭据与外部提交器；模型文本与工具结果从不授予权限。此边界在后续阶段的代码里落地，Phase 1 的探针脚本同样不得越过。
