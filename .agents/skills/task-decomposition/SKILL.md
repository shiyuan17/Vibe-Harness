---
name: task-decomposition
description: Use to split implementation plans into a Goal, Task DAG, and prompts for verifiable work.
---

# 任务拆分与节点提示
用于已有计划的拆分判断、依赖建模和单节点执行提示词生成；不替代目标生命周期，也不自动派发或执行任务。
读取治理规则、原始计划、工作区和相关代码，区分事实、推断、假设和阻塞决定。规划只读，默认在回复中输出可复制结果；长任务需要恢复时才建议写入任务 Markdown。
按依赖、隔离和独立并行收益判断拆分，不因公共契约或文件数量强制拆分；只有边界清晰、合并可控且并行收益超过协调开销时才拆分。只输出当前请求需要的安排。可选字段、质量检查和宿主无关执行提示词格式见 [reference](references/task-decomposition-guide.md)。
