# Task Rules

任务是可验证、可恢复的工作单元；目标执行（`goal`）是一次执行尝试，不是状态真值。

## 状态模型

使用三层状态：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `phase` | `clarify` / `ready` / `execute` / `review` / `done` | 生命周期阶段 |
| `status` | `idle` / `running` / `blocked` / `waiting_human` / `failed_validation` | 当前执行状态 |
| `resolution` | `open` / `done` / `wont_do` / `duplicate` | 结果判定 |

`done` 只能来自验证证据和验收门禁；实现 Agent 不能自证高风险最终通过。

## 父任务 / 子任务

- 父任务负责目标、边界、拆分完整性、依赖和完成校验。
- 子任务负责一个可观察目标，必须有停止条件、验证命令和回滚方案。
- 父任务作为编排者时不得直接实现业务改动。
- 子任务达到停止条件后立即交付；额外发现记录为后续子任务或阻塞项。

## 最小执行卡

执行 child 时至少包含：

- 目标
- 状态字段：`phase` / `status` / `resolution`
- 下一步动作：`nextAction`
- 停止条件
- 验证命令
- 回滚方案
- 写入范围
- 禁止动作

## 完成规则

任务完成前必须满足：

- 验收标准已覆盖；
- 验证命令有退出码或人工核对证据；
- worktree 已 merge-back；
- 审查或人工确认门禁已满足；
- 交接记录包含剩余风险和恢复提示。
