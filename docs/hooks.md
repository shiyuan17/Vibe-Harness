# Hook 安全策略

Cognis full 为 Codex 安装项目级安全 Hook。Hook 不创建任务状态、不运行测试、不检查交付文本，也不阻止 Agent 正常完成。

## 事件

| 事件 | 行为 |
| --- | --- |
| `PreToolUse` | 阻止危险 Git、全局 Agent 配置写入、凭据外传、红区文件上传和项目边界外写入；红区写入返回审批上下文；配置 `allowedEgressHosts` 后阻止非白名单主机出口。 |
| `PermissionRequest` | 拒绝违反硬安全边界的请求；其他请求继续由 Codex 正常审批。 |

配置只支持：

```json
{
  "hooks": {
    "allowedWriteRoots": [],
    "allowedEgressHosts": [],
    "mode": "guarded",
    "rtk": { "enabled": false }
  }
}
```

`mode` 可为 `off`、`observe` 或 `guarded`。跨项目写入必须在目标项目配置中使用绝对路径白名单显式授权；全局 Agent 配置始终拒绝，目录链接逃逸也会被拒绝。

网络出口默认"放行但拦敏感":普通网络命令放行(不影响 `pnpm install`/`git fetch`),网络命令携带密钥引用或上传红区/敏感文件(如 `curl -F data=@.env`)始终拒绝。配置非空 `allowedEgressHosts` 后,出口主机必须在白名单内(支持通配符如 `*.npmjs.org`),非白名单主机在 `guarded` 下拒绝、`observe` 下告警。

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
