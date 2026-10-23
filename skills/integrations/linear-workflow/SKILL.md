---
name: linear-workflow
description: Use when executing, reviewing, verifying, refining, synchronizing, or handling host-dispatched authorized Linear issues in a multi-Agent coding workflow.
---

# Linear 工作流

本 Skill 直接定义执行所需的授权、状态、依赖、登记与交付要求。同步归属：`docs/rules/linear-workflow.md`；两者描述同一工作流，修改须同步。

只有显式调用 vb-linear-worktree-develop / $vb-linear-worktree-develop 才从当前会话计划创建 Parent 与子任务，并在本次新建 ID 的封闭集合内执行 local-land；不得领取集合外任务。该模式需要 Linear 可写、状态重读、隔离 worktree、最新 `origin/develop` 验证、no-ff 合并、推送和清理成功后才能 Done；本模式使用 `worktree bootstrap` 登记仓库外 worktree 做 local-land，宿主 worktree 只有具备等价登记与回收证明时才能走该路径。本轮尚未尝试 Linear 写入且 Linear 只读/不可达时，可按规则降级为未登记本地执行。显式单次运行默认不需要 Claim；宿主为显式并发提供原子 Claim 时由宿主内部生成 v3 Receipt。自动派发必须具备 Claim 和 Grant，否则停止派发。写入已尝试但结果不明、部分登记或重读失败时保留现场并停止受影响节点，不切换到未登记执行。它不创建 PR/MR、不操作 main、不改默认 delivery 配置，也不改变普通 closing PR 的 Done 判据；修改须同步。

触发与边界：

- Writer 仅在用户明确要求处理具体 Issue、用户显式调用专用 Linear worktree 流程处理当前计划、已有 Delegate 且宿主显式启动，或宿主依据有效限时领单授权事件派发具体 Issue 时执行。
- 无宿主授权派发时禁止自动领取；Agent 不扫描、轮询或订阅 Ready Queue。Vibe-Harness 不提供常驻调度器、自动超时回收或自动重派。
- 没有具体 Issue ID 且未显式调用专用 Linear worktree 流程时，Agent 不选择、认领或更新既有任务；该流程可依据当前计划创建有界 Parent/DAG，但不得从队列挑选任务。宿主只能在有效授权的队列内按 Priority 降序、创建时间升序、Issue ID 升序选择 Todo 候选，不把队列可见性当授权。
- 调用写工具前建立当前请求的 Execution Envelope。inspect、plan、monitor 均无写 effect，monitor 还须有终点或时间边界；linear-sync 仅允许 linearWrite；execute 可逐项授权 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse、hostWrite、externalWrite，forbiddenEffects 始终优先。无原生 Goal bridge 时不声称后台持续执行，不阻止用户继续请求或宿主显式续跑恢复原范围工作。
- Parent 计划必须携带 `executionMode`、`wallClock` 和 `agentPlan`；单 Agent 是默认执行模式，只有共享契约冻结、writeScope/Resource Lock 隔离、Agent 容量可用且预计净节省至少 45 分钟和 25% 时才并行。
- 分支约定：`feat/*、fix/* → develop → main`；紧急修复 `hotfix/* → main → develop`。`develop` 是日常集成分支，`main` 是正式发布分支，不创建长期 `release/*` 分支，`release/*` 只在管理员为并行维护版本临时创建时存在并按其门禁处理；closing PR 合并后开发 Issue 立即 Done。`develop` 不配置服务器端 required gate，合入 `develop` 不再要求稳定 fast gate，质量责任落在本地候选合并验证与提交前检查；远端完整 CI 只在发布边界（`develop → main`、`hotfix/* → main`、`release/*`）运行。合并前的本地验证必须建立在最新 `origin/develop` 之上，高风险变更仍须携带 Independent Review Receipt。

## 1. 判断执行授权与角色

提及、查看、总结、解释、Review、Verify 或列出队列都不构成领取授权；Ready、Todo、依赖满足或队列可见不是 execute 授权。Reviewer 和 Verifier 始终只读，不登记执行身份、不写 Receipt、不取得实现所有权。自动领取仅接受宿主给出的具体 Issue ID、未撤销且未过期的限时授权、尚未用尽的领取数额、独占派发证明和绑定该 Issue 的 execute Envelope；缺任一项即拒绝。每个 Issue 达到 terminalCondition 后结束本次运行，下一任务只能由宿主重新核验授权并启动新的运行。

