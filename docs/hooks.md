# Hook 安全策略

Vibe-Harness full 为 Codex 安装项目级安全 Hook。Hook 不创建任务状态、不运行测试、不检查交付文本，也不阻止 Agent 正常完成。

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
    "redZonePaths": [".env", "auth/", "ci/cd/", ".github/workflows/", ".codex/hooks.json"],
    "rtk": { "enabled": false }
  }
}
```

`mode` 可为 `off`、`observe` 或 `guarded`。跨项目写入必须在目标项目配置中使用绝对路径白名单显式授权；全局 Agent 配置始终拒绝，目录链接逃逸也会被拒绝。

`redZonePaths` 是 Hook 运行时的红区单一事实源：每个条目是项目相对路径片段，带末尾 `/` 的匹配目录及其后代，裸文件名（如 `.env`）匹配文件本身及以 `.` 延伸的同名文件（如 `.env.production`），含 `/` 的条目匹配该相对路径或其后代。命中红区的写入返回审批上下文（warn），红区文件上传始终拒绝。注意 `riskZones.red` 是项目治理逻辑分类（供人工与工具参考），与 `hooks.redZonePaths` 职责不同、可独立配置。

网络出口默认"放行但拦敏感":普通网络命令放行(不影响 `pnpm install`/`git fetch`),网络命令携带密钥引用或上传红区/敏感文件(如 `curl -F data=@.env`)始终拒绝。配置非空 `allowedEgressHosts` 后,出口主机必须在白名单内(支持通配符如 `*.npmjs.org`),非白名单主机在 `guarded` 下拒绝、`observe` 下告警。allowlist 应理解为"能力授予"而非"目的地过滤":白名单内主机仍是攻击面，因此密钥引用与红区上传始终被无条件拦截。

RTK 集成只在显式选择 RTK 插件并启用 `hooks.rtk.enabled` 或 `--rtk-hooks on` 时生效。安全策略始终先执行。

## 超时

`.codex/hooks.json` 的 `timeout` 设为 10 秒（Codex 默认为 600 秒）。该取值是有意的保守选择，避免策略评估长挂阻塞交互；超时后 Codex 将 Hook 视为失败，对 `PreToolUse`/`PermissionRequest` 等 guarded 事件按 fail-closed 拒绝。如策略评估确需更长时间，可调整 `hooks.json` 的 `timeout` 字段，但需评估对交互延迟的影响。

## Hook 路径

`.codex/hooks.json` 的 `command` 使用相对路径（`node .agents/runtime/hooks/codex-hook.mjs`），Codex 以启动时的工作目录（`turn_context.cwd`）执行该命令。请在仓库根目录启动 Codex；若需在子目录运行，先 `cd` 到仓库根或从根目录启动，否则相对路径将无法定位 Hook 入口。

## Git Hooks

full 会安装 `.githooks/pre-commit` 和 `.githooks/pre-push`，但不会修改 `.git/config`。需要时由用户对当前仓库显式启用：

```bash
git config --local core.hooksPath .githooks
```

Git Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 安装

```bash
pnpm vibe-harness install --project <project> --target codex --profile full --write --confirm-red-zone
```
