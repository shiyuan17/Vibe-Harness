---
id: ADR-0025
title: 候选取消限域、基线验证与环境失败续验
status: superseded
date: 2026-10-27
review-date: 2027-04-27
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0024]
superseded-by: ADR-0026
---

# 候选取消限域、基线验证与环境失败续验

## Context and Problem Statement

ADR-0024 的两阶段交付已经移出候选验证，但实现将“基线是新远端的祖先”
误作“该任务已被取代”，会终止独立任务及释放仍在使用的租约。另两个可复现
问题是干净候选的 affected 检查缺少基线，以及 publish 验证超时后的 merged
状态不能再次 publish。隔离测试已分别取得失败断言。

## Decision Drivers

- 独立任务不因其他任务交付而丢失验证进度。
- 最终组合候选必须取得有效验证；不能靠空变更范围跳过。
- 环境失败保留候选，真实检查失败仍要求修源并重新 stage。
- 取消不能终止共享宿主进程或提前释放仍被使用的资源。

## Considered Options

- 仅基线前进就杀进程：拒绝；不证明源提交已集成，且 PID 可承载其他工作。
- 关闭全部验证或复用任意旧收据：拒绝；无法覆盖最终组合状态。
- 限域协作取消，绑定候选基线，稳定候选续验：采纳。

## Decision Outcome

保留 ADR-0024 的 stage/publish、队外验证、精确远端对账、非强制推送、
有界重建和 v4 事务协议，以下修正取代其相关断言：

1. 仅当同 push endpoint 指纹与精确 ref 已包含另一事务的全部冻结源，
   且候选仍是登记的 detached worktree、租约仍属于原持有者时，发送
   CANCEL 请求。普通远端前进不取消独立工作。不杀进程、不强制释放活租约；
   原持有者在检查之间停止并释放，崩溃残留走 recover。
2. 候选 verify 显式传入冻结 base SHA。affected 检查与 selection 缓存键
   使用真实组合差异；重建后使用新 base。最终候选的有效收据可以同时支撑
   对应 fan-in，无需同状态重复检查。
3. publish 重建遇到环境失败，记录可恢复 merging 阶段和候选 HEAD。
   基线、源提交、候选 HEAD 与干净状态未变时续验同一树；漂移则拒绝复用
   或按新基线有界重建。真实检查失败仍进入 recovery_required。
4. “短终锁”描述范围，不承诺秒级耗时。原生 push 的 pre-push Hook
   与网络仍在锁内，不能声称已消除这部分重复验证。普通成功路径的本地
   ff-only 同步发生在释放队列后；清理亦在队外。
5. 跨树复用必须显式 tree-content + deterministic 且所有输入匹配；
   当前实现按整树指纹比较，没有任意变更后的逐路径增量缓存。

## Consequences

无关候选不再被误杀；环境超时重试不再额外 merge。协作取消可能等当前检查
完成或超时，期间继续保留资源占用，这是保护归属的必要成本。v4 增加可选
verification.candidateHead；旧收据没有该字段时安全重建，不盲目复用。
任务和最终候选仍需要必要验证，不降低发布或服务端门禁。

## Confirmation

`project-worktree-command.test.js` 通过真实临时 Git 仓库和 bare 远端验证：
独立候选保留、冗余候选仅请求取消、活租约保留、affected 路径传递、远端
推进后重验，以及超时恢复使用相同候选 SHA。Linear Eval 的正反控固定远端
确认先于本地同步；不将离线 replay 作为在线 Agent 提效证明。

## Review Trigger

- 引入候选子进程级取消或改变租约所有权协议。
- 将 Hook 移出 finalize 或增加跨机器验证证明。
- 改变候选输入、缓存粒度或事务阶段兼容策略。

## More Information

- [Git 规则](../rules/git-rules.md)
- [审查与证据](../../audit-reports/2026-10-27-worktree-collaboration-audit.md)

回滚须先结束本次版本的交付进程并保留事务。不能以回滚为由恢复误杀独立
候选或自动释放活租约；必要时只关闭冗余取消优化，保留非强制推送与验证。
