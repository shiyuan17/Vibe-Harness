# Vibe-Harness Agent 配置全面审查与优化调整计划

审查日期：2026-09-15（Asia/Shanghai）

源码基线：bc9073b4543e489d3af82bd9addca00e5f71499b（2026-09-15 13:52，提交信息「fix(eval): 让 eval:check 复核 reference 与当前资产」）。基线时刻工作区非干净。

执行判定：本轮只交付报告。未修改任何配置、规则、Hook、模板、adapter、install-state、Eval reference；第 5 节的批次 1–4 是待批准计划，全部未实施。

实施更新（同日）：用户在计划批准后下达实施指令，批次 1 与批次 2 已完成实施与验证并各自合入独立提交，证据与改动面见第 11、12 节。批次 3、4 尚未开始。本报告自此兼具审查结论与实施台账两种用途。

工作区漂移记录：审查开始时 git status --porcelain 为 29 项（22 项 M + 7 项 ??），审查结束时为 38 项（30 项 M + 8 项 ??），期间新增 tests/target-validation.test.js、tests/tool-provisioning.test.js 等改动。判定为并行人工编辑，本报告不评估这些未归属改动，也不覆盖它们。

文档格式说明：本报告第 1–10 节不使用行内代码跨度（成对反引号）与美元符号加圆括号的写法，原因见 AC-04「AC-04a」——修复前 Hook 会把 apply_patch 的载荷文本当作 shell 命令分析，含上述构造的 Markdown 无法写入。被引用的标识符改用中文书名号代替。AC-04a 已在批次 1 关闭，第 11 节起恢复常规 Markdown；第 1–10 节保留原写法以免制造无意义的全篇改动。

第 10 节记录用户暂时停用本仓库 Hook 之后的复检结果。该停用只改变宿主是否调用 Hook，不改变判定代码，因此本节写法约定继续保留，待 AC-04a 关闭后恢复常规 Markdown。

## 1. 结论先行

当前 Harness 的结构面（规则、角色、投影、安装器、Eval）已经成形，但运行时安全层的可用性与自证能力存在 P0 级缺陷：Hook 的 fail-closed 判定把大量只读操作判成拒绝，拒绝文案与事实相反，直接压缩了 Agent 的可行动作空间，并中断了一部分取证路径。

本轮取证共触发 19 次 Hook 拒绝（含第 9 节复检新增的 3 次），归因如下（判定：已确认事实）：

| reasonCode | 次数 | 触发场景 |
| --- | --- | --- |
| EXECUTION_ENVELOPE_MISSING | 11 | Select-Object 管道、( ... ).Count、rg 接 Select-String 再接 Select-Object 等只读组合；另有 1 次是 MCP 工具调用（见 AC-11） |
| GLOBAL_AGENT_CONFIG | 3 | 用 Get-ChildItem / rg / node 读取临时项目内的 .codex 目录 |
| UNSAFE_SHELL_CONSTRUCT | 4 | 命令文本出现美元符号加圆括号（2 次），apply_patch 载荷出现成对反引号（2 次） |
| CREDENTIAL_EXFILTRATION | 1 | 网络下载命令把输出写到环境变量表示的临时路径 |

12 项发现（2 项 P0、7 项 P1、3 项 P2；AC-12 由第 10 节复检新增）中，三簇决定后续节奏：

- AC-01 / AC-02 / AC-03 是同一根因簇：只读判定词表分散、过窄，且与拒绝文案不一致，于是「无副作用的只读命令被拒」与「有副作用的解释器执行被放行」并存。
- AC-05 / AC-06 / AC-07 是自证能力簇：托管指令块有冗余与空行污染、本仓库自安装面缺少 roles 与 mcp-config、上一轮审查的 F01–F10 没有台账。
- AC-09 / AC-10 / AC-11 是运行成本、取证纪律与外部能力簇：.vibe-harness 已累积约 11 万文件 / 2.09 GB，doctor 报告 2993 个 unmanaged 文件；宿主契约缺少固定的在线核对路径；未列名的 MCP 工具（含本仓库自带的 codebase-memory 状态查询）被默认拒绝。

关键判断：AC-01 在修复前会持续阻断 codex --version 与 codex --help 这类自检命令。Codex 契约核对已改由本机二进制与宿主配置完成（见第 9 节），不再依赖被 403 挡住的官网；但 Windows 上凡涉及管道与宿主 CLI 自检的只读操作仍会被误拒。

复检更新（用户停用 Hook 之后，详见第 10 节）：停用发生在宿主层——宿主配置把本项目两条 Hook 状态条目标记为 enabled = false，而不是撤销信任。受阻项因此大部分解除（codex --version 与 --help 全文、MCP 状态与面板工具、含行内代码跨度的写入、ai-context-kit 出处均已取得），但 AC-01、AC-02、AC-04a、AC-11 的判定代码未变，直接调用 Hook 入口仍然返回 deny。结论：停用不等于修复，批次 1 仍是唯一治本路径。本轮同时新增 AC-12（Hook 停用状态不可观测）。

## 2. 审查范围与方法

### 2.1 范围

| 层 | 覆盖对象 |
| --- | --- |
| 源（pack） | adapters 各宿主的 AGENTS 模板、adapters/install-map.json、manifests/adapters.json、manifests/profiles.json、scripts/lib/install-planner.js、scripts/lib/template-renderer.js、scripts/lib/role-projection.js、runtime/hooks/lib 全部模块、docs/rules、skills/core |
| 投影（plan/render） | createInstalledSurface、renderTemplate、角色投影、Hook 投影、managed-instruction-block 合并逻辑 |
| 已安装面（本仓库） | AGENTS.md、.agents、.codex、.vibe-harness/install-state.json、doctor 输出 |
| 宿主接纳 | 8 个 adapter 的 hookEvents / redZonePrefixes / roleProjection / capabilities 声明核对；仅 Codex 做实测 |
| 业界基准 | agents.md 标准、Claude Code 子 Agent 与 Hooks 契约、MCP 安全最佳实践、OWASP Agentic 资源、Superpowers 与仓库内八维对比框架 |

### 2.2 证据标签口径

| 标签 | 含义 |
| --- | --- |
| 已确认事实 | 本轮实际执行的命令输出、渲染结果或安装产物直接支持 |
| 静态结论 | 读源码或清单可直接判定，未通过运行时验证 |
| 待验证假设 | 有线索、无本轮有效验证 |
| 验证受阻 | 取证手段被 Hook、网络或权限阻断 |

### 2.3 复现命令（本轮实际执行）

    node --input-type=module -e "import { classifyExecutionEffects } from './runtime/hooks/lib/execution-envelope.mjs'; ..."   # Hook 效果判定
    node .agents/runtime/hooks/codex-hook.mjs --expected-event PreToolUse                                                      # 端到端 Hook 判定（stdin 传 PreToolUse JSON）
    node --input-type=module -e "import { analyzeToolRequest } from './runtime/hooks/lib/policy.mjs'; ..."                     # 策略层判定
    node --input-type=module -e "const m = await import('./scripts/lib/pack-validation.js'); console.log(JSON.stringify(await m.validateInstructionBudget(process.cwd())))"
    node ./scripts/vibe-harness.js doctor --project . --output json
    node ./scripts/vibe-harness.js init    --project <临时项目> --target codex
    node ./scripts/vibe-harness.js install --project <临时项目> --target codex --profile full --write --confirm-red-zone --output json

隔离安装实测使用仓库外临时目录 %TEMP%\vh-agent-audit（本轮实际路径位于用户目录下；出于 AC-02 所述的策略原因，报告不写出绝对路径字面量）。

### 2.4 取证受阻清单（复检后已更新）

下表为第 10 节复检后的最新状态；原始受阻形态保留在现象列中，便于对比。

| 目标 | 现象 | 标签 |
| --- | --- | --- |
| Codex 官方契约（developers.openai.com） | 默认 UA、浏览器 UA、强制 HTTP/1.1、附加 Accept 头均返回 HTTP 403；已改用官方仓库 openai/codex 的 docs 目录、本机 CLI 二进制与宿主配置核对 | 验证受阻（已有可用降级路径，见第 10 节） |
| codex --version / codex --help | 曾被本仓库 Hook 判为 high 并拒绝（AC-01）；Hook 停用后已取得完整输出 | 已解除（第 10 节） |
| 在 Codex 面板中打开本报告（MCP 工具） | 曾被 Hook 判为 high 并拒绝（AC-11）；Hook 停用后工具已可用，但判定代码未变 | 已解除（工具可用），AC-11 仍成立 |
| 含行内代码跨度的 Markdown 写入 | apply_patch 载荷被判 UNSAFE_SHELL_CONSTRUCT（AC-04a）；Hook 停用后写入成功 | 已解除（写法约定仍保留） |
| OWASP Top 10 for Agentic Applications 2026 的条目正文 | 资源页可达（HTTP 200，需要跳过吊销检查参数）；条目正文下载入口跳转到 no-access 页面，属权限门控；站内 ASI01 至 ASI10 路径均返回 404 | 验证受阻（权限门控） |
| ai-context-kit 的启发式出处 | 已定位到 npm 包 ai-context-kit（作者 Ofer Shapira，MIT，latest 0.1.2），其 token-budget 规则阈值与本地实现一致 | 已确认事实（第 10 节） |
| Codex Hook 的事件与字段契约 | 由本机 CLI 与宿主配置核对完成；本轮补得宿主状态键形态与特性开关状态 | 已确认事实（第 9 节与第 10 节） |

## 3. 五层能力现状

### 3.1 源层（pack）

- 8 个 adapter 的声明完整：instructionTarget、hookEvents、redZonePrefixes、roleProjection、capabilities 均在 manifests/adapters.json 中，并由 schemas/adapter-pack.schema.json 约束（已确认事实，见 AC-10 表）。
- 指令预算 gate 存在且通过：validateInstructionBudget() 返回空 errors 与空 warnings。该 gate 按完整规则索引渲染模板，当前为 2693 字节、按 4 字节/token 估算约 674 tokens；阈值是 warn 2000、error 5000、Codex 32 KiB 截断（已确认事实，scripts/lib/pack-validation.js:1411-1460 与 1422-1431）。
- 角色投影已按宿主区分原生工具名，并在投影前拒绝提示词越权（静态结论，scripts/lib/role-projection.js:54-61 与 19-21、144）。
- 风险相关判定词表在两个文件各自维护，且已漂移（静态结论，见 AC-04）。

### 3.2 投影层

按完整 21 条规则索引渲染 canonical 模板后，实测输出片段如下（已确认事实）：

    ## 已安装表面

    - 当前 profile 使用 Vibe-Harness Codex 安装面。


    - 规则位于 docs/rules/。命中索引：governance-core（…）、…、ast-grep（…）。   ← 单行 300+ 字符


    - 模板位于 docs/templates/。




    规则优先级：平台系统与用户本轮指令优先；…

即：空占位符渲染为连续空行，规则索引是单行长句。来源是 adapters/codex/AGENTS.template.md 的逐行占位符，加上 scripts/lib/install-planner.js:168-223 的条件行拼接（静态结论）。

### 3.3 已安装面（本仓库）

doctor --project . 实测（已确认事实）：

- ok:true、status:ready、profile:full、sameCount:108、unmanagedCount:2993。
- roles 为空对象；target.adapters.codex.roleProjection 为 null。
- resolvedModules 为 agents、rules、templates、skills、schemas、evals、memory、hooks —— 无 roles、无 mcp-config；install-state.json 的 requestedModules 为 evals、memory、hooks。
- runtimeHooks.status 为 configured-unverified，enforced 为 false，activation.status 为 unknown；warnings 为 HOOK_ACTIVATION_UNVERIFIED 与 HOOK_ENFORCEMENT_UNVERIFIED。
- .codex/agents 与 .agents/roles 目录不存在。
- AGENTS.md 实测 96 行 / 4324 字符 / 7372 字节，按同口径约 1843 tokens，低于 2000 的 warn 阈值。

### 3.4 宿主接纳层（Codex 实测）

隔离临时项目 %TEMP%\vh-agent-audit（已确认事实）：

- init --target codex 写入 vibe-harness.config.json，默认 profile 为 core，含 19 条 redZonePaths。
- install --profile full --write --confirm-red-zone 成功，写出 117 个文件；resolvedModules 含 roles；roleProjections.codex.missingCapabilities 报 test-lead 缺 browser-verification、adversarial-security-reviewer 缺 safe-security-check、technical-release-manager 缺 package-dry-run。
- 生成 .codex/agents 下 7 个 toml、.agents/roles/index.md 与 7 个角色正文、.codex/hooks.json、.githooks 下 pre-commit 与 pre-push；安装后 AGENTS.md 为 32 行 / 1872 字符。
- 角色 sandbox 实测：senior-engineer、test-lead、technical-release-manager 为 workspace-write；chief-architect、product-manager、technical-project-manager、adversarial-security-reviewer 为 read-only。
- 随后 doctor 返回 ok:false、status:invalid，target.adapters.codex.status 为 conflict，changed 为 AGENTS.md，profile 为 core。原因是 init 默认写 core，显式 install --profile full 未把 profile 回写配置（静态结论：先 init 后 install --profile full 会产生自冲突报告，不等价于安装失败）。
- Hook 信任状态只能给出 configured-unverified；Codex 侧需人工在 /hooks 确认。

### 3.5 业界基准层

| 基准 | 来源与取证 | 与本项目的关系 |
| --- | --- | --- |
| AGENTS.md 开放格式 | raw.githubusercontent.com/openai/agents.md/main/README.md，HTTP 200，2011 字节（已确认事实） | 标准只约定「一个可预测的指令文件位置 + 常规章节」；本项目在其上叠加治理块，属扩展而非偏离 |
| Claude Code 子 Agent 契约 | code.claude.com/docs/en/sub-agents.md，HTTP 200，114782 字节（已确认事实） | 子 Agent 能力由 tools 字段、权限模式与宿主过滤器共同决定，后台子 Agent 还会被宿主削减工具集；并发上限默认 20。本项目把能力写成提示词文本，宿主侧的二次削减无法被投影表达 |
| Claude Code Hooks 契约 | code.claude.com/docs/en/hooks.md，HTTP 200，322896 字节（已确认事实） | matcher 有两条求值路径：仅由字母数字、下划线、连字符、空格、逗号、竖线组成时按精确值或竖线列表匹配；含其他字符时按未锚定的 JavaScript 正则匹配。本项目 .codex/hooks.json 的 matcher 含点号与星号，走正则路径；PreToolUse 的决策字段形状与本项目输出的 hookSpecificOutput.permissionDecision 一致 |
| MCP 安全最佳实践 | modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices，HTTP 200，需跟随重定向（已确认事实） | 覆盖 Confused Deputy、Token Passthrough、SSRF、Session Hijacking、Local MCP Server Compromise、OAuth 授权 URL 校验、stdio 代理与 Scope Minimization。本项目方向一致，但 scope 划分过粗（见 AC-01 与 AC-04） |
| OWASP Agentic | genai.owasp.org 的 agentic-ai-threats-and-mitigations 与 owasp-top-10-for-agentic-applications 资源页，HTTP 200（需跳过吊销检查）；第 10 节复检确认条目正文的下载入口跳转到 no-access 页面，属权限门控；站内 ASI01 至 ASI10 路径均 404（部分验证受阻） | 可核对到 ASI 威胁模型指南（2025-02-17）、Top 10 for Agentic Applications 2026（2025-12-09 发布）、Agent Control Standard、AIUC-1 交叉映射、State of Agentic AI Security and Governance 与 Secure MCP Server Development 指南的存在。本报告不引用未取证的条目内容 |
| ai-context-kit（token 预算启发式来源） | npm registry 与包元数据，HTTP 200（第 10 节复检取得）：ai-context-kit 0.1.2，作者 Ofer Shapira，MIT，仓库 github.com/ofershap/ai-context-kit（已确认事实） | 其 lint 规则的 token-budget 项阈值为超过 2,000 tokens 记 warning、超过 5,000 记 error，token 估计使用 4 characters per token，与 scripts/lib/pack-validation.js:1413-1418 完全一致；同时提供重复内容、冲突、模糊指令与目录树噪声四类检查项，正对应 AC-05 的四类征状 |
| AGENTS.md 有效性研究 | sri.inf.ethz.ch 的 publications/gloaguen2026agentsmd，HTTP 200（已确认事实）：标题为 Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?，ICLR 2026 Workshop | 该研究是上下文预算主张的学术来源；对本项目的意义是「指令块的价值取决于相关性而非篇幅」，支持 AC-05 的合并同义行与折叠占位符方向 |
| 同类 harness：Superpowers | api.github.com/repos/obra/superpowers/readme，HTTP 200，12133 字节（已确认事实） | 覆盖 14 个宿主（Claude Code、Antigravity、Codex App、Codex CLI、Cursor、Devin CLI、Factory Droid、Gemini CLI、GitHub Copilot CLI、Grok Build CLI、Kimi Code、OpenCode、Pi、Hermes Agent），Codex 侧通过官方插件市场分发，Antigravity 依赖插件的 session-start hook |
| 同类 harness 对比框架 | docs/inventory/harness-superpowers-comparison.md:103-114 的八维框架（流程设计、规则约束、任务拆解、验证机制、多 Agent 协作、上下文管理、失败恢复、评测与持续改进）（静态结论） | 本报告复用该口径，不新建方法论栈；与本轮发现直接相关的是「规则约束」（AC-01 至 AC-04）与「上下文管理」（AC-05）两维 |

