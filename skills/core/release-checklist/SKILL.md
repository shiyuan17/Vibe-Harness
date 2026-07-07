---
name: release-checklist
description: 准备或审查 release、rollback、version tag 与部署门禁。用于任务提到 release、rollback、tag、deploy、hotfix、changelog 或生产就绪。
---

# 发布检查清单

发布相关工作至少确认：

1. 发布内容、版本、目标环境和负责人明确。
2. changelog、tag、迁移、配置和兼容性说明齐全。
3. 回滚方式可执行，并说明数据或配置是否可逆。
4. 验证命令、冒烟检查和监控观察点明确。
5. 红区、生产或安全影响已获得必要确认。

此 skill 不替代 release rules。遇到生产风险时，按更高工作流处理。
