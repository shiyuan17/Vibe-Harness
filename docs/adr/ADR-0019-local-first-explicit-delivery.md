---
id: ADR-0019
title: 显式执行、本地先合并交付与受限依赖调度
status: accepted
date: 2026-10-23
review-date: 2027-04-23
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: [ADR-0008, ADR-0010, ADR-0018]
superseded-by: null
---

# 显式执行、本地先合并交付与受限依赖调度

## Context and Problem Statement

原流程同时存在远端先推送、主检出后同步与本地先合并的合同；默认 push 配置可改变实际目标，推送后清理失败又会阻断 Done。强制 Receipt 与自动领单设施增加显式任务的前置成本，“最长单元”估算忽略容量和依赖，可能夸大并行收益。

## Decision Drivers

- 用户明确要求先合并到主检出本地 develop，再推送 origin/develop。
- 显式执行保持低摩擦，同时禁止同 Issue 重复并行和越界抢单。
- 集成成功、清理成功与资源释放分别核对。
- 估算可复现，旧计划继续可读，规则与安装投影保持一致。

## Considered Options

- 继续支持 remote 直推：拒绝，会保留两套最终化顺序。
- 本地先合并，清理失败回滚或阻塞 Done：拒绝，清理不能否定已确认的代码集成。
- 显式边界、共用最终化与阶段恢复、容量依赖调度：采纳。

## Decision Outcome

单任务与 batch 共用候选验证、目标锁、主检出 ff-only、精确 SHA 推送和重读确认。主检出须干净且在 develop，本地仅快进同步远端基线；拒绝夹带未归属提交、多 push URL、mirror 和目标不明。remote 参数在任何写入前拒绝。恢复状态位于 Git common dir，绑定源 HEAD、基线、候选、精确目标及阶段；本地已合并而推送失败保留现场，重试原候选，远端分叉不自动 reset/rebase/force push。

推送确认即代码集成完成。清理失败返回 integrated_cleanup_pending，仍可映射 Done / succeeded 并释放依赖；残留路径、端口和资源锁保持占用。重试只做尚未完成的清理。

仅执行显式 Issue 或当前计划，允许计划内接续，不扫描队列抢单。取消 Claim 与 Start/Terminal Receipt 前置要求，保留 Delegate、历史活动 v1/v2/v3 与工作区冲突核验；不交付替代锁服务。Linear 写入不明先重读，尚未尝试写入且上下文充分时可本地继续并报告未同步。

local-land 无需 PR，普通 PR/MR 保留 In Review 与 closing 合并证据；read 以约定输出与 Verification 完成，Parent 以全部必需后代成功及组合 fan-in 验证完成。develop 按风险验证，独立审查可选，项目明确审查与分支保护继续有效。

验收切片、依赖计划与并行分别判断；新计划用 linear-plan/v2 的 kind、dependsOn 和实际 maxAgents。最多两个写、四个读并受宿主总槽位约束，ready 按剩余链耗时降序、ID 升序调度，共享成本只计一次，并行保留 20% 缓冲。净节省至少 45 分钟且 25% 才并行；single 可以更快，预算覆盖所选模式。v1 可读但保守 single。

本决策替代 ADR-0008、ADR-0010、ADR-0018 的活动自动派发与强制记录合同；历史正文和读取兼容保留。ADR-0014 的尽力 teardown 不得用于提前复用残留资源，ADR-0015/0016/0017 的显式入口、封闭计划和本地身份核验仍有效，remote 直推及强制 Receipt 条款由本决策替代。

## Consequences

- 推送失败时本地 develop 可能领先远端，必须保留阶段记录及源工作区用于恢复。
- 无 Claim 服务不能证明跨独立宿主的原子互斥，同 Issue 因此禁止重复并行，活动冲突须显式交接。
- 清理残留不会阻塞独立后继，但仍阻止冲突资源复用。
- v1 的并行估算不再用于派发，需收益评估时显式升级 v2。

## Confirmation

- 临时 bare 仓库在接收推送时检查本地 develop 已等于候选，覆盖单任务、batch、错误默认 refspec 和推送失败重试。
- 规则 Eval 正反例覆盖显式边界、无 Claim/Receipt、本地先合并、无抢单及清理解耦；重放只能证明判据与资产有效，不等于真实 Agent 行为改善。
- 规划测试覆盖容量、依赖、混合读写、门槛等值、所选预算与 v1 读取。
- 安装投影、Skill/Eval 审计及受影响集成检查通过后交付；真实 Linear 与真实远端需独立证据。

## Review Trigger

- 出现目标误推、恢复阶段不一致或重复集成事实。
- 宿主提供新的显式并发所有权合同，或需要重新引入队列派发。
- 实际调度耗时持续偏离容量/依赖估算，或新增受保护交付目标。

## More Information

交付合同见 [Git 规则](../rules/git-rules.md)，状态映射见 [Linear 工作流](../rules/linear-workflow.md)，并发与资源生命周期见 [协作规则](../rules/ai-collab-rules.md)。实现与验收分别由 `runtime/lib/worktree-command.mjs`、`runtime/lib/linear-planning.mjs` 及对应测试维护。