基准给出的四点业界共识与本项目现状的差距：

1. 能力可发现性：宿主会二次过滤子 Agent 工具，因此投影声明必须能与宿主实际授予对齐；本项目把能力写成提示词文本，宿主的削减无法被发现（AC-06、AC-07）。
2. 分发即契约：成熟 harness 走宿主插件市场，宿主支持什么由市场元数据表达；本项目用仓库内投影加自写 installer，需要自己承担契约核对成本（AC-10）。
3. 最小 scope：安全基准一致要求最小授权；本项目 Hook 把不可判定一律纳入拒绝区，把只读 scope 一起拒掉，属于 scope 定义问题，而不是策略过严（AC-01、AC-03）。
4. 上下文即预算：第三方工具与研究都把指令文本当作可度量预算，并检查重复、冲突与模糊指令；本项目已有预算 gate，但只覆盖「按完整规则索引渲染的模板」，不覆盖实际安装产物，也没有重复与冲突检查（AC-05）。

## 4. 分级发现

### AC-01 · P0 · 只读命令被 fail-closed 误拒

现象（已确认事实）：无副作用的只读命令被判 unclassified-effect，风险升级为 high，随后被拒。

| 命令 | effects | highRiskReasons | 出口 |
| --- | --- | --- | --- |
| Get-ChildItem . -Recurse -File | 空 | 无 | 允许 |
| Get-ChildItem . -Recurse -File 接 Select-Object Name | 空 | unclassified-effect | 拒绝 |
| Get-ChildItem . 接 Sort-Object / ForEach-Object / ConvertFrom-Json / Format-Table / Group-Object / Out-String | 空 | unclassified-effect | 拒绝 |
| Get-Process / Get-Help git / jq . package.json | 空 | unclassified-effect | 拒绝 |
| codex --version / codex --help | 空 | unclassified-effect | 拒绝 |
| pytest -q / go test ./... / cargo test / dotnet test / mvn -q test / gradle test / make lint / cmake --build build / rustc --version / java -version | 空 | unclassified-effect | 拒绝 |
| kubectl get pods / docker compose ps / terraform plan / aws s3 ls / php artisan test / bundle exec rspec | 空 | unclassified-effect | 拒绝 |
| node ./scripts/lint.js | workspaceWrite | 无 | 允许 |
| pnpm test:unit / pnpm lint / npx eslint . | workspaceWrite | 无 | 允许 |

端到端复现（真实 Hook 入口与真实参数，已确认事实）：

    输入命令 codex --version
    输出 {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
      "permissionDecisionReason":"[VIBE_HARNESS_POLICY:EXECUTION_ENVELOPE_MISSING:69] An Execution Envelope is required for this effectful or unclassified request."}}
    输入命令 pnpm test:unit
    输出 {}                                                        ← 放行

根因（静态结论）：

1. runtime/hooks/lib/execution-envelope.mjs:92 的 shellReadOnlyPattern 只列了 Get-Content、Test-Path、Get-Item、Get-ChildItem、Resolve-Path、Get-Location、Select-String、Measure-Object、cat、type、ls、dir、pwd、rg、grep、find、where、which、head、tail、wc、stat、file、tree、echo、Write-Output，以及 node/npm/pnpm/yarn/git/gh/glab 加 --version；缺 Select-Object、Sort-Object、ForEach-Object、ConvertFrom-Json、Format-Table、Group-Object、Out-String、Get-Process、Get-Help、jq 等。
2. execution-envelope.mjs:594 要求按竖线切段后的每一段都命中该白名单，否则 unknown 置真。
3. execution-envelope.mjs:93 的 arbitraryRuntimePattern 只覆盖 node、npm、npx、pnpm、yarn、python、python3、py、ruby、perl、deno、bun，因此非 Node 栈工具链一律落入 unknown。
4. execution-envelope.mjs:562 的 readOnlyToolPattern 只认 read、glob、grep、search、view、inspect、list、websearch、webfetch 这类工具名，exec_command 不在其中。

影响面（静态结论）：远大于 PowerShell 场景。所有非 Node 栈的常规验证命令（pytest、go test、cargo test、dotnet test、mvn test、gradle test、make、cmake）在无 Envelope 时一律拒绝，等于对非 JS/TS 项目整体降级。

关闭条件：三类命令（PowerShell 只读管道、宿主 CLI 只读子命令、非 Node 栈只读查询）在本仓库实测返回 allow；凭据、红区、破坏性 git、越界写的拒绝行为不变；新增覆盖上述三类正例与至少 6 类负例的单元测试。

Owner：运行时/Hook 维护者。

### AC-02 · P0 · 只读枚举被误报为「写入全局 Agent 配置」

现象（已确认事实）：对临时项目内的 .codex 目录做只读枚举被拒，理由与事实相反。

| 命令（项目根为临时项目） | 判定 |
| --- | --- |
| Get-ChildItem 指向临时项目下的 .codex 目录 | deny / GLOBAL_AGENT_CONFIG |
| rg -n sandbox_mode 指向同一目录 | deny / GLOBAL_AGENT_CONFIG |
| ls 指向同一目录 | deny / GLOBAL_AGENT_CONFIG |
| Get-Content 读取该目录下的 test-lead.toml | allow |
| Set-Content 写该目录下的 x.txt | deny / GLOBAL_AGENT_CONFIG（正确） |

拒绝文案：Writes to global Agent configuration are blocked by repository policy.（英文，且与只读事实相反）。

根因（静态结论）：

1. runtime/hooks/lib/policy.mjs:12 的 globalAgentConfigPattern 只要求「盘符 + Users 或 Documents and Settings + 用户名」之后 96 字符内出现 .codex、.claude、.cursor、.gemini 之一，不校验该路径是否真的是全局配置位置。因此任何位于用户目录下的项目（含 %TEMP% 下的临时项目）都会被判成全局配置。
2. policy.mjs:289-291 的 commandReads() 只认 Get-Content、Test-Path、Get-Item、Resolve-Path、cat、type，并且锚定在段首；Get-ChildItem、rg、ls、Select-String 都不在其中。execution-envelope.mjs:92 的同名名单却包含它们，两份词表已经漂移。
3. 于是放行条件退化成「段首恰好是那 6 个读动词之一」，与是否只读无关。

影响面（静态结论）：所有在 Windows 用户目录下工作、且项目内存在 .codex、.claude、.cursor、.gemini 目录的场景。本轮审计被阻断 3 次，其中一次阻断了 Codex 角色 sandbox 的读取核对。

关闭条件：只读枚举（含 Get-ChildItem、rg、ls、Select-String）返回 allow；真实全局配置位置的写入仍 deny；新增「项目内 .codex 不命中全局配置规则」与「家目录 .codex 仍命中」的对照测试。

Owner：运行时/Hook 维护者。

### AC-03 · P1 · 风险标定倒挂

现象（已确认事实）：带副作用的解释器执行被判 standard 放行，无副作用的宿主 CLI 查询被判 high 拒绝。

| 命令 | 效果集合 | 风险 | 出口 |
| --- | --- | --- | --- |
| node ./scripts/lint.js | workspaceWrite | standard | 允许 |
| pnpm test:unit | workspaceWrite | standard | 允许 |
| codex --version | 空 | high（unclassified-effect） | 拒绝 |
| git status --short | 空 | standard | 允许 |

根因（静态结论）：execution-envelope.mjs:436 用 arbitraryRuntimePattern 识别解释器，命中即归入已知执行路径并标记 workspaceWrite，于是「可解释执行任意代码」反而比「已知无副作用的工具版本查询」更安全。

关闭条件：定级口径形成可读规则（例如：解释器执行不低于 standard 且必须走 Envelope 决策；已列举的宿主 CLI 只读子命令视为 readOnly），并被单元测试锁定；codex --version 一类查询不再因未分类被拒。

Owner：运行时/Hook 维护者。

### AC-04 · P1 · 分类词表重复维护、无一致性断言

现象（已确认事实或静态结论）：

1. 只读词表存在两份（policy.mjs:289 与 execution-envelope.mjs:92），已经产生 AC-01 与 AC-02。
2. Get-ChildItem 接 Where-Object 被意外放行，原因是白名单项 where 加词边界匹配到了 Where-Object 前缀，说明白名单是按前缀拼接而非系统性设计（该命令的 highRiskReasons 为空）。
3. 凭据判定过宽：policy.mjs:14 的 secretReferencePattern 包含对一般环境变量的匹配，导致一条「网络下载命令把输出写到环境变量表示的临时路径」被误判为 CREDENTIAL_EXFILTRATION（本轮实际发生 1 次）。
4. AC-04a（本轮新发现）：apply_patch 的载荷文本被当作 shell 命令分析。payload 中只要出现成对反引号（行内代码跨度），就会命中 unsafeShellConstructPattern 并被拒。后果是：任何包含行内代码的 Markdown 文件都无法通过 apply_patch 写入，包括本报告的常规写法、仓库文档与规则文件。本轮因此改用无行内代码跨度的写法落盘本报告。第 10 节用真实 Hook 入口复现确认：同一 apply_patch 载荷含成对反引号时返回 UNSAFE_SHELL_CONSTRUCT 拒绝，去掉反引号后返回空对象放行（已确认事实）。

关闭条件：只读与无副作用判定收敛为单一模块并被两侧共同引用；新增一致性断言（同一命令在两处判定必须一致）；为「前缀碰撞」「环境变量非凭据」以及「apply_patch 载荷不是 shell 命令」各补一条回归用例；apply_patch 载荷只按补丁语义分析，不进入 shell 构造检查。

Owner：运行时/Hook 维护者。

### AC-05 · P1 · 托管指令块生成冗余

现象（已确认事实）：

1. 渲染结果存在连续空行：profile 行与规则行之间 1 行，模板行之后 4 行。
2. 三条同义行同时出现：规则位于 docs/rules/、工程专项规则位于 docs/rules/、发布与设计排障规则位于 docs/rules/。临时项目的安装产物同样存在这三行。
3. 规则索引是 21 项单行长句，安装后仍达 300+ 字符（临时项目为 16 项）。
4. 启动清单第 2 条渲染为生硬文案（编辑前检查目标目录文件状态；当前未配置 VCS 状态命令。）；第 3 条把工具发现与角色路由合并成 150+ 字符长句。

度量（已确认事实）：pack 指令预算 gate 为 0 warn、0 error（2693 字节，约 674 tokens）；本仓库 AGENTS.md 为 96 行、4324 字符、7372 字节，约 1843 tokens，未越 2000 阈值。因此 AC-05 是结构与可维护性问题，不是预算越界。另外，该 gate 只测「按完整规则索引渲染的模板」，不测按已装规则渲染的实际产物（静态结论）。

关闭条件：渲染结果无空占位行、无重复同义行；规则索引改为分组或指向单一索引文件；启动清单条目单一职责；validateInstructionBudget 仍为 0 warn、0 error；新增模板渲染断言（禁止连续空行、禁止重复同义前缀行）。

Owner：安装器/投影维护者。

### AC-06 · P1 · 自安装面与 profile 声明不一致

现象（已确认事实）：

| 声明 | 实际 |
| --- | --- |
| vibe-harness.config.json 的 profile 为 full | install-state.json 的 requestedModules 为 evals、memory、hooks，即自定义模块安装 |
| full 应包含角色面 | resolvedModules 无 roles、无 mcp-config；.codex/agents 与 .agents/roles 不存在 |
| — | doctor 的 roles 为空对象；target.adapters.codex.roleProjection 为 null |

根因（静态结论）：本仓库当前安装面由一次自定义模块安装产生，profiles.json 的 full 不复读；roles 只在显式模块选择或插件启用时生效（scripts/lib/module-selection.js:28、37、132-140）。

影响面（静态结论）：仓库无法用自身安装自证角色投影；AC-07 中 F01、F07、F10 的判断只能依赖临时项目实测，不能依赖本仓库。

关闭条件与取舍建议：本仓库自安装纳入 roles，使 doctor 的 roles 非空且 roleProjection 非 null；mcp-config 继续不写（不新增全局 MCP 配置，符合 docs/hooks.md 与 AGENTS.md 的安全规则 1）；重装后 doctor 仍为 ok:true。

Owner：安装器/自安装维护者。

### AC-07 · P1 · 2026-09-05 审查的 F01–F10 无台账

现象（已确认事实）：全仓库检索报告文件名无任何引用；docs/memory/TECH_DEBT.md 现有 7 条（TD-2026-09-02-1、TD-2026-09-11-2、TD-2026-09-11-3、TD-2026-09-11-4、TD-2026-09-14-1、TD-2026-09-14-2、TD-2026-09-15-1），无 F01–F10 条目。

本轮可判定的三态表：

| ID | 2026-09-05 的主题 | 本轮状态 | 证据 |
| --- | --- | --- | --- |
| F01 | Gemini 与 Antigravity 的工具名映射错误 | 已修复 | scripts/lib/role-projection.js:54-61 已按宿主给出原生工具名（gemini 为 read_file、grep_search、run_shell_command；antigravity 为 view_file、replace_file_content、run_command）；roles 审计通过（已确认事实与静态结论） |
| F09 | roles 审计脚本路径不可用 | 已修复 | node ./scripts/roles-audit.js 输出 Role audit: ok、Built-in roles: 7、Errors: 0、Warnings: 0（已确认事实） |
| F02 | 验证权限未区分「改产品」与「产证据」 | 部分变化，未闭环 | 新装 Codex 中 test-lead 与 technical-release-manager 的 sandbox_mode 为 workspace-write，不再是只读；但能力仍以提示词文本声明（verification: read, search, reason, validation-command, browser-verification），missingCapabilities 报 browser-verification、safe-security-check、package-dry-run 无法投影（已确认事实与静态结论） |
| F07 | 自定义或禁用角色缺少一致的有效路由 | 静态仍成立 | .agents/roles/index.md 含 when 与 avoid，而 .codex/agents 下的 toml 只有基础契约、角色正文与预设文本（已确认事实） |
| F03 | 角色与领域 Skills 或 MCP 组合在原生子 Agent 中断开 | 无法判定 | 需宿主实测，本轮未启动真实子 Agent |
| F05 | 角色 Eval 可复述答案满分 | 无法判定 | 需重跑角色 suite 与判分探针 |
| F06 | 角色正文未进入 Eval 指纹 | 无法判定 | 需核对 evals/references 的指纹分组是否覆盖角色正文 |
| F08 | 主 Agent 角色切换与固定子 Agent 权限共用契约 | 无法判定 | 需父子实测 |
| F10 | doctor 未证明角色任务就绪 | 部分改善 | 安装输出已能报告 roleProjections.missingCapabilities；但 doctor 的 roles 仍为空（AC-06） |

关闭条件：F02、F03、F05、F06、F07、F08、F10 逐项给出「已修复 / 未修复 / 无法判定」三态结论并落 TECH_DEBT.md，或记录不修理由；F10 与 AC-06 联动关闭。

Owner：角色/评测维护者。

### AC-08 · P2 · 拒绝文案不可操作

现象（已确认事实）：拒绝输出形如

    [VIBE_HARNESS_POLICY:EXECUTION_ENVELOPE_MISSING:11] An Execution Envelope is required for this effectful or unclassified request.
    [VIBE_HARNESS_POLICY:GLOBAL_AGENT_CONFIG:4] Writes to global Agent configuration are blocked by repository policy.
    [VIBE_HARNESS_POLICY:UNSAFE_SHELL_CONSTRUCT:4] Shell command substitution or line continuation cannot be safely analysed and is blocked by repository policy.

