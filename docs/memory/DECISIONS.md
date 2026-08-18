# 决策索引

正式架构决策的唯一来源是 docs/adr/。本文件只保存 ADR 的 ID、标题、状态、摘要和链接，不复制 ADR 正文。

## 条目格式

- **ADR-0000** 标题 - 状态 - 一行摘要 - 链接

## 当前决策

- **ADR-0001** Linear 显式执行身份与原生 DAG 契约 - accepted - 禁止自动领单，分离 Assignee、Delegate 与运行实例，并使用原生关系和追加式 Receipt - [ADR](../adr/ADR-0001-linear-explicit-execution-and-dag.md)
- **ADR-0002** Linear Execution Envelope、恢复与交付边界 - accepted - 将授权、副作用、恢复检查点和终止条件固化为宿主可持久化契约 - [ADR](../adr/ADR-0002-linear-execution-envelope-and-recovery.md)
- **ADR-0003** 开发集成与发布提升的轻量 GitFlow - accepted - 使用短期任务分支、develop 集成、main 发布和自动回同步分离开发完成与正式发布 - [ADR](../adr/ADR-0003-lightweight-gitflow.md)

## 纪律

- 这里只登记正式 ADR 的 ID、标题、状态、摘要和链接；决策正文、证据和复核信息只保留在 docs/adr/。
- 新增或替换决策时先创建 ADR，再更新本索引；不要直接改写已接受或已拒绝 ADR 的核心内容。
- 这里只存已确认的长期决策；当轮可关闭的解阻走 clarify-requirements，不进此文件。
- 明确排除的项记录在各自范围的 Out of scope，不在此累积。
