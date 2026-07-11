---
name: commit-history
description: Use when listing recent Git commits linked to agent sessions, optionally filtered by branch, repository, or count.
---

# 提交历史

解析 `branch`、`repo`、`limit`，默认 limit 100、最大 500。调用 `memory_commits`；MCP 不可用时回退到 `GET $AGENTMEMORY_URL/agentmemory/commits`，所有 query 参数必须 URL 编码，凭据从 `AGENTMEMORY_SECRET` 读取。

倒序展示 short SHA、branch、authored time、message、关联 session 和文件数，并用本地 `git show` 复核。Git 不可用时明确无法核对；服务不可用时只报告本地 Git 历史。不得编造关联。
