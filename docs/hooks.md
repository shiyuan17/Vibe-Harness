# Hook 安全策略

Vibe-Harness Hook 只执行项目级安全策略。它不创建任务状态、不运行测试、不检查交付文本、不在 Stop 时提交，也不执行 git push。

## 事件能力矩阵

事件与激活方式以 manifests/adapters.json 的 hookEvents 和 hookActivation 为单一事实源。

| 宿主 | PreToolUse | PermissionRequest | Stop | 激活方式 |
| --- | --- | --- | --- | --- |
| Codex | stable | stable | not-projected | manual-trust |
| Claude Code | stable | stable | not-projected | config-file |
| Gemini | unsupported | unsupported | unsupported | unsupported |
| Cursor | stable | unsupported | unsupported | config-file |
| Qoder | stable | stable | unsupported | config-file |
| ZCode | stable | stable | unsupported | config-file |
| Antigravity | preview | unsupported | unsupported | config-file |
| OpenCode | unsupported | unsupported | unsupported | unsupported |

PreToolUse 阻止危险 Git、全局 Agent 配置写入、凭据外传、红区文件上传和项目边界外写入。PermissionRequest 对相同硬边界执行拒绝；其他审批仍由宿主控制。

Codex 投影的 PreToolUse <code>matcher</code> 为 <code>.*</code>，即对宿主上报的每个工具名求值（不再枚举 Bash、Edit、Write、ApplyPatch、apply_patch 与 mcp__.*）：宿主新增的工具不会因为不在枚举里而静默跳过策略。宿主把含正则元字符的 matcher 按未锚定的 JavaScript 正则求值，这与 Claude Code 文档中的匹配路径一致，也正是选择 <code>.*</code> 而不是依赖 <code>*</code> 特殊语义的原因。

`not-projected` 与 `unsupported` 不是同一个结论：`not-projected` 表示宿主支持该事件、但本项目不安装对应 Hook（Codex 与 Claude Code 的 Stop 属于此类，宿主侧另有项目记录过 Stop 信任），`unsupported` 表示该宿主没有这一能力入口。Vibe-Harness 不在 Stop 时 commit 或 push，因此不投影该事件；这既不表示宿主缺少该事件，也不表示缺少它的项目失去了 Stop 防护以外的任何策略。

manifest 的 `hookEvents` 与 `hookActivation` 是事件能力的单一事实源（`manifests/adapters.json`）。取证状态记录在每条 adapter 的 `evidence` 字段：Codex 声明已在 hostVersion 0.147.0 上于 2026-09-15 核对；其余宿主的 `lastVerifiedAt` 与 `hostVersion` 仍为空，表示「声明存在但本轮未在真实宿主上复核」，不得读作已验证。

## 判定分级

只读与无副作用判定由 runtime/hooks/lib/read-only-commands.mjs 单点提供，policy.mjs 与 execution-envelope.mjs 共同引用，不再各自维护词表。判定按「可执行名 + 子命令动词」两级进行，不要求整段命中：

| 类别 | 判定 | 出口 |
| --- | --- | --- |
| PowerShell 与 Unix 只读 cmdlet（Get-ChildItem、Select-Object、Where-Object、Sort-Object、ForEach-Object、ConvertFrom-Json、Format-Table、Group-Object、Out-String、jq、rg 等） | 无副作用 | 允许 |
| 宿主与基础设施 CLI 的只读子命令（codex 的 --version 与 --help、kubectl get、docker compose ps、terraform plan、aws list- 等） | 无副作用 | 允许 |
| 解释器与工具链（node、python、pytest、go、cargo、dotnet、mvn、gradle、make、cmake、bundle、php 等） | workspaceWrite、standard | 允许，与既有 Node 工具链一致 |
| 本地宿主函数工具（view_image、update_plan、agent、spawn_agent、task、read_file，以及 read_thread、read_thread_terminal、list_threads、list_archived_threads、wait_threads、list_agents、list_projects、get_goal、get_handoff_status） | 无副作用 | 允许 |
| 写类子命令（delete、remove、apply、destroy、create 等）与未分类命令 | 高风险或无法判定 | 需要 Execution Envelope，否则拒绝 |
| 危险 Git、全局 Agent 配置写入、凭据外传、红区上传、项目边界外写入 | 明确禁止 | 直接拒绝 |

