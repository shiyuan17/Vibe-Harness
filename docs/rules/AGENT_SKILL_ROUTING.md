# 原生 Skill 选择规则

显式调用 `$git-deliver` 或明确指定该 Skill，才授权分组、提交并普通推送当前任务改动；普通完成请求不构成 Git 写入授权。

Skill 只补充当前任务需要的领域知识，不覆盖项目规则、人工确认或安全边界。宿主依据每个 `SKILL.md` 的 description 直接选择能力，不使用 Router 或流程 Skill 链。

- 高影响产品决定使用 `clarify-requirements`：仅处理当轮可关闭的解阻或显式需求发现，不持久化目标。
- 用户明确要求编写、优化或激活跨任务持续目标时使用 `define-goal`：产出可激活的 Goal Brief，不处理当轮解阻。
- 仅在用户显式调用 `$git-deliver` 或明确指定 `git-deliver` Skill 时使用：整理当前任务改动、按逻辑分组提交并安全地普通推送当前分支。
- 未知根因故障使用 `systematic-debugging`；Agent 规则、Skill、提示或 Hook 行为变化使用 `eval-driven-development`。
- 信任边界使用 `security-and-hardening`；公共契约使用 `api-and-interface-design`；前端体验使用 `frontend-design`；跨仓运行时使用 `runtime-cross-repo-rollout`。
- 同一阶段默认只加载一个最匹配的领域 Skill；能力不可用时使用项目规则和确定性验证，不模拟工具或结果。
- 页面交互、console、network、性能、响应式、可访问性或视觉验收使用 browser-verification integration Skill；它仅由 playwright 或 chrome-devtools plugin 显式安装，不计入九个原生 Skills。未安装时使用项目已有的浏览器验证入口。
- 显式引用 Linear Issue、委派、审查、核验或同步工作状态时使用 linear-workflow integration Skill；它仅由 linear-mcp 或 linear-mcp-readonly 显式安装。未安装时只能使用用户提供的 Issue 上下文，不声称已读取或同步 Linear。

计划、测试、Review、任务记录和普通交付由 Agent 按请求直接完成，不自动创建额外流程、角色或门禁；普通完成请求不得隐式选择 `$git-deliver`、提交或推送。红区、权限、凭据、生产、外部写入和不可逆操作始终保留人工确认。
