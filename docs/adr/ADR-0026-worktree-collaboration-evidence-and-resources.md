---
id: ADR-0026
title: 并行交付的自动证据、候选资源与局部调度
status: accepted
date: 2026-10-27
review-date: 2027-04-27
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0025]
superseded-by: null
---

# 并行交付的自动证据、候选资源与局部调度

## Context and Problem Statement

stage/publish 已将候选验证移到 FIFO 外，但原生 pre-push 会重复验证主检出。
候选沿用源端口、外部集成未回收源资源，以及合法 DAG 的局部冲突扩大为全图
阻塞，增加了协调成本。必须保留 ADR-0025 的限域协作取消、真实 affected
范围和环境失败续验，且不能用失效证据放行最终组合状态。

## Decision Drivers

- 必要自动检查覆盖最终集成对象；不要求本地人工或 Agent 复审。
- 保持 CI 触发范围和稳定门禁名；develop 直推依靠本地必要证据。
- 缓存必须有完整输入证明；资源归属和外部事实不由任务文档重复维护。
- 恢复只重做失效部分，无关任务继续推进。

## Considered Options

- 在发布锁中再次全量验证：拒绝，扩大串行路径。
- 布尔环境变量跳过 Hook：拒绝，无法绑定推送对象和输入。
- 引入独立审批或调度服务：拒绝，超出当前需求。
- 共享风险 Planner、本机认证证明、资源日志和局部 DAG 判定：采纳。

## Decision Outcome

1. `runtime/lib/verification-risk.mjs` 定义风险分类和交付必要检查；CLI、
   runtime 与 CI 共用。反馈成本层不豁免交付证据；未知影响扩大检查。
2. CI 保留 product、merge-gate、测试、类型、结构、契约和安全检查，
   去除独立审查和人工批准 job。兼容审查工具继续可显式使用。
3. 每个候选持有独立资源 ID、端口、命名空间和可写缓存。声明式成对命令
   使用环境变量传参，按资源身份/步骤键幂等。资源日志写在 Git common dir，
   先写操作意图，再执行，最后确认；崩溃窗口重试同一步骤键。
4. 检查只锁声明的具体资源。`repo-heavy` 只表述成本；依赖写入和安装
   必须隔离，未证明不可变的共享依赖不能跨工作区复用。
5. 验证缓存 v6 绑定实际依赖内容、环境文件和资源身份；只有显式
   deterministic 的检查可复用。原生 Hook 核对认证单次证明的精确 SHA、
   tree、仓库、目标地址、ref、检查、配置、环境与运行器。
   证明失效时受管 publish 退出 FIFO，在队外补证后有界重试。
6. 事务 v5 保留终态；外部集成与正常确认走相同幂等清理。源 HEAD、
   脏状态、服务停止或资源归属不确定时保留资源。新增 cleanup --batch，
   默认 dry-run。旧事务可读，无法补足证据时重验或保守恢复。
7. DAG 全图 check 保持严格诊断，派发使用 check --node。结构错误阻断
   全图，调度冲突只影响相关节点。并行建议须同时净节省 10 分钟和 15%，
   加 20% 不确定性缓冲；不自动改变已有 single 计划或派发 Agent。

## Consequences

稳定候选环境在 stage 后保留到 publish/cleanup，因此磁盘占用增加。
证明检查依赖实际字节，开销必须单独计量。不能声明跨机器复用，也不能把
外部可变状态检查批量标为 deterministic。项目 setup/teardown 必须对相同
资源和步骤键幂等；运行时无法让任意数据库或容器命令获得恰好一次语义。

## Confirmation

聚焦回归使用真实临时 Git 仓库、bare 远端和原生 pre-push。覆盖三入口
风险一致、精确对象、多 ref、证明篡改与失效、资源占用和清理重试。
五类性能 fixture 各运行五次，报告中位数、最大值与原始计数；失败交付
不得计入成功性能样本。参考 [迁移说明](../specs/worktree-collaboration-migration.md)。

## Review Trigger

- 扩展跨机器证明或增量路径缓存。
- 新增资源自动领用服务或改变清理所有权。
- 服务器 required checks 变化或证明路径未减少总耗时。

## More Information

- [Git 规则](../rules/git-rules.md)
- [前次审查](../../audit-reports/2026-10-27-worktree-collaboration-audit.md)

回滚可关闭验证复用，但仍须验证精确候选；活动 v5 事务先保留或结束，
禁止旧运行时处理未知资源。保留 ADR-0025 的三项故障修复。