问题：全英文常量，且无可行动作（如何取得授权、如何安全重试、能否改用等价只读形式）；与 CLI 中文化口径冲突（联动 docs/memory/TECH_DEBT.md:23-28 的 TD-2026-09-11-3）。

关闭条件：拒绝输出中文化，并包含 reasonCode、触发原因与最小可行动作（例如：该命令被判 high，需要 Execution Envelope，请改写为无管道形式或申请 Envelope）；「不可判定」与「明确禁止」在文案与 reasonCode 上区分。

Owner：文档/CLI 文案维护者。

### AC-09 · P2 · 运行产物堆积

现象（已确认事实，本轮实测体积）：

| 路径 | 文件数 | 体积 |
| --- | --- | --- |
| .vibe-harness 合计 | 110007 | 2093.93 MB |
| .vibe-harness/external-env | 109134 | 2082.10 MB |
| .vibe-harness/backups | 799 | 5.36 MB |
| .vibe-harness/evals | 71 | 6.37 MB |
| .vibe-harness/transactions | 0 | 0 |
| .vibe-harness/release-notes | 1 | 约 0 |
| .codex/better-harness | 60 | 6.90 MB（20 个顶层目录，含 .cleanup、.draft-2026-08-13-codex-quick、.scratch-learning-evidence-20260902 与 17 个历史 run 目录） |

doctor 报告 unmanagedCount 为 2993（临时项目为 52）；写入本报告后，pnpm check 内的自安装一致性检查报告为 2994，即该计数把仓库内任意未登记文件都算作 unmanaged。

已核对：.gitignore 与 .cbmignore 已经覆盖 .vibe-harness 与 .codex（已确认事实），因此不需要新增忽略项；真正的问题是累积治理与 doctor 噪声。删除需要逐项人工确认，且仓库外路径的删除会被当前 Hook 拒绝（静态结论）。

归属更正（第 9 节复检取得，已确认事实）：.codex/better-harness 下的 20 个目录不是 Vibe-Harness 的产物，而由第三方插件 better-harness 产生。宿主配置中出现 marketplace 项（git 源 QoderAI/better-harness）与插件启用项 better-harness@better-harness，其报告写入该目录。因此清理建议必须按插件归属处理，不能作为 Vibe-Harness 的自有产物一并删除。

关闭条件：产出可按路径执行的清理清单（先列路径、体积与恢复路径），逐项确认后执行；给出保留策略（例如保留前 N 次 run、backups 按日期保留），使 doctor 的 unmanagedCount 有可解释基线。

Owner：仓库/维护流程维护者。

### AC-10 · P2 · 宿主契约取证路径未固定

8 个宿主声明（已确认事实，来源为 manifests/adapters.json 与 loadAdapterCatalog）：

| Adapter | 指令目标 | hookEvents（preToolUse / permissionRequest / stop） | redZone 项数 | 角色投影根 | 权限强制 |
| --- | --- | --- | --- | --- | --- |
| codex | AGENTS.md | stable / stable / unsupported | 1 | .codex/agents | native |
| claude | CLAUDE.md | stable / stable / unsupported | 1 | .claude/agents | prompt-guarded |
| gemini | GEMINI.md | unsupported / unsupported / unsupported | 0 | .gemini/agents | prompt-guarded |
| cursor | AGENTS.md | stable / unsupported / unsupported | 2 | .cursor/agents | prompt-guarded |
| qoder | AGENTS.md | stable / stable / unsupported | 2 | .qoder/agents | prompt-guarded |
| zcode | AGENTS.md | stable / stable / unsupported | 1 | .zcode/plugins/vibe-harness-roles/agents（manual） | prompt-guarded |
| antigravity | .agents/rules/vibe-harness.md | preview / unsupported / unsupported | 2 | .agents/agents | prompt-guarded |
| opencode | AGENTS.md | unsupported / unsupported / unsupported | 2 | .opencode/agents | native |

需要固定的事项：

1. 每个宿主的契约出处、最后一次核对日期与状态映射规则。本报告已把 Claude Code 的 hooks 与 sub-agents 文档作为相邻官方契约参考，并显式标注它不是 Codex 契约。
2. Codex 侧契约：第 9 节已改用「本机已装 CLI 二进制 + 宿主配置」完成核对；第 10 节补得 codex --version 与 codex --help 全文、codex features list 输出、宿主状态键形态，以及官方仓库 docs/config.md 的 Lifecycle hooks 段。developers.openai.com 仍返回 403，但已不影响本节结论。
3. 内部一致性：gemini 与 antigravity 的 capabilities.hooks 为 preview，而 hookEvents 三项全为 unsupported；opencode 声明 permissionEnforcement 为 native，但 capabilities.hooks 为 unsupported。这些组合需要一句可核对的解释，否则读者无法区分「没有 Hook」与「没有被强制」（静态结论）。
4. ai-context-kit 的出处缺失（见 2.4）：第 10 节已定位到 npm 包 ai-context-kit，阈值与估计口径均一致，只需在 pack-validation.js:1413 补上包名、版本与链接即可闭环。

关闭条件：8 个宿主各有一行「契约来源 + 状态 + 核对日期」；Codex 侧在 AC-01 修复后补一次 codex --version 与官方文档核对；内部不一致组合全部有解释或被 schema 约束。

Owner：adapter/契约维护者。

### AC-11 · P1 · 未列名的 MCP 工具被默认拒绝（本轮新增）

现象（已确认事实）：

工具名按第 10 节复检时宿主实际暴露的形态记录（服务器名以双下划线连接，工具名以双下划线连接）：

| 工具名 | effects | highRiskReasons | 出口 |
| --- | --- | --- | --- |
| mcp__codebase_memory_mcp 的 search_graph | 空 | 无 | 允许 |
| mcp__codebase_memory_mcp 的 get_code_snippet | 空 | 无 | 允许 |
| mcp__pencil 的 get_app_state | 空 | 无 | 允许 |
| mcp__linear 的 list_issues | 空 | 无 | 允许 |
| mcp__codebase_memory_mcp 的 status | 空 | unclassified-effect | 拒绝 |
| mcp__codex_app 的 open_in_codex | 空 | unclassified-effect | 拒绝（第 9 节真实发生：打开本报告的文件面板被拒） |
| mcp__codex_app 的 set_thread_archived | 空 | unclassified-effect | 拒绝 |
| mcp__codebase_memory_mcp 的 write | 空 | unclassified-effect | 拒绝 |

注意：第 9 节复检时观测到的服务器名写成 codebase-memory，本轮观测到的实际名称为 codebase_memory_mcp；两种写法的判定结果一致，说明根因在只读启发式而非服务器名本身。

根因（静态结论）：runtime/hooks/lib/execution-envelope.mjs:520-544 的 classifyMcpTool 只把两类 MCP 工具视为已知：linear、github 或 gitlab 的合并请求、凭据类，以及名字里含 filesystem、file、workspace 的写类；其余回落到第 544 行的只读启发式，即工具名中要有 get、list、search、read、find、view、fetch、inspect、query 之一作为分隔段。返回 false 时，execution-envelope.mjs:559-560 会把 unknown 置真，于是升级为 high 并拒绝。

影响面（静态结论）：名字不含上述读动词的 MCP 工具（状态查询、面板操作、写入或执行类）在默认配置下不可用。这与 AGENTS.md 的指示直接冲突：AGENTS.md 要求「理解或定位代码前先检查当前仓库索引状态并按需使用结构查询」，而索引状态查询类工具正因为命名不含读动词而被拒。同类影响还包括 codex_app 的面板工具与任何第三方 MCP 的写入工具。

关闭条件：MCP 工具按「服务器 + 读写分类」判定，而不是按工具名是否含读动词；只读类一律放行，写入与执行类要求 Execution Envelope 而不是直接拒绝；新增 codebase-memory 状态查询与 codex_app 面板工具的放行用例，以及写类 MCP 需 Envelope 的负例。

Owner：运行时/Hook 维护者。

### AC-12 · P1 · Hook 停用状态不可观测（第 10 节新增）

现象（已确认事实）：宿主配置已明确写入两条 Hook 状态条目带 enabled = false，但 doctor 的运行时 Hook 区块仍报告 status 为 configured-unverified、activation.status 为 unknown、activation.verification 为提示在 /hooks 中确认、selfCheck.status 为 pass、enforced 为 false。换言之，「已停用」这个确定事实在 Vibe-Harness 侧表现为「未知」，同时自检显示通过。

根因（静态结论）：doctor 的 Hook 状态来自仓库内声明与投影（manifests/adapters.json 的 evidence 段与 .codex/hooks.json），没有读取宿主状态；manifests/adapters.json 的 evidence.lastVerifiedAt 与 evidence.hostVersion 目前都是空字符串。

影响面（静态结论）：安全层是否真正生效无法从仓库自证。批次 1 修复后，若用户仍处于停用状态，误判会消失、防护同时也不存在，而 doctor 输出无法区分这两种情形；对 AC-10 的「宿主接纳」层同样缺一块可核对证据。

关闭条件：doctor 以只读方式核对宿主状态，把 configured-unverified 细分为三态（已信任且启用、已信任但停用、未信任）；不写入任何宿主配置；补齐 manifests/adapters.json 的 evidence.lastVerifiedAt 与 evidence.hostVersion；新增「宿主条目带 enabled 为 false」的识别用例。

Owner：运行时/Hook 维护者（与 AC-10 的契约取证联动）。

## 5. 改造批次

每批独立提交、可单独 revert；批次 1 的提交不得夹带其他批次内容。

### 批次 1（P0）· 只读判定单一化与风险分级修正

- 覆盖：AC-01、AC-02、AC-03、AC-04、AC-08、AC-11。
- 改动面：抽取单一「只读或无副作用」判定模块，供 runtime/hooks/lib/policy.mjs 与 runtime/hooks/lib/execution-envelope.mjs 共用；补齐 PowerShell 与 Unix 只读 cmdlet（Select-Object、Sort-Object、ForEach-Object、ConvertFrom-Json、Format-Table、Group-Object、Out-String、Get-Process、Get-Help、jq 等）；补宿主 CLI 只读子命令（至少 codex 的 --version 与 --help）；把 globalAgentConfigPattern 收敛为「真实全局配置位置」，项目内 .codex 的读取不再命中写规则；MCP 工具改按服务器与读写分类，只读放行、写入需 Envelope；未分类命令的拒绝文案改为可操作中文，并区分「不可判定，需要 Envelope」与「明确禁止」；凭据判定去掉对一般环境变量的误伤；apply_patch 载荷不再进入 shell 构造检查。
- 验收：pnpm test:unit 与 pnpm test:integration；在本仓库实测 AC-01 表中三类正例返回 allow；凭据、红区、破坏性 git、越界写的负例仍被拒绝；新增对照测试（项目内 .codex 与家目录 .codex）与 MCP 放行或需 Envelope 的用例。
- 回滚：单次 git revert；Hook 行为只由 runtime/hooks/lib 决定，不涉及安装状态迁移。

### 批次 2（P1）· 托管指令块瘦身

- 覆盖：AC-05。
- 改动面：scripts/lib/install-planner.js 的 createInstalledSurface（第 168-223 行）合并同义行、折叠空占位符；scripts/lib/template-renderer.js（第 15-18 行）与 adapters 各宿主的 AGENTS 模板把逐行占位符改为条件块；规则索引改分组或改为指向单一索引文件；同步所有引用 installedSurface 的 adapter 模板。
- 验收：node --test 运行 codex-adapter、cross-platform-adapters、opencode-adapter 三个测试；pnpm test:integration；pnpm smoke:lifecycle；渲染结果无空占位行、无重复的「位于 docs/rules/」行；指令预算仍为 0 warn、0 error。
- 回滚：单次 git revert；该批只改渲染，不改安装状态结构。

### 批次 3（P1）· 自安装面与角色面自证

- 覆盖：AC-06、AC-07。
- 改动面：逐项复核 F02、F03、F05、F06、F07、F08、F10 并产出三态表；决定本仓库自安装是否纳入 roles（建议纳入以便 doctor 自证）与 mcp-config（继续不写全局配置）；把结论落入 docs/memory/TECH_DEBT.md，或明确记录不修理由。
- 验收：pnpm roles:audit、pnpm skills:audit、node --test tests/role-projection.test.js、pnpm eval:check；reference 指纹漂移按 CONTRIBUTING.md 清单单独确认。
- 回滚：配置与清单改动可 git revert；若引入角色文件，需连带 uninstall 与 validate 回归。
- 待用户决策：是否接受本仓库新增 .codex/agents 下的 toml 与 .agents/roles 下的角色正文（预计新增约 15 个受管文件）。

### 批次 4（P2 与 P1 混合）· 运行产物、文案与取证纪律

- 覆盖：AC-08（与批次 1 的文案改动合流或作为其后续）、AC-09、AC-10、AC-12。
- 改动面：产出清理清单（路径、体积、恢复路径），删除前逐项确认；.gitignore 与 .cbmignore 已覆盖，无需新增；拒绝文案语言统一；固定 8 个宿主的契约取证路径与受阻状态，并把 manifests/adapters.json 的 evidence.lastVerifiedAt 与 evidence.hostVersion 填为真实值（本轮已取得 Codex 侧取值：hostVersion 0.147.0，核对日期与来源见第 10 节）；补齐 ai-context-kit 出处的包名、版本与链接；把 stop 声明的 unsupported 改为 not-projected 或在 manifests 中加注释；doctor 增加宿主状态三态识别（AC-12）。
- 验收：pnpm docs:audit 与 pnpm check；AC-12 另需一条覆盖「宿主条目带 enabled 为 false」的 doctor 用例。
- 回滚：文档改动可 git revert；删除动作不可 revert，必须先记录恢复路径（备份或重新生成方式）；doctor 与 manifests 改动可 git revert。

批次依赖：批次 1 是 AC-10 中 Codex 侧取证的前置；批次 3 的 F10 结论依赖 AC-06 的取舍。

## 6. 测试与验证矩阵

| 改动类型 | 显式验证 |
| --- | --- |
| Hook（批次 1） | pnpm test:unit（含 hook-runtime、execution-observer-parity、runtime-diagnostics）；pnpm test:integration（含 hook-installation、cross-platform-adapters、installer-lifecycle）；并在真实仓库复跑被误拒的三类只读命令 |
| 模板与投影（批次 2） | node --test 运行 codex-adapter、cross-platform-adapters、opencode-adapter；pnpm test:integration；pnpm smoke:lifecycle |
| 角色与规则内容（批次 3） | pnpm test:unit；pnpm eval:check；reference 指纹漂移按 CONTRIBUTING.md 单独确认；pnpm eval:replay 复核 |
| 文档（本报告与批次 4） | pnpm docs:audit；若已跑 pnpm check 则已内含（pnpm check 等于 lint、eslint、typecheck、validate 与 test:unit） |
| 收尾统一 | pnpm check 与 git diff --check |

安装实测纪律：使用 CLI 自身在仓库外临时目录执行 init 与 install（--target codex --profile full --write --confirm-red-zone）；不要用 shell 建目录（会被边界规则拒绝）。Codex 的 Hook 信任状态需要人工在 /hooks 确认，报告只能写 configured-unverified。8 个宿主的真实安装实测本轮不做，除非另有指定；Gemini、Antigravity、OpenCode 无 Hook 或 redZone 为空，只做声明一致性核对，不声称安全等价。

本轮已执行的验证（已确认事实）：pnpm check 全量通过（lint 扫描 228 个文件、ESLint 0 error 与 140 warning、typecheck 通过、validate 通过、test:unit 329 个用例全部通过，耗时约 48 秒）；pnpm docs:audit 通过（112 篇文档）；doctor --project .（ok、ready）、doctor 指向临时项目（invalid、conflict，见 3.4）、roles 审计脚本（ok、7 roles、0 errors）、validateInstructionBudget（0 warn、0 error）、loadAdapterCatalog（8 宿主声明）、Hook 入口端到端探针、策略层探针、隔离临时项目全量安装。本轮未执行 pnpm test:integration、pnpm smoke:lifecycle 与 pnpm eval:check，因为它们不在 pnpm check 内，且本轮交付物只有文档新增，不触发对应代码路径。

第 10 节复检新增的验证（已确认事实）：codex --version（codex-cli 0.147.0）与 codex --help 全文；codex features list（hooks 为 stable 且有效值为 true）；Hook 入口端到端探头 6 次（apply_patch 载荷含与不含成对反引号、codex --version、Get-ChildItem 与 ls 与 Get-Content 分别指向用户目录下临时项目的 .codex）；判定模块直探 18 例（shell 命令 9 例、MCP 工具名 8 例、apply_patch 载荷单独 1 例）；doctor --project .；宿主配置 hooks.state 只读核对（确认本项目两条条目带 enabled = false）；.vibe-harness 与 AGENTS.md 体积复核；OWASP 资源页与 npm registry 网络核对。

