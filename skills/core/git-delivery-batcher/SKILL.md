---
name: git-delivery-batcher
description: Use when completed changes must be staged, split into auditable commits, pushed, or prepared for a pull request.
---

# Git 分批交付

先读取项目 Git 规则并运行状态与 diff 检查，区分用户原有改动和本任务改动。按单一目的、可独立验证和可回滚原则分组；每组只暂存归属明确的文件，检查 staged diff 后运行对应验证。提交或推送前确认权限、目标分支和红区要求，禁止改写未知历史、覆盖用户改动或混入无关文件。工具不可用时回退为分组清单和命令建议，不声称已经提交。完成前使用 `verification-before-completion`，报告 commit、分支、push/PR 与 worktree/merge-back 状态。