执行前逐项核对：

- **授权**：Envelope 绑定 requestId、sessionId、targetIssueIds、mode、activeObjective、allowedEffects、forbiddenEffects、terminalCondition。高风险使用 `vibe-harness.execution-envelope/v2`，riskClass=high。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots，以及只含目标类型、标识、环境的 externalTargets。
- **宿主**：worktree 生命周期只要求本地工作区核验，不需要宿主核验信息。跨边界操作与自动领单才要求 hostContext，且只能由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt；自动领单 Envelope 也只由宿主签发，Issue、项目配置和 Agent 不得自造。缺授权或工作区身份不符时暂停受影响写入；缺宿主证明只暂停依赖它的跨边界步骤，不阻塞本地隔离、实现与提交，也不得靠重复询问用户解除。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区或高风险间接写入。

**Claim 不是授权材料**：只有显式调用专用 Linear worktree 流程才直接授权当前计划范围内的 Parent/DAG 同步和该 Skill 列明的本地交付；普通显式 Issue 指令仍只覆盖目标 Issue 的既有执行范围与最小身份登记。两种显式单次执行默认生成 `source=explicit-user-request` 的 v1 Receipt，并先检查已有 Delegate/活动 Receipt；v1 读取检查不是原子锁，同一 Issue 不得并行启动。若宿主为显式并发运行提供 Claim，由宿主内部生成 Claim-bearing v3 Receipt。自动派发必须使用持久 Grant、provider 原子 Claim、fencing 和 v3 Receipt；这些字段由宿主内部产生，不能从 Issue、项目配置或用户输入构造。用户不需要填写 `claimId`、`grantId`、`leaseExpiresAt`、`fencingToken`、`claimProvider` 或 v2 `hostContext`。Claim 解决跨实例互斥，不扩大授权范围；发现活动冲突时请求 handoff/release。

`receipt start` CLI 只允许生成显式 v1；即使用户给出格式正确的四个字段，也不能经 CLI 或普通 Linear 评论签发 v3。Claim-bearing 路径必须由可信宿主持久 provider 原子登记，并在评论写入及恢复时按 Issue、executionId、幂等键、claimId、lease 与 fencing 查询核对；仅有格式校验或 Linear 写后重读仍属于未核验，不能恢复执行。

## 2. 读取 Linear 真值

使用可用的 Linear connector 读取宿主指定的当前 Issue 的状态、Assignee、Delegate、描述、Project、Cycle、labels、全部原生 relations、workspace 与 team Guidance（team 级优先，且指导不是授权根），以及足以判定所有 Execution Receipt 生命周期的完整结构化评论历史。DAG 节点还要读取 DAG Root 和判定直接或传递依赖、Scope、Resource Locks、trigger 与 fan-in 所需的节点。Agent 不读取队列自行选单；宿主事件派发按 Priority 降序、创建时间升序、Issue ID 升序挑选 Todo 候选。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得执行全项目 DAG 遍历。若发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系不完整，退出快车道并按 DAG 门禁补读足够范围。

分页不完整、关系不可见、Receipt 无法解析或记录互相矛盾时 fail-closed。不得推断不存在的字段、关系、权限或评论。不要读取无关团队或扩大搜索范围。Triage Issue 只读解释，不自动 accept、duplicate、decline 或 snooze。

同一用户请求保存 dagStructureHash，覆盖节点 ID、Parent 边、blocked-by / blocks 边、kind、trigger、Scope、resourceLocks、Repository 和精确 Target branch ref，不含 related、评论或状态流转；提供方支持时另存 dagChangeCursor。只有摘要与可靠游标共同证明结构未变，恢复才采用当前 Issue、PR/MR、HEAD 和变化节点的增量读取；旧哈希本身不是未变证据。无可靠游标时允许一次有界重读相关完整范围，仍不完整则暂停受影响执行。

## 3. 执行 Ready 与 DAG 门禁

Todo 必须包含 Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies、Verification。Target branch 必须解析到准确远端 ref，否则报告 NOT_READY_TARGET_BRANCH；Dependencies 只能为 None 或 Managed by Linear relations，文本依赖必须与原生 blocked-by / blocks 一致。Parent 表示分解，不表示顺序；related 不算依赖。自依赖、环、不可见前驱、关系不完整或 trigger 未满足都阻止开始。

