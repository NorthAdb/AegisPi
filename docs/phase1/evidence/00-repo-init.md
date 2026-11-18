# 证据 · 00 仓库初始化与首次推送

命令与输出（2026-11-18）：

```
git init -b main                                  (D:\AegisPi\aegis-pi)
git add . && git commit -m "Phase 1 kickoff: repo skeleton, entry evidence, decision trail"
→ [main (root-commit) 5afc3c9] 6 files changed, 90 insertions(+)
git remote add origin https://github.com/NorthAdb/AegisPi.git
git push -u origin main
→ * [new branch]      main -> main
→ branch 'main' set up to track 'origin/main'.
```

- 远端：https://github.com/NorthAdb/AegisPi（公开仓库，gh CLI 2.95.0 账号 NorthAdb，admin/push 均 true）。
- 写入链路以真实推送证实（开工检查单授权项）。
- 提交身份：git 全局配置 NorthAdb / 1328704940@qq.com（本机既有配置）。
- 敏感内容策略：labels/人工判断文件已被 .gitignore 排除；v1.4.1 规范包不随库分发（决策 D-01，.audit/decision-trail.tsv）。
