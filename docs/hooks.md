# Hook 安全策略

Cognis full 为 Codex 安装项目级安全 Hook。Hook 不创建任务状态、不运行测试、不检查交付文本，也不阻止 Agent 正常完成。

## 事件

| 事件 | 行为 |
| --- | --- |
| `PreToolUse` | 阻止危险 Git、全局 Agent 配置写入、凭据外传和项目边界外写入；红区写入返回审批上下文。 |
| `PermissionRequest` | 拒绝违反硬安全边界的请求；其他请求继续由 Codex 正常审批。 |

配置只支持：

```json
{
  "hooks": {
    "allowedWriteRoots": [],
    "mode": "guarded",
    "rtk": { "enabled": false }
  }
}
```

`mode` 可为 `off`、`observe` 或 `guarded`。跨项目写入必须在目标项目配置中使用绝对路径白名单显式授权；全局 Agent 配置始终拒绝，目录链接逃逸也会被拒绝。

RTK 集成只在显式选择 RTK 插件并启用 `hooks.rtk.enabled` 或 `--rtk-hooks on` 时生效。安全策略始终先执行。

## Git Hooks

full 会安装 `.githooks/pre-commit` 和 `.githooks/pre-push`，但不会修改 `.git/config`。需要时由用户对当前仓库显式启用：

```bash
git config --local core.hooksPath .githooks
```

Git Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 安装

```bash
pnpm cognis install --project <project> --target codex --profile full --write --confirm-red-zone
```
