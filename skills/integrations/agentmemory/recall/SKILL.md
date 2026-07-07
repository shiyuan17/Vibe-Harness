---
name: recall
description: 搜索 agentmemory 中的历史 observation、session、decision 和 learning。用于用户要求 recall、remember what happened、search past sessions 或恢复历史项目上下文。
---

# Agentmemory 检索

按用户问题检索相关记忆，并把结果与当前上下文分开说明。

## 流程

1. 提炼查询词：项目、文件、功能、决策、人名或时间。
2. 搜索 agentmemory session 和 observations。
3. 按相关度和时间排序，优先同项目同主题。
4. 汇报关键发现、来源 session 和不确定性。
5. 如需行动，先用当前仓库状态复核。

不要用记忆覆盖当前文件、测试或用户最新指令。
