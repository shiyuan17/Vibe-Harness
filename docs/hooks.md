# Hook 场景与运行边界

LoopEngine 使用 Codex 原生 hook 协议承载项目内安全策略，并把策略实现放在 `.agents/loopengine/hooks/`。截至 2026-07-12，Codex 项目 hook 使用 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop` 和 `Stop`；没有 `SessionEnd`。

参考实现：

- [Codex hooks](https://developers.openai.com/codex/hooks/)：项目级信任审查、工具阻断、权限决策、压缩和子 Agent 事件。
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)：命令校验、敏感文件保护、格式化和通知。
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/)：工具、Agent、模型和上下文压缩阶段。
- [Cursor hooks](https://cursor.com/docs/agent/hooks)：shell、MCP、文件编辑、prompt 和 subagent 专项事件。
- [Cline hooks](https://docs.cline.bot/features/hooks)：任务启动/恢复/取消和工具前后置处理。
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/hooks)：secret scanning、审计与工具许可控制。

## 默认策略

`loopengine.config.json` 支持：

```json
{
  "hooks": {
    "mode": "guarded",
    "completionGate": "advisory"
  }
}
```

- `mode`：`off` 关闭；`observe` 只提示；`guarded` 和 `strict` 阻断高置信危险行为。默认 `guarded`。
- `completionGate`：`off`、`advisory` 或 `blocking`。blocking 仅在治理校验失败且 `stop_hook_active` 为 false 时强制续跑一次。
- 默认阻断破坏性 Git、`--no-verify`、全局 Agent 配置写入、结构化越界写入和明显的凭据外传。
- `PermissionRequest` 只会拒绝已命中策略的请求；其他请求继续走 Codex 正常审批，不会自动授权。
- hook 不保存 prompt、完整工具结果或 secret，也不在 `PostToolUse` 自动格式化文件。

Codex 会并发启动同一事件的多个匹配 hook，项目 hook 需要通过 `/hooks` 审查并信任，而且当前不能拦截所有 shell/WebSearch 实现。因此 hook 是本地纵深防御，不替代人工确认、CI 或服务端分支保护。

## Git hooks

`full` 和 `codex-internal` 会安装 `.githooks/pre-commit` 与 `.githooks/pre-push`，但不会修改 `.git/config`。确认脚本内容后，仅对当前仓库显式启用：

```bash
git config --local core.hooksPath .githooks
```

`pre-commit` 只检查 staged diff、敏感信息、生成目录和备份目录，不读取或修改 unstaged 内容。`pre-push` 顺序执行 `loopengine.config.json.validationCommands` 中已配置的 governance、lint 和 typecheck。`loopengine doctor --target <project>` 会报告 active、inactive 或 conflict，但不会修改配置。

Git hooks 可以被本地用户绕过，最终强制策略仍应放在 CI、required checks 和服务端保护中。

## 安装生命周期

MVP 项目安装使用：

```bash
pnpm loopengine install --project <project> --target codex --profile full --write --confirm-red-zone
```

legacy/internal 安装使用：

```bash
pnpm loopengine install --target <project> --profile codex-internal --apply --confirm-red-zone
```

不要把 `--project` 与 legacy `--apply` 语义混用。两条路径都不会写全局 Codex 或 Git 配置，且没有 `--force` 时不会覆盖已有文件。