kind 为 read、write 或 aggregate；有子节点的 Parent 为 aggregate，独立旧 Issue 默认 write、all_success、resourceLocks=None。all_success 要求全部直接前驱 succeeded；Canceled、Duplicate、Won't Fix、failed、skipped、cancelled 不算成功，unverified、blocked 也不是终态。all_done 仅用于 aggregate、清理或失败报告，待全部直接前驱终结后执行，不得把失败 DAG 判为成功。

Scope 只接受项目相对精确路径或末尾 `/**` 的目录，统一 `/` 并移除前导 `./`，Windows 比较忽略大小写；拒绝绝对路径、UNC、空路径、`..` 和其他复杂 glob。Scope 重叠、resourceLocks 相同或契约耦合无法证明隔离时串行。发现缺口或冲突只报告事实，不自动拆 Issue、补关系、改 Parent 或优先级。通过后冻结目标远端 ref 的 base SHA；每次派发 write 节点前重核依赖、Scope、锁、HEAD、工作区身份及可用的结构 hash，基线变化暂停受影响派发并重新核验。

墙钟规划的编排顺序固定为 Shared Contract → Parallel Candidate → Fan-in → Final Gate。规划时分别估算 active work、external wait/block、coordination/fan-in 和 verification；并行估算为共享准备 + 并行单元最长耗时 + 协调 + fan-in + 最终集成，并加 20% 缓冲。默认最多 2 个并行写 Agent、4 个只读 Agent；`fanInOwner: parent-agent`；无真实容量时安全降级为单 Agent。共享 API、Schema、迁移、公共模板和最终集成只由一个 owner 写入。共享契约变化、writeScope 越界、Resource Lock/数据库冲突、关键路径阻塞或净节省低于门槛时立即停止并重算，不继续扩展派发。

仅当入口、数据或环境存在实质不确定性时，在 Parent/叶子计划中记录早期探查的问题、方法、预计分钟数、退出条件和后续正式检查；探查计入共享准备或叶子 active work 一次，不抵扣 verification/fan-in。首轮规划默认限时 30 分钟，到时未解则记录风险并重新估算。普通 REPL、临时脚本及人工观察只用于探索，不能写为验证收据；仅配置中已声明的受管 Micro 能产生 L1 收据，且不能代替叶子聚焦验证或 Parent 一次性 fan-in。探查失败、环境异常、`unknown/lower-bound` 不得判为通过。

只读记录预计/实际墙钟、Active Time、Blocked Time、Coordination Time、Fan-out 节省、Fan-in 返工、WIP Age、Cycle Time、Lead Time、重试/冲突/返工率；这些指标只改进后续规划，不触发自动重派、取消、释放、降级或优先级变化。

## 4. 登记 Agent 与 Execution Receipt

正常写通道下，在创建 worktree、分支或开始实现前按固定顺序登记；字段样例位于本 Skill 的 `references/execution-receipt.md`：

1. 检查是否已有其他 Delegate、其他 fallback Agent label 或未终结的活动实例；存在时停止并请求显式交接。
2. 按执行来源登记：显式单次调用生成新的 `executionId`、`runtimeInstanceId`，默认使用 `source=explicit-user-request` 的 v1 Receipt；宿主为显式并发提供 Claim 时生成 Claim-bearing v3。自动派发必须在持久提供方上原子 Claim，冻结 claimId、executionId、lease 与 fencing token。Claim 不得由 Agent 本地锁或写后重读代替。结果不明时显式 v1 路径复用同一 executionId 重读，Claim-bearing 路径查询同一幂等键，不得申请第二套 ID。
3. 保留人类 Assignee，优先登记原生 Delegate/App User；不支持时只使用管理员预配置的低基数 agent:<agent-key> 与 role:writer 标签，不创建实例级标签。
4. 追加不可变 Start Receipt：`schema` 标识 Receipt 版本；显式单次路径默认使用 `vibe-harness.linear-execution/v1`，固定字段为 `schema`、`executionId`、`source`、`agentKey`、`hostKind`、`delegateId`、`runtimeInstanceId`、`role`、`dagRootIssue`、`dagNodeIssue`、`startedAt`。任何由宿主提供原子 Claim 互斥的运行使用 `vibe-harness.linear-execution/v3`，追加 `claimId`、`leaseExpiresAt`、`fencingToken`、`claimProvider`；自动派发另需非敏感 UUID v4 grantId 且 source=authorized-auto-claim。Claim 字段由宿主生成，用户不填写。executionId、runtimeInstanceId、claimId 使用 UUID v4；runtimeInstanceId 新建关联 ID，不复制宿主 thread/session、用户名、主机名或路径。历史 v2 只读兼容，三种版本共同参与活动实例冲突判定。禁止在 Receipt 和事件中保存凭据、个人信息或本地路径。
5. 重新读取并逐字段确认身份与 Receipt 一致；Claim-bearing 路径还必须确认 Claim、lease 和 fencing token 一致。显式登记冲突、自动能力缺失、部分写入、结果不确定或验证失败分别请求交接/人工核对或停止受影响运行，不开始未确认的节点工作，也不声称已领取。

