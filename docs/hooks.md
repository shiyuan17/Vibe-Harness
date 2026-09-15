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

## 判定分级

只读与无副作用判定由 runtime/hooks/lib/read-only-commands.mjs 单点提供，policy.mjs 与 execution-envelope.mjs 共同引用，不再各自维护词表。判定按「可执行名 + 子命令动词」两级进行，不要求整段命中：

| 类别 | 判定 | 出口 |
| --- | --- | --- |
| PowerShell 与 Unix 只读 cmdlet（Get-ChildItem、Select-Object、Where-Object、Sort-Object、ForEach-Object、ConvertFrom-Json、Format-Table、Group-Object、Out-String、jq、rg 等） | 无副作用 | 允许 |
| 宿主与基础设施 CLI 的只读子命令（codex 的 --version 与 --help、kubectl get、docker compose ps、terraform plan、aws list- 等） | 无副作用 | 允许 |
| 解释器与工具链（node、python、pytest、go、cargo、dotnet、mvn、gradle、make、cmake、bundle、php 等） | workspaceWrite、standard | 允许，与既有 Node 工具链一致 |
| 写类子命令（delete、remove、apply、destroy、create 等）与未分类命令 | 高风险或无法判定 | 需要 Execution Envelope，否则拒绝 |
| 危险 Git、全局 Agent 配置写入、凭据外传、红区上传、项目边界外写入 | 明确禁止 | 直接拒绝 |

Shell 分段与读写谓词同样来自该模块，因此同一条命令在策略层与 Envelope 层的只读结论一致。apply_patch 的载荷是文件内容而非 shell 命令，只按补丁目标路径判定写入范围，不做命令替换、重定向或续行检查。

MCP 工具按「服务器 + 动词」分类：get、list、search、read、find、view、inspect、query、status、state、show、open 等只读与 UI 动词放行；write、create、update、delete、send、post、execute、run、apply、install 等写与执行动词，以及无法判定的工具名，保持既有 Execution Envelope 路径。

拒绝输出保留稳定的英文 reasonCode（机器契约），message 使用中文并给出最小可行动作，并区分「不可判定，需要 Execution Envelope」与「明确禁止」两类。

项目内的 .codex、.claude、.cursor、.gemini 目录不是全局 Agent 配置；只有位于家目录之下、紧跟家目录的配置目录才命中全局配置规则，读取这些目录不视为写入。

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

安全事件 timeout 为 10 秒；运行时固定为 guarded，并在无法安全判定时 fail-closed。项目配置只允许收紧出口 allowlist 和额外 red-zone，不提供运行模式或写入根配置。

网络出口默认允许普通依赖和 Git 操作，但始终阻止凭据引用与红区文件上传。非空 allowlist 是能力授予，不是内容安全保证。

RTK 路由仅在 Codex、显式选择 RTK 插件并启用对应设置时生效；安全策略始终先执行。

## Execution Envelope

Execution Envelope 将一次用户请求绑定到 <code>requestId</code>、<code>sessionId</code>、<code>mode</code>、目标 Issue、独立 effect 授权和终止条件。v1 公开合同位于 <code>docs/schemas/execution-envelope.schema.json</code>，新增的 v2 位于 <code>docs/schemas/execution-envelope-v2.schema.json</code>。Hook 接受宿主注入的 <code>execution_envelope</code> / <code>executionEnvelope</code>，或父进程注入的 <code>VIBE_HARNESS_EXECUTION_ENVELOPE</code>；项目文件、install-state 和 Agent 命令都不是授权根。

v1 保持原 schema 与 validator，仅作为 contract-only/degraded 兼容路径；它不能授权 hostWrite、externalWrite、凭据、高风险间接写入或 worktree 拓扑变化。v2 增加 riskClass、精确 workspace identity、允许写入根、外部目标、宿主 enforcement 证明和带 HEAD/续跑计数的 checkpoint。普通项目内低风险写入仍可使用兼容路径；高风险或不可分类调用即使未设置 <code>VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED</code> 也必须提供 high-risk v2 Envelope，否则 fail-closed。

v2 的 hostContext 只能由宿主注入。高风险执行要求新鲜的宿主证明、进程隔离和与 effect 匹配的 filesystem、approval、network 边界；项目配置不得生成、持久化或扩大这些字段。活动任务的 worktree root、git common dir、git dir、branch 和 base SHA 不可变；<code>git worktree move</code> 始终拒绝，合法提交只允许把 checkpoint HEAD 前移到已验证后代。

该控制是可观察 Hook 上的纵深防御，不是常驻宿主状态服务。Vibe-Harness 当前安装器不会声称能够从最新用户消息自行生成、持久化或轮换可信 Envelope，也不会把本地状态文件当作授权根。未提供父进程强制开关、持久 checkpoint 和远程工具拦截的宿主，只获得规则、Skill、Schema 与可观察命令的检查，不能宣称完整宿主级强制。

Hook 能直接绑定 Linear 写入、包含 Issue ID 的 Git 分支、提交、推送命令，以及暴露标题、source branch 或 closing 引用的 PR/MR 写入。看不到目标 Issue 时拒绝执行；MR 正文中普通的非 closing 关联不会被误当成目标。任意解释器、包装脚本、远程 MCP/API、宿主外部写入和真实上下文压缩仍需宿主沙箱、凭据代理、会话存储和 provider 审计独立覆盖。

## Security boundary and diagnostics

Hooks are defense in depth, not a complete machine-security boundary. Command-string inspection cannot reliably interpret arbitrary PowerShell, Python, Node.js, package-manager, Git, subprocess, or network behavior. File-system isolation, process isolation, approval enforcement, and egress control must be provided and independently verified by the host sandbox and network proxy.

<code>doctor</code> and project <code>validate</code> report <code>supported</code>, <code>configured</code>, <code>activated</code>, <code>enforced</code>, <code>executionAuthority</code>, and <code>coverageLimitations</code>. <code>activated</code> remains null when project files cannot prove host runtime state. <code>enforced</code> becomes true only when the host independently proves Hook activation, required Envelope enforcement, sandbox, approval, process isolation, and network control. Adapter capability support never substitutes for this per-task evidence. Legacy activation, declaredEvents, pathResolution, and selfCheck fields remain available for compatibility.

Repository configuration can only tighten policy. Runtime mode is always guarded, write roots are not expanded by project configuration, configured red-zone paths are added to the built-in control-plane list, and an egress allowlist narrows permitted hosts. Repository-local install state records installation history but is not an authorization root.

Direct writes to vibe-harness.config.json, .vibe-harness/install-state.json, managed Hook runtime files, or adapter Hook/MCP configuration are denied. Update these files only through a transactional Vibe-Harness installer operation with the required write and red-zone confirmation flags.

Git Hook diagnostics inspect the active core.hooksPath and confirm that both pre-commit and pre-push scripts call the managed security runtime. Husky v9 paths such as .husky/_ are resolved to their project scripts rather than treated as conflicts.

## Git Hooks

full profile 仍可安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。Vibe-Harness 不会因为安装这些文件而执行提交或推送。

## 安装

<code>pnpm vibe-harness install --project &lt;project&gt; --target codex --profile full --write --confirm-red-zone</code>