Shell 分段与读写谓词同样来自该模块，因此同一条命令在策略层与 Envelope 层的只读结论一致。apply_patch 的载荷是文件内容而非 shell 命令，只按补丁目标路径判定写入范围，不做命令替换、重定向或续行检查。

本地宿主函数工具是一份显式名单：它们不触碰工作区，但名字里没有可推断的读动词（<code>update_plan</code> 是宿主本地清单，<code>view_image</code> 返回像素），未列名时会落到「无法判定」并要求 Execution Envelope。会改动宿主状态的工具不进这份名单——<code>write_stdin</code>、<code>create_thread</code>、<code>fork_thread</code>、<code>automation_update</code>、<code>handoff_thread</code>、<code>set_thread_*</code>、<code>send_message_to_thread</code>、<code>followup_task</code> 以及一切未列名的工具仍走 Envelope 路径（无 Envelope 即拒绝）。相对上一轮，<code>update_plan</code>、<code>view_image</code> 与 <code>Agent</code> 由「不判定」变为「放行」，<code>write_stdin</code>、<code>create_thread</code> 与 <code>automation_update</code> 由「不判定」变为「拒绝」。

MCP 工具先按「服务器 + 工具名」查显式合同表，再回退到「服务器 + 动词」分类。显式表覆盖项目内固定版本的 codebase-memory-mcp：13 个只读工具（<code>search_graph</code>、<code>query_graph</code>、<code>trace_path</code>、<code>get_code_snippet</code>、<code>get_file_outline</code>、<code>get_graph_schema</code>、<code>compare_graphs</code>、<code>get_architecture</code>、<code>search_code</code>、<code>list_projects</code>、<code>index_status</code>、<code>check_index_coverage</code>、<code>detect_changes</code>）与两个只重写工具自身图缓存的可逆工具（<code>index_repository</code>、<code>ingest_traces</code>）直接放行；<code>manage_adr</code> 写项目文件，按 workspaceWrite 需要 Execution Envelope；<code>delete_project</code> 删除整个项目索引，属高风险，保持拒绝。表外工具仍按动词判定：get、list、search、read、find、view、inspect、query、status、state、show、open 等只读与 UI 动词放行；write、create、update、delete、send、post、execute、run、apply、install 等写与执行动词，以及无法判定的工具名，保持既有 Execution Envelope 路径。显式表解决的是按动词猜名会误判的那一类工具名（<code>trace_path</code> 没有读动词，<code>index_repository</code> 没有写动词），动词表继续覆盖未登记服务器。

拒绝输出保留稳定的英文 reasonCode（机器契约），message 使用中文并给出最小可行动作，并区分「不可判定，需要 Execution Envelope」与「明确禁止」两类。

项目内的 .codex、.claude、.cursor、.gemini 目录不是全局 Agent 配置；只有位于家目录之下、紧跟家目录的配置目录才命中全局配置规则，读取这些目录不视为写入。

OpenCode 不安装项目 Hook。其配置文件仍属于默认红区，其他已安装的 stable Hook 可在多宿主项目中保护这些路径；这不代表 OpenCode 自身拥有 Hook 防护。

## 路径解析

每条 Hook 命令使用跨平台 Node bootstrap：

1. 从宿主 session 的当前工作目录逐级向上查找首个含 <code>.git</code> 的目录（目录或文件均可，因此 worktree 与 submodule 各自解析到自己的检出）。
2. 从该根定位 <code>.agents/runtime/hooks/codex-hook.mjs</code>。
3. 使用 <code>process.execPath</code> 启动受管 Hook，并透传 stdin、stdout、stderr 和 Hook 参数；环境只传固定白名单（PATH、PATHEXT、SystemRoot、SystemDrive、TEMP、TMP、HOME、USERPROFILE、CODEX_HOME、两个 <code>VIBE_HARNESS_EXECUTION_ENVELOPE</code> 开关）加解析出的 <code>VIBE_HARNESS_GIT_ROOT</code>，不透传宿主整份环境。
4. 找不到项目根、受管入口、子进程启动失败或超过 8 秒引导预算时，改用宿主 deny 契约阻断（见下节）。

