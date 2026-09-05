# Harness Agent / Subagent 能力设计全面审查

审查日期：2026-09-05（Asia/Shanghai）

源码基线：`feeff1004ef7a001756e5605b689114371dc7206`，审查开始时工作区干净。

方法：源码与规则审查、宿主官方契约核对、本地聚焦测试、隔离临时目录中的最小探针。未启动真实宿主任务或在线模型评测。

执行判定：直接实施审查；仅交付报告，不修改角色、运行时、安装状态或 Eval reference。

## 1. 结论

**当前 Harness 有较完整的主 Agent 治理规则，也有七个不同的专业视角，但尚不能把七个角色视为跨八种宿主均可独立完成职责的执行单元。** 最突出的问题出在角色职责、实际工具、权限和行为证据之间的连接，而非角色数量不足。

发现 **10 项主要问题：6 项 P1、4 项 P2**。P1 表示会阻断所宣称职责、错误分配执行责任或削弱关键能力证据，应优先处理；不等于已经在生产发生事故。每项都区分已确认的生成/源码事实与尚未实测的宿主行为。

- Gemini、Antigravity 的原生角色使用了与官方契约不一致的工具名。
- 验证类权限在不同宿主上同时存在过度限制和限制不足：OpenCode 拒绝验证所需命令，Codex/Cursor 未给项目内验证产物明确写入路径，部分宿主则直接开放通用 Bash。
- 专业角色没有可靠接通其依赖的 MCP/Skill 能力；安装工具不等于角色可调用工具。
- 按“安全、发布、公共契约”等主题优先路由，可能把明确的实现动作交给只读角色。
- 10 个角色 Eval 在零工具事件、零产物情况下，仅返回预置答案就全部通过；角色正文变化又不进入当前资产指纹。

建议保留专业知识，精简默认独立 Agent：**产品澄清和任务编排并入主 Agent；实现、架构咨询、安全审查、独立验证作为按需子任务；发布角色明确为可选的就绪审查者。** 不新增万能协调者、通用 Reviewer 或强制七阶段流水线。

### 证据边界

| 标签 | 本报告的含义 |
|---|---|
| 已确认事实 | 本轮读取的源码、实际生成结果或命令输出直接支持 |
| 静态结论 | 根据当前实现和公开契约推导；未证明模型一定如此行动 |
| 待验证假设 | 尚需真实宿主或场景实测；不能用于能力通过声明 |
| 验证受阻 | 检查未有效执行，不据此推断产品通过或失败 |

本地选定测试共 **168 项：166 通过、2 失败**；另外 `pnpm roles:audit` 因路径错误退出。审查已完成不代表被审查系统通过；测试明细见第 8 节。

## 2. 当前能力清单与真实调用路径

### 2.1 四层不能混同

| 层次 | 本轮确认的状态 | 能说明什么 |
|---|---|---|
| 产品声明 | 7 个角色、5 个权限预设、8 个 adapter | 仓库声明了这些能力 |
| 安装/生成 | 聚焦测试覆盖七个角色的八宿主投影、profile、自定义配置、冲突与部分生命周期 | 能生成受管文件；不证明宿主接纳工具名或实际调用成功 |
| 当前仓库安装 | 配置为 full/Codex；无 `.agents/roles`、`.codex/agents`、`docs/agent-roles`，本次指定位置亦无 install-state | 当前目录不能提供七个本地原生角色文件；不推断历史安装或全局配置状态 |
| 当前会话可调用入口 | 宿主暴露 default、worker、explorer 和 codebase-memory 系列类型；未在类型目录暴露这七个产品角色 ID | 可调用的宿主能力不能被当作 Harness 角色已安装的证明 |

来源：[角色清单与预设](/Users/hsy/Documents/Github/Vibe-Harness/manifests/roles.json:4)、[宿主声明](/Users/hsy/Documents/Github/Vibe-Harness/manifests/adapters.json:5)、[当前项目配置](/Users/hsy/Documents/Github/Vibe-Harness/vibe-harness.config.json:1)、[八宿主投影测试](/Users/hsy/Documents/Github/Vibe-Harness/tests/role-projection.test.js:214)。安装目录状态由本轮 filesystem 探针核对，没有读取 Memory body 或全局凭据配置。

### 2.2 从定义到执行

`profile/modules/roles 配置 → resolveModuleSelection → createInstallPlan → resolveRoleInstallEntries → canonical Prompt + 原生投影 → 项目受管文件 → 宿主发现/用户激活 → 父 Agent 决定是否委派`。

- full 默认包含 roles；显式 modules 是最终选择，冲突会拒绝。roles 依赖 agents、rules，不保证包含 Skills 或浏览器/知识图谱插件。
- 父 Agent 角色视角通过读取对应 Markdown 生效；原生子 Agent 则通过宿主注册文件生效。前者改变当前上下文，后者具有独立上下文及启动时的工具权限。
- 本仓库交付合同、安装器和 Hook，不维护可执行的 Task DAG scheduler。父 Agent 根据规则编排与汇总，这是明确设计，而非单独的缺陷。
- 图追踪确认 `resolveRoleInstallEntries` 被安装/差异规划消费；实际 spawn 由宿主完成。不能把 installer 的成功出口当作运行时可调用证明。

来源：[模块依赖](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/module-selection.js:10)、[选择优先级](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/module-selection.js:115)、[角色安装入口](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/install-planner.js:450)、[角色组合与产物](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:259)、[宿主与合同边界](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/governance-core.md:38)。

### 2.3 已具备的有效设计

现有职责不是完全空白：每个角色都有决策方式、质疑重点、交付物和禁止事项；父 Agent 保持唯一编排与最终交付责任；DAG 明确依赖、写范围、逻辑锁、失败传播和 fan-in；恢复不扩大授权；达到终止条件须停止。配置还防止角色 ID 冲突、越界 Prompt 路径及内置权限扩大。应保留这些机制。

来源：[共同角色契约](/Users/hsy/Documents/Github/Vibe-Harness/roles/base.md:5)、[委派输入](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/ai-collab-rules.md:9)、[DAG 与验收](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/ai-collab-rules.md:17)、[授权、恢复和停止](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/governance-core.md:36)、[自定义角色防护测试](/Users/hsy/Documents/Github/Vibe-Harness/tests/role-projection.test.js:122)。

## 3. 按优先级排序的问题

### F01 · P1 · Gemini / Antigravity 的工具名映射错误，使角色可能有定义却无可用工具

**已确认事实：** `toolSet` 返回 Claude 风格的 `Read/Grep/Glob/Edit/Write/Bash`，Gemini 和 Antigravity 分支直接复用。探针生成的两个宿主 test-lead 均是 `["Read","Grep","Glob","Bash"]`。来源：[共享工具列表](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:155)、[Gemini 映射](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:173)、[Antigravity 映射](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:181)。

