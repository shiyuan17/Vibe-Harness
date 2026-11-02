# Hook 安全策略

Vibe-Harness Hook 只执行项目级安全策略，并叠加一道只读门禁：已冻结的验收测试资产不能被改写。它不创建任务状态、不运行测试、不检查交付文本、不在 Stop 时提交，也不执行 git push。

## 事件能力矩阵

事件与激活方式以 manifests/adapters.json 的 hookEvents 和 hookActivation 为单一事实源。

| 宿主 | PreToolUse | PermissionRequest | Stop | 激活方式 |
| --- | --- | --- | --- | --- |
| Codex | stable | not-projected | not-projected | manual-trust |
| Claude Code | stable | stable | not-projected | config-file |
| Gemini | unsupported | unsupported | unsupported | unsupported |
| Cursor | stable | unsupported | unsupported | config-file |
| Qoder | stable | stable | unsupported | config-file |
| ZCode | stable | stable | unsupported | config-file |
| Antigravity | preview | unsupported | unsupported | config-file |
| OpenCode | unsupported | unsupported | unsupported | unsupported |

PreToolUse 阻止危险 Git、全局 Agent 配置写入、凭据外传、红区文件上传、项目边界外写入、控制面直写与冻结测试资产写入。仍投影 PermissionRequest 的宿主对相同硬边界执行拒绝；其他审批仍由宿主控制。Codex 只投影 PreToolUse：同一调用不再同时启动 `PreToolUse` 与 `PermissionRequest` 两个 Hook 进程，升级安装会清理旧版受管 `PermissionRequest` 条目。

Codex 投影的 PreToolUse <code>matcher</code> 为 <code>.*</code>，即对宿主上报的每个工具名求值（不再枚举 Bash、Edit、Write、ApplyPatch、apply_patch 与 mcp__.*）：宿主新增的工具不会因为不在枚举里而静默跳过策略。宿主把含正则元字符的 matcher 按未锚定的 JavaScript 正则求值，这与 Claude Code 文档中的匹配路径一致，也正是选择 <code>.*</code> 而不是依赖 <code>*</code> 特殊语义的原因。

`not-projected` 与 `unsupported` 不是同一个结论：`not-projected` 表示宿主支持该事件、但本项目不安装对应 Hook（Codex 与 Claude Code 的 Stop 属于此类，宿主侧另有项目记录过 Stop 信任），`unsupported` 表示该宿主没有这一能力入口。Vibe-Harness 不在 Stop 时 commit 或 push，因此不投影该事件；这既不表示宿主缺少该事件，也不表示缺少它的项目失去了 Stop 防护以外的任何策略。

manifest 的 `hookEvents` 与 `hookActivation` 是事件能力的单一事实源（`manifests/adapters.json`）。取证状态记录在每条 adapter 的 `evidence` 字段：Codex 声明已在 hostVersion 0.147.0 上于 2026-09-15 核对；其余宿主的 `lastVerifiedAt` 与 `hostVersion` 仍为空，表示「声明存在但本轮未在真实宿主上复核」，不得读作已验证。

## 判定分级

只读与无副作用判定由 runtime/hooks/lib/read-only-commands.mjs 单点提供，policy.mjs 与 execution-effects.mjs 共同引用。分类用于独立安全规则，不充当授权凭证。判定按「可执行名 + 子命令动词」两级进行：

