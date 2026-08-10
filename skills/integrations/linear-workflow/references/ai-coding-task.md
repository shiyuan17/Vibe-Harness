# AI Coding Task

建议在 Linear 中创建团队级 Form Template，并把 Goal、Scope、Acceptance Criteria、Dependencies 和 Verification 设为必填。以下内容可以作为描述模板。

## Goal

描述可观察的业务或工程结果。

## Context

列出相关实现、文档、既有模式和必要背景。

## Repository

- Repository:
- Target branch:

## Scope

允许修改：

- path/or/glob

## Out of Scope

禁止修改：

- path/or/contract

## Contract

描述 API、schema、事件、配置或用户行为合同。没有公共合同变化时明确写 None。

## Acceptance Criteria

- [ ] 可观察验收点
- [ ] 回归行为保持不变

## Dependencies

明确写 None，或使用 Linear blocked-by / blocks 关系列出 Issue。

## Verification

- command or observable check

## AI Rules

- 不做无关重构。
- 不修改 Scope 外文件。
- 需要改变 Contract 时停止并请求决定。
- 完成前检查 git diff 和实际验证结果。