非自动执行 source 依次判定为：有效交接使用 authorized-handoff；本轮明确执行指令使用 explicit-user-request；否则只有当前 Agent 已是 Delegate 且宿主显式启动时使用 existing-delegate。宿主自动领单不伪装成显式指令。无有效终结事件的 Receipt 为 active，同一 Issue 最多一个 active execution。同 ID 字段完全一致才算幂等成功；冲突、lease 过期、fencing 失配、Grant 撤销或宿主重启时暂停相应写入并保留现场，不静默接管、自动释放或重派。同运行时恢复复用原 ID；Claim-bearing 运行还复用 fencing，新运行时必须显式 handoff 或 release。

压缩或重连前保留 requestId、mode、activeObjective、allowedEffects、forbiddenEffects、terminalCondition、completedFacts、noRepeatSet、nextAction、liveStates、blockerFingerprint、dagStructureHash 和当前唯一 Issue；可用时保存 dagChangeCursor。恢复后首次写入前重读 Issue 与 Git/PR/MR 状态；最新用户意图优先于 checkpoint，实时状态优先于摘要。字段不能可靠恢复时仅只读核对和重新规划。

## 5. Linear 不可写时的回退/fallback

Linear 只读或 MCP 不可用且本轮尚未尝试 Linear 写入时，不得声称已登记、领取或同步；只有用户已明确要求执行具体 Issue，且现有上下文足以通过 Ready 与 DAG 门禁时，才可继续本地工作，并明确标记 unregistered / Linear 未同步。写入已尝试但结果不明、部分登记或重读验证失败时，保留现场并停止受影响节点，不切换到未登记执行；自动领单没有本地回退，停止派发。

写能力恢复后不得回填或倒签 Receipt 冒充先前已登记；若继续执行，从恢复时刻创建新的 registered execution。Reviewer 和 Verifier 即使能看到写工具也不得使用。

## 6. 隔离执行与状态同步

正常登记确认后，write 叶子 Issue 使用一个 Writer、一个命名分支和一个 closing PR/MR。顺序执行且工作区干净时允许使用当前 clone；并发 Agent、脏工作区、存在无关改动或明确需要隔离时，必须创建仓库外 worktree。分支使用 <type>/<ISSUE-ID>-<slug>，worktree 使用同级 <repo>-worktrees/<ISSUE-ID>。commit 使用 `Refs <ISSUE-ID>`；GitHub PR 或 GitLab MR 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置且创建后重读确认的等价 closing 语法才可替代。read 节点只产出约定输出和 Verification 证据；aggregate Parent 不创建实现 worktree。父 Agent 在 fan-in 前不得采纳 child 自报作为 Parent 完成证据。

普通 `feat/*`、`fix/*` 以 `origin/develop` 为目标；合入 `develop` 不要求服务器端 fast gate，质量责任落在本地候选合并验证与提交前检查，Writer 在 envelope 授权 `mergeRequestWrite` 后可自行 squash 合并（或在提供方请求 auto-merge），也可用本地 `worktree land` 以 no-ff 直落，closing PR 合并后开发 Issue 立即 Done。限时领单的默认目标也是合入 `develop`，但各 effect 均须逐项授权；缺少合并授权时停在已授权终点，不假称 Done。合并前必须确认本轮验证建立在最新 `origin/develop` 之上，base 已前进时重跑受影响检查；高风险变更缺少 Independent Review Receipt、与 diff 不匹配、过期或结论为 negative 时不得自行落地合并。收据须来自真实独立上下文，覆盖风险、范围、验证和回滚，不接受实施者自评替代。