| 类别 | 判定 | 出口 |
| --- | --- | --- |
| PowerShell 与 Unix 只读 cmdlet（Get-ChildItem、Select-Object、Where-Object、Sort-Object、ForEach-Object、ConvertFrom-Json、Format-Table、Group-Object、Out-String、jq、rg 等） | 无副作用 | 允许 |
| 宿主与基础设施 CLI 的只读子命令（codex 的 --version 与 --help、kubectl get、docker compose ps、terraform plan、aws list- 等） | 无副作用 | 允许 |
| Git 只读与同步命令（`git fetch`、`git ls-remote`、`git stash list`、`git submodule status`、`git pull --ff-only`） | 无副作用（`pull --ff-only` 额外要求跟踪工作区干净） | 允许；脏工作区 `pull --ff-only` 以 `VIBE_HARNESS_SYNC_DIRTY_TREE` 拒绝，裸 `git pull` 判为 `workspaceWrite` |
| 解释器与工具链（node、python、pytest、go、cargo、dotnet、mvn、gradle、make、cmake、bundle、php 等） | workspaceWrite、standard | 允许，与既有 Node 工具链一致 |
| 本地宿主函数工具（view_image、update_plan、agent、spawn_agent、task、read_file，以及 read_thread、read_thread_terminal、list_threads、list_archived_threads、wait_threads、list_agents、list_projects、get_goal、get_handoff_status） | 无副作用 | 允许 |
| 写类子命令（delete、remove、apply、destroy、create 等）与未分类命令 | 高风险或无法判定 | 执行可识别的独立安全规则；不因未知分类本身拒绝，也不标为已验证只读；只读角色仍拒绝 |
| 危险 Git、全局 Agent 配置写入、凭据外传、红区上传、项目边界外写入、控制面直写、冻结测试资产写入 | 明确禁止 | 直接拒绝 |

Shell 分段与读写谓词同样来自该模块。`git pull --ff-only` 由 Hook 读取跟踪工作区状态：脏工作区以 `VIBE_HARNESS_SYNC_DIRTY_TREE` 拒绝，状态不可读以 `VIBE_HARNESS_SYNC_STATE_UNAVAILABLE` 拒绝；未跟踪文件仍受 Git 自身的覆盖保护。其他 pull 形式按实际写入语义执行独立检查。apply_patch 的载荷按补丁目标路径判定，不把文件内容当作 shell 命令。

本地宿主工具的显式名单仅描述已知分类。未列名或会改变宿主状态的工具不自动获得只读身份；仍按用户请求、宿主实际权限和角色上限行动，不要求额外项目级授权凭证。

MCP 工具先按「服务器 + 工具名」查合同表。codebase-memory-mcp 的已知只读查询与索引写入、项目写入、删除分别分类；未登记工具不猜测为只读。工具版本、安装与索引生命周期由用户或宿主管理。其他服务器沿用通用动词分类，所有调用继续执行可识别的独立安全规则。

拒绝输出保留稳定的英文 reasonCode（机器契约），message 使用中文并给出最小可行动作。普通提交支持消息文件、signoff、签名和经仓库身份核验的 `git -C`；普通当前分支同步可继续，高风险合并需通过宿主确认字段或用户确认环境标记；历史改写、绕过 Hook、跨仓目录与未知推送目标仍拒绝。

项目内的 .codex、.claude、.cursor、.gemini 目录不是全局 Agent 配置；只有位于家目录之下、紧跟家目录的配置目录才命中全局配置规则，读取这些目录不视为写入。宿主管理的 worktree 物化在家目录下的 `.codex/worktrees/<worktree>/<repo>`，该子树是检出而不是配置：以它为会话根时按该检出的项目边界、控制面与红区规则判定写入；豁免只覆盖字面量 `worktrees` 段，`~/.codex/config.toml`、`~/.codex/hooks.json`、`~/.codex/skills/**` 等仍命中全局配置规则，主检出会话跨根写该 worktree 仍按项目边界拒绝。

Gemini 与 OpenCode 的 Hook 机制不被支持（`hookActivation: unsupported`）。Gemini 在 `--allow-preview` 下仍会把 Hook 文件落到 `.agents/runtime/hooks/`，多宿主项目中这些文件也可能由其他目标共装，但它们不会被该宿主激活；OpenCode 不安装项目 Hook。OpenCode 的配置文件仍属于默认红区，其他已安装的 stable Hook 可在多宿主项目中保护这些路径；这不代表 OpenCode 自身拥有 Hook 防护。install／validate／doctor 对这种「文件已落盘、宿主不支持激活」的状态以 `HOOK_ACTIVATION_UNSUPPORTED` 警告按宿主归因透出，报告字段 `runtimeHooks.filesInstalled` 区分「文件在盘」与「宿主支持」。