该入口不调用 <code>git</code>、不使用 shell command substitution，因此也不依赖 PATH 上的 git。它可从仓库根、多级子目录和 Git worktree 启动，并始终命中当前 worktree 的受管 Hook。

## 失败契约

宿主把非零退出记为「Hook 运行失败」并继续执行工具调用，所以阻断只能走宿主决策通道：只有 <code>exit 2</code> 或宿主可识别的 deny 决策才真正拦住调用。

项目根缺失、受管入口缺失、子进程启动失败和 8 秒引导预算用尽，都输出按宿主分形的 deny 载荷后 <code>exit 0</code>：codex／claude／qoder／zcode 的 PreToolUse 用 <code>hookSpecificOutput.permissionDecision=deny</code>，它们的 PermissionRequest 用 <code>hookSpecificOutput.decision.behavior=deny</code>；Cursor 用 <code>{"continue":false}</code>；Antigravity 用 <code>{"decision":"deny"}</code>。只有完全未知的宿主回落到 <code>exit 2</code>。每个理由都以 <code>[VIBE_HARNESS_HOOK:BOOTSTRAP_UNAVAILABLE]</code> 开头，并同时向 stderr 写一行诊断供宿主日志排查。

受管运行时在宿主的 10 秒超时之内保有自己的 5 秒预算，到点写出与常路径同形的 deny 决策（<code>HOOK_BUDGET_EXCEEDED</code>）后退出，而不是被宿主杀掉——被宿主杀掉的 Hook 不阻断工具调用。<code>VIBE_HARNESS_HOOK_BUDGET_MS</code> 只能缩短该预算，不能延长。

残余风险：引导命令以 <code>node</code> 开头，因此依赖宿主 PATH 上的 node 与能运行受管运行时的 Node 版本；解释器本身起不来时命令不会执行，宿主仍按「运行失败」处理并继续工具调用。安装定义保留可移植的 <code>node</code> 调用而不是固化 <code>process.execPath</code>，以便 worktree 迁移与换机后继续可用；需要补足这一点的项目应在自己的宿主配置里固定解释器。

## 激活与诊断

<code>validate</code> 和 <code>doctor</code> 输出 runtimeHooks，包括配置是否存在、声明事件、git-root 路径策略、激活机制、状态和核验方法。

Codex 的 Hook trust 是宿主状态，不能从项目文件推断。doctor 只读宿主配置中本项目条目（<code>hooks.state</code> 里 <code>hooks.json 绝对路径:事件:索引:索引</code> 形式的键），把它归为三态之一：<code>trusted-enabled</code>（已信任且启用）、<code>trusted-disabled</code>（已信任但被停用）、<code>untrusted</code>（没有本项目条目）；宿主配置缺失或解析失败时回退 <code>unknown</code>。宿主的 <code>trusted_hash</code> 属宿主状态，只用于判定是否存在信任记录，不进入任何输出。

无论哪一种三态，activation.status 都不等于「宿主已加载」：<code>trusted-enabled</code> 与 <code>untrusted</code>、<code>unknown</code> 输出 HOOK_ACTIVATION_UNVERIFIED，<code>trusted-disabled</code> 输出更具体的 HOOK_DISABLED，提示安全策略当前不生效。用户需在 Codex 中运行 <code>/hooks</code> 复核并启用当前定义。配置文件型宿主只报告 configured-unverified，不把文件存在描述为 runtime active。

宿主记录为 <code>trusted-enabled</code>、而已安装的 <code>.codex/hooks.json</code> 当前哈希与安装记录的 <code>targetHash</code> 不一致时（定义在安装后被改写，或由更新的 pack 渲染），<code>validate</code>、<code>doctor</code> 与 <code>install</code> 会追加 <code>HOOK_TRUST_REREVIEW_REQUIRED</code> 警告，文案写「可能要求重新信任」而不作因果断言——宿主的信任哈希算法无法从项目复现，这只是需要人工复核的信号。install 另外比较本次安装前后定义文件的哈希，因此「本次安装改写了定义、install-state 已同步」这种情况也能报出。宿主记录为停用、未信任或不可读时已有更具体的警告，不再叠加这一条。

## 跨宿主 fail-closed（hooks.enforcement）

