# Task Rules

任务是可恢复、可验证的工作单元。执行目标是一次执行尝试，不是状态真值来源。

## 状态模型

- `phase`：intake、clarify、spec、plan、decompose、ready、execute、verify、review、done。
- `status`：idle、in_progress、blocked、waiting_human、waiting_dependency、failed_validation、needs_rework。
- `resolution`：open、done、cancelled。

## Parent / Child Task

Parent task 负责总目标、依赖、完成检查和编排。Child task 负责一个可独立验证的切片，并声明写入范围、禁止动作、回滚、停止条件和验证方式。

## 完成规则

只有当验收标准满足、验证证据已记录、必要审查已完成、开放风险已解决或转移、父任务完成检查通过，并且 `phase=done`、`resolution=done` 时，task 才算完成。
