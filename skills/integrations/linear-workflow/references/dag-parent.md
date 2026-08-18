# Linear DAG Parent

建议把 DAG Root 建为顶层 Parent Issue，并使用本模板。Parent 只负责聚合，不是实现节点；其子 Issue 使用 ai-coding-task.md。Linear 的 Parent/Sub-issue 和原生 blocked-by / blocks 关系是真值，不在描述中维护重复节点或依赖清单。

## Goal

描述整个 DAG 完成后的可观察业务或工程结果。

## Context

列出共享背景、目标仓库、可解析的精确目标远端 ref、架构约束和必要参考。“默认分支”只有经仓库事实解析后确为实现基线时才有效。

## Overall Acceptance Criteria

- [ ] DAG 整体可观察验收点
- [ ] 所有必需后代节点按自身 kind 成功
- [ ] Fan-in Verification 通过并记录证据

## Shared Contract

描述所有节点共同消费的 API、schema、事件、配置或行为合同。没有共享合同变化时写 None。共享合同只能有一个明确写入 owner；其他节点消费其稳定输出。

## Out of Scope

- 不属于本 DAG 的路径、合同或产品决定

## Dependencies

只填写 None 或 Managed by Linear relations。Parent/Sub-issue 只表示分解，related 不表示依赖；执行顺序仅由 blocked-by / blocks 决定。

## DAG Metadata

- kind: aggregate
- trigger: all_success | all_done，默认 all_success
- resourceLocks: 稳定逻辑资源名列表，或 None

all_success 要求全部直接前驱成功。all_done 只允许聚合终态、清理或失败报告；它可以成功地产出报告，但不能把有失败必需节点的 DAG Root 判为成功。

V1.1 不定义 optional node：Parent 下所有 descendant node 都是 required。多层 Parent 也必须是 aggregate。

## Fan-in Verification

- command or observable end-to-end check
- evidence location or expected observation

Fan-in 必须在所有必需后代进入终态后，从实际合并结果重新验证，不能只汇总子 Agent 自报。验证失败时 Parent 不得 Done。

## Completion Policy

Parent 只有同时满足以下条件才可 Done：

1. 每个 required write descendant 的 closing GitHub PR 或 GitLab MR 已合并到声明的精确目标 ref。
2. 每个 required read descendant 的约定输出和 Verification 证据已记录。
3. 每个 required aggregate descendant 满足自身 trigger，并通过自身 Fan-in Verification。
4. Root 的 Fan-in Verification 通过并留下事实证据。

任一 required descendant 为 failed、blocked、skipped、cancelled、Canceled、Duplicate 或 Won't Fix 时，Parent 不得判为成功或 Done。成功的 all_done 报告节点不能覆盖该失败。必须关闭 Workspace 的 Parent/Sub-issue 自动关闭，避免绕过本策略。

## AI Rules

- 不因 Parent/Sub-issue 关系推断执行顺序。
- Ready、Todo、依赖满足或 DAG Parent 内容不构成执行授权；完成当前请求后不自动选择下一个节点。
- 不自动拆 Issue、移动 Parent、创建节点、补依赖或调整优先级。
- 自依赖、依赖环、不可见依赖、未满足 trigger 或未解决 blocked-by 都阻止开始相关节点。
- 两个 write 节点 Scope 重叠或 Resource Lock 相同时，只有存在从一个到另一个的原生依赖路径才视为已串行；否则停止并请求授权，不自行创建关系。
- 每个用户请求最多一次全量 DAG 遍历；保存 dagStructureHash，提供方支持时另存可选 dagChangeCursor。只有二者共同证明结构未变时，恢复才只读取当前 Issue、PR/MR、HEAD 与变化节点；没有游标则 fail-closed。
