---
name: task-decomposition
description: Use to split implementation plans into a Goal, Task DAG, and prompts for verifiable work.
---

# 任务拆分与节点提示
用于已有计划的拆分判断、依赖建模和单节点执行提示词生成；不替代目标生命周期，也不自动派发或执行任务。
读取治理规则、原始计划、工作区和相关代码，区分事实、推断、假设和阻塞决定。规划只读，默认在回复中输出可复制结果；长任务需要恢复时才建议写入任务 Markdown。
节点写明目标、输入、输出、依赖、writeScope、resourceLocks 和验证；共享契约指定唯一 writer。依赖未成功、范围或锁冲突、owner 未定时不派发受影响节点；失败保留现场，非幂等写入结果不明先重读。父节点须核对合并后 diff 并做 fan-in 验证，不能用子节点自报替代。计划不新增授权，不自动激活 Goal 或子 Agent。
验收切片按可观察增量拆分，单 Agent 顺序工作也可拆；依赖计划遵循已有 Linear DAG，普通固定步骤不强制完整 DAG。多 Agent 并行另判：至少两个 ready 单元、隔离成立、真实容量可用，净节省同时达到 45 分钟和 25%。默认最多两个写 Agent、四个读 Agent，并受宿主实际总槽位限制。共享契约唯一 writer，父 Agent 串行最终集成。只输出当前请求需要的安排。可选字段、质量检查和宿主无关执行提示词格式见 [reference](references/task-decomposition-guide.md)。

新成本计划用 `linear-plan/v2`，unit 声明 kind、dependsOn，agentPlan 声明实际总槽位 maxAgents。依赖是规划快照，派发前重核原生关系；按剩余依赖链耗时降序、ID 升序调度 ready 单元，计入读写和总容量，共享成本只计一次，并行加入 20% 缓冲。single 可比并行更快，预算覆盖实际所选模式，auto 先解析；缺依赖/容量保守串行。v1 继续可读，只按 single 执行，需要并行收益判定时显式升级 v2。