`hotfix/*` 从 `origin/main` 创建并先合入 `main`，通过发布门禁后用非 closing PR 回同步 `develop`。正式发布使用独立 aggregate Release Issue、`develop → main` merge-commit PR，并保留 release-please 版本 PR。提升与回同步只用 `Refs <ISSUE-ID>`；GitHub Release、制品、发布 smoke、回同步证据齐全才可关闭 Release Issue。回同步失败即发布阻塞，不静默 cherry-pick 成两套历史。Agent 不创建、切换或推送 `release/*`。

Git credential helper 仅由其配置的 Git transport 透明使用；提取或转用输出登录网页/API 需要独立 credentialUse 与对应外部写入授权。原始凭据和 helper 输出不得落盘，credential query、包装脚本或辅助文件不得写入仓库或 worktree。

创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方 target 等于声明 ref；计算 merge-base，并确认它等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代。不一致时阻断创建。创建后重读标题、source、target、描述、Issue 链接和 closing 语义。

优先让 Linear 的 GitHub/GitLab 集成或团队自动化推进状态；只有缺少对应自动化且 envelope 允许 linearWrite 时才手工更新，并执行“读取当前值 → 校验允许转换 → 写入 → 重读确认”。正常顺序为 Todo → In Progress（登记确认、实际开工，write 已建分支）→ In Review（PR 退出 Draft，附本轮验证及逐条验收自审）→ Done。Ready to Merge 仅对 main、release/*，必须有 branch protection 所需 review、CI、契约检查和必要 E2E 记录。后退、重开或纠错需单独状态纠错授权及事实原因。

本地完成、测试通过或创建 PR 不等于 Done。write 叶子须有 closing PR/MR 合并到精确目标 ref 的证据；read 叶子须有约定输出和 Verification；aggregate Parent 须所有必需后代成功及 fan-in 验证通过，不能只汇总 child 自报或靠自动关闭。缺合并授权时在 PR ready for review 后结束并报告等待人工合并；Linear 同步不可用或未授权时报告差异后结束，不因同步缺口续跑。除最小身份登记外，新建其他 Issue、改关系、优先级、Assignee、Delegate、Project、Cycle、Parent 或 Contract 需单独授权。

释放、中止、交接和本地完成追加 `vibe-harness.linear-execution-event/v1`：eventId、executionId、eventType、successorExecutionId、occurredAt；eventType 为 released、aborted、handed-off 或 local-work-completed。每次执行最多一个有效终结事件，矛盾时 fail-closed，不编辑原 Receipt。handoff 用预定 successorExecutionId 终结旧运行，再用同一 ID 登记新运行；release 仅按明确授权清除 Delegate，abort/local completion 默认保留。失联需人工核对 worktree、分支、PR 后显式释放或交接，不自动超时回收。local-work-completed 不等于 Linear Done。

## 7. 交付与参考

交付时报告本地结果、验证证据、PR/MR/merge 的已观察状态、登记状态及 Linear 是否实际同步。不要把请求已发送、工具不可用或推测状态写成成功。当前 Issue 的已授权 effects 完成即结束，不自动转 monitor 或选下一任务；monitor 只观察指定对象，到终点或时间边界停止。建议 Writer In Progress ≤3、In Review ≤2，限时授权默认仅一个活动运行；异常、撤销或证据不足时停止整个授权后续派发，不自动回收或重派。Done 后回归默认用新回归 Issue 和非 closing revert PR，原 Issue 保持 Done 并追加事实关联；需要重开时另取状态纠错授权。

创建团队模板或管理员配置时，按需读取：

- references/ai-coding-task.md
- references/dag-parent.md
- references/execution-receipt.md
- references/release-issue.md
- references/triage-template.md
- references/workspace-setup.md
- references/symphony-host.md

这些文件是配置和契约清单，不授权直接修改 Linear Workspace；Symphony 参考还要求宿主侧实际实现和验证，安装本 Skill 不会安装调度器。
