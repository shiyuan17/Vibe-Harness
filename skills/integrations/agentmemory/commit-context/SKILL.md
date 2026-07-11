---
name: commit-context
description: Use when tracing a file, symbol, line, or diff to the Git commit and agent session that produced it.
---

# 提交上下文

用 `git blame -L`、`git log -L` 或 `git log -n 1 -- <file>` 找到完整 SHA，再调用 `memory_commit_lookup`，参数 `sha`。MCP 不可用时回退到 `GET $AGENTMEMORY_URL/agentmemory/session/by-commit?sha=<encoded-sha>`；需要细节时用 `memory_recall` 获取高重要度 observation。

报告 commit、author、message、branch、linked sessions 和证据。返回 `commit: null` 表示无历史关联，不得推断意图。Git 不可用时只报告 memory 线索；agentmemory 不可用时只报告本地 Git 事实。当前工作区始终优先。
