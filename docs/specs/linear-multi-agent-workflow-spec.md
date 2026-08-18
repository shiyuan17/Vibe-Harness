# Linear 多 Agent 工作流规格

## 状态

状态：Implemented（V1.1 资产合同；宿主执行强制能力按集成条件生效）

## 目标

Vibe-Harness 通过显式 integration plugin 提供 Linear 工作流规则、操作 Skill、团队模板和项目级 Remote MCP 配置。Linear 是工作状态、责任和原生依赖真值，GitHub 或 GitLab 是代码、PR/MR、检查和合并真值。

默认交付分支模型是轻量 GitFlow：<code>feat/*、fix/* → develop → main</code>，hotfix 使用 <code>hotfix/* → main → develop</code>。开发 Issue 在 closing PR 合入 <code>develop</code> 后 Done；正式发布由独立 aggregate Release Issue、<code>develop → main</code> 提升 PR、release-please 版本 PR 和 <code>main → develop</code> 回同步共同证明。

V1.1 增加显式执行登记、具体运行实例审计和原生 DAG 完成语义，同时长期保留禁止自动领取。交付范围是规则、Skill、模板、安装投影、ADR、测试和 Eval，不包含常驻运行服务。

## 非目标

- 不扫描或轮询 Ready Queue，不创建 Webhook 调度器、Linear Loop、leader lease、自动超时回收或自动重派。
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

任何写入前必须为当前请求建立逻辑 Execution Envelope，至少包含 schema、requestId、sessionId、mode、targetIssueIds、allowedEffects、forbiddenEffects、terminalCondition 和 activeObjective。mode 只允许 inspect、plan、linear-sync、execute、monitor；effect 只允许 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse。各 effect 独立授权且 forbiddenEffects 优先；实现授权不自动包含分支、提交、推送、PR/MR 或凭据使用。

inspect 与 plan 默认只读。linear-sync 仅允许本轮明确要求的 Linear 写入，必须禁止其他六种 effect。execute 只能实施授权的最小 effects。monitor 默认只读且写 effect ceiling 为空，并必须包含观察对象、终止事件或时间边界。Ready、Todo、依赖满足或队列可见只表示条件满足，不构成 execute 授权。

默认 terminalCondition 是当前 Issue 的已授权 effects 完成；若授权到 mergeRequestWrite，则 PR/MR ready for review、创建后重读确认并完成已授权证据同步时结束。Linear 自动化或已授权回写应进入 In Review；同步不可用或未授权时报告差异后结束。人工合并不是默认持续目标；没有显式 monitor 授权时不得持续轮询、自动续跑或选择下一个 Ready 节点。

本规格的 Implemented 表示规则、Skill、模板、schema、测试和 Eval 资产合同已经交付，不代表每个宿主都存在常驻状态服务或完整 Hook enforcement。支持结构化会话状态的宿主应持久化 envelope/checkpoint；不支持时由 Agent 在当前上下文执行门禁，恢复后不能证明一致性则 fail-closed。Hook 只能约束其可观察的调用，不能证明未暴露远程工具的安全性。

## 显式执行授权

只有以下情况允许 Writer 启动：

1. 用户在本轮明确要求实现、处理、继续或领取某个具体 Issue。
2. Issue 已委派给当前 Agent，且宿主以该 Issue 为目标显式启动本次运行。

提及、查询、总结、解释、Review、Verify 或列出队列不构成领取授权。没有具体 Issue 时不得主动读取、搜索、选择、领取或更新 Ready Queue。Triage 的 accept、duplicate、decline 和 snooze 仍需人工决定，且 accept 不等于执行授权。

用户只要求更新 DAG、同步 Linear 元数据或当前任务已经完成时，即使存在 Ready Issue，也不得登记 Writer、创建 worktree/分支或开始实现。新执行必须来自新用户输入，或宿主对已委派具体 Issue 的显式启动。

显式执行授权只包含当前 Issue 的最小身份登记；不包含修改人类 Assignee、Priority、Contract、Project、Cycle、Parent 或 relations，也不包含创建其他 Issue。

## 身份与执行记录

责任分为四层：

- 人类 Assignee：结果责任人，Agent 登记不得覆盖。
- Linear Delegate/App User：Agent 产品身份。
- Execution Receipt：具体运行实例。
- Linear Activity Feed：委派或身份变更历史。

不支持 Delegate 时，只能使用管理员预配置的低基数 agent:<agent-key> 和 role:writer 标签；不得创建 execution、runtime、thread 或 session 级标签。

正常启动顺序固定为：读取 Issue 和完整 Receipt 生命周期事实；通过 Todo、Definition of Ready、DAG、仓库、精确目标远端 ref、Scope 和 Verification 门禁；解析并冻结目标 ref 的 base SHA；检查其他 Delegate、fallback identity 和活动实例；登记身份；追加 Start Receipt；重新读取逐字段确认；最后才开始节点工作。write 节点此时才创建仓库外 worktree、命名分支并开始实现；read 节点只产出约定输出和 Verification 证据。“默认分支”只有解析后确为实现基线时才有效，否则返回 NOT_READY_TARGET_BRANCH。

任一步出现部分写入、结果不确定或验证失败，都进入 registration-incomplete，不得声称已领取或开始实现。同一 Issue 同时最多一个 active execution；其他 Delegate、其他 fallback identity 或其他活动实例必须显式交接。

Start Receipt 使用 schema vibe-harness.linear-execution/v1，字段和枚举以 execution-receipt.md 为准。释放、中止、交接和本地工作完成使用 vibe-harness.linear-execution-event/v1 追加 terminal event；原记录不得编辑。一次写入尝试的重试以及同一运行时的上下文压缩恢复复用相同 ID；新的运行时不得静默采用 active Receipt，必须显式 handoff 或 release。

交接先终结旧 execution，并预先引用 successor executionId，再更新身份和追加 source=authorized-handoff 的新 Receipt。中途失败报告 handoff-incomplete，重试复用 successor ID。没有自动超时或自动回收；失联实例由人工核对 worktree、分支和 PR 后显式释放或交接。

checkpoint 必须保留 envelope 的 requestId、mode、activeObjective、唯一当前 Issue、allowedEffects、forbiddenEffects 和 terminalCondition，以及 completedFacts、noRepeatSet、nextAction、liveStates、blockerFingerprint 和 dagStructureHash；提供方支持变化游标时另存可选 dagChangeCursor。压缩恢复后的第一个写调用前重新读取当前 Issue 与相关 Git/PR/MR 状态，确认 mode、目标、effect 和下一动作仍与最新用户意图一致；实时事实高于旧计划或摘要，无法可靠恢复时仅允许只读核对和重新规划。

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
| 执行者 | Delegate + Execution Receipt |

Parent/Sub-issue 只表示分解，不隐含执行顺序；related 也不表示依赖。Dependencies 只允许 None 或 Managed by Linear relations，不维护重复 Issue 清单。描述明确声明依赖但缺少对应原生关系时，任务不 Ready。

独立旧 Issue 默认 Root=None、kind=write、trigger=all_success、resourceLocks=None，无需迁移。节点可声明 kind=read|write|aggregate、trigger=all_success|all_done 和稳定低基数 Resource Locks。Parent 必须 aggregate；V1.1 不定义 optional node，Parent 的全部 descendant 都是 required。

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

固定状态为 Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done；Blocked 只使用关系。Linear 的 GitHub/GitLab 集成或团队自动化优先推进代码状态，缺少自动化时只有 Execution Envelope 允许 linearWrite 的 Writer 才能回写当前 Issue。

Agent 手工状态写入必须按“读取当前值 -> 校验允许转换 -> 写入 -> 重读确认”执行。实时状态与代码提供方事实优先于旧计划、DAG 快照或压缩摘要；常规代码流只前进 Todo -> In Progress -> In Review -> Ready to Merge -> Done。任何后退、重开或纠错转换都需要单独状态纠错授权和事实原因，不得为了 Ready 清单或旧规划统计把 In Progress、In Review 或 Ready to Merge 退回 Todo。

- write 叶子 Done：closing PR/MR 已合并到声明的精确目标 ref。
- read 节点 Done：约定输出和 Verification 证据已记录。
- aggregate Parent Done：每个 required descendant 按自身 kind 成功，且自身与 Root 的 Fan-in Verification 通过并记录证据。

任一 required descendant 失败、阻塞、跳过、取消、Duplicate 或 Won't Fix 时，Parent 不得成功或 Done；成功的 all_done 报告节点不能覆盖失败。Workspace 应关闭 Parent/Sub-issue 自动关闭，但该设置由管理员手工完成，不授权 Agent 修改。

本地工作完成、Agent 自报、测试通过或 PR/MR 创建都不等于 Linear Done。local-work-completed terminal event 只结束运行实例，不替代 closing PR/MR 或 fan-in 证据。

## 安全与降级

Reviewer 和 Verifier 保持只读：不写 Receipt、不修改 Delegate、不取得实现所有权；即使共享配置暴露写工具也不得调用。

Linear 只读、MCP 不可用或写入验证失败时，不得声称已登记、领取或同步。只有用户明确要求执行具体 Issue，且用户提供的上下文足以通过 Ready 与 DAG 门禁时，才可走 unregistered / Linear 未同步的本地回退路径。写能力恢复后不得倒签或回填 Receipt；继续执行时从恢复时刻创建新的 registered execution。

Receipt、event、评论、Eval 和日志不得包含用户名、主机名、本地路径、Token、Cookie、认证头、验证码、真实 thread/session ID、OAuth 凭据或个人敏感数据。不得伪造 Linear、PR/MR、CI、review 或 merge 状态。

## 兼容与演进

V1.1 对旧 Issue 采用无需迁移策略。Receipt 和 event 通过 schema 版本区分，采用追加式演进：消费者可以忽略不改变现有语义的新增字段；字段删除、改名、类型变化、枚举语义变化或完成条件变化必须使用新的 schema major。未知 major 或矛盾记录必须 fail-closed。

## 交付资产与验证

Integration 交付 Linear 规则、Skill、AI Coding Task、DAG Parent、Execution Receipt、Triage、Workspace Setup 模板和项目级 MCP 安装投影。确定性测试覆盖插件互斥、默认 profile 不变、安装投影、Receipt 契约和 DAG 规则；Online Eval 保留 NO_AUTO_CLAIM，并覆盖显式登记、身份冲突、授权交接、fallback 标签基数、只读降级、Reviewer/Verifier、依赖环、Scope/Lock 冲突、trigger、closing PR/MR 和 fan-in 完成语义。

V1.1 关键恢复 Eval 还必须覆盖：linear-sync 遇 Ready 节点不执行代码；无新输入不续跑下一节点；压缩后恢复同一目标；实时 In Review 不被旧 Todo 快照覆盖；不精确目标 ref 返回 NOT_READY_TARGET_BRANCH；credential helper 不转作网页/API 登录；PR/MR base 与实现 merge-base 不一致时创建前阻断；DAG 摘要未变时不重复全量读取。
