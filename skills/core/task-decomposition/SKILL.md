---
name: task-decomposition
description: Use to split implementation plans into a Goal, Task DAG, and prompts for verifiable work.
---

# 任务拆分与节点提示
用于已有计划的拆分判断、依赖建模和单节点执行提示词生成；不替代目标生命周期，也不自动派发或执行任务。
读取治理规则、原始计划、工作区和相关代码，区分事实、推断、假设和阻塞决定。规划只读，默认在回复中输出可复制结果；长任务需要恢复时才建议写入任务 Markdown。
节点写明目标、输入、输出、依赖、writeScope、resourceLocks 和验证；共享契约指定唯一 writer。依赖未成功、范围或锁冲突、owner 未定时不派发受影响节点；失败保留现场，非幂等写入结果不明先重读。父节点须核对合并后 diff 并做 fan-in 验证，不能用子节点自报替代。计划不新增授权，不自动激活 Goal 或子 Agent。
按依赖、隔离和独立并行收益判断拆分，不因公共契约或文件数量强制拆分；只有边界清晰、合并可控且并行收益超过协调开销时才拆分。只输出当前请求需要的安排。可选字段、质量检查和宿主无关执行提示词格式见 [reference](references/task-decomposition-guide.md)。
