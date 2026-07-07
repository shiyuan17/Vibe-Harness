---
name: task-decomposition
description: 将宽泛工作拆成 parent/child task，并明确 lifecycle-v2 字段、5 分钟子目标、停止条件、验证、回滚和写入范围。
---

# 任务拆解

把大任务拆成能独立验证的子任务：

1. 写清 parent 目标、成功标准和非目标。
2. 每个 child 只承担一个 5 分钟左右的可验证目标。
3. 为每个 child 指定写入范围、验证命令、停止条件和回滚方式。
4. 标出依赖顺序：哪些可以并行，哪些必须串行。
5. 给高风险 child 标记红区、review 或人工确认需求。

不要把“实现整个功能”当作单个 child。无法独立验收的子任务继续拆。