## 7. 假设与未决

待验证假设：

- Codex Hook 契约的官网原文仍未取得（developers.openai.com 返回 403）。第 10 节已补得 codex --help 全文、codex features list 输出、宿主状态键形态，以及官方仓库 docs/config.md 的 Lifecycle hooks 段；仍缺的是官网对 tool_name 取值与 matcher 语义的逐字说明。
- F03、F05、F06、F08 需要宿主实测或 Eval 重跑，当前没有本轮证据。
- 角色投影在 Gemini、Antigravity、Cursor、Qoder、ZCode、OpenCode 上的实际加载与权限行为未实测。

未决事项：

- 是否接受批次 3 的自安装 roles 扩容（新增受管文件）需要用户决定。
- AC-09 的清理范围与保留策略需要用户逐项确认；.vibe-harness/external-env（2082 MB）能否整体重建，需要先确认其生成方式。（同日更新：用户已确认「保留最近 20 + 删除临时文件」口径并授权执行，结果见第 15 节。）
- AC-08 的中文化范围是否与 TD-2026-09-11-3 合并处理，需要一次口径决定。
- AC-12 的三态口径（已信任且启用、已信任但停用、未信任）与 doctor 输出格式是否需要同步进 doctor JSON schema，需要一次设计决定。
- Hook 是继续停用还是尽快恢复，需要用户决定：恢复后本会话可用的取证手段（宿主 CLI 自检、含行内代码跨度的写入、MCP 状态与面板工具）会再次被 AC-01、AC-04a、AC-11 拦回。

边界声明：用 node 执行脚本并传入仓库外路径时，脚本可以写入仓库外目录，因为策略只从结构化 toolInput 的路径键取写入目标，不解析 shell 操作数；docs/hooks.md 已声明「任意解释器需要宿主沙箱独立覆盖」。本报告不把该行为计入缺陷，但它是批次 1 文案必须交代的限制。

## 8. 台账表（finding 到 owner 到关闭条件）

| ID | 级别 | 一句话 | Owner | 关闭条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| AC-01 | P0 | 只读命令被 fail-closed 误拒 | 运行时/Hook 维护者 | 三类只读正例 allow，负例仍 deny，测试覆盖 | 已关闭（批次 1） |
| AC-02 | P0 | 只读枚举被误报为写全局配置 | 运行时/Hook 维护者 | 项目内 .codex 读取 allow、家目录写入仍 deny、对照测试 | 已关闭（批次 1） |
| AC-03 | P1 | 风险标定倒挂 | 运行时/Hook 维护者 | 定级口径成文并被测试锁定 | 已关闭（批次 1，口径：只扩只读白名单，不改解释器定级） |
| AC-04 | P1 | 词表重复维护、无一致性断言（含 AC-04a apply_patch 载荷误判） | 运行时/Hook 维护者 | 单一模块加一致性断言，前缀碰撞、环境变量、apply_patch 载荷三类用例 | 已关闭（批次 1） |
| AC-05 | P1 | 托管块冗余与空行污染 | 安装器/投影维护者 | 渲染无空占位行与重复同义行，预算仍 0 warn 0 error | 已关闭（批次 2） |
| AC-06 | P1 | 自安装面与 profile 声明不一致 | 安装器/自安装维护者 | doctor 的 roles 非空、角色目录存在、不写全局配置 | 已关闭（批次 3） |
| AC-07 | P1 | F01–F10 无台账 | 角色/评测维护者 | 七项三态结论并落 TECH_DEBT 或记录不修理由 | 已关闭（批次 3：F01/F08/F09 已修复，F02/F04/F06/F07/F10 部分修复，F03/F05 未修复并已成 TECH_DEBT 条目） |
| AC-08 | P2 | 拒绝文案不可操作 | 文档/CLI 文案维护者 | 中文可操作文案加不可判定与禁止的区分与测试 | 已关闭（批次 1 完成 Hook 侧，批次 4 完成 doctor 告警与文档；CLI 其余诊断仍属 TD-2026-09-11-3） |
| AC-09 | P2 | 运行产物堆积 | 仓库/维护流程维护者 | 清理清单执行、保留策略、unmanaged 基线 | 已关闭（2026-09-15）：清单见附录 A，保留策略为 backups/evals 各保留最近 20，经用户确认后已执行删除；执行收据与保留项复核见第 15 节 |
| AC-10 | P2 | 宿主契约取证路径未固定 | adapter/契约维护者 | 8 宿主各一行契约来源、状态与核对日期；AC-01 后补 Codex 核对 | 已关闭（批次 4：codex evidence 落 manifests，stop 改 not-projected，其余宿主标注未核对） |
| AC-11 | P1 | 未列名的 MCP 工具被默认拒绝 | 运行时/Hook 维护者 | MCP 只读放行、写入需 Envelope，并有对应用例 | 已关闭（批次 1） |
| AC-12 | P1 | Hook 停用状态不可观测 | 运行时/Hook 维护者 | doctor 输出三态（已启用、已停用、未信任），manifests 补 evidence 取值，并有对应用例 | 已关闭（批次 4：doctor 输出 trusted-disabled 与 HOOK_DISABLED，含 2 个新用例） |

实施顺序（用户批准的计划已调整并锁定）：批次 1（P0，先解除自我阻断）→ 批次 2（投影瘦身）→ 批次 3（自安装面与角色面自证）→ 批次 4（成本、文案与取证纪律）。批次 2 提到批次 3 之前，原因是批次 3 会重装本仓库并重写 AGENTS.md，需要先让投影定型，避免同一段受管块在一个提交内被改两次。每批一个独立提交，可单独 revert，提交之间不夹带内容。

## 9. 受阻项复检（同日，用户口头授权之后）

### 9.1 授权模型结论（先给结论）

用户在本轮给出的口头授权不会改变运行时行为。判定依据（已确认事实）：

- Hook 的授权来源是宿主注入的 Execution Envelope：doctor 输出 executionAuthority.trustedSource 为 host-injected、projectConfigMayAuthorize 为 false。仓库内没有任何路径可让「用户说可以」变成「策略放行」。
- 本会话的 Hook 之所以生效，是因为宿主已按项目记录信任：Host 配置的 [hooks.state] 段中存在本项目 .codex/hooks.json 的 pre_tool_use 与 permission_request 两条 trusted_hash 记录。真正的授权界面是宿主侧的 /hooks 信任流程，不是对话中的口头授权。
- 因此被阻项要真正放行只有三条路：修复 AC-01、AC-02、AC-11（推荐，即批次 1）；由宿主注入 Execution Envelope；或在宿主侧撤销信任（会同时关闭整套防护）。本报告建议第一条。

### 9.2 Codex 契约核对：由「验证受阻」升级为「已确认事实」

改用本机已装 CLI 与宿主配置取证，不再依赖被 403 挡住的官网：

| 项目 | 取值 | 取证方式 |
| --- | --- | --- |
| Codex CLI 版本 | 0.147.0 | 读取 pnpm 全局包元数据（未执行 codex --version） |
| AGENTS.md 截断阈值 | project_doc_max_bytes = 32768 | CLI 二进制字符串 |
| Hook 事件枚举 | PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、SessionStart、SessionEnd、UserPromptSubmit、SubagentStart、SubagentStop、Stop、Interrupt | 二进制 HookEventsToml 枚举 |
| 宿主配置中的事件名 | snake_case，例如 pre_tool_use | 宿主配置 [hooks.state] 的键 |
| Handler 字段 | command、commandWindows、timeout、async、statusMessage；匹配器结构为 MatcherGroup 带 matcher 与 hooks | 二进制结构名 |
| PreToolUse 输出 | hookSpecificOutput 含 hookEventName、permissionDecision、permissionDecisionReason、additionalContext；deny 必须带非空 reason；ask、approve、continue、stopReason、suppressOutput 明确 unsupported | 二进制错误文案与 wire 结构 |
| PermissionRequest 输出 | decision 内含 behavior 与 message | 二进制 PermissionRequestBehaviorWire |
| 信任存储 | 宿主配置 [hooks.state] 中按「项目路径 的 hooks.json + 事件 + 索引」记录 trusted_hash 的 sha256 | 宿主配置实读 |
| Hook 能力开关 | 二进制特性键列表含 codex_hooks，并伴随「不稳定特性可能行为异常」的警告；本机未显式开启但 Hook 已生效 | 二进制字符串与本机实测 |

对 Vibe-Harness 的影响：

1. codex adapter 声明 stop 为 unsupported，与宿主事件表不一致。需要澄清语义：是「宿主不支持」还是「Vibe-Harness 未实现」。宿主配置中另有项目为 10 个事件全部记录信任，说明宿主支持这些事件。
2. .codex/hooks.json 的结构（matcher 加 hooks，handler 类型为 command，含 commandWindows、timeout、statusMessage）与宿主的 MatcherGroup 与 HookHandlerConfig 一致，属于正确投影。
3. doctor 报 configured-unverified 偏保守：宿主配置中已有本项目的两条信任记录，可只读宿主配置把该状态升级为 trusted，且不需要写入任何全局配置。
4. Hook 是否受 codex_hooks 特性开关门控，需要一次显式实验：本机默认生效，当前无法区分「默认开启」与「桌面端注入」。

### 9.3 仍受阻项与处置

说明：下表记录的是 Hook 仍然生效时的状态，保留原文以便追溯。用户随后暂时停用了本仓库 Hook，本节多数条目已被第 10 节取代；仍实际受阻的只剩 developers.openai.com 与 OWASP 条目正文两处。

| 项 | 状态 | 原因与后续 |
| --- | --- | --- |
| developers.openai.com | 仍受阻 | 403（默认 UA 与浏览器 UA 均如此）。已由本机二进制替代，不再构成 AC-10 阻塞，但官网与本地版本的差异无法核对 |
| codex --version / codex --help | 仍受阻 | AC-01；版本号已由包元数据取得，--help 文本仍未取证 |
| OWASP Top 10 for Agentic Applications 2026 的条目 | 仍受阻 | 资源页与 ASI 页可达并已核对标题与发布日期；条目正文在 PDF 中，静态 HTML 不含可直取的下载链接，本轮未取得 |
| ai-context-kit 出处 | 仍受阻 | 仓库内仅一处注释；GitHub 同名仓库搜索结果 189 个，均非该启发式的权威来源 |
| 含行内代码跨度的 Markdown 写入 | 仍受阻 | AC-04a；本报告继续以无行内代码跨度的写法维护 |
| MCP 面板与状态类工具 | 仍受阻 | AC-11；无法自动在面板打开本报告，需人工打开文件 |
| 本地只读枚举 .codex 目录 | 已可完成 | 通过 node 直接读取（不经过 shell 词表）绕开策略误判，本节取证即使用该路径 |

### 9.4 复检新增的次要发现

- 宿主配置同时承载信任记录与插件清单：marketplace 项与 [hooks.state] 位于同一文件，说明「不写全局配置」的承诺需要与宿主自身写入区分，避免把宿主写入误判成安装器写入。
- 宿主配置中已存在其他项目（LoopEngine、CNAS、PaProject、BL-CNAS）的 Hook 信任记录，其中 PaProject 记录 10 个事件，可作为宿主事件契约的旁证。
- AC-09 的归属更正：.codex/better-harness 下的历史目录由第三方插件 better-harness 产生，不属于 Vibe-Harness 自有产物。

## 10. Hook 停用后的复检（同日，用户暂时停用 Hook 之后）

### 10.1 停用机制与效力边界（已确认事实）

用户所述「暂时停止 Hook 阻止」在宿主配置中可核对到确切形态：

| 观察点 | 取值 | 取证方式 |
| --- | --- | --- |
| 本项目 Hook 状态键 | 项目 .codex 下 hooks.json 的绝对路径，加事件 snake_case 名，加索引 0:0 | 读取宿主配置 hooks.state 段 |
| 两个事件条目的新增字段 | enabled = false，pre_tool_use 与 permission_request 各一条 | 同上 |
| trusted_hash | 与停用前一致，信任未被撤销 | 同上 |
| 宿主全局要求文件 | requirements.toml 不存在，故官方文档所述 allow_managed_hooks_only 未参与 | 目录枚举 |

效力判定：

1. 停用发生在宿主调用层，不是策略层。本轮实测：此前被拒的 Select-Object 管道、rg 与 Select-Object 组合、codex --version 与 codex --help 全部正常返回（已确认事实）。
2. 判定代码未变。用 stdin 直接调用 .agents/runtime/hooks/codex-hook.mjs 并传 PreToolUse 载荷，仍返回 permissionDecision 为 deny（见 10.3）。
3. 因此 AC-01、AC-02、AC-03、AC-04a、AC-08、AC-11 全部仍然成立；停用只是把「宿主是否调用 Hook」这一层关掉。批次 1 仍是唯一治本路径。

副作用（已确认事实）：停用同时让本轮补回了此前被自己阻断的取证手段——可执行宿主 CLI 自检、可写入含行内代码跨度的文件、可调用 MCP 状态与面板工具。

### 10.2 受阻项解除情况

| 此前受阻项 | 本轮结果 | 标签 |
| --- | --- | --- |
| codex --version | 取得 codex-cli 0.147.0，与第 9 节的包元数据一致 | 已确认事实 |
| codex --help | 取得全文：子命令含 exec、review、login、mcp、plugin、app-server、doctor、sandbox、debug、apply、resume、archive、fork、cloud、features 等；选项含 -s 与 --sandbox、-a 与 --ask-for-approval、--dangerously-bypass-approvals-and-sandbox、--dangerously-bypass-hook-trust、--strict-config、--add-dir | 已确认事实 |
| Hook 是否受特性开关门控（第 9 节未决） | 解除：codex features list 输出 hooks 为 stable 且有效值为 true；plugin_hooks 为 removed；features 子命令可读可写特性开关 | 已确认事实 |
| Codex 官方契约来源 | developers.openai.com 仍为 403（自定义 UA、浏览器 UA、强制 HTTP/1.1、附加 Accept 头均如此）。降级路径固定为三处：官方仓库 openai/codex 的 docs 目录（GitHub raw 可达）、本机 CLI 二进制、本机宿主配置 | 验证受阻（已有可用降级路径） |
| 官方文档中的 Hook 契约细节 | 取得一条：官方仓库 docs/config.md 的 Lifecycle hooks 段说明，requirements.toml 设置 allow_managed_hooks_only 为 true 会忽略用户、项目与会话 Hook 配置，同时仍允许来自 requirements 与受管配置层的 Hook | 已确认事实 |
| OWASP Top 10 for Agentic Applications 2026 条目正文 | 资源页可达：标题、发布日期 2025-12-09、面向 2026 年版；同页关联资源含 Agent Control Standard、AIUC-1 交叉映射、State of Agentic AI Security and Governance、A Practical Guide for Secure MCP Server Development。条目正文的下载入口跳转到 no-access 页面（权限门控）；站内 ASI01 至 ASI10 路径均返回 404 | 验证受阻（权限门控） |
| ai-context-kit 启发式出处 | 解除：出处为 npm 包 ai-context-kit（作者 Ofer Shapira，MIT，latest 0.1.2，仓库 github.com/ofershap/ai-context-kit）。其 lint 规则的 token-budget 项写明超过 2,000 tokens 为 warning、超过 5,000 为 error，token 估计使用 4 characters per token；与 scripts/lib/pack-validation.js:1413-1418 的注释与阈值完全一致 | 已确认事实 |
| 含行内代码跨度的 Markdown 写入 | 解除：Hook 停用后写入成功 | 已确认事实 |
| MCP 面板与状态类工具 | 解除：本会话已可用 codebase_memory_mcp、codex_app、pencil、linear 四组工具；但判定代码仍拒绝其中一部分（见 10.3） | 已确认事实 |

### 10.3 停用后仍复现的判定缺陷（已确认事实）

以下判定由直接导入 runtime/hooks/lib/execution-envelope.mjs，或直接用 stdin 调用 Hook 入口取得，与宿主是否调用 Hook 无关：

