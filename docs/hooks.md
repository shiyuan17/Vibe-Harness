# Hook 安全策略

Vibe-Harness Hook 只执行项目级安全策略。它不创建任务状态、不运行测试、不检查交付文本、不在 Stop 时提交，也不执行 git push。

## 事件能力矩阵

事件与激活方式以 manifests/adapters.json 的 hookEvents 和 hookActivation 为单一事实源。

| 宿主 | PreToolUse | PermissionRequest | Stop | 激活方式 |
| --- | --- | --- | --- | --- |
| Codex | stable | stable | unsupported | manual-trust |
| Claude Code | stable | stable | unsupported | config-file |
| Gemini | unsupported | unsupported | unsupported | unsupported |
| Cursor | stable | unsupported | unsupported | config-file |
| Qoder | stable | stable | unsupported | config-file |
| ZCode | stable | stable | unsupported | config-file |
| Antigravity | preview | unsupported | unsupported | config-file |
| OpenCode | unsupported | unsupported | unsupported | unsupported |

PreToolUse 阻止危险 Git、全局 Agent 配置写入、凭据外传、红区文件上传和项目边界外写入。PermissionRequest 对相同硬边界执行拒绝；其他审批仍由宿主控制。所有宿主的 Stop 都是 unsupported，Vibe-Harness 不自动 commit 或 push。

OpenCode 不安装项目 Hook。其配置文件仍属于默认红区，其他已安装的 stable Hook 可在多宿主项目中保护这些路径；这不代表 OpenCode 自身拥有 Hook 防护。

## 路径解析

每条 Hook 命令使用跨平台 Node bootstrap：

1. 从宿主 session 的当前工作目录运行 <code>git rev-parse --show-toplevel</code>。
2. 从返回的 Git root 定位 <code>.agents/runtime/hooks/codex-hook.mjs</code>。
3. 使用 <code>process.execPath</code> 启动受管 Hook，并继承 stdin、stdout、stderr 和 Hook 参数。
4. 找不到 Git root、受管入口或子进程启动失败时明确返回非零状态。

该入口不使用 shell command substitution。它可从仓库根、多级子目录和 Git worktree 启动，并始终命中当前 worktree 的受管 Hook。

## 激活与诊断

<code>validate</code> 和 <code>doctor</code> 输出 runtimeHooks，包括配置是否存在、声明事件、git-root 路径策略、激活机制、状态和核验方法。

Codex 的 Hook trust 是宿主状态，不能从项目文件推断。即使文件一致，activation.status 也保持 unknown，并输出 HOOK_ACTIVATION_UNVERIFIED；用户必须在 Codex 中运行 <code>/hooks</code> 复核当前定义。配置文件型宿主只报告 configured-unverified，不把文件存在描述为 runtime active。

## 配置与超时

安全事件 timeout 为 10 秒；guarded 模式在无法安全判定时 fail-closed。hooks.mode 支持 off、observe 和 guarded。allowedWriteRoots、allowedEgressHosts 与 redZonePaths 分别控制项目外写入授权、出口能力和运行时红区。

网络出口默认允许普通依赖和 Git 操作，但始终阻止凭据引用与红区文件上传。非空 allowlist 是能力授予，不是内容安全保证。

RTK 路由仅在 Codex、显式选择 RTK 插件并启用对应设置时生效；安全策略始终先执行。

## Git Hooks

full profile 仍可安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。Vibe-Harness 不会因为安装这些文件而执行提交或推送。

## 安装

<code>pnpm vibe-harness install --project &lt;project&gt; --target codex --profile full --write --confirm-red-zone</code>
