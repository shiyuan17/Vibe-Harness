---
name: task-decomposition
description: Use to split implementation plans into verifiable acceptance slices, follow an existing Linear DAG, or plan explicitly requested multi-agent work.
---

# 任务拆分

只做拆分判断、依赖建模和单节点执行提示词；不新增授权、不自动派发、不替代实施或最终验证。

1. 先区分验收切片、依赖计划和真实多 Agent 并行。验收切片按可观察增量拆分，单 Agent 顺序任务也可拆。
2. 已有 Linear DAG 必须遵循；普通固定步骤只保持顺序和检查点，不生成完整 DAG。
3. 只有实际采用两个以上协作单元时才加载 [按需 reference](references/task-decomposition-guide.md)，由其判断隔离、容量、读写槽位与并行收益。普通任务不计算墙钟预算。
4. 共享 API、Schema、迁移或行为契约只有一个 writer；最终集成和 fan-in 由父 Agent 串行负责。
5. 需要恢复或跨会话执行时再写持久计划；普通任务保留简洁顺序步骤即可。

新成本计划只在真实并行时使用 `linear-plan/v2`，字段和调度规则见 reference。v1 仍可读并保守按 single 执行。