## 冻结测试资产

受管任务锚点可以把一次缺陷修复的验收资产冻结起来。当 `.vibe-harness/tasks/` 下的锚点带有 `units[].testFreeze.paths` 且 `status: frozen` 时，PreToolUse 拒绝任何解析后命中这些路径（或其父目录）的写入：结构化编辑工具与 `*** Update/Add/Delete File:` 补丁头按目标拒绝；shell 命令拒绝「写形命令点名冻结资产」和「解析出的写入目标命中冻结资产」，写动词清单与只读分类共用 `read-only-commands.mjs` 的同一真值源（覆盖 `Remove-Item`、`Rename-Item`、`Clear-Content`、`rd`／`rmdir`、`sed -i`、`dd of=`、`rsync` 等），重定向按目标解析，解释器内联代码按交给文件 API 的字面路径判定，只经符号链接到达该资产的路径按真实路径拦截。因此运行与读取冻结测试始终可用（`node --test tests/frozen.test.js > node-test.log` 与 `… | tee report.txt` 都放行），而任何命中冻结资产的目标都拒绝。无法解析出目标的结构化写请求以 `FROZEN_TEST_WRITE_TARGET_UNKNOWN` 拒绝而不是放行，锚点不可读时以 `FROZEN_TEST_STATE_UNAVAILABLE` 拒绝；两者保持 fail-closed，因为被静默跳过的冻结没有第二道门禁兜底。命令行无法跟随的任意代码写入（未点名冻结资产）是已声明的覆盖边界，不宣称完整防护。

锚点本身属于控制面：对 `.vibe-harness/tasks/` 的直接编辑、补丁或 shell 写入以 `CONTROL_PLANE_WRITE` 拒绝，冻结不能通过改写记录它的文件来解除。该门禁只读；`run.mjs task freeze-tests` 是建立冻结的唯一写入方，`rebaseline-tests` 额外要求宿主受保护批准收据。它在 `hooks.mode = off` 的提前返回之前生效——off 关闭的是安全策略，不是已冻结的验收基线——并且不参与任务完成判定。

红区与控制面判定按解析后的真实路径匹配，项目内符号链接别名不再是绕过通道；无法解析出真实路径的候选保留字面路径，并由项目边界判定兜底拒绝。

## 路径解析

每条 Hook 命令使用跨平台 Node bootstrap：

1. 从宿主 session 的当前工作目录逐级向上查找首个含 <code>.git</code> 的目录（目录或文件均可，因此 worktree 与 submodule 各自解析到自己的检出）。
2. 从该根定位 <code>.agents/runtime/hooks/codex-hook.mjs</code>。
3. 使用 <code>process.execPath</code> 启动受管 Hook，并透传 stdin、stdout、stderr 和 Hook 参数；环境只传固定白名单（PATH、PATHEXT、SystemRoot、SystemDrive、TEMP、TMP、HOME、USERPROFILE、CODEX_HOME、<code>VIBE_HARNESS_PERMISSION_PRESET</code>）加解析出的 <code>VIBE_HARNESS_GIT_ROOT</code>，不透传宿主整份环境。
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

信任记录以「<code>hooks.json</code> 绝对路径 + 事件 + 索引」为键：把项目移动到新目录（或换一台机器）会让原信任记录落在旧路径上，新路径被判定为 <code>untrusted</code>；重新安装同样会重写定义文本，可能触发 <code>HOOK_TRUST_REREVIEW_REQUIRED</code>。两种情况都需在 Codex 中对该路径重新运行 <code>/hooks</code>，本项目只报告状态、不改写宿主配置。

同一原因，worktree 里的 <code>hooks.json</code> 路径（<code>&lt;worktree&gt;/.codex/hooks.json</code>）是**独立于主检出的信任键**：当 <code>worktree.mirrors</code> 把 <code>.codex</code> 投影进新 worktree 时，主检出的授权不会自动延伸到该 worktree，必须在那个 worktree 内单独运行一次 <code>/hooks</code>。<code>worktree bootstrap</code> 的收据对这种情况给出 <code>WORKTREE_HOOK_TRUST_REQUIRED</code> 警告；授权仍由人工在 Codex 侧完成。

