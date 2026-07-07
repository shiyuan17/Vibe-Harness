---
name: worktree-mergeback-check
description: 检查 git worktree 的任务隔离和 merge-back 完成度。用于涉及 worktree、subagent、branch、dirty workspace、merge-back 或清理的工作。
---

# Worktree 合并回主线检查

合并或清理前确认：

1. 当前 worktree、分支和目标合并分支明确。
2. `git status --short` 中没有未解释的改动。
3. 子任务产物已合并回目标工作区或明确放弃。
4. 测试和验证证据来自最终合并位置，而不是临时 worktree。
5. 临时 worktree、分支和中间文件有清理计划。

不要在 dirty workspace 中盲目合并。不要把临时 worktree 中通过的验证当成最终验证。
