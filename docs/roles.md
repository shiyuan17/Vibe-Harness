# 多角色 Agent

Vibe-Harness 的角色系统为同一个主 Agent 提供阶段化决策人格，并为支持子 Agent 的宿主生成原生角色定义。它不是固定生命周期，也不会为简单任务依次调用全部角色。

## 默认行为

- full profile 默认启用七个内置角色；minimal、core 和 docs-only 默认不启用。
- 每个原子动作只选择一个角色，先按动作、有效角色和能力，再按领域选择；目标或动作类型变化时重新选择。
- 当前角色可以叠加一个 description 精确命中的领域 Skill；角色与 Skill 互不替代。
- 只有独立并行、高风险二次复审或治理拆分规则命中时才创建真实子 Agent。
- 所有角色都受父 Agent sandbox、用户授权和 Execution Envelope 约束。

## 内置角色

内置角色包括 chief-architect、product-manager、technical-project-manager、senior-engineer、test-lead、adversarial-security-reviewer 和 technical-release-manager（显示为“发布就绪审查者”）。product-manager 与 technical-project-manager 仅在显式咨询时选择，保留原 ID 以兼容既有配置。完整路由规则见 docs/rules/role-routing.md，可用角色索引安装到 .agents/roles/index.md。

## 项目配置

roles.enabled 可以覆盖 profile 默认值；roles.disabled 按 ID 禁用已解析角色。roles.overrides 只能为内置角色追加项目 Prompt 或选择能力更小的权限预设。roles.custom 用于注册项目角色，必须提供 ID、名称、描述、Prompt 路径、权限预设以及 when/avoid 路由提示。

项目 Prompt 必须是 docs/agent-roles 目录下的直接 Markdown 文件。安装器拒绝绝对路径、父目录穿越、符号链接或 junction 越界、重复 ID、内置 ID 冲突、权限扩大，以及试图覆盖治理、安全、sandbox 或授权边界的内容。

当 modules 显式存在时，roles 模块是否出现是最终启用依据；若它与 roles.enabled 冲突，配置直接失败。未显式配置 modules 时，full 默认启用，其他 profile 可用 roles.enabled=true 启用，full 可用 roles.enabled=false 关闭。

## 权限预设

- analysis：只读、搜索和推理。
- implementation：项目内写入与验证命令，但不增加 Git、发布或外部写权限。
- verification：只读检查、测试构建和浏览器验证，默认不修改实现。
- security-review：只读安全审查和授权范围内的安全检查。
- release-readiness：只读发布审查、验证与包 dry-run，禁止自动 tag、push 或 publish。

宿主不能精确表达权限时，安装器使用最严格可用映射，并在安装或 doctor 以 degraded-permission-mapping 状态和 ROLE_PERMISSION_MAPPING_DEGRADED 告警报告。doctor 的 configured-unverified 仅说明文件已生成，另列出角色所需但未绑定的能力；它不表示宿主已激活或真实任务已验证。Prompt 防线不能替代父 Agent 的真实 sandbox。

## 宿主输出

Codex、Claude、Gemini CLI、Cursor、Qoder、Antigravity 和 OpenCode 直接生成项目级原生 Agent 文件。ZCode 生成 .zcode/plugins/vibe-harness-roles 项目插件包，不写用户全局目录；doctor 会报告 manual-activation-required，由用户在 ZCode 中手动启用。

## 生命周期

角色文件与其他安装资产使用同一 install-state v5、owner 合并、冲突检测、事务写入、diff、rollback 和 uninstall 机制。未使用 force 时不会覆盖非受管同名文件；用户修改过的受管角色文件在 upgrade、rollback 或 uninstall 时保留并报告冲突。

## 设计参考

角色专业化和独立 Prompt 结构参考 [agency-agents](https://github.com/msitarzewski/agency-agents)；按需组合、避免固定流水线参考 [Anthropic Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)；项目级 custom agents 与最小权限参考 [OpenAI Codex Subagents](https://developers.openai.com/codex/subagents)。这些资料用于角色边界和投影设计，不改变 Vibe-Harness 的治理、安全和用户授权优先级。
