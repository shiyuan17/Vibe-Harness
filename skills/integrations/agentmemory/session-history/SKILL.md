---
name: session-history
description: Use when listing recent agent sessions for the current project before selecting one for deeper recall.
---

# Agentmemory Session 历史

调用 `memory_sessions`，传入 `limit: 20`；按当前项目路径边界过滤并倒序展示 session ID、时间、状态、标题、observation 数和关键决策。保持为可选择的时间线，不展开完整 recap。

MCP 不可用时回退到授权 HTTP sessions；仍不可用时列出本地 session 记录并说明限制。只报告真实返回结果。
