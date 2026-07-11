---
name: recap
description: Use when summarizing recent agent sessions for a project over today, this week, or a requested count.
---

# Agentmemory 汇总

解析窗口：today、最近 7 天、last N 或默认 10。调用 `memory_sessions`，按 cwd 目录边界过滤当前项目并按 startedAt 倒序；每个 session 用 `memory_recall`（limit 3）取高重要度摘要。按本地日期分组，最后统计 session、天数和 observation。

MCP 不可用时回退到授权 HTTP sessions/recall；仍不可用时使用本地 session 记录并说明范围。不得把不同项目的同前缀路径混入，也不得编造空窗口内容。
