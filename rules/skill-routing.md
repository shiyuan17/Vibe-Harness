# Skill Routing

Skill 只补强执行方式，不覆盖 `AGENTS.md`、红区确认、工作流、审查或验证门禁。常规任务最多选择一个流程 skill、一个专项 skill 和一个验证 skill；兼容入口解析到 canonical skill 后不重复加载同类能力。

## 生命周期

| 阶段 | 首选 | 需要时补充 |
| --- | --- | --- |
| Clarify | `task-intake` | 深度未知用 `grill-me`；创意方案用 `brainstorming` |
| Spec | `api-and-interface-design` | 外部契约用 `api-contract-check` |
| Plan | `writing-plans` | - |
| Task | `task-decomposition` | - |
| Execute | `executing-plans` | 行为变更用 `test-driven-development`；故障用 `systematic-debugging` |
| Verify | `verification-before-completion` | UI 用 `browser-verification` |
| Review | `open-code-review` | 不可用时回退 `code-review-and-quality` |
| Handoff | `workflow-handoff` | 恢复历史用 agentmemory 子 skill |

## 专项

| 场景 | Skill |
| --- | --- |
| 前端实现 | `frontend-ui-engineering` |
| 安全、认证、敏感数据 | `security-and-hardening` |
| 等价精简 | `code-simplification` |
| 文档和 ADR | `documentation-and-adrs` |
| Git 分批交付 | `git-delivery-batcher` |
| Worktree merge-back | `worktree-mergeback-check` |
| 发布 / Pencil / loop | `release-checklist` / `pencil-design-check` / `loop-planning` |
| Full 高风险审查 | `adversarial-review-packet` |
| 跨仓运行时落地 | `runtime-cross-repo-rollout` |

设计类只选一个主入口：营销、品牌、作品集用 `taste-skill`；产品 UI、后台、表单和工具用 `impeccable`；方向未定时用 `frontend-design`。三者共享同一设计真值，不叠加使用。

## 兼容与外部工具

- `debugging-and-error-recovery` 兼容路由到 `systematic-debugging`。
- `browser-testing-with-devtools` 兼容路由到 `browser-verification`。
- `open-code-review`、agentmemory 和浏览器能力是本地适配层；第三方 CLI/MCP 不可用时必须按 skill 的回退协议执行。
- 不引用当前 profile 未安装的 skill；optional skill 不可用时使用已声明回退。

## Profile

- `minimal` / `codex-minimal`：不安装 skills。
- `core`：常规澄清、计划、inline 执行、实现、调试、安全、审查、验证、文档、Git 和 memory。
- `full` / `codex-internal`：在 core 上增加设计、对抗审查、跨仓、发布、Pencil、loop 和 subagent 执行。