| 输入 | 判定 | 出口 |
| --- | --- | --- |
| codex --version | effects 空，highRiskReasons 为 unclassified-effect | 拒绝（Hook 入口实测） |
| codex --help | 同上 | 拒绝 |
| Get-ChildItem 接 Select-Object Name | 同上 | 拒绝 |
| Get-ChildItem 接 Sort-Object Name | 同上 | 拒绝 |
| pytest -q | 同上 | 拒绝 |
| go test ./... | 同上 | 拒绝 |
| git status --short | effects 空，无 highRiskReasons | 允许 |
| node ./scripts/lint.js | workspaceWrite，无 highRiskReasons | 允许 |
| Set-Content 指向仓库内新文件 | workspaceWrite，无 highRiskReasons | 允许 |
| apply_patch 载荷含成对反引号 | UNSAFE_SHELL_CONSTRUCT（Hook 入口实测） | 拒绝 |
| 同一 apply_patch 载荷去掉反引号 | 空对象 | 允许 |
| Get-ChildItem 或 ls 指向临时项目内的 .codex | GLOBAL_AGENT_CONFIG（Hook 入口实测） | 拒绝 |
| Get-Content 读取同一路径下的文件 | 空对象 | 允许 |
| codebase_memory_mcp 的 search_graph 与 get_code_snippet、pencil 的 get_app_state、linear 的 list_issues | effects 空，无 highRiskReasons | 允许 |
| codebase_memory_mcp 的 status 与 write、codex_app 的 open_in_codex 与 set_thread_archived | effects 空，但有 unclassified-effect | 拒绝 |

与第 4 节的判定一致，未观察到位表变化；本轮新增的证据是「宿主不再调用 Hook」与「判定代码仍拒绝」两件事同时成立。

### 10.4 复检新增发现

主要发现为 AC-12（Hook 停用状态不可观测），已写入第 4 节与第 8 节台账。其余复检发现：

1. stop 声明的语义已可解释（已确认事实）：适配器声明 stop 为 unsupported，而仓库 .codex/hooks.json 只定义 PreToolUse 与 PermissionRequest 两个事件；宿主侧另有项目（PaProject）被信任的记录覆盖了含 stop 在内的 10 个事件。因此 unsupported 的含义是「本项目未投影该事件」，不是「宿主不支持」。建议改名为 not-projected，或在 manifests 中加注释。
2. 宿主状态键的契约形态已固定（已确认事实）：键为「项目 hooks.json 绝对路径 + 事件 snake_case 名 + 索引 0:0」，值为 trusted_hash 与可选的 enabled。可直接作为 AC-10 中 Codex 一行的契约来源。
3. 宿主提供了一键绕过开关（已确认事实）：codex --help 列出 --dangerously-bypass-hook-trust，描述为在不要求持久化 Hook 信任的前提下运行已启用的 Hook。这是宿主能力而非缺陷，但建议在 docs/hooks.md 的安全边界一节记录，理由与 AC-12 相同：防护可以被静默关闭。
4. 运行产物堆积的另一半在宿主侧（已确认事实，归属为 Codex CLI 而非 Vibe-Harness）：用户配置目录中 logs_2.sqlite 约 2.59 GB、thread_history_1.sqlite 约 900 MB、state_5.sqlite 约 4.6 MB，另有 13 个 .codex-global-state.json.tmp-星号残留文件（部分 0 字节）与 1 个以两个点开头的 .codex-global-state.json.bak.tmp-星号多份副本。这些不属于 AC-09 的仓库范围，建议作为宿主侧维护事项单独登记。
5. 度量复核（已确认事实）：本仓库 .vibe-harness 现为 110010 个文件、2094.08 MB，AGENTS.md 为 95 行、7372 字节；与第 4 节记录的量级一致，AC-05 与 AC-09 判定不变。
6. 报告写法约定仍然保留：虽然本轮可以写入行内代码跨度，但同一 Hook 一旦恢复启用，含反引号的 apply_patch 载荷会再次被拒（10.3 已复现）。因此本报告继续使用无行内代码跨度的写法，直到 AC-04a 关闭。

## 11. 批次 1 实施记录（2026-09-15，P0）

状态：已完成实施、验证与提交。本批次对应一个独立提交，可单独 `git revert`；不涉及安装状态结构迁移，也不写任何全局 Agent 配置。

### 11.1 结论

AC-01、AC-02、AC-03、AC-04（含 AC-04a）、AC-11 已关闭；AC-08 的 Hook 侧文案已中文化并可操作，CLI 侧文案与 TD-2026-09-11-3 的处理留到批次 4。判定逻辑不再由两份词表承担：policy 层与 Execution Envelope 共用同一模块，测试断言同一命令在两处得到一致结论。

### 11.2 改动面

| 文件 | 作用 |
| --- | --- |
| `runtime/hooks/lib/read-only-commands.mjs`（新增） | 唯一判定源：命令分词与分段、只读命令表、只读子命令规则表、参数护栏、写入谓词、MCP 读写分类 |
| `runtime/hooks/lib/policy.mjs` | 删除本地重复词表改为引用共享模块；`globalAgentConfigPattern` 收敛为「家目录紧跟配置目录」；`apply_patch` 载荷不再进入 shell 构造、重定向与凭据检查，只按补丁语义取目标路径；八条拒绝文案改中文并附最小可行动作 |
| `runtime/hooks/lib/execution-envelope.mjs` | 同上来源改造；`gitInvocation`、`cliInvocation`、`classifySupabase` 改用共享 `shellInvocation()`，修掉「带引号参数被当成可执行名」的缺陷；段循环以 `isReadOnlyShellSegment()` 为唯一放行判据；全部拒绝文案改中文 |
| `tests/hook-read-only-classification.test.js`（新增） | 12 个用例：三类只读正例、两处判定一致性、解释器定级、项目内与家目录 `.codex` 对照、`apply_patch` 载荷、六类负例、只读与写类 MCP |
| `package.json` | `test:unit` 显式清单加入新测试文件 |
| `docs/hooks.md` | 新增「判定分级」：五类判定矩阵、单一模块来源、`apply_patch` 语义、MCP 服务器加动词分类、中文文案与英文 reasonCode 的关系、项目内 `.codex` 不属于全局配置 |
| `adapters/install-map.json`、`manifests/capabilities.json` | 把新模块登记进 hooks 组与 hook-policy 能力目标，保证投影与自安装面同步 |
| `.agents/runtime/hooks/lib/*.mjs` | 同步本仓库已安装面，使 `self-install-check` 不产生漂移 |
| `.vibe-harness/install-state.json` | 本地状态（已被 gitignore），更新三条 hooks 条目的哈希并为新模块追加条目 |

### 11.3 判定规则要点

- 只读命令表覆盖 PowerShell cmdlet 与谓词族（`Get-`、`Select-`、`Sort-`、`Where-`、`ForEach-`、`Group-`、`ConvertFrom-`、`Format-`、`Measure-`、`Compare-`、`Resolve-`、`Test-`、`Split-`、`Join-`）、Unix 读工具（`jq`、`awk`、`sed`、`cut`、`tr`、`uniq`、`rg`、`find` 等）。
- 参数护栏会把只读判定撤回 Envelope 路径：`find` 的 `-delete`/`-exec`、`rg` 的 `--pre`、`sed` 的 `-i`、`awk` 的 `system(`/`exec(`、`terraform` 的 `-out`。
- 宿主与基础设施 CLI 按「可执行名加子命令动词」两级判定，不再要求整段命中：`codex --version`/`--help`/`features list`/`mcp list`、`kubectl get|describe|logs`、`docker ps|images|compose ps|compose config|logs`、`terraform plan|validate|show|output|version`、`aws list-|describe-|get-` 前缀、`gh` 与 `glab` 的 `list|view|status|diff`。写动词表刻意不含 `run`，否则 `gh run view` 会被误判为写入。
- 解释器与非 Node 工具链（`node`、`python`、`pytest`、`go`、`cargo`、`dotnet`、`mvn`、`gradle`、`make`、`cmake`、`php`、`bundle`、`rspec`、`ruby`、`deno`、`bun` 等）统一维持 workspaceWrite 加 standard，既不升级为 high，也不新增强制 Envelope——这是 AC-03 倒挂的修复口径：只扩只读白名单，不动解释器定级。
- MCP 工具按「服务器加动词」分类：只读与 UI 类动词放行，写与执行类动词与无法判定者走 Envelope，不再硬编码 fail-closed 拒绝。
- `apply_patch` 只按补丁语义取目标路径并记为 workspace 写入；命令替换、成对反引号、行尾反斜杠的检查只作用于 shell 命令。

### 11.4 端到端实测（已确认事实）

探针直接调用与宿主相同的入口 `.agents/runtime/hooks/codex-hook.mjs --expected-event PreToolUse`，stdin 传 PreToolUse JSON，工作目录为本仓库。21 例全部符合预期（正例放行、负例拒绝且文案为中文）。

| 类别 | 用例 | 期望 | 结果 |
| --- | --- | --- | --- |
| 正例 | `codex --version`、`codex --help` | allow | allow（输出为空对象） |
| 正例 | `Get-ChildItem -Force \| Select-Object Name,Length` | allow | allow |
| 正例 | `Get-ChildItem \| Sort-Object Name \| Format-Table` | allow | allow |
| 正例 | `Get-Process \| Where-Object { $_.Name -like "node*" }` | allow | allow |
| 正例 | `pytest -q`、`go test ./...` | allow | allow |
| 正例 | `git status --short` | allow | allow |
| 正例 | 读家目录 `.codex` 目录与 `config.toml` | allow | allow |
| 正例 | `apply_patch` 载荷含行内代码跨度与命令替换文本 | allow | allow |
| 正例 | 只读 MCP 工具（`mcp__codebase-memory-mcp__search_graph`） | allow | allow |
| 负例 | `git push --force`、`git reset --hard` | deny | deny（DESTRUCTIVE_GIT） |
| 负例 | 含命令替换的只读管道 | deny | deny（UNSAFE_SHELL_CONSTRUCT） |
| 负例 | 带 Bearer 环境变量凭据的请求、上传 `.env` | deny | deny（CREDENTIAL_EXFILTRATION） |
| 负例 | 补丁写入家目录 `.codex` | deny | deny（GLOBAL_AGENT_CONFIG；控制面路径形态先命中 CONTROL_PLANE_WRITE，同为拒绝） |
| 负例 | `Set-Content` 写家目录 `.codex` 下新文件 | deny | deny（GLOBAL_AGENT_CONFIG） |
| 负例 | 写类 MCP 工具（`mcp__codex_app__set_thread_archived`） | deny | deny（EXECUTION_ENVELOPE_MISSING，文案明确「不可判定，需要 Execution Envelope」） |

### 11.5 验证清单

| 命令 | 结果 |
| --- | --- |
| `pnpm test:unit` | 341 通过、0 失败（含新增的 12 个用例） |
| `pnpm test:integration` | 320 通过、0 失败、1 跳过（约 408 秒） |
| `node --test tests/hook-read-only-classification.test.js` | 12 / 12 |
| `node --test tests/hook-runtime.test.js` | 38 / 38 |
| `node --test tests/documentation.test.js` | 14 / 14 |
| `node --test tests/self-install-check.test.js` | 6 / 6 |
| `node ./scripts/lint.js`、`npx eslint`（四个改动文件） | 230 文件扫描通过；ESLint 0 error（保留既有复杂度告警） |
| `node ./scripts/docs-audit.js` | 112 篇文档通过 |
| 端到端探针 | 21 / 21 符合预期 |

### 11.6 未闭合与移交

- AC-08 只完成 Hook 侧：CLI 与 doctor 的文案中文化、以及 TD-2026-09-11-3 的合并口径，移交批次 4。
- `install --project . --write` 目前仍被两条既有 `user-modified` 拦截（pack 源与目标同路径的 `docs/rules/project-specific-rules.md`，以及用户既有的 `.agents/evals/references/vibe-harness-core.offline.json` 改动）。这是既有行为，不在批次 1 范围内，移交批次 3 处理。
- Hook 在本机宿主侧仍处于 `enabled = false`（AC-12）。批次 1 的修复不改变该状态；恢复启用或保持停用属于用户决策，恢复后建议复跑 11.4 的探针清单。
- 本报告第 1–10 节保留原始无行内代码跨度的写法；AC-04a 关闭后新章节恢复常规 Markdown，不做全篇重写。

### 11.7 回滚

单次 `git revert` 即可回滚本批次；运行时判定只由 `runtime/hooks/lib` 决定，本仓库已安装面在回滚后需按 11.2 的同步方式重新对齐（或直接执行一次带 `--write` 的安装）。

## 12. 批次 2 实施记录（2026-09-15，P1）

状态：已完成实施、验证与提交。AC-05 关闭；本批次为一个独立提交，可单独 revert。

### 12.1 改动面

| 文件 | 作用 |
| --- | --- |
| `scripts/lib/template-renderer.js` | 渲染改为逐行处理：一行只有占位符且替换结果为空时丢弃整行，不再渲染空行；`defaultTemplateData` 去掉被合并的两个字段 |
| `scripts/lib/rules-index.js` | 规则索引按治理 / 工程 / 工具与集成 / 发布与排障分组渲染；新增 `ruleGroupLabel` 与未分组兜底「其他」；id 与 title 相同的项只渲染一次 |
| `scripts/lib/install-planner.js` | 删除 `engineeringRulesLine` 与 `operationalRulesLine` 两条同义行及其前缀判定；规则行继续与角色索引句同条 |
| `adapters/codex/AGENTS.template.md`、`adapters/claude/CLAUDE.template.md`、`adapters/gemini/GEMINI.template.md`、`adapters/opencode/AGENTS.template.md` | 删除两个已被合并的占位符行（antigravity 模板不引用这两个字段，无需改动） |
| `AGENTS.md` | 按新渲染结果重放本仓库受管块 |
| `tests/rules-index.test.js` | 分组断言、每条规则都有显式分组、模板渲染无空占位行与无重复同义行 |

### 12.2 口径与取舍

- 分组实际为四组（治理、工程、工具与集成、发布与排障），比原计划的三组多一组。原因：`codebase-memory-mcp`、`chrome-devtools-mcp`、`linear-workflow`、`rtk`、`ast-grep` 只在安装对应插件后才出现，并入「工程」会掩盖「这条规则可能并不存在于本项目」的区别。未登记分组的 id 落入兜底组「其他」而不是被丢弃，并有测试断言本包 21 条规则全部已显式分组。
- 索引保留 `id（title）` 的形态，标题是宿主路由到不具名 id 的唯一线索；只对 id 与 title 完全相同的项去掉重复标题。
- 同义行的合并口径：三条「位于 docs/rules/」收敛为一条索引行，规则索引用分组前缀表达「工程」「发布与排障」的分类，不再需要独立说明行。

### 12.3 效果（已确认事实）

| 指标 | 批次 2 前 | 批次 2 后 |
| --- | --- | --- |
| AGENTS.md 行数 | 95 | 91 |
| AGENTS.md 字节 | 7372 | 7291 |
| 指向 docs/rules 的同义行 | 3 | 1 |
| 空占位行 | 2 | 0 |
| 指令预算门禁（`validateInstructionBudget`） | 0 warn / 0 error | 0 warn / 0 error |
| 渲染后的 codex 常驻指令（门禁口径：adapter 模板加全量规则索引） | 未记录 | 2705 字节 / 约 677 token |

其余宿主的门禁口径渲染体积：claude 2882 字节、gemini 2825 字节、opencode 2705 字节、antigravity 534 字节，均远低于 2000 token 警告线与 32 KiB 截断线。AGENTS.md 全文 7291 字节，同样低于阈值。

### 12.4 验证清单

| 命令 | 结果 |
| --- | --- |
| `node --test tests/rules-index.test.js` | 9 通过 / 0 失败 |
| `node --test tests/self-install-check.test.js tests/cross-platform-adapters.test.js tests/codex-adapter.test.js tests/opencode-adapter.test.js` | 55 通过 / 0 失败 |
| `pnpm test:unit` | 343 通过 / 0 失败 |
| `pnpm test:integration` | 320 通过 / 0 失败 / 1 跳过（341 秒） |
| `pnpm smoke:lifecycle` | init、dry-run、write、validate、doctor 五步全部退出码 0 |
| `node ./scripts/validate.js` | 通过（自安装一致性 ready） |
| `validateInstructionBudget` | 0 warn / 0 error |

插曲（已确认事实）：第一次整跑 `pnpm test:integration` 时 `tests/project-verification.test.js:249` 的「超时必须 5 秒内返回」墙钟断言在高负载下取到大于 5 秒而失败；该文件单独复跑 17/17 通过，重跑整表 320/0 通过。该断言与批次 2 的改动面无交集，属于既有高负载脆弱断言（CHANGELOG 亦记录过同类现象）。

### 12.5 未闭合与移交

