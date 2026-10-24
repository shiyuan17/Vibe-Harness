# Linear 多 Agent 工作流规格

## 状态

状态：Implemented（资产合同；宿主执行强制能力按集成条件生效）

## 目标

Vibe-Harness 通过显式 integration plugin 提供 Linear 工作流规则、操作 Skill、团队模板和项目级 Remote MCP 配置。Linear 是工作状态、责任和原生依赖真值，GitHub 或 GitLab 是代码、PR/MR、检查和合并真值。

默认交付分支模型是轻量 GitFlow：<code>feat/*、fix/* → develop → main</code>，hotfix 使用 <code>hotfix/* → main → develop</code>。开发 Issue 在 closing PR 合入 <code>develop</code> 后 Done；正式发布由独立 aggregate Release Issue、<code>develop → main</code> 提升 PR、release-please 版本 PR 和 <code>main → develop</code> 回同步共同证明。CI 只在发布边界运行（<code>develop → main</code>、<code>hotfix/* → main</code> 和 <code>release/*</code>）；合入 <code>develop</code> 不要求远端 CI 或强制人工审批，Writer 可在授权后自行落地 squash merge。合并前的本地验证必须建立在合并时的最新 <code>origin/develop</code> 之上，base 前进后重跑受影响检查或交由 merge queue 重跑；develop 按风险完成必要验证，独立审查可选；项目明确的审查和分支保护继续生效。<code>release/*</code> 不是日常分支，仅由管理员为并行维护版本临时创建，出现时按带门禁目标处理。

本规格定义显式执行、必要身份状态同步和原生 DAG 完成语义。显式执行由本轮用户请求授权，不要求用户提供 Claim/Grant；自动领单已退役，不要求 Start/Terminal Receipt。Vibe-Harness 交付规则、Skill、模板、收据校验、安装投影、ADR、测试和 Eval；不包含常驻派发服务，亦不因安装资产而启用真实自动领单。Symphony 宿主集成边界见 Linear Skill 的 `references/symphony-host.md`。

## 非目标

- Agent 不扫描或轮询 Ready Queue；Vibe-Harness 不创建常驻调度器、Linear Loop、自动超时回收或自动重派。旧自动领单合同只读兼容，不再启用。
- 不直接修改真实 Workspace 的 workflow、template、guidance、view、Parent 自动关闭设置或 GitHub/GitLab automation。
- 不自动拆 Issue、改变 Parent、创建依赖、调整优先级或生成额外 DAG 节点。
- 不修改 Linear MCP endpoint、认证方式、插件互斥或默认 profile。

## 安装合同

- linear-mcp 选择读写 endpoint https://mcp.linear.app/mcp。
- linear-mcp-readonly 选择 https://mcp.linear.app/mcp/readonly。
- 两者互斥、必须显式选择、不属于任何默认 profile，也不随 plugin all 展开。
- 安装器只管理项目级配置，不保存 Token、API key 或 OAuth 凭据，也不修改真实 Workspace 配置。
- Codex、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 使用项目级配置；Claude 和 Gemini 安装规则与 Skill，并报告 MCP 需要手工配置。

Remote MCP server 使用 url，本地 MCP server 使用 command、args 和 env；同一 server 不得同时使用两种形态。OpenCode 将 remote server 转换为 type remote，其他 JSON adapter 使用 URL 配置，Codex TOML 使用 url 字段。

## Execution Envelope 与宿主边界

本节的 v1 是显式单次执行和低风险项目内写入的兼容合同；它不能授权 hostWrite、externalWrite、凭据、高风险间接写入、红区或移动活动任务自身绑定的 worktree。用户不需要提供 v1 JSON，Agent/宿主根据当前请求与工作区事实建立逻辑记录。高风险跨边界效果以 v2 宿主合同为准。worktree 生命周期（创建、实现、回收、清理）是工作区内部操作，按 <code>workspaceWrite</code>/<code>gitBranch</code> 授权，不需要宿主证明。v2 额外冻结 riskClass、canonical cwd、worktree root、Git common dir、git dir、branch、base ref/SHA、initial HEAD、allowed write roots、无凭据 external targets、可选的 <code>scope.linear</code> team/project 目标，以及仅由宿主注入的 filesystem、approval、process、network 证明。

Linear 写入按归一化后的 MCP server 段绑定 provider，因此安装器写入的 <code>linear</code>、provider 别名 <code>linear-mcp</code>/<code>linear-mcp-readonly</code> 与角色投影的 <code>vibe-harness-linear</code> 解析为同一 provider。更新既有 Issue 仍以 toolInput 暴露的 Issue ID 与 <code>targetIssueIds</code> 绑定；新建 Issue 时 toolInput 中不存在 Issue ID，此时由 <code>scope.linear</code> 的 <code>teamIds</code>/<code>projectIds</code> 提供可核验的 team/project 目标，登记之外的 team/project 一律拒绝；未登记 <code>scope.linear</code> 的新建保持 fail-closed。

高风险或不可分类调用缺少 high-risk v2、精确目标或新鲜宿主证明时 fail-closed。活动执行的 workspace identity 不可移动；worktree move 无法由 effect allowlist 授权。checkpoint 另保存 headSha、continuationCount 和 blockerCount；每次自动续跑前重读原生 Goal、thread status、最新用户输入、cwd、worktree、branch、HEAD 和 blocker。达到终点、等待审批、workspace 漂移、未归属 HEAD 或相同 blocker 连续三次时停止；没有原生 Goal bridge 时只输出可恢复 checkpoint，不跨 turn 自主续跑。

除 `git-rules.md` 限定的普通提交与当前分支普通推送外，写入前必须为当前请求建立逻辑 Execution Envelope，至少包含 schema、requestId、sessionId、mode、targetIssueIds、allowedEffects、forbiddenEffects、terminalCondition 和 activeObjective。mode 只允许 inspect、plan、linear-sync、execute、monitor；v1 枚举为 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse，其中 `credentialUse` 仅保留解析兼容，实际凭据操作按高风险分类并由运行时拒绝 v1；v2 增加 hostWrite、externalWrite，凭据及其他高风险效果还须满足适用的宿主核验。`gitCommit`／`gitPush` 继续保留兼容字段，普通操作不需要逐项登记或 execute 模式，已有有效 Envelope 的 forbiddenEffects 仍优先；其他 effect 独立授权，实现授权不自动包含分支、PR/MR 或凭据使用。<code>mergeRequestWrite</code> 覆盖创建或更新 PR/MR 与落地该 PR/MR 的合并（squash merge 或 auto-merge）。

inspect 与 plan 默认只读。linear-sync 仅允许本轮明确要求的 Linear 写入，必须禁止其他六种 effect。execute 只能实施授权的最小 effects。monitor 默认只读且写 effect ceiling 为空，并必须包含观察对象、终止事件或时间边界。Ready、Todo、依赖满足或队列可见只表示条件满足，不构成 execute 授权。

默认 terminalCondition 是当前 Issue 的已授权 effects 完成；若授权到 mergeRequestWrite 且目标为 <code>develop</code>，则在 closing PR/MR 已 squash 合并到声明的精确目标 ref、创建后重读确认并完成已授权证据同步时结束，写叶子 Issue 同时进入 Done；若未授权落地 merge，则在 PR/MR ready for review、创建后重读确认后结束并报告等待人工合并。Linear 自动化或已授权回写应进入 In Review 或 Done；同步不可用或未授权时报告差异后结束。单次运行不持续轮询或选择下一个 Ready 节点；已授权整计划可在依赖就绪后接续，不扫描队列。

本规格的 Implemented 表示规则、Skill、模板、schema、测试和 Eval 资产合同已经交付，不代表每个宿主都存在常驻状态服务或完整 Hook enforcement。支持结构化会话状态的宿主应持久化 envelope/checkpoint；不支持时由 Agent 在当前上下文执行门禁，恢复后不能证明一致性则 fail-closed。Hook 只能约束其可观察的调用，不能证明未暴露远程工具的安全性。

## 显式执行授权与历史记录

只执行显式授权 Issue、当前计划或宿主明确启动的既有委派 Issue；计划内可接续，不扫描队列自行抢单。普通显式 Issue 执行只包含当前 Issue 的最小身份登记和必要状态同步；只有显式调用 `vb-linear-worktree-develop` 才额外覆盖当前计划的 Parent、子任务和原生关系，不修改无关 Issue 或业务字段。

显式执行不要求 Claim 或 Start/Terminal Receipt，同一 Issue 不重复并行执行。通过 Ready、原生关系、Scope、资源及工作区核验后，同步必要身份与状态并重读确认。Delegate、历史活动 v1/v2/v3 Receipt 和现有 worktree 参与冲突检查，不自动接管、超时释放或重派。用户不填写 grantId、claimId、lease 或 fencing 字段；不新建替代锁服务。

历史 v1/v2/v3 Receipt 与 event v1 保持只读兼容，字段与终结语义见 references/execution-receipt.md，旧 Symphony 参考仅用于历史迁移。限时 Grant、原子 Claim 和自动队列派发已退出活动流程；历史活动记录矛盾仍须显式 handoff/release。

Linear 写入结果不明先重读，不盲目重建 Issue 或追加记录；尚未尝试写入且上下文足够时可本地继续并标记 Linear 未同步。恢复核对实时 Issue、授权、工作区、HEAD 和 Git common dir 阶段，不补造 Receipt。

## Linear DAG 合同

| Task DAG 语义 | Linear 投影 |
| --- | --- |
| DAG Root | 顶层 Parent Issue |
| 节点 | Sub-issue；独立任务可无 Parent |
| 分解关系 | Parent/Sub-issue |
| 执行依赖 | 原生 blocked-by / blocks |
| 输出 | Goal 与 Acceptance Criteria |
| 写入范围 | Scope 中的项目相对路径 |
| 逻辑锁 | DAG Metadata 的 Resource Locks |
| 验证 | Verification |
| 执行者 | 必要 Delegate/身份，历史 Receipt 参与冲突核验 |

Parent/Sub-issue 只表示分解，不隐含执行顺序；related 也不表示依赖。Dependencies 只允许 None 或 Managed by Linear relations，不维护重复 Issue 清单。描述明确声明依赖但缺少对应原生关系时，任务不 Ready。

独立旧 Issue 默认 Root=None、kind=write、trigger=all_success、resourceLocks=None，无需迁移。节点可声明 kind=read|write|aggregate、trigger=all_success|all_done 和稳定低基数 Resource Locks。Parent 必须 aggregate；本规格不定义 optional node，Parent 的全部 descendant 都是 required。

all_success 要求全部直接前驱成功；Canceled、Duplicate、Won't Fix、failed、skipped 和 cancelled 均不算成功。all_done 仅允许 kind=aggregate，且仅用于汇总、清理或失败报告；它只要求全部直接前驱进入终态，可以产出报告，但不能把失败 DAG 判为成功。

自依赖、任意依赖环、不可见依赖、无法完整读取关系、未满足 trigger 或未解决 blocked-by 都阻止相关节点开始。Agent 只能报告 offending edge 或 path，不得自行补、删或修改关系。

Scope 是 writeScope 的唯一 Linear 投影。只接受精确项目相对路径或末尾为 /** 的目录；统一使用 / 并移除前导 ./，拒绝绝对路径、盘符、UNC、任何 .. segment、空路径和其他复杂 glob。Windows 比较忽略大小写，祖先关系按 path segment 判定。

两个 write 节点 Scope 重叠或 Resource Lock 相同时，只有存在从一个到另一个的原生 dependency path 才视为已串行；否则两者都不 Ready。Agent 发现冲突后停止，不得自动创建关系。共享合同由唯一节点写入，其他节点消费稳定输出。

通用轻量 Task DAG 仍是本地协作记录；映射到 Linear 时，dependsOn 只能从原生 blocked-by / blocks 派生，不成为第二依赖真值。即使只使用一个 Agent，也不能忽略已有 Linear DAG。

同一用户请求最多执行一次全项目 DAG 全量遍历。首次完整读取后计算 dagStructureHash，输入至少包含节点 ID、Parent 边、blocked-by / blocks 边、kind、trigger、Scope、Resource Locks、Repository 和 Target branch；提供方支持变化游标时另存可选 dagChangeCursor。恢复时只有二者共同证明结构未变，才读取当前 Issue、PR/MR、HEAD 和变化节点；禁止再次逐项读取全部 DAG。没有可用 dagChangeCursor 或无法证明完整性与变化边界时 fail-closed，不得仅凭旧哈希跳过校验，也不进行无上限全量重跑。

## GitHub PR / GitLab MR 合同

write 节点使用 <code>&lt;type&gt;/&lt;ISSUE-ID&gt;-&lt;slug&gt;</code> 分支和仓库同级的 <code>&lt;repo&gt;-worktrees/&lt;ISSUE-ID&gt;</code>。commit 使用 <code>Refs &lt;ISSUE-ID&gt;</code>；closing PR/MR 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code>。只有提供方已配置并在创建后重读确认具有相同 closing 语义的语法才可替代；<code>Implements</code> 等非 closing 文本不合规。

开始实现前解析并冻结精确目标远端 ref 和 base SHA，分支从该基线创建。创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方 target 等于声明 ref，并计算 merge-base；merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代，否则必须阻断创建。创建后重读确认标题和 Issue ID、source、target、描述、Issue 链接及 closing 语义。

Git credential helper 只能由其配置的 Git transport 透明调用。提取、解析或转用 helper 输出进行网页/API 登录需要独立 credentialUse 和对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或辅助文件不得写入仓库或 worktree。

## 状态与完成语义

固定状态为 Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done；Blocked 只使用关系。Ready to Merge 只用于带门禁目标（<code>main</code>、<code>release/*</code>）；<code>develop</code> 快车道下 closing PR 合入后由 In Review 直接 Done。Linear 的 GitHub/GitLab 集成或团队自动化优先推进代码状态，缺少自动化时只有 Execution Envelope 允许 linearWrite 的 Writer 才能回写当前 Issue。

Agent 手工状态写入必须按“读取当前值 -> 校验允许转换 -> 写入 -> 重读确认”执行。实时状态与代码提供方事实优先于旧计划、DAG 快照或压缩摘要；常规代码流在 <code>develop</code> 路径上只前进 Todo -> In Progress -> In Review -> Done，只有带门禁目标才经过 Ready to Merge。任何后退、重开或纠错转换都需要单独状态纠错授权和事实原因，不得为了 Ready 清单或旧规划统计把 In Progress、In Review 或 Ready to Merge 退回 Todo。

- 普通 write 叶子 Done：closing PR/MR 已合并到声明精确目标 ref，保留 In Review。
- 显式 local-land write Done：Todo → In Progress → Done；候选必要验证通过，先 ff-only 更新主检出本地 develop，再显式非强制推送并精确重读远端确认。无需 PR，integrated_cleanup_pending 仍映射 succeeded 并释放依赖；清理状态单列，残留路径、端口及资源锁保持占用，禁止提前复用。
- read 节点 Done：约定输出和 Verification 证据已记录。
- aggregate Parent Done：每个 required descendant 按自身 kind 成功，且自身与 Root 的 Fan-in Verification 通过并记录证据。

任一 required descendant 失败、阻塞、跳过、取消、Duplicate 或 Won't Fix 时，Parent 不得成功或 Done；成功的 all_done 报告节点不能覆盖失败。Workspace 应关闭 Parent/Sub-issue 自动关闭，但该设置由管理员手工完成，不授权 Agent 修改。

本地工作完成、Agent 自报、测试通过或 PR/MR 创建都不等于 Linear Done。local-work-completed terminal event 只结束运行实例，不替代 closing PR/MR、local-land 或 fan-in 证据。

## 安全与降级

Reviewer 和 Verifier 保持只读：不写 Receipt、不修改 Delegate、不取得实现所有权；即使共享配置暴露写工具也不得调用。

Linear 只读或 MCP 不可用且本轮尚未尝试 Linear 写入时，不得声称已登记、领取或同步；只有用户明确要求执行具体 Issue，且现有上下文足以通过 Ready 与 DAG 门禁时，才可走 unregistered / Linear 未同步的本地回退路径。写入已尝试但结果不明、部分登记或重读验证失败时，保留现场并停止受影响节点，不切换为未登记执行。写能力恢复后不得倒签或回填 Receipt；完成状态核对后，按当前事实同步必要身份和状态，不要求新建 Receipt。

Receipt、event、评论、Eval 和日志不得包含用户名、主机名、本地路径、Token、Cookie、认证头、验证码、真实 thread/session ID、OAuth 凭据或个人敏感数据。不得伪造 Linear、PR/MR、CI、review 或 merge 状态。

## 兼容与演进

旧 Issue 无需迁移，历史 v1/v2/v3 Receipt 继续可读，未知或矛盾记录暂停相关执行。新成本计划采用 linear-plan/v2，单元含 kind、dependsOn，agentPlan 含 maxAgents；依赖是原生关系的规划快照，派发前重核，不成为第二真值。v1 继续可读但执行保守采用 single，需并行收益评估时显式升级 v2。

验收切片、依赖计划与多 Agent 并行分别判断。单 Agent 顺序任务也可按可观察增量拆片，普通固定步骤不强制完整 DAG；已有 Linear DAG 必须遵循。普通任务不计算容量、墙钟或并行收益；只有实际派发多个 Agent 时才按 task-decomposition 的按需 reference 判断隔离、容量和收益，容量或依赖不完整时保持 single。

Git local-land 默认 bootstrap 登记隔离树，主检出须在 develop 且干净；冻结唯一 origin 实际 push URL、refs/heads/develop 与候选 SHA，拒绝多地址或 mirror。本地只快进同步，候选 no-ff 合并并验证后先本地再远端。阶段保存在 Git common dir；失败保留现场，基线前进有界重建，本地已合并推送失败重试原候选，结果不明先查精确远端，远端分叉不自动 reset/rebase/force push。确认后的重试只清理，remote 参数写前拒绝。

## 交付资产与验证

Integration 交付 Linear 规则、Skill、AI Coding Task、DAG Parent、Execution Receipt、Triage、Workspace Setup 和 Symphony 宿主接入参考、v1/v2/v3 收据校验及项目级 MCP 安装投影。不交付自动派发宿主，也不宣称仅凭规则能真实领单。确定性测试覆盖插件互斥、默认 profile 不变、安装投影、Receipt 兼容、过期 Claim 禁止替换和 DAG 规则；Online Eval 保留无授权时的 NO_AUTO_CLAIM，并覆盖退役队列入口、无 Claim/Receipt 显式执行、并发冲突、只读端点、清理解耦及精确推送，以及既有显式登记和交付边界。Symphony 提供方及消费者共用契约样例，双实例、重启、网络中断、凭据代理、真实 Linear/Git 成功和失败路径须独立取证，单仓 mock 不构成集成完成证明。

关键恢复 Eval 还必须覆盖：linear-sync 遇 Ready 节点不执行代码；只在已授权计划内接续后继；压缩后恢复同一目标；实时 In Review 不被旧 Todo 快照覆盖；不精确目标 ref 返回 NOT_READY_TARGET_BRANCH；credential helper 不转作网页/API 登录；PR/MR base 与实现 merge-base 不一致时创建前阻断；DAG 摘要未变时不重复全量读取。
