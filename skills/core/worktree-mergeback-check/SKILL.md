---
name: worktree-mergeback-check
description: 检查 git worktree 的任务隔离和 merge-back 完成度。用于涉及 worktree、subagent、branch、dirty workspace、merge-back 或清理的工作。
---

# Worktree 合并回主线检查

读取 `docs/rules/git-rules.md`；只核对目标分支是否包含采纳提交、最终位置验证是否运行以及清理是否安全。存在未解释改动、未 merge-back 或验证只来自临时 worktree 时不得宣称完成。