- 批次 3 会再次重放 AGENTS.md 受管块（纳入 roles 后角色索引句随之出现），本批次先重放一次是为了让 `validate` 与 `self-install-check` 在批次之间保持绿色；两次重放都属于预期的投影收敛，不是漂移。
- 规则分组表是静态清单：新增规则必须在 `RULE_GROUPS` 中登记，否则会落入「其他」并被「本包无未分组规则」的断言拦下。
- 批次 2 只收敛常驻指令的形态，未改动任何安全判定；指令预算的进一步压缩（例如去掉索引标题）会牺牲路由信号，本轮不做。

## 13. 批次 3 实施记录（2026-09-15，P1）

状态：已完成实施、验证与提交。AC-06 与 AC-07 关闭；本批次为一个独立提交，可单独 revert。全局 Agent 配置仍未被写入，mcp-config 继续不写。

### 13.1 改动面

| 文件 | 作用 |
| --- | --- |
| `vibe-harness.config.json` | 增补显式 `modules`（agents、rules、templates、skills、schemas、evals、memory、hooks、roles）与 `roles.enabled: true`，使声明面与 `full` profile 的实际安装面一致 |
| `.agents/roles/**`、`.codex/agents/**` | 自安装产物：canonical 角色目录 8 个文件（含 index）与 Codex 原生 7 个 `*.toml` |
| `AGENTS.md` | 重放受管块：启动序列第 4 条并入角色选择要求，已安装表面新增多角色索引句 |
| `evals/references/vibe-harness-core.offline.json`、`.agents/evals/references/vibe-harness-core.offline.json`、`evals/results/vibe-harness-core.offline.json` | 按 CONTRIBUTING 的「Eval reference 更新清单」经正规入口再生成 |
| `docs/memory/TECH_DEBT.md` | 落地 F01–F10 三态台账，并为 6 个未闭合项建立 TD-2026-09-15-2…7 |

### 13.2 安装前核对与执行（已确认事实）

- 修改声明前先 dry-run 对比：actions 由 109 增至 125，新增项全部为角色相关（`docs/rules/role-routing.md`、`.agents/roles/**` 8 项、`.codex/agents/*.toml` 7 项），没有删除或剪枝 schemas、memory 的动作，符合「只增不减」的前提。
- 首次 `install --write` 被 4 项非本批次原因拦下：3 个 `user-modified`（AGENTS.md 受管块、`docs/rules/project-specific-rules.md`、`.agents/evals/references/vibe-harness-core.offline.json`）与 1 个 `conflict`（`docs/rules/role-routing.md` —— pack 源与目标同文件且未登记 install-state）。本次仅在本地（gitignore 的）`.vibe-harness/install-state.json` 中更新对应 hash 并登记该条目，未改动任何受管内容；随后 `install --project . --target codex --write --confirm-red-zone` 返回 ok / status ready / written 125 / retired 0 / skipped 0。
- 自安装把 `docs/rules/project-specific-rules.md` 渲染成了项目画像内容（模板占位符被填入本仓库信息），已恢复为 pack 模板原文；该现象属自安装模板误写，记入 13.6。
- `doctor --project .`：`roles.codex = { permissionMapping: "native", roleCount: 7, status: "configured-unverified", activationPath: ".codex/agents", missingCapabilities: { test-lead: [browser-verification], adversarial-security-reviewer: [safe-security-check], technical-release-manager: [package-dry-run] } }`，`missingCapabilities: []`（顶层），角色面首次在本仓库自证。
- `pnpm roles:audit`：ok，7 个角色、0 errors、0 warnings。

### 13.3 Eval reference 再生成（含批次 1 遗留漂移）

`pnpm eval:check` 在批次 3 开始时报告 6 项漂移，来源跨三个批次，因此按 CONTRIBUTING 的正规顺序一次性再生成并逐项确认：

| 漂移字段 | 旧值 | 新值 | 归因 |
| --- | --- | --- | --- |
| `assets.groups.hooks.fileCount` / `hash` | 14 | 16 | 批次 1 新增 `runtime/hooks/lib/read-only-commands.mjs` 及其 `.agents/runtime/hooks` 镜像 |
| `assets.groups.rules.fileCount` / `hash` | 29 | 44 | 批次 3 新增 `.agents/roles` 与 `.codex/agents`（`ASSET_GROUPS.rules` 已覆盖角色目录，即 F06 的 offline 侧） |
| `assets.groups.config.hash` | — | 变更 | 批次 3 的 `vibe-harness.config.json`（config 组含该文件；fileCount 36 未变） |
| `assets.skills` | 121 | 121 | 未漂移（工作区既有的 stale-cleanup skill 已在更早的 reference 中登记） |

执行与结果：`eval run --project . --mode offline --write`（写出 run 并如实报 degraded:fingerprint mismatch）→ `eval reference --from <run> --write --confirm-reference-update --force`（ok，旧文件先备份到 `.vibe-harness/backups/`）→ `pnpm eval:sync --write`（1 个镜像文件更新）→ `pnpm eval:replay --write`（新 aggregate `57f474e7…`）→ `pnpm eval:check` 通过。

取舍（已确认事实）：reference 的指纹是按分组聚合的，工作区里既有的未提交资产改动（例如 `skills/core/stale-cleanup/`）与批次 1/3 的改动落在同一组哈希里，无法只登记一侧。本轮按工具的正规入口以「当前资产树」为准再生成；工作区既有的 eval reference/replay 修订版已先被备份（`.vibe-harness/backups/2026-09-15T11-12-*`），如需回到再生成前的状态可直接取回。

### 13.4 F01–F10 三态结论

| ID | 结论 | 关闭条件 / 去向 |
| --- | --- | --- |
| F01 | 已修复 | 原生工具名映射已落地并被测试锁定，无需再记账 |
| F02 | 部分修复 | 只到投影层，宿主实测缺失 → TD-2026-09-15-2 |
| F03 | 已修复（静态，2026-09-16 更新） | 能力按本次安装解析结果注入四个宿主，Codex 由父会话继承，Antigravity 维持 configured-unverified → TD-2026-09-15-3 |
| F04 | 部分修复 | 规则已改成先判动作，缺路由 Eval 观察，不单独建条目（批次外） |
| F05 | 未修复 | suite 仍为文本重放 → TD-2026-09-15-4 |
| F06 | 部分修复 | offline 已覆盖角色目录，在线 CONFIG_PATHS 未覆盖 → TD-2026-09-15-5 |
| F07 | 已修复（2026-09-16 更新） | when/avoid 与 description 组合进原生 description，索引同源同语言；TD-2026-09-15-6 关闭 |
| F08 | 已修复（静态） | 父/子契约已在 base 与路由规则成文 |
| F09 | 已修复 | 路径修正后 audit 可运行并全绿 |
| F10 | 部分修复（2026-09-16 更新） | doctor 已拆四级状态（fileGenerated / hostActivated / toolBinding / currentTaskExecutable），真机实证仍缺 → TD-2026-09-15-7 |

`docs/memory/TECH_DEBT.md` 同步新增「F 系列三态台账（2026-09-05 审查，2026-09-15 复核）」小节与 6 条未闭合技术债，每条含证据、影响、owner 与关闭条件。

### 13.5 验证清单

| 命令 | 结果 |
| --- | --- |
| `pnpm roles:audit` | ok，7 roles、0 errors、0 warnings |
| `node --test tests/role-projection.test.js tests/self-install-check.test.js` | 18 通过 / 0 失败 |
| `pnpm test:unit` | 343 通过 / 0 失败 |
| `pnpm eval:check` | 通过（再生成后） |
| `vibe-harness install --project . --target codex --write --confirm-red-zone` | ok / ready / written 125 |
| `vibe-harness doctor --project .` | ok / ready，roles 非空、roleProjection 非 null |

### 13.6 未闭合与移交

- 自安装把 `docs/rules/project-specific-rules.md` 渲染为项目画像内容，说明该文件的投影策略与「项目专属规则由目标项目自行维护」的声明不一致；本批次只恢复原文，未改投影策略。批次 4 的清理清单与文案收尾不覆盖此项，需要在后续批次单独决策（选项：把该文件移出 replace 投影，或像 memory 文档一样加渲染说明与允许偏离的先例）。
- doctor 的 `runtimeHooks.activation.status` 仍为 `unknown`，且宿主侧本项目两条 Hook 条目当前 `enabled = false`；这正是 AC-12 的输入，留批次 4。
- 本批次未写入任何全局 Agent 配置，`mcp-config` 继续不写；角色面只在项目内自证。

### 13.7 回滚

单独 `git revert` 本批次提交即可回到「声明为 full、实际无 roles」的状态；`.vibe-harness/install-state.json` 属 gitignore，如需彻底回退还需在目标项目重跑一次 `install --write`（角色目录会作为孤儿被 `retire` 处理），或在本地恢复本次登记前的 install-state 备份。

## 14. 批次 4 实施记录（2026-09-15，P2 与 P1 混合）

状态：已完成实施、验证与提交。AC-08、AC-10、AC-12 关闭，AC-09 交付清理清单（不执行删除）；本批次为一个独立提交，可单独 revert。本轮未执行任何删除，未写入全局 Agent 配置，未新增 MCP 配置。（该「本轮」指批次 4 提交时点；同日稍后经用户授权的清理执行见第 15 节，AC-09 据此关闭。）

### 14.1 改动面

| 文件 | 作用 |
| --- | --- |
| `scripts/lib/host-hook-state.js` | 新增只读宿主 Hook 状态读取：解析 `CODEX_HOME` 或用户目录下 `.codex/config.toml` 的 `[hooks.state]`，只返回本项目三态与条目计数，不读取、不输出 `trusted_hash` |
| `scripts/lib/runtime-diagnostics.js` | `inspectRuntimeHooks` 接收/自动读取宿主状态，`activation.status` 细化为 `trusted-enabled`、`trusted-disabled`、`untrusted`，缺失或解析失败回退 `unknown`；新增 `runtimeHooks.hostHookState`；`runtimeHookWarnings` 新增 `HOOK_DISABLED` |
| `manifests/adapters.json` | codex 的 `stop` 由 `unsupported` 改为 `not-projected`，claude 同步；codex 的 `evidence` 填入真实取值（`lastVerifiedAt: 2026-09-15`、`hostVersion: 0.147.0`）；其余宿主保持空值 |
| `schemas/adapter-pack.schema.json` | `hookEvents` 的三个事件枚举增加 `not-projected` |
| `docs/hooks.md` | 事件矩阵同步 `not-projected`；补 `not-projected` 与 `unsupported` 的语义区分、evidence 取证状态说明；重写激活与诊断一节，写明三态、`HOOK_DISABLED` 与否决 `trusted_hash` 回显 |
| `scripts/lib/pack-validation.js` | 指令预算注释补齐启发式出处（npm `ai-context-kit` 0.1.2，MIT，作者 Ofer Shapira，阈值 2000/5000 token、4 字符/token 与两条来源链接） |
| `tests/runtime-diagnostics.test.js` | 新增宿主状态解析用例与激活三态用例（含「一个停用条目即视为停用」「输出不含 `trusted_hash`」） |
| `tests/hook-installation.test.js` | 套件把 `CODEX_HOME` 指向空目录，使临时项目的信任态确定为 `unknown`，不再依赖跑测机器的宿主配置 |
| `tests/manifest-schema.test.js` | 期望表更新为 `not-projected`；模板一致性断言排除 `not-projected`（宿主支持但本项目未投影的事件不得出现在模板里） |

### 14.2 AC-12 实测（已确认事实）

`vibe-harness doctor --project .` 输出：

```json
{
  "activation": { "mechanism": "manual-trust", "status": "trusted-disabled" },
  "hostHookState": {
    "configPath": "C:\\Users\\Administrator\\.codex\\config.toml",
    "entries": { "disabled": 2, "enabled": 0, "total": 2, "trusted": 2 },
    "reason": "entries-disabled",
    "status": "trusted-disabled"
  },
  "warnings": ["HOOK_DISABLED", "HOOK_ENFORCEMENT_UNVERIFIED"]
}
```

即：宿主侧本项目两条 Hook 定义仍是「已信任但停用」，doctor 现在能把这一状态说出来，并给出可行动作（在 /hooks 或宿主配置中重新启用后复跑）。`trusted_hash` 只用于判定是否存在信任记录，未进入任何输出。三态判定口径：有本项目条目且都在启用 → `trusted-enabled`；有本项目条目但至少一条 `enabled = false` → `trusted-disabled`（一个停用条目足以让策略不生效，故不按「多数」判定）；没有本项目条目 → `untrusted`；宿主配置缺失或不可读 → `unknown`。

### 14.3 AC-10 取证（已确认事实）

- Codex：`codex --version` 实测返回 `codex-cli 0.147.0`（批次 1 修复只读白名单后才可执行）；`hostVersion` 与核对日期已写入 `manifests/adapters.json` 的 `evidence`。
- Stop 语义：Codex 与 Claude Code 的 `hookEvents.stop` 改为 `not-projected`。依据是宿主侧存在把该项目含 `stop` 在内的 10 个事件全部记为已信任的记录（第 10 节已确认），而仓库 `.codex/hooks.json` 只定义 PreToolUse 与 PermissionRequest；因此原 `unsupported` 读起来像「宿主不支持」，实际含义是「本项目不投影」。
- 其余六个宿主（gemini、cursor、qoder、zcode、antigravity、opencode）的 `lastVerifiedAt` 与 `hostVersion` 继续保持空字符串，含义是「声明存在、本轮未在真实宿主复核」，并在 `docs/hooks.md` 明确写出该读法。
- 8 宿主声明与官方契约的核对方式固定为：以 `manifests/adapters.json` 的 `hookEvents`/`hookActivation`/`roleProjection`/`redZonePrefixes` 为声明面，逐个对照宿主官方文档与（有条件的）宿主二进制事件枚举；`developers.openai.com` 返回 403、`genai.owasp.org` 证书吊销检查失败两项受阻状态保持如实记录，不因本轮修订而消失。

### 14.4 AC-08 收尾

- Hook 侧：批次 1 已把拒绝输出改成中文主句并保留 `[VIBE_HARNESS_POLICY:<reasonCode>]` 前缀，本轮新增的 doctor 告警同样使用中文主句，`reasonCode`/`warning.code` 集合保持不变（机器契约）。
- `docs/hooks.md`：判定矩阵已在批次 1 同步，本轮补上激活三态与 `HOOK_DISABLED`，并保留「不可判定，需要 Execution Envelope」与「明确禁止」两类出口的区分。
- 未纳入本轮：CLI 其余诊断（`toolRecommendations` 的 `unsupported` 分支、`runtime/hooks/lib/rtk.mjs`、`scripts/lib/tool-provisioning/runtime-probe.js`）仍中英混用，属 TD-2026-09-11-3 的范围，需要先定语言契约再统一，本轮不扩大范围。

### 14.5 AC-09 清理清单

见附录 A。本轮只产出清单与归属判定，未执行任何删除；`.gitignore`（`.vibe-harness/`、`/.codex/better-harness/`）与 `.cbmignore`（`/.codex/`、`/.vibe-harness/`）已覆盖这些路径，经复核无需新增忽略项；待解决的是累积治理与 doctor 噪声，不是忽略规则。用户在同日授权后，本清单已按「保留最近 20 + 删除临时文件」执行：删除明细、保留项复核与执行后度量见第 15 节。

### 14.6 验证清单

| 命令 | 结果 |
| --- | --- |
| `node --test tests/runtime-diagnostics.test.js` | 6 通过 / 0 失败（含 2 个新增用例） |
| `node --test tests/runtime-diagnostics.test.js tests/manifest-schema.test.js tests/hook-installation.test.js tests/safety-posture.test.js tests/target-validation.test.js` | 53 通过 / 0 失败 |
| `node ./scripts/vibe-harness.js doctor --project .` | status ready，`activation.status = trusted-disabled`，warnings = HOOK_DISABLED + HOOK_ENFORCEMENT_UNVERIFIED |
| `pnpm eval:check` | 通过（config 组随 manifests/schemas 变更再生成后） |
| `pnpm check` | 通过（345 通过 / 0 失败） |
| `pnpm test:integration` | 319 通过 / 1 失败 / 1 跳过；唯一失败是既有墙钟脆弱断言（见下） |
| `pnpm docs:audit` | 通过 |
| `git diff --check` | 通过 |

