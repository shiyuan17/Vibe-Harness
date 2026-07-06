# Loop Engineering

Loop 是显式、受控、有边界的反馈系统，不是无限继续寻找问题的授权。

## 单轮流程

`Scope -> Hypothesis -> Action -> Observe -> Decide -> Write-back`

- Scope：定义目标、写入范围和禁止动作。
- Hypothesis：写出一个可证伪假设。
- Action：执行能产生证据的最小动作。
- Observe：记录命令输出、日志、截图、diff 或人工核对结果。
- Decide：继续、停止、升级或创建新任务。
- Write-back：更新 task、handoff、evidence 或 memory。

## Packet

Loop Packet 包含 loop 类型、停止条件、验证命令、状态写入位置、升级条件、验收负责人、最终开关、判定来源、验收冻结、澄清门禁、迭代预算和 ledger 路径。
