# Hook 场景与运行边界

Cognis 使用 Codex 原生 hook 协议承载项目内安全策略，并把策略实现放在 `.agents/cognis/hooks/`。Adaptive 安装 `SessionStart`、`PostCompact`、`PreToolUse`、`SubagentStart`、`SubagentStop` 和 `Stop`；strict 兼容路径保留 `UserPromptSubmit`、`PermissionRequest`、`PostToolUse` 与 `PreCompact` 在内的原 10 事件集合。两条路径都没有 `SessionEnd`。

参考实现：

- [Codex hooks](https://developers.openai.com/codex/hooks/)：项目级信任审查、工具阻断、权限决策、压缩和子 Agent 事件。
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)：命令校验、敏感文件保护、格式化和通知。
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/)：工具、Agent、模型和上下文压缩阶段。
- [Cursor hooks](https://cursor.com/docs/agent/hooks)：shell、MCP、文件编辑、prompt 和 subagent 专项事件。
- [Cline hooks](https://docs.cline.bot/features/hooks)：任务启动/恢复/取消和工具前后置处理。
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/hooks)：secret scanning、审计与工具许可控制。

## 默认策略

`cognis.config.json` 支持：

```json
{
  "governance": { "workflow": "adaptive" },
  "hooks": {
    "mode": "guarded",
    "completionGate": "advisory",
    "rtk": { "enabled": true }
  },
  "plugins": ["rtk"]
}
```

- `mode`：`off` 关闭；`observe` 只提示；`guarded` 和 `strict` 阻断高置信危险行为。默认 `guarded`。
- `completionGate`：`off` 不检查最终回复；`advisory` 提醒治理失败或交付字段缺失；`blocking` 在存在任一问题且 `stop_hook_active` 为 false 时强制续跑一次。
- `hooks.rtk.enabled`：可选布尔值。优先级为 CLI `--rtk-hooks`、项目配置、install-state；默认关闭，且启用时必须选择 `rtk` 插件并使用 Codex target。
- 默认规范化 `git` / `git.exe`、`-C` 等全局参数并阻断破坏性 reset、clean、restore、path checkout、强制 switch、stash 删除和 `--no-verify`。
- 全局 Agent 配置策略区分读写：允许 `Get-Content`、`cat`、`type` 和 `git config --global --get/--list`，阻断 PowerShell、cmd、POSIX 写法及无法安全判定的敏感路径命令。
- `PermissionRequest` 只会拒绝已命中策略的请求；其他请求继续走 Codex 正常审批，不会自动授权。
- hook 不保存 prompt、完整工具结果或 secret，也不在 `PostToolUse` 自动格式化文件。
- 每条模板命令携带 `--expected-event <Event>`。输入事件与配置不一致时不得继续执行策略。
- `PreToolUse` 与 `PermissionRequest` 发生 JSON、策略或 runtime 异常时输出事件正确的 deny JSON 并退出 0，确保宿主消费拒绝决定；通知类事件返回 `HOOK_RUNTIME_ERROR` warning。外层错误不输出 stack、绝对路径或环境变量。

RTK 项目 hook 调用项目内 binary 的 `rewrite`，上限 750ms，并限制 stdout/stderr。`observe`/`guarded` 只提示项目内精确重试命令，`strict` 阻断原命令后要求重试；安全策略始终先执行。敏感命令、原始日志、已包装命令、显式 bypass、工具不可用和超时不会被强制压缩。命令使用与 bypass 入口见 [`rules/rtk.md`](../rules/rtk.md)。

## 会话输入与输出

- `SessionStart` / `PostCompact` 读取 `cwd`，输出项目根、Git 分支、工作区状态和活跃任务合同。Adaptive 没有 active task 时不注入；strict 保留原行为。任务只展示最多 5 个开放任务的编号、标题、档位、阶段、状态和下一步。
- `UserPromptSubmit` 不保留或回显 `prompt`，只注入通用要求：新任务或范围实质变化时先输出任务确认，普通追问不重复输出。
- `SubagentStart` 只注入 child 写入边界、最小上下文、禁止再委派和不得自批等提醒；Codex 事件合同不支持在这里阻止 subagent 启动，Cognis 不宣称该能力。
- `SubagentStop` 只提醒父 Agent 核对实际 diff 与自报证据、将状态持久化到父 Agent 维护的任务 Markdown，并在合并后的目标工作区复验；它不替代任务图 validator 或独立审查。
- `Stop` 读取 `last_assistant_message`。Adaptive 普通任务只检查结果、实际变更和本轮验证，不运行 Eval；只有 active 完整任务才运行治理门禁。Strict 继续运行治理、可选 Eval 和结果状态、变更摘要、影响范围、工作流档位、验证证据、未验证项、剩余风险、Git、worktree/merge-back、后续动作与 Memory 的完整交付检查。
- 交付解析忽略代码围栏、缩进代码、HTML、注释和引用示例，并拒绝 TODO、TBD、N/A、待补充等占位值。
- `blocking` 首次返回 `{ "decision": "block", "reason": "..." }`；advisory 或第二次 Stop 返回 `systemMessage`，不会形成无限续跑。

SessionStart 上下文最长 4096 字符，单条任务字段会截断；其中不包含用户 prompt。最终回复只在当前 Stop 调用内校验，不写入磁盘。

Codex 会并发启动同一事件的多个匹配 hook，项目 hook 需要通过 `/hooks` 审查并信任，而且当前不能拦截所有 shell/WebSearch 实现。因此 hook 是本地纵深防御，不替代人工确认、CI 或服务端分支保护。

## Git hooks

`full` 会安装 `.githooks/pre-commit` 与 `.githooks/pre-push`，但不会修改 `.git/config`。确认脚本内容后，仅对当前仓库显式启用：

```bash
git config --local core.hooksPath .githooks
```

`pre-commit` 只检查 staged diff、敏感信息、生成目录和备份目录，不读取或修改 unstaged 内容。`pre-push` 顺序执行 `cognis.config.json.validationCommands` 中已配置的 governance、lint 和 typecheck。`cognis doctor --project <project>` 会报告 active、inactive 或 conflict，但不会修改配置。

Git hooks 可以被本地用户绕过，最终强制策略仍应放在 CI、required checks 和服务端保护中。

## 安装生命周期

所有项目安装使用：

```bash
pnpm cognis install --project <project> --target codex --profile full --write --confirm-red-zone
```

仅安装 RTK 不会启用 hook；显式启用项目 hook 使用：

```bash
pnpm cognis install --project <project> --target codex --profile core --plugin -rtk --rtk-hooks on --write --confirm-red-zone
```

RTK 的全局安装边界与降级要求由 [`rules/rtk.md`](../rules/rtk.md) 统一定义。

不会再解析 `--target <project>` 或 `--apply`；旧项目先运行 `init --project <project>`，再用 `install --upgrade --write` 归一状态。该流程不会写全局 Codex 或 Git 配置，且没有 `--force` 时不会覆盖已有文件。
