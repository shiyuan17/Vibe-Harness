---
name: subagent-driven-development
description: 执行已有实现计划且任务可隔离、需要子 agent、任务级审查或文件化交接时使用。
---

# Subagent 驱动开发

用于 full/internal 档位的高阶执行。目标是在当前负责人控制下，把独立任务交给新上下文执行，并用文件化证据避免长对话污染和压缩后重复派发。

## 使用条件

- 已有决策完整的实现计划。
- 任务之间写入范围清楚，不需要多个 agent 同时改同一文件。
- 需要任务级实现者、任务级 reviewer 和最终整体审查。

## 执行协议

1. 先审计划：发现互相矛盾、缺验收或越权写入时先暂停。
2. 父任务维护 progress ledger、依赖顺序、冲突关系和最终集成验证。
3. 为每个 child 创建 brief 文件，只包含该任务目标、输入、接口、约束、写入范围、不得修改范围、输出格式和验证命令。
4. 子 agent 只接收 child brief 和必要上下文，不读取整份长计划。
5. 子 agent 报告写入独立 report 文件，报告必须遵循 brief 声明的输出格式。
6. reviewer 读取 brief、report、diff/review package，分别给出“规格符合性”和“代码质量”结论。
7. 只有阻断问题解决并复审后，才把任务写入 progress ledger。
8. Fan-in 时由父 Agent 汇总、去重、处理冲突、审查最终 diff，并在集成位置记录最终验证；不得用一个大提交掩盖多个独立目的。

## 文件化交接

| 文件 | 内容 |
| --- | --- |
| task brief | 单任务需求、写入范围、接口、验收标准、验证命令 |
| report | 子 agent 状态、变更摘要、测试输出、疑问和风险 |
| review package | commit 范围、diff 摘要、完整 diff 或审查输入 |
| progress ledger | 已完成任务、commit 范围、审查结果和下一步 |

## 红旗

- 让子 agent 读取整份长计划，而不是任务 brief。
- reviewer 只有“LGTM”，没有规格符合性和质量结论。
- 上一任务仍有阻断问题就派发下一任务。
- 压缩或恢复后不查 ledger，重复派发已完成任务。
- 把临时 worktree 的验证当成最终合并位置验证。

## 完成证据

- 每个任务都有 brief、report、review package 和 ledger 记录。
- 阻断审查意见已修复或有明确批准的延期。
- 最终验证来自合并后的目标工作区。
