---
name: loop-planning
description: 用于任务明确要求带 ledger、停止条件和判定来源的受控 loop。
---

# Loop 规划

Loop 每轮只验证一个假设。开始前先定义 scope、hypothesis、action、observation、decision、write-back 和迭代预算。

## 触发条件

仅当用户或任务明确要求 loop 行为时使用。

## 输出

Loop Packet 和 Loop Ledger。

## 禁止项

不得用 loop 逃避 review、人工确认或验证。
