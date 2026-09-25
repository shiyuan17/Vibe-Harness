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

宿主不能精确表达权限时，安装器使用最严格可用映射，并在安装或 doctor 以 degraded-permission-mapping 状态和 ROLE_PERMISSION_MAPPING_DEGRADED 告警报告。Prompt 防线不能替代父 Agent 的真实 sandbox。

## 角色描述

宿主按 description 自动委派，因此每个角色的 description 由安装器从 `manifests/roles.json` 的 `description`、`routing.when` 和 `routing.avoid` 组合成单行英文句子：能力句 + `Triggers:` + 适用项 + `. Avoid:` + 避免项 + `.`。`routing.mode: explicit` 的角色（product-manager、technical-project-manager）额外以 `[Explicit invocation only; do not auto-select. ` 开头，抑制自动委派。组合结果必须不超过 300 字符；超出时安装失败并指出角色，不做截断。

该组合串同时写入各宿主原生角色文件的 description 与 `.agents/roles/index.md`；索引额外列出路由模式、权限预设与适用/避免项，是有效角色集合的第二入口。

## 宿主映射

| 宿主 | 投影路径 | 可表达的权限键位 | 注入的能力 | 状态 |
| --- | --- | --- | --- | --- |
| Codex | `.codex/agents/*.toml` | `sandbox_mode` | Skill 与 MCP 由父会话继承（未设置的字段沿用父会话配置，属预期，不是缺口） | native |
| Claude | `.claude/agents/*.md` | `tools` 白名单、`skills` 预加载、`permissionMode` | 按本次安装枚举 `mcp__<server>`，预加载已安装 Skill；不把 `Skill` 写进 `tools` | prompt-guarded |
| Gemini CLI | `.gemini/agents/*.md` | `tools` | 安装含 MCP server 时追加 `mcp_*` 通配 | prompt-guarded |
| Cursor | `.cursor/agents/*.md` | `readonly` | 无 | prompt-guarded |
| Qoder | `.qoder/agents/*.md` | 无（frontmatter 只解析 `name`/`description`/`model`/`skills`/`mcpServers`） | `skills` 与 `mcpServers` 列表 | prompt-guarded |
| ZCode | `.zcode/plugins/vibe-harness-roles/agents/*.md` | `tools`、`permissionMode` | `skills`（声明后宿主自动授予 Skill 工具） | prompt-guarded，需手动激活插件 |
| Antigravity | `.agents/agents/*.md` | `tools` | 无 | configured-unverified |
| OpenCode | `.opencode/agents/*.md` | `edit`/`bash`/`task`/`webfetch`/`websearch`/`external_directory` 权限映射 | 无 | native |

- Codex、Claude、Gemini、Cursor、Qoder、Antigravity、OpenCode 直接生成项目级原生 Agent 文件；ZCode 生成项目插件包，不写用户全局目录。
- Qoder 的 subagent frontmatter 没有 `tools` 键，投影因此不再写工具表；该宿主的权限只靠组合后的 Prompt 与父级 sandbox，安装器不声明原生强制。
- Antigravity 的工具名取自宿主二进制（`view_file`、`grep_search`、`list_dir`、`replace_file_content`、`write_to_file`、`run_command`），但 `.agents/agents/` 是否是宿主读取角色定义的位置尚未实证，因此该宿主的工具绑定状态固定为 `configured-unverified`，doctor 输出 ROLE_TOOL_BINDING_UNVERIFIED。
- OpenCode 是唯一原生强制权限的宿主：所有角色 deny `task`/`webfetch`/`websearch`；非可执行预设额外 deny `external_directory` 且完全关闭 bash；可执行预设在 `"*": ask` 之后追加只读命令精确白名单（仅无参数形式，带参数命令仍然询问），白名单由 runtime/hooks/lib/read-only-commands.mjs 的分类表派生。

## 宿主输出

ZCode 的角色能力经项目插件生效，doctor 会报告 manual-activation-required，由用户在 ZCode 中手动启用后角色才可能被加载。

doctor 的角色报告把状态拆成四级，不把「文件已生成」读成「当前任务可用」：`fileGenerated`（安装器已写出角色文件）、`hostActivated`（宿主是否已加载，ZCode 为 manual-activation-required）、`toolBinding`（native / prompt-guarded / configured-unverified）、`currentTaskExecutable`（本轮是否有真机证据，无证据一律为 false）。合并字段 `status` 只描述第一级。

## 生命周期

角色文件与其他安装资产使用同一 install-state v5、owner 合并、冲突检测、事务写入、diff、rollback 和 uninstall 机制。未使用 force 时不会覆盖非受管同名文件；用户修改过的受管角色文件在 upgrade、rollback 或 uninstall 时保留并报告冲突。角色文件不是项目自有的种子，漂移不适用「保留并重新记录基线」的处理（那条路径只覆盖 docs/memory/* 与 .agents/memory/*，见[迁移指南](migration-guide.md)的项目自有种子漂移一节）。

## 设计参考

角色专业化和独立 Prompt 结构参考 [agency-agents](https://github.com/msitarzewski/agency-agents)；按需组合、避免固定流水线参考 [Anthropic Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)；项目级 custom agents 与最小权限参考 [OpenAI Codex Subagents](https://developers.openai.com/codex/subagents)。这些资料用于角色边界和投影设计，不改变 Vibe-Harness 的治理、安全和用户授权优先级。