[Gemini 官方契约](https://geminicli.com/docs/core/subagents/)使用 `read_file`、`grep_search` 等名称；[Antigravity 官方契约](https://www.antigravity.google/docs/subagents/)使用 `view_file`、`grep_search`、`run_command` 等名称，并提示未知工具名可能造成执行异常。

**触发/影响：** 在这两个宿主派发源码定位、修复或回归任务。七个角色的工具表均可能不能正确绑定，连“感知”阶段都无法稳定开始。具体表现是拒载、空工具还是调用异常仍需宿主实测；本报告不声称已复现挂起。

**建议与验收：** 为每种宿主维护其原生工具映射，不能复用名称不同的宿主列表。增加原生工具标识断言；加载最小角色后分别读 fixture 文件、运行受控验证、拒绝越界动作。没有真实绑定证据时保持 configured-unverified。

### F02 · P1 · 验证权限未区分“修改产品”和“生成验证证据”

**已确认事实：**

- OpenCode 对所有非 implementation 角色输出 `edit: deny`、`bash: "*": deny`，包括宣称 validation-command 的 test-lead 和 release-readiness。来源：[OpenCode 权限投影](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:189)。
- Codex 同样把它们全部映射到 `read-only`；Cursor 全部映射到 `readonly: true`。来源：[Cursor 投影](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:176)、[Codex 投影](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:206)。
- Claude/Qoder/ZCode 的验证、安全、发布角色直接获得通用 Bash，但没有由角色投影生成的命令或写根限制。来源：[验证类工具列表](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:159)。
- 项目浏览器 Skill 需要准备隔离工具目录、保存截图与 trace，默认产物写到项目内。来源：[浏览器准备](/Users/hsy/Documents/Github/Vibe-Harness/skills/integrations/browser-verification/SKILL.md:12)、[证据输出路径](/Users/hsy/Documents/Github/Vibe-Harness/skills/integrations/browser-verification/SKILL.md:38)。

[OpenCode 官方权限契约](https://opencode.ai/docs/agents/)支持按命令控制 Bash；[Cursor 官方契约](https://prod.cursor.com/docs/subagents)说明 readonly 限制文件修改和改变状态的命令。**静态结论：** OpenCode 原生测试角色无法直接运行 Bash 测试；Codex/Cursor 需写缓存、构建目录或截图的验证路径存在权限冲突。纯读取检查仍可执行，不能笼统写成“所有测试均不能运行”。

**限制不足的证据：** 在临时项目将 `agent_type` 标记为 test-lead，仅调用 `evaluateHook` 评估普通 Bash 文件重定向；返回 `{}`，没有拒绝。探针没有执行该命令。现有 Hook 依据动作/Envelope 判断，没有将 role permissionPreset 作为可信授权输入。来源：[Hook 判定](/Users/hsy/Documents/Github/Vibe-Harness/runtime/hooks/codex-hook.mjs:104)、[Envelope 决策](/Users/hsy/Documents/Github/Vibe-Harness/runtime/hooks/lib/execution-envelope.mjs:883)。这不证明越过宿主 sandbox；它证明项目通用 Hook 不能代替角色专属只读约束。

**建议与验收：** 明确业务源码写权限、测试代码写权限和验证产物写权限。test-lead 可以运行已授权验证并写隔离证据目录；新增测试由限定测试范围的工程任务承接。通过宿主原生权限和隔离工作区执行限制；无法精确支持时回传缺失能力，由父 Agent 另派可授权的验证任务。至少覆盖命令成功、截图落盘、业务源码修改被拒三种情况。

### F03 · P1 · 角色与领域 Skills/MCP 的组合在原生子 Agent 中断开

**已确认事实：** Claude、Qoder、ZCode 原生投影使用穷举工具表，未包含相关 MCP 工具；Claude 还未包含 Skill 工具或预加载 skills。analysis 类只获得文件读与文本搜索，没有 WebSearch/WebFetch。生成阶段也不根据已安装插件推导角色所需工具。来源：[工具表](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:155)、[原生字段](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:165)、[Prompt 组合](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:133)。

[Claude 官方契约](https://code.claude.com/docs/en/sub-agents)明确，省略 Skill 会阻止其原生调用，预加载技能需要 skills 字段。[Qoder 官方契约](https://docs.qoder.com/cli/subagent)要求 MCP 已发现且被 tools 允许。[ZCode 官方契约](https://zcode.z.ai/en/docs/subagents)说明自定义 tools 是完整列表，MCP 需精确工具名。

**触发/影响：** 架构师需要图谱调用链，测试负责人需要 DevTools，产品分析需要外部材料，或技术规划需要读取 Linear；父会话已安装插件，子 Agent 仍不能直接调用。它们可以读取已知本地 Skill 正文或消费父 Agent 提供的证据，因此属于组合能力断点，不是完全丧失专业知识。可用 Bash 的角色有时能改用已授权 CLI，但这也不恢复原生 MCP 可达性。

**建议与验收：** 派发前检查任务真正需要的工具；按已安装能力授予最小具体工具集合，或明确让父 Agent 提供带来源的证据。Claude 提供可控的 Skill 调用或必要内容注入，不预加载全部 Skills。验证图谱、浏览器及用户提供上下文三条路径；工具缺失须回传 blocked/unverified，不能仅因插件存在就派发。

### F04 · P1 · 主题优先路由可能把实现任务交给只读审查角色

**已确认事实：** 当前顺序先匹配信任边界、安全与敏感数据，再匹配发布/版本，再匹配公共契约，最后才匹配实现。安全、发布、架构角色分别采用 security-review、release-readiness、analysis。来源：[角色选择顺序](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/role-routing.md:7)、[角色权限与触发条件](/Users/hsy/Documents/Github/Vibe-Harness/manifests/roles.json:22)。

**静态场景：**

- “按已确认方案实现鉴权校验”：因信任边界命中安全审查者，而该角色默认只读。
- “按已批准 schema 更新四个调用方”：因公共契约命中架构师，实施责任可能被反复转回分析。
- “实现版本展示功能”：可能因版本主题进入发布就绪审查。

现有规则强调按原子动作切换，因此善于解释上下文的 Agent 可以自行化解；但缺少“先按动作能力过滤，再按领域选视角”的明确规则与对抗 Eval，不能证明稳定路由。

**建议与验收：** 父 Agent 先区分澄清、设计、实现、独立验证、审查与外部执行；安全/API 等领域为执行者叠加知识或追加独立咨询。已决策的安全/API 实现交给工程师，审查请求才交只读审查者。对上述正例与“仅审查、不得修改”反例同时评测，并覆盖安全＋发布＋未决产品目标的冲突。

### F05 · P1 · 角色 Eval 可以靠复述答案满分，不能证明能力闭环

**已确认事实：** 本轮对角色 suite 的全部 10 个 case，向实际 `scoreCase` 传入 `events: []`、`artifacts: []`、`exitCode: 0`，只保留预置 replay.output；结果 **10/10 passed，score 全部为 1**。这些 case 全部没有 requiredEvents、requiredArtifacts 或 execution fixture；输入还直接指定应回答的角色名称或短语。

来源：[角色用例](/Users/hsy/Documents/Github/Vibe-Harness/evals/suites/vibe-harness-role-routing.json:9)、[“稳定性”单次回答用例](/Users/hsy/Documents/Github/Vibe-Harness/evals/suites/vibe-harness-role-routing.json:193)、[判分逻辑](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/eval-scoring.js:68)。离线 runner 本来就直接评估 replay，不能视作模型行为测试：[离线执行契约](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/eval-replay.js:19)。

**影响：** 当前 suite 可以证明有限的文本判分契约，却不能证明角色读取正确上下文、实际派发、运行测试、停止、处理失败或形成有效交付。“跨两次消息保持角色”目前也只是让一次回答输出三个名称。

**建议与验收：** 保留少量名称选择 smoke case；移除场景中的答案提示，为关键能力增加实际工具事件、fixture 内容变化、隐藏验收和错误完成断言。至少覆盖一次真实任务执行、一次权限不足、一次父子交接、一次停止后的不续跑。用“只输出正确短语的空执行器”做负控，行为套件必须拒绝它。该整改才需要另行在线评测，本轮未执行。

### F06 · P1 · 角色行为正文未进入 Eval 指纹，旧证据可能关联到新角色

**已确认事实：** 资产指纹只扫描 config、hooks、rules、skills，未扫描 `roles/`、`.agents/roles/`、原生角色目录或 `docs/agent-roles/`。在线路径也调用该函数；其另一组 CONFIG_PATHS 同样没有这些角色正文目录。来源：[资产分组](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/eval-assets.js:5)、[配置指纹路径](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/project-evaluation.js:56)、[在线指纹](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/project-evaluation.js:234)。

**最小复现：** 临时目录中修改 roles/base、角色 Prompt、canonical 安装文件、Codex 原生文件、自定义角色正文，aggregateHash 不变；修改 docs/rules/role-routing 则改变哈希。即 `roleChangesDetected=false`、`routingChangeDetected=true`。没有修改源仓库或 reference。

**影响：** 角色 manifest 变化可能改变 config 分组，但相同 ID/路径下的正文变化不会；批准结果不能可靠绑定实际角色行为。此处指“角色正文指纹缺口”，不是指所有配置都没有指纹。

**建议与验收：** 对实际生效的组合 Prompt、路由以及宿主工具/权限映射记录可比较摘要，同时覆盖项目追加正文；复用现有指纹机制，不另建状态服务。修改任一生效角色正文必须导致对应指纹变化；无关报告文件变化不应导致漂移。reference 的重新批准单独进行。

### F07 · P2 · 自定义/禁用角色缺少一致的有效路由

**已确认事实：** canonical 索引过滤 disabled 并写出 custom 的 when/avoid；原生角色只组合 base、正文和权限，没有加入 when/avoid。静态路由仅对显式选择要求 enabled，并只给 senior-engineer 写了未启用回退；其他六个角色和 custom 的优先级没有同等规则。

来源：[索引路由提示](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:140)、[自定义角色组合](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:299)、[禁用过滤](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:316)、[静态路由](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/role-routing.md:7)。

探针禁用 security reviewer 并增加 migration-owner 后，索引正确显示有效角色，但 `CUSTOM_ROUTE_SENTINEL`、`CUSTOM_AVOID_SENTINEL` 只在索引出现，原生文件不包含。**静态结论：** 不先读有效索引的宿主可能继续选择已禁用角色，或让 custom 与内置角色靠 description 临场竞争。不能据此称 custom 完全不可调用：明确指定已注册 custom 仍有入口。

**建议与验收：** 从有效角色集合路由，所有角色统一处理未安装、禁用、不可调用和权限不足；明确 custom 与内置的冲突处理。关键 when/avoid 在父选择与子接单两处都可见。覆盖禁用安全/发布角色、仅 custom 匹配、显式指定禁用角色和多个 custom 同时匹配。

### F08 · P2 · 主 Agent 角色切换与固定子 Agent 权限共用同一契约

**已确认事实：** base 要求目标或动作变化时重新选择角色，并被原样拼入每个原生子 Agent；其工具和 sandbox 却在生成/启动时固定。base 未区分“当前是父 Agent 的视角”还是“接收父任务的固定职责子 Agent”。来源：[共同契约](/Users/hsy/Documents/Github/Vibe-Harness/roles/base.md:3)、[共用组合](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:133)、[静态权限](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:206)。

**触发/影响：** 架构咨询发现需要修改测试或实现时，子 Agent 可以从文本上理解成切换工程师，但原有只读工具没有升级；另一方向，工程子 Agent 切成审查者，也不会自动收回写权限。现有治理禁止扩大授权，所以正确行为应是回报父 Agent，而非角色名称承担授权转换。

此外，七份专业 Prompt 有交付物清单，但没有逐角色接单所需输入、缺失输入时的回报对象。全局协作规则已经规定目标、输出、边界和判据，不能说“没有 I/O 契约”；缺口是未把共同契约落实到固定角色的独立上下文与拒接判据。来源：[既有派发要求](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/ai-collab-rules.md:9)、[角色交付要求](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/test-lead.md:13)。

**建议与验收：** 保留共同专业内容，区分父视角与子任务执行说明。子 Agent 在现有职责内继续执行；需要另一职责或权限时，返回结果、证据缺口和转派请求，由父 Agent 决定自己接手或创建兄弟任务。输入输出复用既有委派/DAG 字段，补齐缺失的基线、验证环境和回传接收者，不引入强制交接文件。测试只读子 Agent 遇到修复需求时应正确移交、工程子 Agent 不应以“改名为审查者”宣称隔离审查。

### F09 · P2 · roles:audit 当前不可用，恢复后也不足以验证实际能力

**已确认事实：** `pnpm roles:audit` 退出 1，读取不存在的 `rules/role-routing.md`；实际受管来源位于 docs/rules。读取发生在逐角色 catch 之前，直接抛出 ENOENT。来源：[错误路径](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/roles-audit.js:82)、[权威路由路径](/Users/hsy/Documents/Github/Vibe-Harness/adapters/install-map.json:143)。

审计主要检查章节、完全相同正文、重复生成是否一致和部分 frontmatter。OpenCode 分支仅核对 edit；其他工具列表仅检查是否含 Write，不检查原生工具名、必需工具或 Bash 间接写入。来源：[frontmatter 检查](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/roles-audit.js:30)、[权限断言](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/roles-audit.js:41)、[正文与投影断言](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/roles-audit.js:101)。

**影响：** 当前审计门槛无法运行；修正路径仍不能发现 F01–F03。两份语义重叠但措辞不同的角色也不会被完整字符串去重检测发现。

**建议与验收：** 修正路径并以仓库实际目录执行 audit 回归；为原生工具名、必需能力与禁用动作添加确定性契约检查。语义重叠保留场景审查，不靠相似度自动删除角色。建立一组故意错误的投影负例，必须触发审计失败。

### F10 · P2 · doctor 的 ready/native 描述生成状态，未证明角色任务就绪

**已确认事实：** `roleRuntimeReport` 只看 activation 是否 manual 就给出 manual-activation-required 或 ready；permissionMapping 来自 adapter 固定标签。没有逐角色检查工具是否可绑定、任务要求是否满足或宿主是否加载。来源：[运行时角色状态](/Users/hsy/Documents/Github/Vibe-Harness/scripts/vibe-harness.js:154)、[固定诊断](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:360)。

权限收紧探针把 test-lead 改为 analysis，仍保留“执行证据”的职责正文；诊断仍是 automatic/native，没有“验证能力已被收紧”的信息。该配置收紧是允许的，不应被直接判错；错误在于能力声明和有效状态没有对应变化。来源：[权限收紧](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:276)、[配置契约](/Users/hsy/Documents/Github/Vibe-Harness/docs/roles.md:19)。

**建议与验收：** 区分“文件已生成”“宿主已激活”“工具绑定已验证”和“当前任务可执行”；可用现有诊断字段扩展，不必建立调度器。对每个任务报告缺失能力与降级原因。收紧测试权限、插件缺失、错误工具名及 ZCode 未激活都不能与验证就绪混为同一 ready 结论。

## 4. 逐角色能力闭环与处置

下表评价设计支持度，不是未运行的模型成功率。**可**＝具备相应规则/本地能力；**依赖**＝需父 Agent、已提供材料或宿主工具；**缺口**＝当前契约/映射不能支撑全部声明。“执行”包括形成可验收决策，不要求咨询角色写代码。

| 角色 | 感知 | 判断 | 执行 | 验证 | 交付 | 建议 |
|---|---|---|---|---|---|---|
| 主 Agent | 可：规则、源码、状态；外部证据依赖工具 | 可：事实分类、风险、授权、拆分 | 可：已授权工作及原生编排 | 可：fan-in 与修改后验证；受环境限制 | 可：唯一最终责任、停止/恢复规则 | **强化**派发前能力检查；产品澄清与 DAG 所有权在这里 |
| product-manager | 依赖：本地材料、用户/父 Agent；原生外部检索受限 | 可：价值、范围、指标、验收 | 可：需求决策摘要；用户决策依赖父 Agent | 依赖：真实需求证据与用户回答，没有替代用户验证的能力 | 可：需求交付清单；接收者需明确 | **合并**默认独立 Agent 到主 Agent＋clarify-requirements；资料研究仍可独立只读任务 |
| chief-architect | 依赖：消费者、调用链、约束；MCP 可能不可达 | 可：兼容、结构、可逆性 | 可：设计决策；实现/迁移执行另派 | 依赖：可行性实验、消费者测试由执行者提供 | 可：方案、接口、迁移、回滚 | **保留并收窄**为按需架构咨询；不截获已定方案的实现 |
| technical-project-manager | 依赖：完整任务清单、依赖与状态 | 可：关键路径、冲突、拆分 | 可：计划；没有独立调度职责所需权限 | 依赖：执行状态和验收均由父 Agent 核实 | 可：实施顺序和阻塞条件 | **合并**默认独立 Agent 到父 Agent；复杂计划审查可显式咨询 |
| senior-engineer | 可：本地定位；未知故障依赖 debugging 知识与环境 | 可：根因与最小改动 | 可：项目范围实现；Gemini/Antigravity 有 F01 | 可：聚焦验证；浏览器/MCP 有 F03 | 可：diff、兼容、修改后证据 | **保留并强化**为唯一默认实现角色；显式承接定位及测试代码编写 |
| test-lead | 可：代码/测试；外部观测依赖工具 | 可：风险、覆盖、证据质量 | 缺口：执行命令、截图、缺失测试作者归属 | 缺口：F02/F03 导致部分宿主只能静态评估 | 可：质量结论；必须缩小未执行主张 | **强化**为独立验证者；测试计划可咨询，测试编写交限定范围工程任务 |
| adversarial-security-reviewer | 可：本地信任边界；动态检查依赖受控工具 | 可：威胁、攻击入口、拒绝路径 | 可：只读审查；安全检查需匹配工具和授权 | 依赖：复现与拒绝测试，不能凭猜测认定漏洞 | 可：严重度、证据、影响、建议 | **保留并重划**为独立安全审查；安全实现由工程师承接 |
| technical-release-manager | 依赖：候选版本、检查、迁移、监控与回滚证据 | 可：readiness go/no-go | 可：就绪审查；包验证有 F02，发布执行不在职责内 | 依赖：环境与目标验证，不能以本地构建替代 | 可：阻塞、迁移、监控、回滚清单 | **重命名/收窄**为发布就绪审查；默认按需，执行交已授权主/工程任务 |
| custom roles 机制 | 由项目 Prompt 和工具决定 | 无能力质量检查；ID/schema 合法不等于职责有效 | 受预设和宿主限制 | 未要求可验收证据或能力满足检查 | 由项目自行定义 | **保留并强化**有效路由、最低接单信息和能力诊断 |

逐角色原始依据：[产品](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/product-manager.md:5)、[架构](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/chief-architect.md:5)、[项目管理](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/technical-project-manager.md:5)、[工程](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/senior-engineer.md:5)、[测试](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/test-lead.md:5)、[安全](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/adversarial-security-reviewer.md:5)、[发布](/Users/hsy/Documents/Github/Vibe-Harness/roles/prompts/technical-release-manager.md:5)。主 Agent 依据 [执行循环](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/governance-core.md:7)。

### 4.1 每个角色应明确的最小输入与输出

以下为整改建议，复用当前任务上下文，不要求新建 JSON schema 或强制文件。

| 接收方 | 接单所需输入 | 输出及消费者 | 无法继续时 |
|---|---|---|---|
| 主 Agent | 最新目标、授权范围、工作区状态、验收条件 | 最终结果/未完成项 → 用户；子任务 → 指定执行者 | 产品决定/授权交用户；工具与证据缺口先寻找合法替代 |
| 产品视角 | 用户问题、现有证据、约束、待决定问题 | 范围、非目标、验收、未决取舍 → 主 Agent/用户 | 缺事实继续调查；缺产品决定经父 Agent 提问；不编造研究 |
| 架构师 | 决策问题、当前契约/消费者、兼容约束、可变范围 | 选定方案、影响、验证与回滚 → 主 Agent/工程师 | 关键消费者不可见、产品目标未决或需实验时回传缺口 |
| 计划咨询 | 已冻结范围、任务候选、依赖、资源锁、容量约束 | 依赖顺序/冲突与可验收拆分 → 父 Agent | 前驱不可见、有环或范围冲突时指出具体边，不擅自改状态 |
| 工程师 | 明确行为、代码基线、写范围、契约、验证命令/判据 | 实际 diff、根因、验证、风险 → 父 Agent | 未决产品/契约、环境不足、越权需求或失败阈值触发时停止相关动作 |
| 测试负责人 | 验收、被测基线/diff、环境、可用工具、允许证据目录 | 场景结果、复现、证据范围 → 父 Agent；修复需求 → 工程师 | 工具缺失为 blocked/unverified；行为断言失败为 failed；缺测试回传作者任务 |
| 安全审查者 | 授权的系统/资产、入口、攻击者模型、允许检查方式 | 脱敏 findings、影响、复现边界 → 父 Agent/修复任务 | 未授权动态动作不执行；无法证实降为待验证；冲突升级 |
| 发布就绪审查 | 候选版本、验收证据、迁移/回滚方案、环境与责任人 | 有条件的 go/no-go、阻塞与监控 → 发布责任人/主 Agent | 缺目标验证、回滚或授权即 no-go/待验证；go 不授权发布 |
| 自定义角色 | 以上共同信息＋专有输入来源、非职责、输出消费者 | 项目定义的可验收结果 → 唯一消费者 | 不得依赖未知工具或无边界工作；由父 Agent 重划 |

### 4.2 万能、空壳、重复与能力孤岛的判定

| 类型 | 当前判断 | 处置 |
|---|---|---|
| 万能 Agent | 主 Agent 的全流程责任合理；风险在于路由不匹配后无界兜底。senior-engineer 是通用实现者，不因覆盖多种语言就应删除 | 用任务范围、能力检查和停止条件约束；避免把所有审查责任压给工程角色 |
| 空壳 Agent | 七份 Prompt 均有专业内容，不能一概称空壳；F01 可使原生角色成为运行时空壳，F02 可使验证者退化为只读建议者 | 先修可调用性，再评价角色增益，不靠加长 Prompt 补工具 |
| 重复 Agent | product-manager 与 clarify-requirements 的范围/验收输出高度重叠；TPM 的拆分输出与父 Agent DAG 责任重叠 | 删除其**默认独立派生定位**；保留知识视角和显式咨询能力，承接者分别为主 Agent＋既有 Skill、主 Agent＋协作规则 |
| 合理重叠 | 架构师与 api-and-interface-design、安全审查者与 security-and-hardening 都有交叉，但独立咨询/审查可提供不同证据责任 | 角色负责判断与交付，Skill 提供方法；不重复加载相同大段流程 |
| 不可调用能力 | 工具名错误、显式工具表排除 MCP、验证者无命令权限 | F01–F03；在安装/派发时暴露实际缺失 |
| 错误委派 | 主题匹配取代动作匹配；子 Agent 切角色却没有对应权限 | F04/F08；父 Agent 独占重派权 |
| 能力孤岛 | custom 路由提示只存在索引；缺测试后的作者任务、发布 go 后的授权执行没有角色级清晰接收者 | F07/F08；补消费者与转派条件，不新增“总管 Agent” |

产品能力重叠依据：[需求发现输出](/Users/hsy/Documents/Github/Vibe-Harness/skills/core/clarify-requirements/SKILL.md:20)。未知根因并非全系统无人负责：[现有排障能力](/Users/hsy/Documents/Github/Vibe-Harness/skills/core/systematic-debugging/SKILL.md:10)已有复现、假设、修复和回归；应明确由工程师消费，而非新增 Debugger 角色。测试、安全、发布的专业方法也已有相应规则，不需要重复造流程 Skill。

## 5. 八种宿主的可达性与权限矩阵

全部宿主仅完成源码/生成与公开契约检查，**没有实际启动角色**。下表“格式支持”不等于本机激活或任务成功。

| 宿主 | 注册/生成入口 | 工具与权限现状 | Skill/MCP 与边界结论 | 当前处置 |
|---|---|---|---|---|
| Codex | `.codex/agents/*.toml`；名称、描述、developer_instructions 符合公开格式 | 工程师 workspace-write，其余 read-only；预设被压缩为二分类 | 父会话 MCP/Skills 可继承，但须检查实际可用；验证产物写入有冲突 | 格式有据；F02/F08/F10；实测待补 |
| Claude | `.claude/agents/*.md` | 工程师含 Edit/Write/Bash；验证者有 Bash；analysis 仅读搜 | 显式工具表无 Skill/相关 MCP；通用 Bash 不能代表只读 | F02/F03；按任务接通依赖并限制写入 |
| Gemini | `.gemini/agents/*.md`；kind=local | 目录/结构有据，但 Read/Grep/Bash 等不是官方原生工具名 | MCP 可配置，但当前表未提供；不能依赖角色先自行补工具 | F01 优先；具体宿主错误形式待实测 |
| Cursor | `.cursor/agents/*.md` | 非工程角色 readonly=true | 本地子 Agent可继承 MCP；云侧能力来源不同；证据写入和父子角色切换需核验 | F02/F08；保持本地与云环境边界 |
| Qoder | `.qoder/agents/*.md` | Read/Grep/Glob/Bash 名称有官方依据；验证 Bash 仍过宽 | MCP 要发现且工具表允许，当前未列入；analysis 无外部检索 | F02/F03；接通必要工具 |
| Antigravity | `.agents/agents/*.md` | 注册目录有官方依据；工具名称复用了其他宿主，契约不符 | 当前无专门工具/技能依赖配置；未证明实际调用成功 | F01 优先；不能仅凭 stable 声明通过 |
| OpenCode | `.opencode/agents/*.md`；mode=subagent | 工程师 edit allow/Bash ask，其余 edit deny/Bash deny | 这不限制所有远程副作用；未明确的工具仍受宿主设置控制 | 验证角色被直接削去命令能力；F02/F10 |
| ZCode | `.zcode/plugins/vibe-harness-roles` 项目插件 | 需手动激活；显式工具表与 Claude 类似 | MCP 必须精确加入 tools；是否被插件发现仍需实际启用确认 | manual 状态保留；F02/F03；不改全局配置 |

宿主依据：[Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Claude](https://code.claude.com/docs/en/sub-agents)、[Gemini](https://geminicli.com/docs/core/subagents/)、[Cursor](https://prod.cursor.com/docs/subagents)、[Qoder](https://docs.qoder.com/cli/subagent)、[Antigravity](https://www.antigravity.google/docs/subagents/)、[OpenCode](https://opencode.ai/docs/agents/)、[ZCode Subagents](https://zcode.z.ai/en/docs/subagents) 与 [ZCode Plugin](https://zcode.z.ai/en/docs/plugin)，均于本轮获取。ZCode 插件页面后续定位请求遇到连接失败，本报告只确认生成机制和 manual 状态，未把插件路径激活成功当作事实。

本仓库八个 adapter 的 evidence 均未给出 hostVersion/lastVerifiedAt 的实际值；因此 capabilities 中 stable 与 doctor ready 不能替代宿主运行证据。来源：[宿主能力与证据字段](/Users/hsy/Documents/Github/Vibe-Harness/manifests/adapters.json:11)。

### 5.1 宿主内置 Agent 与插件能力的边界

- Codex 的 worker/explorer、其他宿主的通用/Explore/Browser 类 Agent，由宿主维护；当前产品没有必要再建立同名能力副本。委派它们时也要传递任务范围、授权、证据和停止条件。
- codebase-memory 的 Scout/Verify/Auditor 是代码证据深度，不是产品/实现/发布责任角色；图谱输出只能支持结构事实，不能代替测试或最终验收。
- 一次只读探索通常无需先创建架构师；一次命令验证也无需先创建测试负责人。复杂、有独立证据价值的任务才值得隔离上下文。
- 浏览器、Linear、记忆等工具不是所有角色的默认前提；父 Agent 应优先确认已安装、可调用与权限边界，再决定派发或提供上下文。

### 5.2 何时执行、委派、停止与升级

| 动作 | 当前规则支持 | 需强化之处 |
|---|---|---|
| 直接执行 | 清晰、授权、证据充分、可逆工作直接做 | 增加“当前角色实际工具能完成”检查；不能只看角色名 |
| 委派 | 独立并行、必要复审或治理拆分；父唯一编排；写范围冲突有规则 | 固定子角色的接单与拒接；按动作和有效能力匹配；禁止靠换角色突破权限 |
| 停止 | terminalCondition、审批、workspace 漂移、未归属 HEAD、同一 blocker 阈值 | 子 Agent必须得到同样的范围/终点，不能假设继承父全部会话 |
| 升级 | 未决产品、安全授权、依赖冲突、失败证据 | 明确先回父 Agent；父核实后仅将必须由人决定的事项交用户 |
| 失败恢复 | 失败隔离、禁止非幂等外部重试、fan-in 再验收、恢复不扩权 | 统一讲清局部 succeeded 与验收 passed 的差别；无新写入不反复跑相同测试 |

这些是“强化已存在的契约”，不是引入新的固定门禁。当前停止规则可直接沿用 [治理硬边界](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/governance-core.md:36) 和 [失败传播/重试](/Users/hsy/Documents/Github/Vibe-Harness/docs/rules/ai-collab-rules.md:21)。

## 6. 真实开发场景推演与验收设计

以下是根据当前源码、规则和工具投影进行的静态推演；仅“本地探针”列有实际执行结果，未把推演冒充在线行为测试。建议的预期路径同时作为整改验收条件。

| 场景 | 必需输入 | 预期执行者与允许动作 | 有效证据/交付 | 停止或移交 | 当前判定 |
|---|---|---|---|---|---|
| 用户说“提升转化”，无受众与验收 | 现有业务事实、限制、未决取舍 | 主 Agent 用产品视角，先查事实再问关键决定 | 可检验目标、非目标、验收 | 缺业务决定经父 Agent 向用户澄清 | 产品 Prompt 具备问题框架；独立子 Agent外部数据和提问路径不完整 |
| 四模块共同消费 API，设计未定 | API 当前形态、消费者、兼容窗口 | 架构师只读设计；需要实验另派限定任务 | 明确方案及迁移/回滚、消费者验证要求 | 关键消费者不可见或目标冲突回父 Agent | 设计判断可用；MCP/实验能力依赖 F03/F08 |
| 五个任务共享 schema 且存在前后依赖 | 冻结范围、依赖、资源锁 | 父 Agent 建最小 DAG；计划咨询仅建议 | 无环、唯一契约写者、明确 ready 与验收 | 环、不可见依赖、共享写冲突停止受影响节点 | 既有协作规则较完整；再派 TPM 做实际调度会重复责任 |
| 一行已知根因修复 | 复现、允许文件、期望行为 | 工程师直接实现并跑聚焦回归 | 最小 diff 与最后修改后结果 | 发现范围扩张或契约改变回父 Agent | 主流程合理；不应机械派七角色 |
| 未知原因的偶发失败 | 最小症状、环境、日志/测试 | 工程师＋systematic-debugging 复现、证伪、固定失败再修 | 根因证据、回归、剩余假设 | 证据不足不能猜改；受阻标记环境缺口 | 有既有能力；manifest 的“已定位根因”入口需与 fallback 统一 |
| 按已批准方案实现鉴权校验 | 已冻结安全语义、授权范围、拒绝场景 | 工程师＋安全方法实现；必要时独立安全审查 | 正向/拒绝路径通过，审查问题有证据 | 未授权外部动作不执行 | 主题路由可能交给只读安全角色，F04 |
| 无新增测试的功能需要独立回归 | 行为验收、diff、环境、证据路径 | 测试负责人识别覆盖缺口；工程任务写测试；验证者重验 | 新测试真正观察行为，失败不弱化断言 | 缺测试作者或工具时回父 Agent | 当前“测试设计”与“测试编写”的交接不够明确，F02/F08 |
| 浏览器保存失败，需要截图、网络与回归 | URL、隔离会话、断言、允许输出目录 | 验证者使用已接通浏览器入口并生成证据 | 截图/trace、console、请求状态、功能断言 | 工具缺失转合法入口或人工步骤，不声称页面通过 | F01–F03；本地探针已确认权限/工具表问题，未开浏览器 |
| 路径穿越疑似绕过 | 入口、输入边界、受控 fixture | 安全审查者只读分析与授权内最小检查 | 可重现输入、受影响路径、拒绝测试建议 | 需要扩大攻击范围回父 Agent/用户 | 职责清晰；safe-security-check 需真实工具约束 |
| 候选版本准备上线，但回滚未验证 | 候选 SHA、检查、迁移与回滚证据、监控责任人 | 发布就绪审查者评估；未授权不 tag/push/publish | 有条件 go/no-go 与阻塞列表 | 回滚不可用即 no-go；go 后由授权执行者处理 | 审查角色合理；名字不应暗示直接发布，F02/F04 |
| 禁用安全角色，custom 可审同一变更 | 有效角色索引、custom when/avoid | 父 Agent仅在可用角色中选；对 custom 明确适用条件 | 角色可达、合法工具、对应交付 | 没有合适角色则中性主 Agent或报告缺口 | 索引正确但原生提示/静态优先级不一致，探针见 F07 |
| 只读架构子任务发现需要改代码 | 原任务范围、发现与证据 | 子 Agent回报修复建议，父另派写任务 | 原咨询结果＋具体转派输入 | 不靠切换角色升级权限 | 共用 base 与固定 sandbox 存在冲突，F08 |
| 一个写子任务失败，其余部分完成 | DAG、各节点结果、实际 diff | 父按失败规则停派新写任务、汇总并核对已完成结果 | 独立成功不掩盖必需节点失败 | 必需失败不得交付整体完成 | 规则已定义；应补真实父子交互 Eval，F05 |
| 压缩恢复时 HEAD 变化或终点已达到 | 最新用户意图、宿主状态、cwd/branch/HEAD、checkpoint | 父重新核实；漂移期间只读；终止后不派下一节点 | 明确恢复/阻塞理由 | 不扩大授权，不自动续跑新工作 | 治理合同充分；角色 suite 未验证此行为，F05/F08 |

对每种宿主至少需要同一组最小任务：读文件、执行合法局部操作、生成验证产物、拒绝未授权写入、调用或明确拒绝缺失工具、正确回传父 Agent。先用无网络 fixture 验证工具绑定，再在独立任务中验证浏览器/外部集成；这属于后续整改验收，本轮不执行在线任务。

## 7. 建议的责任划分与整改顺序

### 7.1 推荐分工

- 用户 ↔ 主 Agent：目标、授权、产品澄清、DAG、最终验收。
- 主 Agent → 工程师：实现、排障、限定范围测试编写。
- 主 Agent → 架构咨询 / 安全审查 / 独立验证：按需派发，获取独立证据。
- 主 Agent → 发布就绪审查：仅在需要独立 readiness 判断时派发。
- 所有子任务 → 主 Agent 汇总；角色变化或权限不足时回父 Agent 重派。

主 Agent 保留亲自实现和验证的能力，不强制每次走子 Agent；角色专业内容仍可作为父 Agent 的按需视角。主 Agent 也不能把未归属权限、外部写入或已有拒绝转派出去。

| 处置 | 对象 | 职责承接与兼容方式 | 验收标准 |
|---|---|---|---|
| 删除默认独立派生定位 | product-manager | 主 Agent＋clarify-requirements 承接澄清；既有 ID 可在迁移期保留为显式咨询 | 模糊需求能得到决定摘要；不会为了问用户一句话绕子 Agent |
| 合并编排责任 | technical-project-manager | 父 Agent＋ai-collab-rules 统一 DAG；复杂计划审查可显式调用 | 只有一个调度者和最终验收者，计划不冒充运行状态 |
| 保留并收窄 | chief-architect | 架构决策咨询；实现/验证由写任务承接 | 设计交付含消费者与回滚；已定实现不被重复截获 |
| 保留并强化 | senior-engineer | 根因定位、实现、重构、测试编写和局部验证 | 不新增泛化职责，每个写任务有可验收行为及范围 |
| 强化 | test-lead | 风险覆盖与独立验证；限定证据输出写权限 | 可执行验证、可保存证据、不能修改业务实现 |
| 保留并收窄 | adversarial-security-reviewer | 独立审查与授权检查；修复交工程师 | findings 可复核；不因“涉及安全”就阻断工程执行 |
| 重新定位 | technical-release-manager | 展示为“发布就绪审查者”；实际发布由已授权主/工程任务完成 | 能报告可靠 go/no-go；不混同审查与执行授权 |
| 强化 | custom roles | 使用相同有效路由、能力诊断和接单标准 | custom 与内置均可查能力缺口；禁用有统一回退 |

不建议立刻强删对外角色 ID：已有项目配置可能引用它们。先改变默认派生与责任说明，提供弃用/重命名兼容窗口；退休文件继续走现有受管生命周期，保留用户修改冲突。

### 7.2 整改依赖顺序

| 顺序 | 修改目标 | 主要对应发现 | 聚焦验收 |
|---|---|---|---|
| 1 | 恢复 roles:audit，并加入工具名与必需能力负例 | F09/F01 | 当前目录可运行；错误工具名与缺失验证命令必须失败 |
| 2 | 修宿主工具名、验证权限和 MCP/Skill 接线 | F01–F03 | 八宿主生成契约；受控读/验/写证据；未授权业务写入拒绝 |
| 3 | 按动作＋有效能力路由；统一 custom/disabled；分开父视角与子契约 | F04/F07/F08 | 安全/API 实现不会误委派；只读子任务能正确拒接与移交 |
| 4 | 补角色指纹与真实行为 Eval，修正诊断语义 | F05/F06/F10 | 空执行器失败；正文变化漂移；生成/激活/验证状态不混同 |
| 5 | 根据行为结果精简默认角色面，提供迁移兼容 | 角色矩阵与重叠分析 | 原有职责均有承接者；简单任务开销下降；独立证据不丢失 |

这些建议涉及公开 role pack、宿主投影和项目配置消费者。整改时应评估 schema 兼容、安装/升级/禁用/卸载，以及已有 custom 配置；对职责变更与 adapter 行为变更运行聚焦 Eval，reference 按仓库流程单独审查。当前报告没有新增公共 API、字段、角色或权限。

## 8. 本轮验证与可复现证据

### 8.1 本地检查结果

全部检查针对同一未修改源码基线。测试内的安装/写入只发生在临时项目；报告文件不进入角色实现或 Eval 指纹。为避免重复计数，仅统计最终保留输出的两组测试。

| 检查 | 结果 | 能证明的范围 |
|---|---|---|
| 角色/模块/跨平台/OpenCode/执行简化 5 个测试文件 | **passed：84/84** | 现有投影、配置、拒绝配置和安装行为 |
| Hook/规则深度/Eval 契约/评分 4 个测试文件 | **failed：82 passed，2 failed** | Hook 与规则/评分的已覆盖行为；整体不能声称全通过 |
| `pnpm roles:audit` | **failed：退出 1，ENOENT** | 确认 F09；没有完成角色审计检查 |
| 八宿主 test-lead 投影探针 | **已执行** | 确认各格式和工具/权限输出，不证明宿主加载 |
| 空事件/空产物评分探针 | **已执行：10/10 满分** | 确认 F05 的判分盲区，不是行为通过结果 |
| custom/禁用/权限收紧探针 | **已执行** | 确认 F07/F10 的索引、原生正文和诊断差异 |
| Hook 角色写入判定探针 | **已执行：返回 {}；未执行被评估命令** | 项目 Hook 没有在该输入上拒绝普通写入；不证明宿主越权 |
| 角色资产指纹对照探针 | **已执行：角色变更未检出，路由变更检出** | 确认 F06；未更新任何 reference |
| 真实宿主/在线 Agent/浏览器与外部系统 | **unverified，按本次约定未运行** | 不报告成功率、调用成功、实际发布或线上验证 |
| 报告引用、行号与格式检查 | **passed：72 个本地链接有效，10 项发现、7 个角色和 8 个宿主覆盖齐全；代码围栏与 diff 格式检查通过** | 仅证明报告引用有效和规定范围覆盖完整 |

本轮测试命令：

```sh
node --test --test-timeout=30000 \
  tests/role-projection.test.js tests/module-selection.test.js \
  tests/cross-platform-adapters.test.js tests/opencode-adapter.test.js \
  tests/execution-simplification.test.js

node --test --test-timeout=30000 \
  tests/hook-runtime.test.js tests/rules-depth.test.js \
  tests/eval-contract.test.js tests/eval-scoring.test.js

pnpm roles:audit
```

治理组的两项失败位于 [离线重放结果与 reference 指纹比较](/Users/hsy/Documents/Github/Vibe-Harness/tests/eval-contract.test.js:400) 和 [eval 脚本重放](/Users/hsy/Documents/Github/Vibe-Harness/tests/eval-contract.test.js:439)。实际结果显示 config、hooks、rules、skills 四组指纹与已检入结果不同，第二项报告 `replay differs from the checked-in result`。这些失败出现在报告写入前，源码工作区仍干净；属于当前基线失败，未进一步归因到具体历史变更，也未擅自重建 reference。它与 F06 的“角色目录未被扫描”是两个不同问题。

按已确认的只读审查范围，没有运行无关全量测试，也没有为了报告写入执行整仓行为矩阵。

### 8.2 最小评分反例

在仓库根执行；只读源文件，不启动模型：

```sh
node --input-type=module <<'JS'
import {readFile} from 'node:fs/promises';
import {scoreCase} from './scripts/lib/eval-scoring.js';
const suite = JSON.parse(await readFile(
  'evals/suites/vibe-harness-role-routing.json', 'utf8'));
const results = await Promise.all(suite.cases.map(definition =>
  scoreCase({definition, observation: {
    output: definition.input.replay.output,
    events: [], artifacts: [], exitCode: 0
  }})
));
console.log({
  total: results.length,
  passed: results.filter(x => x.passed).length,
  allScoresOne: results.every(x => x.score === 1)
});
JS
```

本轮结果：`{ total: 10, passed: 10, allScoresOne: true }`。输入本身给出了期望名称/短语，所以这不是模型能力实验，而是证据强度的负控。

### 8.3 指纹反例

该探针只创建和删除自己的临时目录；源仓库保持只读。

```sh
node --input-type=module <<'JS'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEvalAssetFingerprint} from './scripts/lib/eval-assets.js';
const root = await mkdtemp(path.join(tmpdir(), 'vibe-role-hash-audit-'));
try {
  for (const dir of ['docs/rules', 'roles/prompts', '.agents/roles',
                     '.codex/agents', 'docs/agent-roles'])
    await mkdir(path.join(root, dir), {recursive:true});
  await writeFile(path.join(root, 'docs/rules/role-routing.md'), 'fixed');
  const before = await createEvalAssetFingerprint(root);
  for (const file of ['roles/base.md', 'roles/prompts/test-lead.md',
                      '.agents/roles/test-lead.md',
                      '.codex/agents/test-lead.toml',
                      'docs/agent-roles/custom.md'])
    await writeFile(path.join(root, file), 'changed role behavior');
  const after = await createEvalAssetFingerprint(root);
  await writeFile(path.join(root, 'docs/rules/role-routing.md'), 'changed');
  const control = await createEvalAssetFingerprint(root);
  console.log({
    roleChangesDetected: before.aggregateHash !== after.aggregateHash,
    routingChangeDetected: after.aggregateHash !== control.aggregateHash
  });
} finally {
  await rm(root, {recursive:true, force:true});
}
JS
```

本轮结果：`{ roleChangesDetected: false, routingChangeDetected: true }`。

### 8.4 投影与自定义探针的复现输入

调用 [projectRole](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:206)，取 manifests/roles 中的 test-lead，Prompt 由 base 与角色正文组合，遍历 manifests/adapters 的 8 个条目；前言结果已经完整归纳到第 5 节。所有 7 个角色使用同一按 permissionPreset 分支的生成逻辑。

在临时项目创建直接位于 docs/agent-roles 的 migration-owner.md，调用 [resolveRoleInstallEntries](/Users/hsy/Documents/Github/Vibe-Harness/scripts/lib/role-projection.js:259)，参数如下；其余 required 参数使用当前 rootDir、临时 targetDir、Codex adapter 与 packageVersion：

```json
{
  "rolesConfig": {
    "disabled": ["adversarial-security-reviewer"],
    "overrides": {"test-lead": {"permissionPreset": "analysis"}},
    "custom": [{
      "id": "migration-owner",
      "name": "Migration owner",
      "description": "Review database changes.",
      "permissionPreset": "analysis",
      "promptPath": "docs/agent-roles/migration-owner.md",
      "routing": {
        "when": ["CUSTOM_ROUTE_SENTINEL"],
        "avoid": ["CUSTOM_AVOID_SENTINEL"]
      }
    }]
  }
}
```

本轮结果：

```json
{
  "disabledAbsentFromIndex": true,
  "customInIndex": true,
  "whenInIndex": true,
  "whenInNative": false,
  "avoidInNative": false,
  "testLeadReducedToAnalysis": true,
  "testLeadStillPromisesExecution": true,
  "diagnostics": {
    "activation": "automatic",
    "activationPath": ".codex/agents",
    "permissionMapping": "native"
  }
}
```

Hook 探针使用临时项目（hooks.mode=enforce），调用 evaluateHook；rawInput 为 PreToolUse、agent_type=test-lead、tool_name=Bash、tool_input.command=`printf fixture > result.txt`，host=claude、environment={}。返回 {}。该调用只运行策略判断，未执行 command。它用于界定角色限制的责任层，不是演示绕过父 sandbox。

## 9. 覆盖与限制

- 已逐一检查七个内置 Prompt、共同 base、主治理/协作规则、role pack/schema、custom/override/disabled、原生投影和安装消费链；每个角色与八个宿主均在矩阵中有结论或未验证说明。
- 使用 codebase-memory Auditor 深度的有界源码审查：本轮索引 ready，generation 为 `2026-09-05T04:04:29Z`；角色安装关系查询和相关 trace 均完成返回页。对 55 个证据路径检查 coverage，均为 metadata_match、no_recorded_issue。
- 图明确排除 .agents 与 .codex 子树，已以 filesystem 枚举/存在性探针补证安装状态；未将“图无结果”作为不存在的证据。无 recorded gap 也不等于数学意义的完整性保证。
- 没有读取治理记忆或会话记忆正文，没有修改全局 Agent/MCP 配置，没有启动第三方宿主任务或读取其用户凭据。
- 官方文档描述的是当前公开契约，本轮未固定本机八种宿主版本；因此 F01 的契约不一致有依据，但实际错误形态、角色加载、MCP 连通、权限强制和行为可靠性仍需独立宿主实测。
- 专业 Prompt 较短本身不是缺陷；父 Agent 合理全流程工作不是万能 Agent 反模式；没有机器 scheduler 是既定边界。删除/合并建议来自责任和交付重叠，而不是按字数或职位名称判断。
- 后续优先修复可调用性与证据链，再用真实行为评测判断独立角色是否值得保留。仅增加 Prompt 篇幅无法解决已确认的工具、权限和指纹问题。