宿主记录为 <code>trusted-enabled</code>、而已安装的 <code>.codex/hooks.json</code> 当前哈希与安装记录的 <code>targetHash</code> 不一致时（定义在安装后被改写，或由更新的 pack 渲染），<code>validate</code>、<code>doctor</code> 与 <code>install</code> 会追加 <code>HOOK_TRUST_REREVIEW_REQUIRED</code> 警告，文案写「可能要求重新信任」而不作因果断言——宿主的信任哈希算法无法从项目复现，这只是需要人工复核的信号。install 另外比较本次安装前后定义文件的哈希，因此「本次安装改写了定义、install-state 已同步」这种情况也能报出。宿主记录为停用、未信任或不可读时已有更具体的警告，不再叠加这一条。

## 跨宿主 fail-closed（hooks.enforcement）

`hooks.enforcement` 只取 `advisory`（默认）或 `strict`，由 schemas/project-config.schema.json 校验。它不改变 Hook 的独立安全判定。

`runtimeHooks.enforced` 只表示项目 Hook 已安装、观测到激活且自检通过；宿主 sandbox、approval、process、network 能力分别报告。配置存在不证明任何宿主权限已经生效。

`HOOK_ENFORCEMENT_UNVERIFIED` 在两种模式中都只是事实提示，不要求宿主证明、人工重载或降级豁免，不把通过的本地检查改判失败。

strict 保留两类已知安全缺口的阻断：

1. **已知禁用或自检失败**：`HOOK_DISABLED`、`HOOK_SELF_CHECK_DEGRADED` 为阻断警告，不把已知损坏表述为健康；这与仅缺少宿主观察不同。
2. **不支持 Hook 的红区投影**：真实写入仍按 owner-union 核对宿主原生 Hook 支持；所有归属宿主均不支持时拒绝。共有宿主支持 Hook 时不因其他宿主未知而拒绝共享投影。

安装一致性、本地检查和宿主激活分别报告；ready 或 passed 不等于宿主已激活，也不等于外部系统写入成功。

## 配置与超时

安全事件在宿主侧的 timeout 为 10 秒，受管运行时另保有 5 秒内部预算（见「失败契约」）。项目可在 `hooks` 中声明 `mode`、`profile` 和 `enforcement`；默认仍为 `guarded + standard + advisory`，无法安全判定时 fail-closed。

`hooks.mode`：

| mode | 普通策略风险 | 安全硬边界 |
| --- | --- | --- |
| `guarded`（默认） | 按风险等级允许、告警或拒绝 | 拒绝 |
| `observe` | 降为 warning 或 telemetry，不阻断 | 拒绝 |
| `off` | 不评估普通策略 | 冻结测试资产门禁、凭据保护、Git 交付检查与角色权限仍然生效 |

`hooks.profile`：

| profile | 保留范围 |
| --- | --- |
| `minimal` | 只保留硬边界；普通红区、文档命名、非关键 push 策略、TODO/console 等记为 telemetry-only，不注入模型上下文 |
| `standard`（默认） | 普通策略按 guarded/observe 语义处理 |
| `strict` | 即使 `mode=observe`，普通风险仍阻断 |

安全硬边界包括凭据/密钥外传、项目边界外写入、明显破坏性 Git、全局 Agent 配置修改、冻结测试写入、控制面直写与角色权限违规。普通非 allowlist 网络访问不是硬边界：它只在 guarded/standard 下按普通策略处理，真正的凭据外传仍由 `CREDENTIAL_EXFILTRATION` 拒绝。

每次决策向 `.git/vibe-harness/hooks/telemetry.jsonl`（worktree 通过 Git common dir 共享）追加一行记录，包含稳定 hook id、host、event、mode/profile/enforcement、action、reasonCode、`wouldBlock`、`suppressed`、耗时和错误；不记录工具参数、命令正文或敏感环境值。设置 `VIBE_HARNESS_HOOK_TELEMETRY=0` 可关闭该记录。项目配置仍不能扩大写入根，出口 allowlist 和额外 red-zone 只会收紧策略。

