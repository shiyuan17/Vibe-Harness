---
name: remember
description: Use when the user explicitly asks to preserve a durable insight, decision, fact, or learning for future sessions.
---

# Agentmemory 保存

提炼用户要求保存的原意、2-5 个可搜索 concepts 和相关 files。调用 `memory_save`：`content` 保留原意，`concepts` 使用具体小写关键词，`files` 无相关路径时为空数组。成功后报告保存内容和标签。

不得保存 secret、未经确认的推测、临时流水账或可由当前仓库直接读取的噪声。MCP 不可用时回退到获授权的 HTTP save；仍不可用时仅在用户允许时写本地 memory，否则报告未保存，不得假称成功。
