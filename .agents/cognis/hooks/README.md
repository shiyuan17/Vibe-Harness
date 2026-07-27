# Cognis Hooks

本目录包含 Codex 项目 Hook 使用的本地运行时。安装器会将其复制到
`.agents/cognis/hooks/`；`.codex/hooks.json` 会为已配置的生命周期事件调用
`codex-hook.mjs`。

## Codex 生命周期 Hook

| Hook | 触发时机 | Cognis 的作用 |
| --- | --- | --- |
| `SessionStart` | 会话启动、恢复、清空或压缩时。 | 注入受长度限制的项目摘要，包括项目根目录、Git 状态和活跃任务合同，并报告 RTK 可用性。 |
| `UserPromptSubmit` | 用户提交提示时。 | 提醒 Agent 在新任务或实质扩大范围的任务中，先给出任务确认；不会保存或回显用户提示。 |
| `PreToolUse` | `Bash`、`Edit`、`Write` 或 MCP 工具调用前。 | 按本地安全策略评估工具请求。危险 Git 操作、全局 Agent 配置写入、疑似凭据外泄，以及越出项目或白名单范围的结构化写入都可能被拒绝。 |
| `PermissionRequest` | Codex 为匹配工具请求权限时。 | 应用同一安全策略，仅拒绝违规请求；其他请求仍走 Codex 原有审批流程。 |
| `PostToolUse` | 匹配工具执行后。 | 对写入类工具提醒 Agent 保持验证证据最新；不会自动格式化文件或保存工具输出。 |
| `PreCompact` | 上下文压缩前。 | 保留协议事件入口，当前不执行额外处理。 |
| `PostCompact` | 上下文压缩后。 | 重新构建与会话启动时相同的受限项目上下文和 RTK 状态。 |
| `SubagentStart` | 子 Agent 启动时。 | 注入子任务写入边界、最小上下文、禁止再次委派和交接证据要求；Tester/Reviewer 创建 v2 收据并锁定实现与任务/审查证据，它不能阻止子 Agent 创建。 |
| `SubagentStop` | 子 Agent 停止时。 | 校验固定字段和角色结论；只有 Tester `通过` 与 Reviewer `批准` 可封存，并提醒父 Agent fan-in、检查实际 diff 和重跑晚于收据完成时间的集成验证。 |
| `Stop` | Codex 准备停止时。 | 检查治理、可选评测和必需交付字段。`completionGate: "blocking"` 会阻止首次不完整的停止；`advisory` 仅提示问题。 |

策略例外应配置在目标项目的 `cognis.config.json`，而非本运行时。例如，
`hooks.allowedWriteRoots` 可以允许写入明确指定的绝对协作项目目录。全局
Agent 配置路径仍始终拒绝。

## Git Hook

`full` profile 还会在 `.githooks/` 中安装以下包装脚本。仓库所有者在本地启用
`core.hooksPath` 后，它们才会运行。

| Hook | 作用 |
| --- | --- |
| `pre-commit` | 检查暂存 diff 中的空白错误、疑似密钥，以及不应提交的生成目录或备份目录；不会读取或修改未暂存内容。 |
| `pre-push` | 运行 `cognis.config.json` 中已配置的治理、lint 和类型检查命令；未配置的命令会跳过。 |

策略配置、事件合同、限制与已知边界，见目标项目的 `docs/hooks.md`。