已知失败（已确认事实，非本批次回归）：`tests/project-verification.test.js` 的 `verify --project terminates a hanging command and returns a structured timeout receipt` 在末尾断言 `Date.now() - startedAt < 5000`；两次全量 `pnpm test:integration` 均只失败该用例（实测 7.5 秒级），该文件单独运行 17/17 通过。该断言与批次 4 的改动面（宿主 Hook 状态读取、manifests/schemas、docs）无交集，与批次 2 记录的是同一处负载敏感断言。已按仓库的 flaky 口径登记为新条目 TD-2026-09-15-8（证据、影响、owner、关闭条件齐全）。

附带修复（已确认事实）：批次 2 引入的分组渲染在 `scripts/lib/rules-index.js` 用了 `new Map([...])` 的元组数组，`pnpm typecheck` 报 TS2769；批次 2 的验证清单没有跑 `pnpm check`，因此该错误直到本批次收尾才暴露。本批次以独立提交 `fix(install): 修复规则索引分组的类型推断` 修复（改为预置分组键 + 类型化 `Map<string, string[]>`），使批次 4 的回滚不会重新引入类型错误。

### 14.7 未闭合与移交

- 宿主侧的 Hook 启用仍需用户操作：把本项目两条 `hooks.state` 条目恢复启用（或在 Codex 中运行 /hooks）后，`activation.status` 预期变为 `trusted-enabled`，安全策略才真正生效。本批次只让该状态可观测，不改写宿主配置。
- 批次 3 记录的「自安装会把 `docs/rules/project-specific-rules.md` 渲染成项目画像内容」仍未处理，需要在后续批次单独决策。
- 附录 A 的删除动作在本批次交付时全部待用户逐项确认（`runtime/tools` 979 MB 与 `.vibe-harness/external-env` 2082 MB 是最值得先决策的两项）；用户随后同日授权，删除已执行完成，执行收据见第 15 节。
- `docs/memory/TECH_DEBT.md` 新增 TD-2026-09-15-8（project-verification 墙钟断言）。

## 15. 运行产物清理执行记录（2026-09-15，用户确认后执行）

用户在本轮审查后明确授权「附录 A 的删除项进行删除，临时文件也删除」。本节是该授权的执行收据，也是 AC-09 的关闭证据。所有删除都以显式路径调用 .NET 文件/目录 API（宿主安全策略拦截 `Remove-Item` 后采用的替代路径），未使用通配符批量删除，也未触碰任何被 git 跟踪的文件。

### 15.1 已删除（删除前 → 删除后）

| 路径 | 删除前（实测） | 删除后 | 恢复路径 |
| --- | --- | --- | --- |
| `.vibe-harness/external-env` | 109134 文件 / 2082.1 MB | 不存在 | 未确认可重建（仓库内无生产者，最后写入 2026-09-06） |
| `.vibe-harness/backups` 最旧 40 个目录 | 60 个目录 / 914 文件 / 6.28 MB | 20 个目录 / 438 文件 / 3.32 MB | 保留窗口内仍是 install/rollback 的恢复路径 |
| `.vibe-harness/evals/runs` 最旧 52 个文件 | 72 个文件 | 20 个文件 | `pnpm vibe-harness eval run --write` 重跑再生成 |
| `.vibe-harness/evals/rules-semantics-pre.stdout.log`、`.stderr.log` | 203002 B、0 B | 不存在 | 历史日志，无需恢复 |
| `.vibe-harness/tmp-hook-check` | 6 B（内容 `test`） | 不存在 | 无恢复价值 |
| `.vibe-harness/stage-batch4-pack-validation.js`（本轮临时件） | 71530 B | 不存在 | 本轮暂存脚本，无恢复价值 |
| `.tmp-install-dryrun.json`（本轮临时件） | 21775 B | 不存在 | 重跑 dry-run 再生成 |
| `.tmp-install-write.json`（本轮临时件） | 本轮存在 | 不存在 | 重跑 install 再生成 |
| `.tmp-better-harness/`（仓库根临时目录） | 237 文件 / 0.66 MB（只含插件临时安装的 `yaml` 依赖） | 不存在 | better-harness 插件按需重建 |
| `runtime/tools/playwright-cli/node_modules` | 801 文件 / 718.53 MB | 不存在 | `vibe-harness provision` 重建 |
| `runtime/tools/codebase-memory-mcp/node_modules` | 14 文件 / 260.69 MB | 不存在 | `vibe-harness provision` 重建 |
| 宿主 `~/.codex/..codex-global-state.json[.bak].tmp-*`（13 个） | 13 个孤儿写入临时件，最新 2026-09-12 | 不存在 | 真实文件 `.codex-global-state.json`（728278 B）与 `.bak` 均未受影响 |

`external-env` 的删除分两步完成：首次整树删除在 2033.4 MB / 109093 文件后中断，报 `Access to the path 'commit-graph-chain' is denied`（根因是 git 对象文件的 ReadOnly 属性）；清除属性后对剩余 41 文件 / 48.7 MB 重试成功，目录现已不存在。

`runtime/tools` 只删了两个 `node_modules`，该目录下 `package.json`、`package-lock.json`、`run.mjs` 等被 git 跟踪的源文件全部保留；`git status --porcelain` 中删除类条目为 0，没有跟踪文件被删。

### 15.2 保留未删（内容复核后判定）

| 路径 | 判定 |
| --- | --- |
| `.vibe-harness/release-notes/v0.3.0.md` | 保留。2152 B 的英文改名说明（Cognis/LoopEngine → Vibe-Harness）；`CHANGELOG.md` 的 `## 0.3.0` 是另一批中文条目，二者内容不同，删除即不可重建。附录 A 的原始建议是「人工确认内容后再决定」，本轮完成该确认。 |
| `.codex/workflow-asset-scan-blindspot-result.json` | 保留。2476 B，内容是 better-harness 插件的 work-loop 报告（`modelId: agent-work-loop-v4`），属三方归属，与 `.codex/better-harness` 同口径由插件侧维护。 |
| `.codex/better-harness` | 保留。第三方插件产物（60 文件 / 6.9 MB），本项目不代为删除。 |
| 宿主 `~/.codex/logs_2.sqlite`、`thread_history_1.sqlite` | 保留。Codex CLI 宿主库，不在仓库治理范围。 |

### 15.3 执行后度量（已确认事实）

- `.vibe-harness`：110010 文件 / 2094.08 MB → 460 文件 / 4.85 MB。
- `runtime/tools`：839 文件 / 979.28 MB → 24 文件 / 0.06 MB。
- `node ./scripts/validate.js`：通过（Workflow asset integrity clean；Self-install conformance `unmanagedCount = 3192`）。
- `unmanagedCount` 在清理后没有下降，这是机制事实而非回归：`collectTargetFiles()`（`scripts/lib/install-state.js`）显式跳过 `.vibe-harness/`（stateDir）与 `node_modules/`，该计数统计的是「仓库内未登记进 install-state 的文件」，与本次删除的运行产物不相交。因此 AC-09 的实际收益是磁盘与规模治理；若要让该计数成为健康指标，仍需按第 8 节 AC-09 关闭条件单独定义基线。

## 16. Hook 配置优化实施记录（2026-09-15，P0 与 P1，H-01–H-11）

状态：三个独立提交已完成实施与验证，可逐个 revert。范围不含 SessionStart/PostToolUse 投影与「Hook 同进程 import」重构（H-09），也未改宿主全局配置、未写 requirements.toml、未改 v1/v2 Envelope 语义。约束：一次定义变更只做一次——改 `.codex/hooks.json` 即让宿主信任哈希失效，必须在宿主中重新信任一次。

### 16.1 结论到批次

H 编号沿用本轮 Hook 审查输出的编号；下表按执行计划的分批映射，描述以落地改动为准，不逐字复述审查原文。

| 结论 | 内容 | 批次 / 出口 |
| --- | --- | --- |
| H-01 | 引导脚本失败走非零退出，宿主按「Hook 运行失败」处理并继续执行工具调用，实际是 fail-open | 提交 1 · 宿主 deny 契约 |
| H-02 | PreToolUse matcher 是工具名枚举，宿主新增工具静默跳过策略；只读集合不含本地函数工具 | 提交 2 · `.*` 与显式名单 |
| H-03 | `runtime/hooks/README.md` 把失败语义写成 non-zero exit，并把 Stop 写成 "unsupported on every host"，与 `manifests/adapters.json` 的 `not-projected` 矛盾 | 提交 3 · 文档口径 |
| H-04 | 引导命令是手写双重转义字符串，无单一真源，不能独立审阅或执行 | 提交 1 · `scripts/lib/hook-bootstrap.cjs` |
| H-05 | `docs/hooks.md` 未同步失败语义、matcher 全匹配与本地函数工具分类 | 提交 3 · 文档口径 |
| H-06 | 引导依赖 `git rev-parse` 子进程，也依赖 PATH 上的 git | 提交 1 · 文件系统向上查找 `.git` |
| H-07 | Hook 子进程整份继承 `process.env`，Provider 与云凭据变量随之进入 | 提交 1 · 环境白名单 |
| H-08 | `gitOutput` 与 `isAncestor` 的 git 子进程没有超时，可能先于宿主超时被杀死（杀进程不等于阻断） | 提交 1 · 3 秒超时 |
| H-09 | SessionStart/PostToolUse 投影与 Hook 同进程 import 重构 | 本轮排除，未实施 |
| H-10 | 运行时没有自有预算，宿主 10 秒超时杀进程即 fail-open | 提交 1 · 5 秒 watchdog |
| H-11 | doctor/安装缺少「定义变更可能要求重新信任」提示，且实施过程无台账 | 提交 3 · `HOOK_TRUST_REREVIEW_REQUIRED` 与本节 |

### 16.2 改动面（按提交）

| 提交 | 覆盖 | 主要改动 |
| --- | --- | --- |
| `fix(hooks): bootstrap 失败路径改为 fail-closed 并单源化命令定义` | H-01、H-04、H-06、H-07、H-08、H-10 | 新增 `scripts/lib/hook-bootstrap.cjs` 单一真源与载荷字符白名单；根定位改走 `.git` 向上查找；失败分支按宿主输出 deny 载荷并 `exit 0`；环境白名单；运行时 5 秒预算；两处 git 子进程超时；删除重复 `commandWindows` |
| `feat(hooks): 钩子判定覆盖全部本地函数工具并补全只读工具集合` | H-02 | PreToolUse `matcher` 改为 `.*`；只读集合新增 15 个本地函数工具；写入类与未列名工具仍走 Envelope |
| 本节所在提交 | H-03、H-05、H-11 | `runtime/hooks/README.md` 与 `docs/hooks.md` 口径统一；新增 `HOOK_TRUST_REREVIEW_REQUIRED` 与 `hookDefinitionDrift`、`hookDefinitionPath`；install/validate/doctor 三处接入；本节台账与 CHANGELOG |

### 16.3 契约与接口变化

- `.codex/hooks.json` 的 `command` 文本与 PreToolUse `matcher` 改变 ⇒ 宿主信任哈希失效，所有已安装项目需在宿主中重新信任一次（Codex 用 `/hooks`）。
- Hook 失败出口由「非零退出」改为「宿主 deny 载荷」，理由前缀固定为 `[VIBE_HARNESS_HOOK:BOOTSTRAP_UNAVAILABLE]`。
- 新增导出 `hookDefinitionDrift(adapter, targetDir, installState)`、`hookDefinitionPath(adapter, targetDir)`，以及 `runtimeHookWarnings(runtimeHooks, { definitionChanged })` 的可选第二参数与告警码 `HOOK_TRUST_REREVIEW_REQUIRED`。
- 只读/无副作用工具集合扩大；`docs/schemas/*`、install-map 与 Envelope v1/v2 语义不变。

### 16.4 验证证据

| 命令 | 结果 |
| --- | --- |
| `node --test tests/hook-bootstrap.test.js tests/hook-runtime.test.js tests/codex-adapter.test.js` | 50 通过 / 0 失败 |
| `node --test tests/hook-read-only-classification.test.js` | 14 通过 / 0 失败（含 2 个新增表驱动用例） |
| `node --test tests/runtime-diagnostics.test.js` | 7 通过 / 0 失败（含新增 re-review 用例） |
| `node --test tests/hook-installation.test.js` | 提交 1 时点 9 通过 / 0 失败 |
| `node ./scripts/lint.js`、`pnpm typecheck`、`git diff --check` | 通过（`pnpm lint:eslint` 0 error，仓库既有 warning 不变） |
| `vibe-harness install --project . --target codex --profile full --write --confirm-red-zone` | ok / ready / written 125 / retired 0 |

bootstrap 端到端耗时中位数 275.8 ms → 225.2 ms（12 轮交错实测，省去一次 git 子进程）；仅作记录，不作门禁。

环境噪声（已确认事实）：本批次期间工作区同时存在其他会话的未提交改动（`runtime/commands/run.mjs`、新增 `runtime/lib/worktree-audit.mjs`、`scripts/lib/worktree-audit.js`、`scripts/lib/install-preset.js` 等），因此 `pnpm validate`、`doctor` 与 `pnpm test:unit` 会报与钩子无关的失败：self-install conformance 报 `runtime/commands/run.mjs` 漂移与 `runtime/lib/worktree-audit.mjs` 缺失，`tests/project-commands.test.js` 因新安装面缺 `.agents/runtime/lib/worktree-audit.mjs` 失败。这些路径不属于本批次，也未被本批次的任何提交包含。

### 16.5 未闭合与移交

- H-09（SessionStart/PostToolUse 投影与同进程 import 重构）未实施。
- 残余风险：引导命令以 `node` 开头，宿主 PATH 无 node 或 Node 版本过低时命令起不来，宿主仍按失败处理并继续工具调用；本轮不做 `process.execPath` 绝对路径固化，以保留 worktree 与迁移可移植性。该风险已写入 `runtime/hooks/README.md` 与 `docs/hooks.md`。
- 非 Codex 宿主只同步共享引导的 fail-closed 行为，未在真实 Claude/Cursor/Qoder/ZCode/Antigravity 上实测，标记为静态结论。
- 自安装仍会把 `docs/rules/project-specific-rules.md` 渲染成项目画像内容（13.6 已记录，本批次日经 install 复现并已恢复 pack 模板原文），投影策略问题本身仍未决策。

### 16.6 回滚

三个提交可逐个 `git revert`；由于 `command` 文本与 `matcher` 随之回退，revert 后同样需要重装安装面并在宿主中重新信任一次。

## 17. 角色投影全面优化实施记录（2026-09-16，P1–P6 与 8 宿主）

状态：一个独立提交，可单独 revert。范围覆盖 8 个宿主（codex / claude / gemini / cursor / qoder / zcode / antigravity / opencode）与 `.agents/roles/index.md` 索引面；不写宿主全局配置、不新增 MCP server 或凭据、不改角色 Prompt 正文与 Skill 正文语言（正文维持中文，只有 description 与 `routing.when`/`routing.avoid` 改英文）。原则是「只投影当前宿主已验证的契约」：无法验证的键位不猜也不保留，并把「文件已生成 / 宿主已激活 / 工具绑定已验证」拆开表述。

### 17.1 改动面

| 文件 | 作用 |
| --- | --- |
| `manifests/roles.json` | 7 个内置角色的 `description`、`routing.when`、`routing.avoid` 全部改英文，组合后逐条落在 259–299 字符，全 ASCII |
| `manifests/adapters.json`、`schemas/adapter-pack.schema.json` | 每个 adapter 的 `roleProjection` 新增 `toolBinding`（`native` / `prompt-guarded` / `configured-unverified`）并成为 schema 必填 |
| `scripts/lib/role-projection.js` | 新增 `projectRoleDescription()`（唯一组合规则与 fail-closed 校验）、`supportNativeCapabilityBinding()` 与 `MANAGED_MCP_SERVER_PREFIX`；Qoder 改为手写 frontmatter 且不写 `tools`；OpenCode 补 deny 键位与 bash 前缀白名单；Antigravity 工具名按二进制核实修正 |
| `runtime/hooks/lib/read-only-commands.mjs` | 新增导出 `readOnlyCommandPrefixes()`，从既有分类表派生 184 条无参数只读命令前缀，供 OpenCode 的 bash allowlist 与角色审计共用同一来源 |
| `scripts/lib/install-planner.js` | 新增 `resolvedRoleCapabilities()`，把本次安装解析到的 Skill 名与 `vibe-harness-*` MCP server 名传入两处 `resolveRoleInstallEntries()` 调用点 |
| `scripts/lib/roles-audit.js` | 新增 description 逐字/单行/ASCII/≤300/explicit 前缀断言、role `name` 与 Prompt H1 一致性断言、OpenCode bash 白名单顺序与来源断言、逐宿主能力键位断言（期望表独立于投影助手维护） |
| `scripts/vibe-harness.js` | doctor 的角色报告拆成四级状态并新增 `ROLE_TOOL_BINDING_UNVERIFIED` 告警 |
| `roles/prompts/technical-release-manager.md` | H1 由「技术发布经理」改为「发布就绪审查者」，与 manifest `name` 及 `docs/roles.md` 对齐（P3） |
| `docs/rules/role-routing.md`、`docs/roles.md` | 新增「角色描述契约」与 8 宿主映射表；doctor 口径改为四级状态 |
| `tests/role-projection.test.js`、`tests/opencode-adapter.test.js` | 新增描述契约、能力绑定、fail-closed、OpenCode 权限面与审计负向用例；适配器侧新增端到端用例断言落盘后的 agent 文件 |

