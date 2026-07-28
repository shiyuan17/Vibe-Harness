# Cognis v0.8 结果优先自适应执行路径

状态：Superseded

本文件记录已退役的 adaptive/strict workflow benchmark 和旧的 active-task 自动发现设计，仅供历史审计。当前 adaptive 只在会话显式使用 `@cognis-task <任务ID>` 后加载该任务；无绑定会话不会扫描任务、注入任务摘要或运行完整治理。当前规范从 `docs/README.md` 进入。

## 历史合同

当时的新项目默认 `governance.workflow: adaptive`，强调“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”。普通任务不应触发完整治理，但旧实现仍会根据开放任务自动恢复上下文，并提供 40×3 adaptive/strict workflow benchmark。

该 benchmark 运行入口、fixture、案例和发布比较门槛已被移除，不再是当前产品能力或发布依据。有关历史比较、模型、成本和方法论的结论不得用于当前验收。

## 归档理由

- LoopEngine 兼容迁移和全局任务扫描已被破坏性移除。
- adaptive 的普通澄清、原型、文档和局部实现保持单 Agent。
- 完整任务仅由显式会话绑定恢复 Tester、Reviewer、Handoff、fan-in 与集成验证。
- 当前 Hook 以轻量 `UserPromptSubmit` 解析绑定指令，压缩恢复与 Stop 按绑定短路。
