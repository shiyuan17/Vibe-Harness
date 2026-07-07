---
name: commit-history
description: 展示与 agent session 或 memory context 关联的近期 git commits。用于用户询问 agent 做了哪些 commit、带 session context 的近期提交历史，或 commit 到 session 的可追踪性。
---

# 提交历史

列出 commit 与 agentmemory 上下文的关联。

输出应包含 commit hash、提交信息、时间、关联 session 或记忆线索，以及仍需用 `git show` 或当前仓库复核的事项。
