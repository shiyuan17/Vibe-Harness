# Skill Routing

Skill 只补强执行方式，不覆盖 `AGENTS.md`、红区确认、Workflow、Review 或验证门禁。

## 选择原则

- 先声明主 Workflow 与风险，再选择最小 skill 集。
- 常规任务最多选择一个流程 skill、一个专项 skill、一个验证 skill。
- 不引用未安装 skill；不可用时说明原因并回退到已安装规则、等价流程或人工步骤。
- Skill 不得降低错误处理、权限、数据映射、验证或用户反馈要求。

## 生命周期映射

| 阶段 | 推荐 skill |
| --- | --- |
| Clarify | `task-intake` / `brainstorming` |
| Spec | `api-contract-check` / `api-and-interface-design` |
| Plan | `writing-plans` |
| Task | `task-decomposition` |
| Execute | `test-driven-development` / `systematic-debugging` |
| Verify | `verification-before-completion` / `browser-verification` |
| Review | `open-code-review` 优先，失败回退 `code-review-and-quality` |
| Handoff | `workflow-handoff` |
| Resume | agentmemory `handoff` / `recall` / `session-history` |

## 专项映射

| 场景 | Skill |
| --- | --- |
| API / DTO / mock / 联调 | `api-contract-check` |
| 前端页面 / 组件 / 状态 | `frontend-implementation-check` |
| 发布 / 回滚 | `release-checklist` |
| Worktree / merge-back | `worktree-mergeback-check` |
| Pencil 设计稿 | `pencil-design-check` |
| 显式 loop | `loop-planning` |

## Review

默认 AI 审查入口是 `open-code-review`；不可用时说明原因，并回退到 `code-review-and-quality` 或人工审查。`open-code-review` 不替代高风险人工确认。
