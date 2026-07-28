# 原生 Skill 选择规则

Skill 只补充当前任务需要的领域知识，不覆盖项目规则、人工确认或安全边界。宿主依据每个 `SKILL.md` 的 description 直接选择能力，不使用 Router 或流程 Skill 链。

- 高影响产品决定使用 `clarify-requirements`：仅处理当轮可关闭的解阻或显式需求发现，不持久化目标。
- 用户明确要求编写、优化或激活跨任务持续目标时使用 `define-goal`：产出可激活的 Goal Brief，不处理当轮解阻。
- 未知根因故障使用 `systematic-debugging`；Agent 规则、Skill、提示或 Hook 行为变化使用 `eval-driven-development`。
- 信任边界使用 `security-and-hardening`；公共契约使用 `api-and-interface-design`；前端体验使用 `frontend-design`；跨仓运行时使用 `runtime-cross-repo-rollout`。
- 同一阶段默认只加载一个最匹配的领域 Skill；能力不可用时使用项目规则和确定性验证，不模拟工具或结果。

计划、测试、Review、任务记录和交付由 Agent 按请求直接完成，不自动创建额外流程、角色或门禁。红区、权限、凭据、生产、外部写入和不可逆操作始终保留人工确认。
