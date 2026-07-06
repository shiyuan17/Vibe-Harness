---
name: handoff
description: 用于暂停、转交或总结任务，并保留足够状态以便安全续接。
---

# 交接

记录已完成事项、未完成事项、当前状态、验证、风险、下一步、恢复提示和 Git/worktree 状态。

## 触发条件

工作暂停、换 Agent、跨天继续，或带剩余后续事项收尾时使用。

## 输出

使用 `templates/handoff-template.md`。

## 禁止项

不得用 handoff 文本替代 task 状态或验证证据。
