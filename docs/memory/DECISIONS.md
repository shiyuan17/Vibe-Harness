# 决策索引

正式架构决策的唯一来源是 docs/adr/。本文件只保存 ADR 的 ID、标题、状态、摘要和链接，不复制 ADR 正文。

## 条目格式

- **ADR-0000** 标题 - 状态 - 一行摘要 - 链接

## 当前决策

- **ADR-0001** Linear 显式执行身份与原生 DAG 契约 - superseded - 原始禁止自动领单决定由 ADR-0008 替代；身份、原生关系和追加式 Receipt 约束保留 - [ADR](../adr/ADR-0001-linear-explicit-execution-and-dag.md)
- **ADR-0002** Linear Execution Envelope、恢复与交付边界 - accepted - 将授权、副作用、恢复检查点和终止条件固化为宿主可持久化契约 - [ADR](../adr/ADR-0002-linear-execution-envelope-and-recovery.md)
- **ADR-0003** 开发集成与发布提升的轻量 GitFlow - superseded - 使用短期任务分支、develop 集成、main 发布和自动回同步分离开发完成与正式发布 - [ADR](../adr/ADR-0003-lightweight-gitflow.md)
- **ADR-0004** 任务拆分治理与 DAG 状态一致性 - accepted - 保持单 Agent 快车道，统一本地与 Linear DAG 状态，要求共享契约唯一写入者和 write 派发前重验证 - [ADR](../adr/ADR-0004-task-decomposition-governance.md)
- **ADR-0005** 规则治理：SSOT、排版与本地化 - accepted - ai-collab-rules 独占通用 DAG 语义、linear-workflow 只留 Linear 投影，统一排版与中文本地化约定，并禁止硬编码版本与计数 - [ADR](../adr/ADR-0005-rules-governance.md)
- **ADR-0006** 发布边界门禁与 Writer 落地 develop 合并 - accepted - 把 CI 从 develop 逐任务合并移到发布边界，并授权 Writer 自行 squash 合并自己的 PR；合并到 develop 即为 Done - [ADR](../adr/ADR-0006-release-gated-ci-writer-landed-merges.md)
- **ADR-0007** DAG result 引入 unverified - accepted - 本地 result 新增非终态 unverified，把 Linear「Done 缺证据」从 blocked 改判过去，使缺证据与等依赖不再共用一个枚举 - [ADR](../adr/ADR-0007-dag-result-unverified.md)
- **ADR-0008** 宿主限时授权自动领取 Linear 任务 - accepted - 事件派发、独占选单、逐 Issue v2 Envelope 与 v2 Start Receipt；不交付真实派发服务 - [ADR](../adr/ADR-0008-bounded-linear-auto-claim.md)

## 纪律

- 这里只登记正式 ADR 的 ID、标题、状态、摘要和链接；决策正文、证据和复核信息只保留在 docs/adr/。
- 新增或替换决策时先创建 ADR，再更新本索引；不要直接改写已接受或已拒绝 ADR 的核心内容。
- 这里只存已确认的长期决策；当轮可关闭的解阻走 clarify-requirements，不进此文件。
- 明确排除的项记录在各自范围的 Out of scope，不在此累积。
