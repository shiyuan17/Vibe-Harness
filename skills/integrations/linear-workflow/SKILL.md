---
name: linear-workflow
description: Use when executing, reviewing, verifying, refining, or synchronizing explicitly referenced Linear issues in a multi-Agent coding workflow.
---

# Linear 工作流

本 Skill 操作 Linear 工作项，不替代项目治理、Git 规则、测试或人工权限门禁。V1.1 禁止自动领取，也就是不自动从队列领单：不扫描或轮询 Ready Queue，不创建 Webhook 调度器、Linear Loop、leader lease、自动超时回收或自动重派。

默认采用轻量三层工作流：<code>feat/*、fix/* → develop → main</code>；紧急修复使用 <code>hotfix/* → main → develop</code>。<code>develop</code> 是日常集成分支，<code>main</code> 是正式发布分支，不创建长期 <code>release/*</code> 分支。

调用写工具前建立当前请求的 Execution Envelope。mode 只允许 inspect、plan、linear-sync、execute、monitor；effect 只允许 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse，并分别授权，forbiddenEffects 优先。linear-sync 只执行用户明确列出的 Linear 变更，禁止代码、分支、提交、推送、PR/MR 和凭据 effect；monitor 默认只读且写 effect ceiling 为空，并必须有终点或时间边界。

## 1. 判断执行授权与角色

只有以下情况授权 Writer 启动：

- 用户在本轮明确要求实现、处理、继续或领取某个具体 Issue。
- Issue 已委派给当前 Agent，且宿主以该 Issue 为目标显式启动本次运行。

提及、查看、总结、解释、Review、Verify 或列出队列都不构成领取授权。未指定 Issue 时不得选择、认领或更新任务，也不得主动列出或搜索 Ready Queue。Reviewer 和 Verifier 始终只读，不登记执行身份、不写 Receipt、不取得实现所有权。

Ready、Todo、依赖满足或队列可见不是 execute 授权。当前请求达到 terminalCondition 后，没有新用户输入或宿主对已委派具体 Issue 的显式启动时，不得自动选择下一个 Ready 节点。

显式执行授权只允许对当前 Issue 做最小身份登记；不允许改变人类 Assignee、Priority、Contract、Project、Cycle、Parent 或依赖关系，也不允许创建额外 Issue。

## 2. 读取 Linear 真值

使用可用的 Linear connector 读取当前 Issue 的状态、Assignee、Delegate、描述、Project、Cycle、labels、全部原生 relations、团队 Guidance，以及足以判定所有 Execution Receipt 生命周期的完整结构化评论历史。DAG 节点还要读取 DAG Root 和判定直接或传递依赖、Scope、Resource Locks、trigger 与 fan-in 所需的节点。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得执行全项目 DAG 遍历。若发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系不完整，退出快车道并按 DAG 门禁补读足够范围。

分页不完整、关系不可见、Receipt 无法解析或记录互相矛盾时 fail-closed。不得推断不存在的字段、关系、权限或评论。不要读取无关团队或扩大搜索范围。Triage Issue 只读解释，不自动 accept、duplicate、decline 或 snooze。

同一用户请求最多做一次全项目 DAG 全量遍历。首次完整读取后保存 dagStructureHash，覆盖节点 ID、Parent/依赖边、kind、trigger、Scope、Resource Locks、Repository 和 Target branch；提供方支持变化游标时另存可选 dagChangeCursor。压缩恢复时，只有二者共同证明结构未变，才重读当前 Issue、PR/MR、HEAD 和变化节点；禁止再次逐项读取整张 DAG。没有可用 dagChangeCursor 或无法证明完整性与变化边界时 fail-closed，不得仅凭旧哈希跳过校验。

## 3. 执行 Ready 与 DAG 门禁

只有 Todo Issue 才能开始，并且必须满足：

- 执行授权成立，角色为 Writer。
- Goal、Context、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies 和 Verification 均存在。
- Dependencies 只能是 None 或 Managed by Linear relations；依赖真值只来自原生 blocked-by / blocks。
- 没有未解决的 blocked-by，仓库、精确目标远端 ref、写入范围和验证方式可确定。“默认分支”只有解析后确为实现基线时才有效，否则返回 NOT_READY_TARGET_BRANCH。
- 没有自依赖、依赖环、不可见前驱，且所有直接前驱满足 trigger。
- 并行 write 节点没有无序的 Scope 重叠或相同 Resource Lock。

Parent/Sub-issue 只表示分解，related 不表示依赖。文本声明依赖但缺少对应原生关系时任务不 Ready。发现缺口或冲突时只报告事实，不自动拆 Issue、补关系、改变 Parent 或调整优先级。

all_success 要求全部直接前驱成功；Canceled、Duplicate、Won't Fix、failed、skipped 和 cancelled 均不算成功。all_done 只允许 kind=aggregate，且仅用于汇总、清理或失败报告；它可以产出终态报告，但不能把失败 DAG 判为成功。

Ready 门禁通过后解析目标远端 ref 并冻结 base SHA；后续分支和 worktree 必须从该基线创建。Ready 仍不授权执行任何未列入 allowedEffects 的动作。

## 4. 登记 Agent 与 Execution Receipt

正常写通道下，在创建 worktree、分支或开始实现前按以下顺序登记：

1. 检查是否已有其他 Delegate、其他 fallback Agent label 或未终结的活动实例；存在时停止并请求显式交接。
2. 保留人类 Assignee，优先登记原生 Delegate/App User。
3. 不支持 Delegate 时，只使用管理员预配置的低基数 agent:<agent-key> 与 role:writer 标签；不得创建带实例 ID 的标签。
4. 按 references/execution-receipt.md 追加不可变 start Receipt。
5. 重新读取并逐字段确认身份与 Receipt 一致；任何部分写入、结果不确定或验证失败都报告 registration-incomplete，不开始实现，也不声称已领取。

同一 Issue 同时最多一个活动实例。一次登记尝试中的传输重试复用相同 executionId 和 runtimeInstanceId；写入结果不确定时先重读，完全相同的已有 Receipt 视为幂等成功，不得追加第二条。恢复或授权交接后的新运行才生成新 ID。

同一运行时的上下文压缩或恢复沿用原 ID；新运行时不得静默接管 active Receipt，必须先显式 handoff 或 release。checkpoint 保留 requestId、mode、activeObjective、唯一当前 Issue、allowedEffects、forbiddenEffects、terminalCondition、completedFacts、noRepeatSet、nextAction、liveStates、blockerFingerprint 和 dagStructureHash；提供方支持时另存可选 dagChangeCursor。恢复后的第一个写调用前重读当前 Issue 与相关 Git/PR/MR 状态，并核对 mode、目标和 effect；无法可靠恢复时只读核对并重新规划。

source 依次判定为：有效交接使用 authorized-handoff；本轮明确执行指令使用 explicit-user-request；否则只有当前 Agent 已是 Delegate 且宿主显式启动时使用 existing-delegate。

## 5. Linear 不可写时的回退/fallback

Linear 只读、MCP 不可用或写入验证失败时，不得声称已登记、领取或同步。只有用户已明确要求执行具体 Issue，且用户提供的上下文足以通过 Ready 与 DAG 门禁时，才可继续本地工作，并明确标记 unregistered / Linear 未同步。

写能力恢复后不得回填或倒签 Receipt 冒充先前已登记；若继续执行，从恢复时刻创建新的 registered execution。Reviewer 和 Verifier 即使能看到写工具也不得使用。

## 6. 隔离执行与状态同步

正常登记确认后，write 叶子 Issue 使用一个 Writer、一个命名分支和一个 closing PR/MR。顺序执行且工作区干净时允许使用当前 clone；并发 Agent、脏工作区、存在无关改动或明确需要隔离时，必须创建仓库外 worktree。分支使用 <type>/<ISSUE-ID>-<slug>，worktree 使用同级 <repo>-worktrees/<ISSUE-ID>。commit 使用 <code>Refs &lt;ISSUE-ID&gt;</code>；GitHub PR 或 GitLab MR 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code>，只有提供方配置且创建后重读确认的等价 closing 语法才可替代。read 节点只产出约定输出和 Verification 证据；aggregate Parent 不创建实现 worktree。

普通 <code>feat/*</code>、<code>fix/*</code> 以 <code>origin/develop</code> 为目标；closing PR 合并后开发 Issue 立即 Done。<code>hotfix/*</code> 从 <code>origin/main</code> 创建并先合入 <code>main</code>，随后用非 closing PR 回同步 <code>develop</code>。正式发布使用独立 kind=aggregate Release Issue，以 merge commit 提升 <code>develop → main</code>，再保留 release-please 版本 PR；提升和回同步使用 <code>Refs &lt;ISSUE-ID&gt;</code>，不重新关闭开发 Issue。Release Issue 只有 GitHub Release、制品、发布 smoke 和回同步均有证据后才 Done。

创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方 target 等于声明 ref；计算 merge-base，并确认它等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代。不一致时阻断创建。创建后重读标题、source、target、描述、Issue 链接和 closing 语义。

优先让 Linear 的 GitHub/GitLab 集成或团队自动化推进状态：开始分支到 In Progress，PR/MR 进入审查到 In Review，required review 和 checks 通过到 Ready to Merge，closing PR/MR 合并到精确目标 ref 后 write 节点才 Done。只有缺少对应自动化且 envelope 允许 linearWrite 时才手工更新；每次手工状态写入执行“读取当前值 -> 校验转换 -> 写入 -> 重读确认”。实时状态优先于旧计划或摘要，后退、重开或纠错需要单独授权和事实原因，不得把 In Progress、In Review 或 Ready to Merge 退回 Todo 来恢复 Ready 统计。

本地工作完成、测试通过或 PR/MR 创建都不等于 Done。read 节点以输出和验证证据为完成条件；aggregate Parent 只有所有必需后代成功且 Fan-in Verification 通过才 Done。all_done 报告节点成功不能覆盖后代失败。

释放、中止、交接和本地工作完成都追加 terminal event，不编辑原 Receipt。没有自动超时或自动回收；失联实例必须由人工核对 worktree、分支和 PR 后显式释放或交接。

Git credential helper 按 git-rules.md credential helper 条款执行：只能由已配置的 Git transport 透明使用，读取、解析或转用其输出登录网页/API 需要单独的 credentialUse 与对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，query、包装脚本或辅助文件不得写入仓库或 worktree。

默认在当前 Issue 的已授权 effects 完成时终止：若授权到 mergeRequestWrite，则 PR/MR ready for review、创建后重读确认并完成已授权证据同步时结束。Linear 未进入 In Review 且状态同步不可用或未授权时，报告差异后结束。除非 envelope 明确为 monitor 且带观察终点或时间边界，不等待人工合并、不持续轮询，也不续跑下一节点；终止不等于 Linear Done。

## 7. 交付与参考

交付时报告本地结果、验证证据、PR/MR/merge 的已观察状态、登记状态及 Linear 是否实际同步。不要把请求已发送、工具不可用或推测状态写成成功。

创建团队模板或管理员配置时，按需读取：

- references/ai-coding-task.md
- references/dag-parent.md
- references/execution-receipt.md
- references/release-issue.md
- references/triage-template.md
- references/workspace-setup.md

这些文件是配置和契约清单，不授权直接修改 Linear Workspace。
