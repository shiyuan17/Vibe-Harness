---
name: executing-plans
description: Use when a decision-complete implementation plan must be executed in the current session with checkpoints.
---

# 执行计划

## 前置检查

读取完整计划并核对目标、文件边界、依赖、验收和验证命令。计划存在冲突、占位或越权写入时先停止并澄清。

## 执行

1. 将计划步骤写入进度清单，同时只保留一个进行中步骤。
2. 按依赖顺序逐项实现；行为变更遵循测试先行。
3. 每项完成后运行该项验证并记录退出码，失败则定位原因，不跳过。
4. 范围或风险变化时更新计划；红区扩大时重新确认。
5. 全部步骤结束后运行完整验证，并核对 diff、未验证项和回滚状态。

## 输出

报告已完成项、变更范围、验证证据、剩余风险和 Git/worktree 状态。完成声明必须使用 `verification-before-completion`。
