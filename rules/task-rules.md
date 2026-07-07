# Task Rules

Task 是可验证、可恢复的工作单元；Goal 是一次执行尝试，不是状态真值。

## 状态模型

使用三层状态：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `phase` | `clarify` / `ready` / `execute` / `review` / `done` | 生命周期阶段 |
| `status` | `idle` / `running` / `blocked` / `waiting_human` / `failed_validation` | 当前执行状态 |
| `resolution` | `open` / `done` / `wont_do` / `duplicate` | 结果判定 |

`done` 只能来自验证证据和验收门禁；实现 Agent 不能自证高风险最终通过。

## Parent / Child

- Parent 负责目标、边界、拆分完整性、依赖和完成校验。
- Child 负责一个可观察目标，必须有停止条件、验证命令和回滚计划。
- Parent 作为 orchestrator 时不得直接实现业务改动。
- Child 达到 Stop Condition 后立即交付；额外发现记录为后续 child 或阻塞项。

## 最小执行卡

执行 child 时至少包含：

- Goal
- phase/status/resolution
- nextAction
- Stop Condition
- Verification Command
- Rollback Plan
- Write Scope
- Forbidden Actions

## 完成规则

任务完成前必须满足：

- 验收标准已覆盖；
- 验证命令有退出码或人工核对证据；
- worktree 已 merge-back；
- review 或人工确认门禁已满足；
- handoff 记录剩余风险和恢复提示。
