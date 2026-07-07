---
name: handoff
description: 从当前项目最相关的近期 agentmemory session 恢复上下文。用于用户说 resume、where were we、pick up、continue from last time，或要求从记忆中接续。
---

# Agentmemory 交接

目标是恢复“最可能相关”的上一段工作，而不是罗列全部历史。

## 流程

1. 根据当前仓库、分支、用户描述和近期 session 查找候选。
2. 优先选择同项目、同主题、最近且有未完成事项的 session。
3. 汇总：目标、已完成、未完成、关键文件、验证证据和风险。
4. 明确哪些内容来自 agentmemory，哪些仍需重新验证。
5. 给出下一步建议；执行前遵守当前仓库规则。

不要把历史记忆当作事实。涉及代码状态时，以当前工作区为准。
