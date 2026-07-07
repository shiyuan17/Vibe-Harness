# Task Lifecycle

本规则定义从需求到交付的可选产物。Fast Path 可以简化，但不能跳过红区、验证或用户改动保护。

## 阶段

| 阶段 | 目标 | 最小产出 |
| --- | --- | --- |
| Clarify | 消除目标、验收、非目标歧义 | Task Intake |
| Spec | 固定行为、契约和边界 | Spec |
| Plan | 拆成可执行步骤 | Plan |
| Task | 建立 parent/child 执行单元 | task.json 或任务卡 |
| Execute | 在边界内实现 | diff + 证据 |
| Verify | 证明成功标准 | 命令、截图、日志或人工核对 |
| Review | 独立检查风险 | Review Packet |
| Handoff | 保留续接状态 | Handoff |

## 5 分钟 Child

子任务应能在 5 分钟内判断完成、未完成或阻塞。必须包含：

- `Execution Mode: goal`
- `Timebox: <= 5 minutes`
- Goal / Acceptance Criteria / Non-goals
- Stop Condition
- Verification Command
- Rollback Plan
- Evidence

## 多 Agent

- 实现、集成、审查角色分离。
- 并行 child 必须声明 `writeScope`、`parallelSafety`、`humanConfirmation` 和冲突关系。
- 无法判断 write scope 是否重叠时，回退串行。
- 高风险默认启用独立 Review。
