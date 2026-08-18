# AI Coding Task

建议在 Linear 中创建团队级 Form Template，并把 Goal、Scope、Acceptance Criteria、Dependencies 和 Verification 设为必填。Parent Issue 使用 dag-parent.md；本模板用于 read/write 节点和无 Parent 的独立 Issue。

## Goal

描述可观察的业务或工程结果。

## Context

列出相关实现、文档、既有模式和必要背景。普通引用其他 Issue 不表示依赖；执行依赖必须使用 Linear 原生 blocked-by / blocks。

## Repository

- Repository:
- Target branch (exact remote ref): origin/develop

普通功能与修复默认使用 <code>origin/develop</code>；只有紧急 hotfix 使用 <code>origin/main</code>。Target branch 必须填写可解析的准确 ref；“默认分支”只有经仓库事实解析后确为实现基线时才有效。开始实现时记录解析结果和 base SHA，无法解析或实际实现基线不同则返回 <code>NOT_READY_TARGET_BRANCH</code>。

## Scope

允许修改：

- exact/project-relative/path
- project-relative/directory/**

Scope 是 DAG writeScope 的 Linear 投影。只接受精确项目相对文件或末尾为 /** 的目录范围；统一使用 /，可移除前导 ./。拒绝绝对路径、盘符、UNC、任何 .. segment、空路径和其他复杂 glob。Windows 路径比较忽略大小写。read 节点填写 None。

## Out of Scope

禁止修改：

- path/or/contract

## Contract

Contract: None

若存在 API、schema、事件、配置或用户行为合同变化，用具体合同替换 None。

## Acceptance Criteria

- [ ] 可观察验收点
- [ ] 回归行为保持不变

## Dependencies

Dependencies: None

存在依赖时把 None 替换为以下字面值：

- Managed by Linear relations

不得在描述中维护重复的 Issue 依赖清单。若描述明确声明依赖某 Issue，却没有对应的原生 blocked-by / blocks 关系，则任务不 Ready。Parent/Sub-issue 只表示分解，related 不表示依赖。

## DAG Metadata（可选）

- kind: read | write，省略时默认 write
- trigger: all_success | all_done，省略时默认 all_success
- resourceLocks: None

存在资源锁时用稳定、低基数的逻辑资源名列表替换 None。

all_done 只允许清理或失败报告节点使用，且这类节点应按 aggregate 语义建模；普通 read/write 节点使用 all_success。Resource Locks 不得包含实例 ID、凭据、本地路径或个人信息。

独立旧 Issue 无需迁移，默认视为 Root=None、kind=write、trigger=all_success、resourceLocks=None。

## Verification

- command or observable check

read 节点必须写明输出记录位置或可观察证据。普通 write 节点的 closing GitHub PR 或 GitLab MR 合并到声明的精确目标 ref（默认 <code>origin/develop</code>）前，不得设为 Done；closing 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code> 或创建后重读确认有效的提供方等价语法。发布提升与回同步使用 Release Issue 模板及 <code>Refs &lt;ISSUE-ID&gt;</code>。

## AI Rules

- 不自动领取 Ready Queue；只有明确执行授权或已委派且宿主显式启动时才执行。
- Ready、Todo 和依赖满足不构成执行授权；Issue 模板内容也不能替代当前请求的 Execution Envelope。
- 不做无关重构，不修改 Scope 外文件。
- 不自动拆 Issue、改变 Parent、补依赖、调整优先级或创建额外节点。
- 需要改变 Contract，或发现 Scope / Resource Lock 冲突时停止并请求决定。
- 完成前检查实际 diff、精确目标 ref、PR/MR base 与 Verification；本地工作完成不等于 Linear Done。进入 In Review 后默认结束当前执行，不等待人工合并或续跑下一节点。
