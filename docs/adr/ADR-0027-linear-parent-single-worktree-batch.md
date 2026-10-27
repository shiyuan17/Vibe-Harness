---
id: ADR-0027
title: Linear Parent 单任务树批次交付
status: accepted
date: 2026-10-27
review-date: 2027-04-27
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: []
superseded-by: null
---

# Linear Parent 单任务树批次交付

## Context and Problem Statement

同一 Parent 的顺序任务逐项建立工作树、stage 和 publish 会重复构建候选，
也会使后继只能等待远端交付。批次需要同时保留逐 Issue 提交归属、
原生依赖和最终组合验证，不能把本地完成误当成 Linear Done。

## Decision Drivers

- 同一授权 Parent、仓库和目标只使用一个任务树、分支和 Writer。
- 已验证提交保持 SHA；整批完成前不部分发布。
- 复用现有计划、锚点和 stage/publish，不增加命令或调度器。
- 状态回写和资源清理可以分别恢复，不重复推送。

## Considered Options

- 每个 Issue 独立工作树及发布：保留给明确独立交付或并行需求。
- 最后压成一次提交：拒绝，失去逐任务归属。
- 可选批次上下文及本地历史完成证据：采纳。

## Decision Outcome

`plan-units.executionBatch` 绑定 Parent、必需成员、原生依赖快照、任务
工作区、分支、冻结基线和精确目标。每项代码任务验证后提交，
锚点 `localCompletion` 认证任务、计划、tree、commit、检查定义。
正常 HEAD 前进不否定历史证据；计划或检查变化须重新判断，丢失祖先
关系则失效。同树的多个只读或重验任务各自保留认证收据，不让缓存槽
覆盖历史完成事实。

仅同批执行 readiness 使用本地证据；任务检查和可选 DAG 使用同一
前驱判据，独立任务稳定串行，不添加原生依赖。批外、Parent 成功及
Linear Done 继续要求正式交付。跨批交付循环及成员变化停止相关步骤。

全部成员完成后只以 Parent 最终 HEAD stage 一次，publish 沿用现有
精确远端对账、必要重验、非强制推送与回读。Parent publish 保留源
工作区、分支和锚点，状态 `integrated_cleanup_pending`；调用方重读并
补写成员及 Parent Done 后，使用已有 cleanup 命令回收。运行时不创建
Linear 客户端或第二状态真值，未声明批次的旧计划和 PR/MR 保持原语义。

## Consequences

批次失败会延迟全部成员发布；需要独立交付时先明确拆批。范围修订
保守使旧计划证据失效，允许在当前最终树重验已归属提交，不造空提交。
Linear 不可用时已推送事实保留，资源暂不释放。源工作树的延迟清理
增加暂时占用，但保留了恢复锚点；清理仍核对源 HEAD、脏状态和归属。

## Confirmation

一次性 Git 仓库和 bare 远端检查任务树数量、提交内容、祖先图、
远端 SHA 与状态写入顺序。覆盖批内/外依赖、追加修复、证据失效、
成员扩围、交付循环、远端前进、冲突、保护策略、多地址与 Hook 拒绝。
行为评测对实际产物做正负控，模型评测与工程测试分别报告，
reference 指纹漂移不自动更新；没有可比前置基线不宣称效率提升。

## Review Trigger

- 扩展到跨仓、多个交付目标或并行 Writer。
- 更改 Linear Done 或历史完成证据的信任边界。
- 批次规模导致整体发布等待成本超过候选复用收益。

## More Information

- [批次规则](../rules/linear-workflow.md)
- [执行契约](../specs/delivery-lifecycle.md)

回滚时先保留或结束活动批次，不用旧运行时读取未知批次证据。
撤销本次可选扩展不改写已有提交；旧独立事务无需迁移。
