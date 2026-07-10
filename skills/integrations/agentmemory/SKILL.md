---
name: agentmemory
description: 管理 agentmemory skill 家族入口，或需要选择记忆保存、检索、恢复、遗忘和 session 历史能力时使用。
---

# Agentmemory 集成

agentmemory skill 家族用于保存、检索、恢复和解释跨 session 的项目记忆。按具体意图使用 `handoff`、`recall`、`remember`、`forget`、`recap`、`session-history`、`commit-history` 或 `commit-context`。

本地记忆库默认位于 `.agents/memory/`：

- `observations.md` 保存长期观察、陷阱和验证注意事项。
- `decisions.md` 保存已确认的长期决策。
- `sessions/` 保存需要跨 session 恢复的摘要或交接记录。

记忆只能辅助恢复上下文；当前文件、测试输出和用户最新指令始终优先。