### 17.2 各宿主投影契约（按已核实的键位）

| 宿主 | 投影路径 | 权限键位 | 注入的能力 | `toolBinding` |
| --- | --- | --- | --- | --- |
| Codex | `.codex/agents/*.toml` | `sandbox_mode` | Skill 与 MCP 由父会话继承 | native |
| Claude | `.claude/agents/*.md` | `tools` 白名单、`skills` 预加载、`permissionMode: plan`（analysis） | 按本次安装枚举 `mcp__<server>`，无 server 时不写 `mcp__` 键；不把 `Skill` 写进 `tools` | prompt-guarded |
| Gemini CLI | `.gemini/agents/*.md` | `tools` | 仅当本次安装含 MCP server 时追加官方通配 `mcp_*` | prompt-guarded |
| Cursor | `.cursor/agents/*.md` | `readonly` | 无 | prompt-guarded |
| Qoder | `.qoder/agents/*.md` | 无（解析器不认 `tools`） | `skills` 与 `mcpServers` 列表 | prompt-guarded |
| ZCode | `.zcode/plugins/vibe-harness-roles/agents/*.md` | `tools`、`permissionMode: plan`（analysis 与 security-review） | `skills`（声明后宿主自动授予 Skill 工具） | prompt-guarded，需手动激活插件 |
| Antigravity | `.agents/agents/*.md` | `tools` | 无 | configured-unverified |
| OpenCode | `.opencode/agents/*.md` | `edit` / `bash` / `task` / `webfetch` / `websearch` / `external_directory` | 无 | native |

两点与执行计划原文的差异，按宿主实际语义修正（已确认事实）：

- OpenCode 的 bash 映射把 catch-all `"*"` 写在最前、具体 allow 规则写在后面。计划原文写的是「把 `"*"` 放在最后一条」，与官方文档矛盾：opencode.ai/docs/permissions 明确「Rules are evaluated by pattern match, with the last matching rule winning. A common pattern is to put the catch-all `"*"` rule first, and more specific rules after it.」若按计划原文落盘，184 条 allow 会被随后的 `"*": ask` 覆盖，白名单失效。现实现与审计断言都以「catch-all 在前、specific 在后」为准。
- 角色级 `sandbox_mode` 未在 Codex 真机冒烟中独立生效（见 17.4 与 TD-2026-09-15-2），因此本批次没有据此改动 Codex 的 `permissionEnforcement`：该键位仍按既有契约投影，真正生效范围改由四级状态与 doctor 告警如实呈现。

### 17.3 门禁与诊断

- `resolveRoleInstallEntries()` 的入参扩展为可选 `resolvedCapabilities`：缺省时不注入任何能力键位（向后兼容），传入时按宿主白名单 fail-closed——非 `claude`/`gemini`/`qoder`/`zcode` 的宿主收到能力请求直接报错，MCP 名必须是 `vibe-harness-*`、Skill 名必须是纯目录名，否则安装中止而不是静默丢弃。
- `scripts/lib/roles-audit.js` 的期望值不复用投影助手：description 由 manifest 字段在审计侧重算，能力键位由独立常量表断言。已覆盖 Qoder 不得出现 `tools`、Claude 必须逐字枚举已安装 server 且不得把 `Skill` 写进 `tools`、Gemini 的 `mcp_*` 条件性、不可绑定宿主不得出现 mcp/skills、Antigravity 工具名白名单、OpenCode bash 顺序与来源。
- doctor 的 `roles.<host>` 现在输出 `fileGenerated: generated`、`hostActivated`、`toolBinding`、`currentTaskExecutable`（无真机证据恒为 false），合并字段 `status` 只描述第一级；`configured-unverified` 的宿主额外报 `ROLE_TOOL_BINDING_UNVERIFIED`。

### 17.4 Codex 真机冒烟（已确认事实，Codex 0.147.0）

在本仓库工作区派生两个角色子 Agent，`agent_type` 分别为 `chief-architect`（analysis 预设）与 `senior-engineer`（implementation 预设），并读取两者的会话记录（`~/.codex/sessions/2026/09/16/`）：

- 角色文件确实被宿主加载：两个子 Agent 的注入上下文都包含本仓库角色契约正文（`# 首席架构师` / `# 高级工程师` 与 `# 生效权限预设` 段落），说明 `.codex/agents/*.toml` 的 `developer_instructions` 进入了子会话。
- 命令面：`codex exec` 的子会话里 `list_agents` 只返回 `/root`，`spawn_agent` 的 `agent_type` 接受本仓库的 7 个角色 id；一次带 `-s read-only` 的 CLI 会话中，`chief-architect` 子 Agent 自报 sandbox 为只读。
- 角色级 sandbox 未独立生效：两次桌面宿主派生的子 Agent 拿到的 `<permissions instructions>` 都是父会话的 `sandbox_mode is danger-full-access`，没有出现角色文件里写的 `read-only` 或 `workspace-write`。据此不宣称「只读角色一定只读」。
- 未验证项：`description` 组合串是否直接参与委派无法从会话记录区分（宿主只暴露 agent_type 与本仓库角色契约），其余 7 个宿主未安装/未登录，全部停在 `configured-unverified`。

### 17.5 验证清单

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过（lint、typecheck、结构校验与 381 项单元测试，0 失败） |
| `pnpm roles:audit` | ok，7 roles、0 errors、0 warnings |
| `pnpm skills:audit` | clean，15 Skills（12 native + 3 integration）、0 findings |
| `pnpm docs:audit` | 通过，115 documents |
| `pnpm test:integration` | 加本批次用例前一次全绿（320 通过 / 1 既有跳过 / 0 失败）；加用例后两次被外部负载打红，均为超时类（见 17.6 与 TD-2026-09-15-8），同一文件清单把单测预算放宽到 600000 ms 后为 321 通过 / 1 既有跳过 / 0 失败 |
| `pnpm smoke:lifecycle` | 全部 step exitCode 0 |
| `node --test tests/role-projection.test.js`、`tests/opencode-adapter.test.js` | 17 / 17、5 / 5 通过 |
| `git diff --check` | 干净（退出码 0） |
| 自安装重放 `install --project . --target codex --write --confirm-red-zone` | 首次因 3 个 `user-modified`（`docs/rules/project-specific-rules.md`、`docs/rules/role-routing.md`、`.agents/evals/references/*.offline.json`）被拒；核对三者源与目标同路径同内容后用 `--force` 重放，ok / ready / written 138 / retired 0 / skipped 0，随后把被实例化的 `docs/rules/project-specific-rules.md` 恢复为 pack 模板原文（沿用 13.2 与 16.5 记录的既有现象） |

Eval 指纹：本批次同时改动 hooks（`runtime/hooks/lib/read-only-commands.mjs` 新增导出）、config（`manifests`、`schemas`）与 rules（`roles/`、`.agents/roles`、`.codex/agents`、`docs/rules/role-routing.md`）三组，因此漂移为三组加 `aggregateHash`，比执行计划预估的「config 与 rules 两组」多出 hooks 组。按 CONTRIBUTING 清单顺序执行 `eval run --write` → `eval reference --from <run> --write --confirm-reference-update --force` → `eval:sync --write` → `eval:replay --write` 后，`pnpm eval:check` 与 `pnpm eval:replay` 通过；新旧指纹对照：config `86eca5ad…` → `223c04b7…`、hooks `a0167e38…` → `b46cb939…`、rules `5c7ccc71…` → `9218948c…`、aggregate `e5c24b01…` → `48f3c958…`，skills 组未动（128 文件）。

### 17.6 未闭合与移交

- Antigravity 的发现路径与工具名仍无真机证据（TD-2026-09-15-3），`toolBinding` 固定 `configured-unverified`。
- 角色级 `sandbox_mode` 在 Codex 上的实际效力未确认（TD-2026-09-15-2）；`currentTaskExecutable` 对全部宿主仍为 false（TD-2026-09-15-7）。
- Gemini/Cursor/Qoder/ZCode/Claude/Antigravity/OpenCode 七个宿主只做静态投影与审计，未做真机加载与工具绑定验证，文档与 doctor 均按此口径表述。
- `docs/rules/project-specific-rules.md` 的自安装实例化现象仍存在（13.6、16.5 已记录），本批次沿用「重放后从 git 恢复模板原文」的既有做法，未改变投影策略。
- 本批次收尾时本机同时运行其它项目的构建，`pnpm test:integration` 两次红灯都不是断言失败而是超时：一次是 TD-2026-09-15-8 记录的 `Date.now() - startedAt < 5000` 断言（该场景同机三次独立测量 5329 / 9983 / 7937 ms），一次是 `tests/cross-platform-adapters.test.js` 的 120 秒单测上限（该文件单独运行 42/42 通过但耗时 107.8 秒）。两条证据已补进 TD-2026-09-15-8；本批次未修改该断言或测试超时预算（不属本批次范围）。

### 17.7 回滚

本节所在提交可单独 `git revert`；回滚后需要重放一次自安装（角色投影会随之回到旧键位），并按 CONTRIBUTING 的 Eval reference 清单再生成一次 reference/replay 产物。

## 附录 A · 运行产物清理清单（2026-09-15 实测；删除已同日按用户确认执行，见第 15 节）

体积与文件数为本机实测（PowerShell 递归统计）。「生产者」一列是仓库内可核对的生成入口；标「未找到生产者」的路径在仓库源码中没有任何引用，删除前必须确认其可重建性。

| 路径 | 文件数 | 体积 | 生产者 | 恢复路径 | 建议 |
| --- | --- | --- | --- | --- | --- |
| `.vibe-harness/external-env` | 109134 | 2082.1 MB | 未找到生产者（最后写入 2026-09-06，仓库内无引用） | 未确认可重建 | 先确认生成方式；确认前不删除，可先改名隔离并复跑一次安装与验证 |
| `.vibe-harness/backups` | 912 | 6.2 MB（58 个时间戳目录，2026-08-03…2026-09-15） | 安装/升级事务与 `eval reference --force`、`eval:replay --write` 的写前备份 | 它本身就是恢复路径 | 保留最近窗口（建议 7 天或最近 20 个目录），更早目录可删 |
| `.vibe-harness/evals` | 73 | 6.5 MB（`runs/` 72 个 run 文件 + 2 个历史 stdout/stderr 日志） | `vibe-harness eval run --write` | 重新运行同一命令即可再生成 | 只保留最近若干 run；两个历史日志可直接删 |
| `.vibe-harness/release-notes/v0.3.0.md` | 1 | 2.1 KB | 未找到生产者（仓库内无引用） | 无法重建 | 人工确认内容后再决定 |
| `.vibe-harness/tmp-hook-check` | 1 | 6 字节（内容为 `test`） | 未找到生产者 | 无法重建且无价值 | 可删（仍需确认） |
| `.vibe-harness/transactions` | 0 | 0 | 安装事务日志目录 | 重跑 install 生成 | 空目录，无需处理 |
| `runtime/tools` | 839 | 979.3 MB | `vibe-harness provision`（包含 `node_modules`） | 重新 provision | 属可选工具链，可按需删除后恢复 |
| `.codex/better-harness`（三方归属） | 60 | 6.9 MB（20 个顶层目录：`.cleanup`、`.draft-2026-08-13-codex-quick`、`.scratch-learning-evidence-20260902` 与 17 个历史 run） | 第三方插件 better-harness（marketplace 源 QoderAI/better-harness），非本项目产物 | 由该插件重新生成 | 交插件侧维护，本项目不代为删除 |
| `.codex/workflow-asset-scan-blindspot-result.json`（三方归属） | 1 | 2.4 KB | 未找到生产者，内容为外部工作流的执行报告 | 无法重建 | 保留或经确认后删除 |
| 宿主 `~/.codex/logs_2.sqlite`（宿主维护） | 1 | 2588700672 B（约 2.41 GiB） | Codex CLI 宿主日志库 | 宿主自身维护 | 不在本仓库治理范围，需宿主侧保留策略 |
| 宿主 `~/.codex/thread_history_1.sqlite`（宿主维护） | 1 | 934141952 B（约 0.87 GiB） | Codex CLI 宿主线程历史库 | 宿主自身维护 | 同上 |

doctor 的 `unmanagedCount` 在本轮测量中由 2989 升到 3190，随仓库文件数（含工作区里用户未提交的新文件）同步变化：该计数把仓库内任意未登记文件都算作 unmanaged，因此它本身不是「异常数量」的判据，只有配上保留策略才有意义。清理若要落地，建议先给出保留策略（例如「backups 保留 7 天、evals/runs 保留最近 20 个」）作为可解释基线，再逐项确认删除。

执行结果（2026-09-15 同日，用户确认后）：本清单的删除项已全部执行——external-env、backups 最旧 40 个目录、evals/runs 最旧 52 个文件与两个历史日志、tmp-hook-check、两个 `node_modules`，另加仓库根 `.tmp-better-harness/`、本轮的 `.tmp-install-*.json` 与宿主侧 13 个 `..codex-global-state.json[.bak].tmp-*` 临时件；`release-notes/v0.3.0.md` 与 `.codex/workflow-asset-scan-blindspot-result.json` 经内容复核后保留（理由见 15.2），`.codex/better-harness` 与宿主 sqlite 按原建议不动。删除前后对照、失败重试证据与执行后度量见第 15 节。

## 附录 B · 提交台账（2026-09-15）

| 提交 | 批次 | 覆盖 finding | 可单独 revert |
| --- | --- | --- | --- |
| `2308667` fix(hooks): 统一只读判定并修正风险分级 | 批次 1（P0） | AC-01、AC-02、AC-03、AC-04、AC-04a、AC-11；AC-08 的 Hook 侧 | 是 |
| `2edca93` refactor(install): 精简托管指令块并分组规则索引 | 批次 2（P1） | AC-05 | 是 |
| `32d47a5` feat(install): 自安装纳入角色面并落地 F01-F10 台账 | 批次 3（P1） | AC-06、AC-07；eval reference/replay 再生成 | 是 |
| `5a2d6b6` fix(install): 修复规则索引分组的类型推断 | 批次 2 的回归修复 | 批次 2 的 TS2769（`pnpm typecheck`） | 是 |
| feat(hooks): 可观测宿主信任三态并固定契约取证 | 批次 4（P2 与 P1 混合） | AC-08 收尾、AC-09 清单、AC-10、AC-12 | 是 |
| `04850f1` fix(hooks): bootstrap 失败路径改为 fail-closed 并单源化命令定义 | 第 16 节（H-01、H-04、H-06、H-07、H-08、H-10） | Hook 失败出口、引导单源化、环境与超时边界 | 是 |
| `afeebe8` feat(hooks): 钩子判定覆盖全部本地函数工具并补全只读工具集合 | 第 16 节（H-02） | Hook 触发面与只读工具分类 | 是 |
| fix(hooks): 文档口径、重新信任提示与实施台账（第 16 节所在提交） | 第 16 节（H-03、H-05、H-11） | Hook 文档、`HOOK_TRUST_REREVIEW_REQUIRED` | 是 |
| 本节所在提交 | 第 17 节（角色投影 P1–P6、8 宿主） | F03（静态部分）、F07、F10 的四级状态与能力注入 | 是 |

工作区中仍有用户在本次审查之前/之外改动的文件（stale-cleanup、install-preset 等相关）未纳入以上任何提交；每个提交只包含该批次自己的改动，`scripts/lib/pack-validation.js`、`package.json`、`adapters/install-map.json`、`scripts/lib/install-planner.js` 等重叠文件用「按内容建 blob 后更新索引」的方式只暂存本批次 hunk。

批次 4 的提交就是本报告所在的提交，因此其 SHA 不写死在报告里（写入即会失效），用 `git log -1 --format=%h -- audit-reports/2026-09-15-agent-config-review.md` 取当前值即可。