`hooks.enforcement` 配置只取 `advisory`（默认，向后兼容）或 `strict`。它不改变 Hook 运行时的判定，只改变安装与诊断命令在「执行能力无法证明」时的结论；配置值由 schemas/project-config.schema.json 校验。

报告的 `runtimeHooks.envelopeSupport` 逐宿主给出高风险执行包络事实（`degraded`、`highRiskEnforcement`、`versions`）。声明 `envelopeVersions` 为空且 `highRiskEnforcement` 为 `unsupported` 的宿主，在任何模式下都附带 ENVELOPE_UNSUPPORTED 警告；该警告永远不阻断——「是否因此拒绝」是策略决定，不是事实陈述。

advisory 保持既有行为：HOOK_ENFORCEMENT_UNVERIFIED 只是提示（Hook 策略是纵深防御），安装与验证命令照常给出 ready；不含执行包络的宿主照常可装可验。

strict 把两类「声明 ≠ 执行」的缺口转为硬结论：

1. **未证明的 Hook 执行**：已安装 Hook 但 `enforced` 无法证明时，HOOK_ENFORCEMENT_UNVERIFIED 升级为阻断警告。`install`、`validate`、`doctor` 的状态从 ready 降为 degraded（exit 2），可用 `--allow-degraded` 显式越过（报告仍标注 degraded）；`verify` 没有 degraded 词汇，配置的检查全绿也判 invalid（exit 1）。宿主证据（激活、Envelope enforcement、sandbox、approval、process、network）齐备时该警告消失。
2. **红区写入拒绝**：strict 下的真实写入，若某个红区目标的所有投影宿主都未声明高风险执行包络（owner-union 判定：任一共有宿主可执行即不拒绝），安装直接拒绝且没有 bypass 旗标——配置值本身就是运维决定，救济路径只有去掉 unsupported 目标、去掉 hooks 相关模块，或改回 advisory。混合目标安装（既有可执行宿主也有 unsupported 宿主）因此不被拒绝，只按第 1 条对未证明的执行报 degraded。

一句话：advisory 如实报告「宿主没有执行包络」但不改变行为；strict 要求命令结论与执行能力一致，宁可拒绝也不给出 ready 或通过。当前没有任何宿主真实注入 hostEvidence，strict 项目的常态因此是 degraded/invalid，直到 TD-2026-09-18-1 的宿主证据通道落地。

## 配置与超时

安全事件在宿主侧的 timeout 为 10 秒，受管运行时另保有 5 秒内部预算（见「失败契约」）；运行时固定为 guarded，并在无法安全判定时 fail-closed。项目配置只允许收紧出口 allowlist 和额外 red-zone，不提供运行模式或写入根配置。

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

<code>doctor</code> and project <code>validate</code> report <code>supported</code>, <code>configured</code>, <code>activated</code>, <code>enforced</code>, <code>envelopeSupport</code>, <code>executionAuthority</code>, and <code>coverageLimitations</code>. <code>activated</code> remains null when project files cannot prove host runtime state. <code>enforced</code> becomes true only when the host independently proves Hook activation, required Envelope enforcement, sandbox, approval, process isolation, and network control. Adapter capability support never substitutes for this per-task evidence. Legacy activation, declaredEvents, pathResolution, and selfCheck fields remain available for compatibility.

Repository configuration can only tighten policy. Runtime mode is always guarded, write roots are not expanded by project configuration, configured red-zone paths are added to the built-in control-plane list, and an egress allowlist narrows permitted hosts. Repository-local install state records installation history but is not an authorization root.

Direct writes to vibe-harness.config.json, .vibe-harness/install-state.json, managed Hook runtime files, or adapter Hook/MCP configuration are denied. Update these files only through a transactional Vibe-Harness installer operation with the required write and red-zone confirmation flags.

Git Hook diagnostics inspect the active core.hooksPath and confirm that both pre-commit and pre-push scripts call the managed security runtime. Husky v9 paths such as .husky/_ are resolved to their project scripts rather than treated as conflicts.

## Git Hooks

full profile 仍可安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。Vibe-Harness 不会因为安装这些文件而执行提交或推送。

## 安装

<code>pnpm vibe-harness install --project &lt;project&gt; --target codex --profile full --write --confirm-red-zone</code>
