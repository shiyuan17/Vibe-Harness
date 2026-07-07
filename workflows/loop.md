# Loop 工作流（循环流程）

仅在明确要求 loop 时使用。Loop 是有预算、有停止条件的反馈系统，不是无限寻找问题的授权。

## 阶段目标

用有限轮次验证假设、观察结果并写回状态，在达到停止条件、升级条件或预算上限时明确停止。

## 输入内容

- Loop Type、Scope、Stop Condition、Escalation Condition。
- Verification Command、State Sink、判定来源和验收负责人。
- 迭代预算；不得写 `N/A`。
- 允许动作和禁止动作。

## 输出内容

- Loop Packet。
- Loop Ledger：Cycle、Hypothesis、Action、Observation、Decision、Write-back。
- 每轮证据：命令输出、截图、diff、日志或人工核对。
- 最终状态：继续、停止、升级、失败或 handoff。

## 完成标准

- 每轮都有可追溯 Observation，不写空泛流水账。
- 达到 Stop Condition、Escalation Condition 或预算上限时停止。
- 状态写入 State Sink，下一位执行者能恢复。
- 未把新发现范围直接塞回当前 loop。

## 常见异常

- 验收条件不清但想启动 loop。
- 观察结果无法证明假设。
- 范围扩大、触发红区或发现外部契约。
- 连续失败导致重复试错。

## 异常处理方式

- 验收条件不清时不启动 loop，先回到 Clarify。
- 证据不足时缩小假设或改验证命令。
- 触发红区、权限、发布或契约变化时停止并升级。
- 预算耗尽时 handoff，不继续消耗轮次。
