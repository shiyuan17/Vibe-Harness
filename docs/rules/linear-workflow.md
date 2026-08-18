# Linear 多 Agent 工作流

Linear 保存工作状态、责任、委派与依赖；GitHub 或 GitLab 保存代码、提交、PR/MR、检查与合并状态。Agent 自报、Execution Receipt 或本地工作完成都不能替代代码与合并证据。

默认采用轻量三层工作流：<code>feat/*、fix/* → develop → main</code>；紧急修复使用 <code>hotfix/* → main → develop</code>。<code>develop</code> 是日常集成分支，<code>main</code> 是正式发布分支；不创建长期 <code>release/*</code> 分支。任务分支应在约两个工作日内合并和删除，超出时优先拆小或用 feature flag 隔离未完成功能。

## 授权与长期边界

- 禁止自动领取：不得扫描、轮询、订阅或从 Ready Queue 选择 Issue，不增加 Webhook 调度器、Linear Loop、leader lease、自动超时回收或自动重派。
- Writer 只在两种情况下启动：用户在本轮明确要求实现、处理、继续或领取某个具体 Issue；或 Issue 已委派给当前 Agent，且宿主以该 Issue 为目标显式启动本次运行。普通提及、查看、总结、解释、Review、Verify 或列出队列都不授权登记或执行。
- 人类 Assignee 是结果责任人；Linear Delegate/App User 是 Agent 产品身份；Execution Receipt 记录具体运行实例；Activity Feed 记录委派与身份变化。
- 显式执行指令只授权当前 Issue 的最小身份登记，不授权修改 Assignee、Priority、Contract、Project、Cycle、Parent 或 relations。已有其他 Delegate、fallback Agent 标签或活动运行时，必须停止并请求显式 release 或 handoff。
- Reviewer 和 Verifier 只读，不写 Receipt、不修改 Delegate 或 fallback 标签，也不取得实现所有权。

每个请求在任何写入前都必须建立 Execution Envelope，mode 只允许 inspect、plan、linear-sync、execute、monitor；effect 只允许 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse，并分别列入 allowedEffects 或 forbiddenEffects。linear-sync 只允许本轮明确要求的 Linear 写入，必须禁止代码、worktree/分支、提交、推送、PR/MR 和凭据 effect。Ready、Todo、依赖满足或队列可见只表示执行条件满足，不构成 execute 授权；当前 terminalCondition 达成后不得自动选取下一个 Ready 节点。

## 固定状态与责任

团队使用 Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done。Triage 四动作 accept / duplicate / decline / snooze 需要人工确认；Agent 不自动处置。Blocked 不是状态，只使用原生 blocked-by / blocks 关系；related 永不表示依赖，关系解除或调整也需要授权。

- Todo：Definition of Ready 完整，所有直接前驱满足 trigger，且没有 Scope 或 Resource Lock 冲突。
- In Progress：身份登记与 Receipt 已确认且节点工作已经开始；write 节点还必须已创建 worktree 和分支，Draft PR 仍保持此状态。
- In Review：PR/MR 已退出 Draft 并进入审查。
- Ready to Merge：受保护分支要求的 review、CI、契约检查和必要 E2E 均通过。
- Done：write 叶子由 closing PR/MR 合并到声明的精确目标 ref 证明；read 叶子由约定输出和 Verification 证据证明；aggregate Parent 由全部必需后代成功和 Fan-in Verification 证明。

Agent 手工写状态必须执行“读取当前值 -> 校验允许转换 -> 写入 -> 重读确认”。实时状态和提供方事实优先于旧计划、任务模板、DAG 快照或压缩摘要；常规代码流只前进 Todo -> In Progress -> In Review -> Ready to Merge -> Done。任何后退、重开或纠错转换都需要单独的状态纠错授权并记录事实原因，尤其不得为恢复 Ready 清单或旧规划统计把 In Progress、In Review 或 Ready to Merge 退回 Todo。

一个 write 叶子 Issue 对应一个 Writer；按隔离条件使用当前 clone 或仓库外 worktree，并且只绑定一个命名分支和一个 closing PR/MR。顺序执行且工作区干净时允许在当前 clone 创建任务分支；存在并发 Agent、脏工作区、当前分支含无关改动或任务明确要求隔离时，必须使用仓库外 worktree。read 叶子只绑定一个执行 Agent、约定输出与 Verification 证据，不要求实现 worktree、分支或 PR/MR。存在子 Issue 的 Parent 是 aggregate，不直接实现。独立旧 Issue 可无 Parent，并按 kind=write、trigger=all_success、resourceLocks=None 处理，无需迁移。

## Definition of Ready 与原生 DAG

Todo Issue 必须包含 Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies 和 Verification。Target branch 必须能解析到准确远端 ref；“默认分支”只有经仓库事实解析为实际实现基线时才有效，否则返回 NOT_READY_TARGET_BRANCH。Dependencies 只能是 None 或 Managed by Linear relations；描述中的明确依赖陈述必须与原生关系一致，否则不 Ready。Parent/Sub-issue 只表示分解，不隐含顺序；blocked-by / blocks 是唯一执行依赖，related 不进入 DAG。

DAG 节点可声明 kind（read / write / aggregate）、trigger（all_success / all_done）和 resourceLocks。无 Parent 的旧 Issue 使用上述默认值；有子 Issue 的 Parent 必须是 aggregate。all_success 要求全部直接前驱 succeeded，Canceled、Duplicate、Won't Fix、failed、skipped 或 cancelled 都不算成功。all_done 只允许 aggregate、清理或失败报告节点在全部直接前驱终结后运行，且不能把失败 DAG 或 Root 判为成功。

自依赖、任意依赖环、不可见前驱、关系读取不完整、未解决的 blocked-by 或未满足 trigger 都阻止开始。Scope 是 writeScope 的 Linear 投影，只接受精确项目相对路径或末尾为 /** 的目录；统一使用 / 并移除前导 ./，拒绝绝对路径、UNC、空路径、.. 和其他复杂 glob，Windows 比较忽略大小写。write 节点的 Scope 重叠或 resourceLocks 相同，只有存在从一方到另一方的原生依赖路径时才已串行；否则冲突节点都不 Ready。Agent 只报告冲突、边或环，不自行拆 Issue、改变 Parent、创建或删除关系、调整优先级或创建额外节点。

DAG Parent 模板包含 Goal、整体 Acceptance Criteria、Shared Contract、Out of Scope、Fan-in Verification 和 Completion Policy。所有 descendant 默认必需；任一必需节点非 succeeded 时 Parent 不得 Done。关闭 Linear 的 Parent/Sub-issue 自动关闭，避免绕过 closing PR/MR 与 fan-in 验证。

同一用户请求最多执行一次全项目 DAG 全量遍历。首次完整读取后保存 dagStructureHash，至少覆盖节点 ID、Parent 边、blocked-by / blocks 边、kind、trigger、Scope、Resource Locks、Repository 和 Target branch；提供方支持变化游标时另存可选 dagChangeCursor。恢复时只有摘要与游标共同证明结构未变化，才只读取当前 Issue、PR/MR、HEAD 与变化节点；禁止再次逐项读取全部节点。没有可用 dagChangeCursor 或无法证明完整性与变化边界时 fail-closed，不得仅凭旧哈希跳过校验，也不以重复全量轮询替代证据。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得为此执行全项目 DAG 遍历。发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系读取不完整时退出快车道，再按上述 DAG 门禁读取足够范围。

## 显式执行登记

Linear 正常可写通道下，在开始节点工作前按固定顺序执行：

1. 读取状态、Assignee、Delegate、描述、全部原生 relations、团队 Guidance，以及足以判定所有未终结结构化执行记录的完整评论历史。
2. 验证 Todo、Definition of Ready、DAG、仓库、精确目标远端 ref、Scope 和 Verification；解析并冻结目标 ref 的 base SHA。分页不完整、记录无法解析或相互矛盾时 fail-closed。
3. 检查 Delegate、管理员预配置的 fallback 标签和活动实例；存在其他身份或活动实例时停止并请求显式交接。
4. 保留人类 Assignee。优先登记原生 Delegate/App User；不支持时只使用低基数 agent:<agent-key> 与 role:writer 标签，不创建实例级标签，也不覆盖其他 agent:* / role:* 标签。
5. 追加不可变 Execution Receipt，并重新读取逐字段确认身份和 Receipt 一致；确认成功后才开始节点工作，write 节点按隔离条件创建当前 clone 分支或仓库外 worktree 并实现。

Receipt schema 为 vibe-harness.linear-execution/v1，字段固定为 executionId、source、agentKey、hostKind、delegateId、runtimeInstanceId、role、dagRootIssue、dagNodeIssue 和 startedAt。source 只允许 explicit-user-request、existing-delegate、authorized-handoff。executionId 与 runtimeInstanceId 使用 UUID v4；runtimeInstanceId 是本 Receipt 新生成的关联 ID，不得复制宿主 thread、session、用户名、主机名或本地路径。

一个 start Receipt 在其后没有有效终结事件时为 active，同一 Issue 最多一个 active execution。传输重试复用同一组 ID：结果不确定时先重读，字段完全一致视为幂等成功；同 ID 内容不同、出现第二个 active execution 或 identity / Receipt 不一致时停止。同一运行时的上下文压缩或恢复保留原 executionId 与 runtimeInstanceId；新的运行时不得静默接管 active Receipt，必须先走显式 handoff 或 release。身份已写但 Receipt 未确认时报告 registration-incomplete，不开始实现，也不删除或编辑原记录。

原 Receipt 不得编辑。released、aborted、handed-off、local-work-completed 使用 vibe-harness.linear-execution-event/v1 追加事件，包含 eventId、executionId、eventType、successorExecutionId 和 occurredAt；每个 execution 最多一个有效终结事件，矛盾事件 fail-closed。local-work-completed 不是 Linear Done。handoff 先用预定 successorExecutionId 终结旧运行，再用同一 successor ID 创建 source=authorized-handoff 的新 Receipt；重试不得生成第三套 ID。release 可按明确授权清除 Delegate，abort 和 local completion 默认保留 Delegate。

Receipt 与事件禁止包含用户名、主机名、本地路径、Token、Cookie、会话凭据或个人敏感数据。只读、MCP 不可用、写入或重读验证失败时不得声称已登记领取；有明确执行指令时可以按用户上下文以 unregistered / Linear 未同步模式做本地工作，但不得回填成先前已经登记，写能力恢复后继续执行需从恢复时刻创建新的 registered execution。

上下文压缩、重试或工具重连前后的 checkpoint 必须保留 envelope 的 requestId、mode、activeObjective、唯一当前 Issue、allowedEffects、forbiddenEffects 和 terminalCondition，以及 completedFacts、noRepeatSet、nextAction、liveStates、blockerFingerprint 和 dagStructureHash；提供方支持时另存可选 dagChangeCursor。恢复后的第一个写调用前重新读取当前 Issue 与相关 Git/PR/MR 状态，确认 mode、目标、effect 和下一动作仍一致；最新用户意图高于 checkpoint，实时状态高于旧摘要。任何字段无法可靠恢复时只允许只读核对和重新规划。

## Git、状态同步与安全

- 普通功能和修复的精确目标 ref 默认为 <code>origin/develop</code>，分支分别使用 <code>feat/&lt;ISSUE-ID&gt;-&lt;slug&gt;</code> 与 <code>fix/&lt;ISSUE-ID&gt;-&lt;slug&gt;</code>；closing PR 合并到 <code>develop</code> 后开发 Issue 即 Done，发布等待不得阻塞或重开它。
- 紧急修复从 <code>origin/main</code> 创建 <code>hotfix/&lt;ISSUE-ID&gt;-&lt;slug&gt;</code> 并先合入 <code>main</code>；正式发布或恢复后必须立即以非 closing PR 将 <code>main</code> 回同步到 <code>develop</code>。回同步失败是发布阻塞，不得静默 cherry-pick 成两套历史。
- 正式发布使用独立 kind=aggregate Release Issue 和 <code>develop → main</code> merge-commit PR；随后保留 release-please 版本 PR。提升与回同步 PR 使用 <code>Refs &lt;ISSUE-ID&gt;</code>，不得再次 closing 已 Done 的开发 Issue。Release Issue 只有在 GitHub Release、制品、发布 smoke 和 <code>main → develop</code> 回同步全部有证据后才能 Done。
- write 节点分支使用 <type>/<ISSUE-ID>-<slug>；worktree 位于仓库同级的 <repo>-worktrees/<ISSUE-ID>。commit 使用 <code>Refs &lt;ISSUE-ID&gt;</code> 关联；GitHub PR 或 GitLab MR 的 closing 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code>，只有提供方配置且创建后重读确认有效的等价 closing 语法才可替代，closing 词不放在 commit 中。
- 开始实现前记录精确目标远端 ref 和 base SHA，并从该基线创建分支。创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方所选 target 与声明 ref 相同，并验证 merge-base 等于冻结 base SHA 或是该 SHA 在同一目标 ref 历史上的已验证后代；不一致时阻断创建。创建后重读确认标题、source、target、描述、Issue 链接和 closing 语义。
- 优先由 Linear 的 GitHub/GitLab 集成或团队已配置自动化推进 In Progress、In Review、Ready to Merge 和 Done。只有缺少对应自动化且 Execution Envelope 明确允许 linearWrite 时才按状态写入协议手工回写。
- Ready to Merge 依赖 branch protection、required review 和 required checks；没有这些门禁时不得仅凭 Linear 自动化声称可合并。
- 已授权 Issue 内可追加事实性的进展、验证、阻塞或决策评论。除本节定义的最小身份登记外，创建其他 Issue、改变关系、优先级、Assignee、Delegate、Project、Cycle、Parent 或 Contract 都需要单独授权。
- MCP 不可用时可以使用用户提供的 Issue 内容，但必须明确未读取或同步 Linear；不得伪造评论、状态、关系、Delegate、Receipt、PR、review、CI 或 merge 结果。

Git credential helper 仅可由其配置的 Git transport 透明使用。仅有 Git transport 授权时不得读取、解析或转换 helper 输出用于网页/API 会话；这种用途必须另有 credentialUse 与对应外部写入授权。Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或辅助文件也不得写入仓库或 worktree。

默认 terminalCondition 是当前 Issue 的已授权 effects 完成：本地实现只交付到本地验证；若授权到 mergeRequestWrite，则在 PR/MR ready for review、创建后重读确认并完成所有已授权证据同步时结束。Linear 自动化或已授权回写应使 Issue 进入 In Review；若状态同步不可用或未授权，报告差异后结束，不得因此续跑。除非用户明确授权 mode=monitor 并给出观察终点或时间边界，否则不得等待人工合并、持续轮询、自动续跑或执行下一个 Ready 节点；达到终止条件也不等于 Done。

推荐 Writer In Progress 不超过 3、In Review 不超过 2。AI Ready Queue 只供人查看和显式选择；Agent 不读取它来挑选工作。
