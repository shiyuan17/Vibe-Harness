# Agent Skill 路由规则

Skill 只补强任务，不得覆盖项目规则、治理硬边界或人工门禁。先读取 `governance.workflow`，再按真实可用能力路由；不得引用未安装 Skill。

## Adaptive 短路由

默认不嵌套调用规划、TDD、验证和审查 Skill。先执行治理内核的结果优先主循环，仅在出现一个明确失败信号、领域信号或风险信号时加载一个必要 Skill：

| 触发信号 | 最多加载的入口 | fallback |
| --- | --- | --- |
| 用户可见行为仍有关键歧义 | `brainstorming` | 批量询问独立产品决定 |
| 同一实现失败但仍有有效进展 | `systematic-debugging` | 复现、根因、回归验证 |
| Agent 规则、Skill、模板、adapter 或 Hook 行为变化 | `eval-driven-development` | 确定性测试 + 受影响 Eval smoke |
| 安全、数据、发布、红区、不可逆或外部契约 | 对应领域 Skill，或 `adversarial-review-packet` | 进入完整路径和独立审查 |
| 复杂验证设计，普通命令不足以证明主张 | `verification-before-completion` | 治理内核的证据核对 |

领域 Skill 可替代流程 Skill 的唯一名额；不要为了“完整流程”串联 Skills。低风险本地实现不因跨模块自动升级完整档。

## Strict 路由

Strict 保留生命周期路由：Clarify 可用 `brainstorming`，Plan 可用 `writing-plans`，行为实现可用 `test-driven-development`，故障用 `systematic-debugging`，完成前用 `verification-before-completion`，完整/高风险用 `adversarial-review-packet` 或 `code-review-and-quality`。常规任务最多一个流程 Skill、一个领域 Skill和一个验证/审查 Skill。

## 共同边界

- Review 统一进入质量或 Red Team 入口；实现者不得自批高风险变更。
- 多 Agent 仅在完整路径、边界和验证独立且存在明确墙钟收益时使用；否则保持单 Agent。
- UI、API、Security、Architecture 等特殊领域只在任务真正命中时加载对应能力。
- 能力不可用时记录缺失覆盖轴，使用专项规则、项目命令或人工核验，不模拟工具或结果。
- 红区、权限、凭据、生产、外部写入和不可逆操作始终保留人工门禁。
- 复杂输入的信息呈现按 `ai-collab-rules.md` 选择最小清晰结构；简单回答保持简短。
- 完整任务通过多 Agent 准入条件后才可加载 `subagent-driven-development`。

安装了 Skills 时由 `using-cognis` 执行本路由；未安装时直接按治理内核 fallback。