网络出口默认允许普通依赖和 Git 操作，但始终阻止凭据引用与红区文件上传。非空 allowlist 是能力授予，不是内容安全保证。


## 授权机制迁移

Execution Envelope 已全局移除，不提供替代授权凭证或 Broker。旧请求字段、环境变量和系统兼容文件不再参与判定，也不再签发或校验；历史文件不由安装器删除。用户请求、宿主原生权限与服务端权限决定可执行范围。

Linear 建单、更新、评论、关系和删除不再要求预登记 Issue、Team 或 Project；仍需遵循用户范围、写入后确认和超时查重。未知工具不能被标为已验证只读，但不会仅因无法分类而拒绝。角色只读、红区、项目边界、凭据泄露及落盘、破坏性 Git、冻结测试与 Hook 故障检查继续生效。

不再提供原有跨边界效果、目标和会话绑定防护，不能宣称同等安全性。OCR 入口仅检查模型端点配置，成功返回 `OCR_PREFLIGHT_READY`、`executed: false`，不启动 OCR 或代表评审完成。实际外发仍受用户授权和宿主权限约束。

升级先 dry-run，通过事务式安装器按哈希退役旧受管模块与 schema；用户改动文件保留并报告冲突。本变更以安装迁移、源码和本地测试为验收依据，不追加宿主重载或外部系统确认；未迁移的旧副本仍按冲突报告，不能表述为新机制已生效。回滚使用安装备份，不修改全局配置。

完成口径：Envelope 已移除，Linear 不再被项目级 Envelope 阻断；真实外部系统状态不作为本变更验收项，不要求用户重试或提供外部写入证明，也不列为后续待办。验收覆盖本地实现、安装迁移、Hook 测试、Linear 模拟回归和 Eval。真实调用失败按工具返回的权限、网络或服务端错误处理，不撤销已验证的本地交付；没有成功结果不得声称 Linear 已同步。

## Security boundary and diagnostics

Hooks are defense in depth, not a complete machine-security boundary. Command-string inspection cannot reliably interpret arbitrary PowerShell, Python, Node.js, package-manager, Git, subprocess, or network behavior. File-system isolation, process isolation, approval enforcement, and egress control must be provided and independently verified by the host sandbox and network proxy.

<code>doctor</code> and project <code>validate</code> report <code>supported</code>, <code>configured</code>, <code>activated</code>, <code>enforced</code>, <code>executionAuthority</code>, and <code>coverageLimitations</code>. <code>activated</code> remains null when project files cannot prove host runtime state. <code>enforced</code> becomes true only when the managed Hook is configured, independently confirmed active, and its self-check passes. This describes project Hook enforcement only, not machine-wide isolation. Native sandbox, approval, process, and network evidence are reported separately. Adapter capability support never substitutes for this per-task evidence. Legacy activation, declaredEvents, pathResolution, and selfCheck fields remain available for compatibility.

Repository configuration can lower ordinary policy friction through `hooks.mode` and `hooks.profile`, but it can never widen a write root, disable a hard safety boundary, or turn an unverifiable decision into an allow. Configured red-zone paths are added to the built-in control-plane list, and an egress allowlist narrows permitted hosts. Repository-local install state records installation history but is not an authorization root.

Direct writes to vibe-harness.config.json, .vibe-harness/install-state.json, managed Hook runtime files, or adapter Hook/MCP configuration are denied. Update these files only through a transactional Vibe-Harness installer operation with the required write and red-zone confirmation flags.

Git Hook diagnostics inspect the active core.hooksPath and confirm that both pre-commit and pre-push scripts call the managed security runtime. Husky v9 paths such as .husky/_ are resolved to their project scripts rather than treated as conflicts.

## Git Hooks

full profile 仍可安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。Vibe-Harness 不会因为安装这些文件而执行提交或推送。

## 安装

<code>pnpm vibe-harness install --project &lt;project&gt; --target codex --profile full --write --confirm-red-zone</code>
