---
name: linear-workflow
description: Use when executing, reviewing, verifying, refining, synchronizing, or continuing explicitly authorized Linear issues in a multi-Agent coding workflow.
---

# Linear 工作流

本 Skill 直接定义执行所需的授权、状态、依赖、登记与交付要求。同步归属：`docs/rules/linear-workflow.md`；两者描述同一工作流，修改须同步。

只有显式调用 vb-linear-worktree-develop / $vb-linear-worktree-develop 才从当前会话计划创建 Parent 与子任务，并在本次新建 ID 的封闭集合内执行 local-land；不得领取集合外任务。该模式需要 Linear 可写、状态重读、隔离 worktree、最新 `origin/develop` 验证、no-ff 合并、本地合并和远端推送确认后即可 Done，清理失败单列残留；本模式使用 `worktree bootstrap` 登记仓库外 worktree 做 local-land，当前不提供宿主 worktree 导入登记。本轮尚未尝试 Linear 写入且 Linear 只读/不可达时，可按规则降级为未登记本地执行。显式执行不要求 Claim 或 Start/Terminal Receipt；同一 Issue 不重复并行执行，自动队列抢单已退役。写入已尝试但结果不明、部分登记或重读失败时保留现场并停止受影响节点，不切换到未登记执行。它不创建 PR/MR、不操作 main、不改默认 delivery 配置，也不改变普通 closing PR 的 Done 判据；修改须同步。

触发与边界：

- Writer 仅执行用户明确要求的具体 Issue、当前已授权计划或宿主明确启动的既有委派 Issue；计划内可接续，不扫描队列自行抢单。
- 自动队列领单入口已退役；Agent 不扫描、轮询或订阅 Ready Queue，不提供自动回收或重派。
- 没有具体 Issue ID 且未显式调用专用流程时，不选择、认领或更新既有任务；专用流程只同步当前计划的封闭集合。
- 调用写工具前核对当前请求的授权与工作区；Execution Envelope 可选记录 requestId、sessionId、targetIssueIds、activeObjective、allowedEffects、forbiddenEffects、terminalCondition，不是普通本地执行或 land 的门禁。inspect、plan、monitor 均无写 effect，monitor 还须有终点或时间边界；linear-sync 仅允许 linearWrite；execute 可逐项授权 linearWrite、workspaceWrite、gitBranch、gitCommit、gitPush、mergeRequestWrite、credentialUse、hostWrite、externalWrite，forbiddenEffects 始终优先。无原生 Goal bridge 时不声称后台持续执行，不阻止用户继续请求或宿主显式续跑恢复原范围工作。
- Parent 计划必须携带 `executionMode`、`wallClock` 和 `agentPlan`；单 Agent 是默认执行模式，只有共享契约冻结、writeScope/Resource Lock 隔离、Agent 容量可用且预计净节省至少 45 分钟和 25% 时才并行。
- 分支约定：`feat/*、fix/* → develop → main`；紧急修复 `hotfix/* → main → develop`。`develop` 是日常集成分支，`main` 是正式发布分支，不创建长期 `release/*` 分支，`release/*` 只在管理员为并行维护版本临时创建时存在并按其门禁处理；closing PR 合并后开发 Issue 立即 Done。本仓库默认 `develop` 不配置服务器端 required gate；其他项目明确的审查和分支保护仍须遵守，合入 `develop` 不再要求稳定 fast gate，质量责任落在本地候选合并验证与提交前检查；远端完整 CI 只在发布边界（`develop → main`、`hotfix/* → main`、`release/*`）运行。合并前的本地验证必须建立在最新 `origin/develop` 之上，高风险按影响面完成必要验证；独立审查可选，项目明确的审查和分支保护继续生效。

## 1. 判断执行授权与角色

只执行显式授权 Issue、当前计划或宿主明确启动的既有委派 Issue；查看、总结、Review、Verify 或队列可见不授权执行。活动自动领单入口已退役，不扫描队列挑选工作。普通 Issue 指令不创建 Parent/DAG；专用 vb-linear-worktree-develop 的显式调用才同步当前计划并在封闭集合内接续。

显式执行不要求 Claim，不强制 Start/Terminal Receipt；同一 Issue 不允许重复并行执行。先核对 Delegate、历史活动 Receipt 和现有 worktree，冲突走显式 handoff/release。历史 v1/v2/v3 只读兼容，可选 v1 使用 explicit-user-request；用户不填写 `claimId`、`grantId` 或 fencing 字段。只读角色不写身份或状态。

工作区核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；worktree 生命周期只需本地事实核验，local-land 使用 worktree bootstrap 登记树，不导入宿主 worktree。hostWrite、externalWrite、credentialUse、红区或高风险间接写入才要求 v2 hostContext：source=host，包含 filesystem、approval、process=isolated、network、observedAt，Agent 不得自造。缺授权或身份不符时暂停对应写入；缺宿主证明不得靠重复询问用户解除，只阻塞依赖它的跨边界步骤。旧 v1 Envelope 仅作 contract-only/degraded 兼容，不授权跨边界写入。

## 2. 读取 Linear 真值

使用可用的 Linear connector 读取宿主指定的当前 Issue 的状态、Assignee、Delegate、描述、Project、Cycle、labels、全部原生 relations、workspace 与 team Guidance（team 级优先，且指导不是授权根），以及足以判定所有 Execution Receipt 生命周期的完整结构化评论历史。DAG 节点还要读取 DAG Root 和判定直接或传递依赖、Scope、Resource Locks、trigger 与 fan-in 所需的节点。Agent 不读取队列自行选单。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得执行全项目 DAG 遍历。若发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系不完整，退出快车道并按 DAG 门禁补读足够范围。

分页不完整、关系不可见、Receipt 无法解析或记录互相矛盾时 fail-closed。不得推断不存在的字段、关系、权限或评论。不要读取无关团队或扩大搜索范围。Triage Issue 只读解释，不自动 accept、duplicate、decline 或 snooze。

同一用户请求保存 dagStructureHash，覆盖节点 ID、Parent 边、blocked-by / blocks 边、kind、trigger、Scope、resourceLocks、Repository 和精确 Target branch ref，不含 related、评论或状态流转；提供方支持时另存 dagChangeCursor。只有摘要与可靠游标共同证明结构未变，恢复才采用当前 Issue、PR/MR、HEAD 和变化节点的增量读取；旧哈希本身不是未变证据。无可靠游标时允许一次有界重读相关完整范围，仍不完整则暂停受影响执行。

## 3. 执行 Ready 与 DAG 门禁

Todo 必须包含 Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies、Verification。Target branch 必须解析到准确远端 ref，否则报告 NOT_READY_TARGET_BRANCH；Dependencies 只能为 None 或 Managed by Linear relations，文本依赖必须与原生 blocked-by / blocks 一致。Parent 表示分解，不表示顺序；related 不算依赖。自依赖、环、不可见前驱、关系不完整或 trigger 未满足都阻止开始。

kind 为 read、write 或 aggregate；有子节点的 Parent 为 aggregate，独立旧 Issue 默认 write、all_success、resourceLocks=None。all_success 要求全部直接前驱 succeeded；Canceled、Duplicate、Won't Fix、failed、skipped、cancelled 不算成功，unverified、blocked 也不是终态。all_done 仅用于 aggregate、清理或失败报告，待全部直接前驱终结后执行，不得把失败 DAG 判为成功。

Scope 只接受项目相对精确路径或末尾 `/**` 的目录，统一 `/` 并移除前导 `./`，Windows 比较忽略大小写；拒绝绝对路径、UNC、空路径、`..` 和其他复杂 glob。Scope 重叠、resourceLocks 相同或契约耦合无法证明隔离时串行。发现缺口或冲突只报告事实，不自动拆 Issue、补关系、改 Parent 或优先级。通过后冻结目标远端 ref 的 base SHA；每次派发 write 节点前重核依赖、Scope、锁、HEAD、工作区身份及可用的结构 hash，基线变化暂停受影响派发并重新核验。

墙钟规划的编排顺序固定为 Shared Contract → Parallel Candidate → Fan-in → Final Gate。规划时分别估算 active work、external wait/block、coordination/fan-in 和 verification；并行耗时用依赖拓扑与读写/总槽位确定性调度：ready 单元按剩余依赖链耗时降序、ID 升序；共享准备、等待、协调、fan-in、最终集成只计一次，再加 20% 缓冲。默认最多 2 个并行写 Agent、4 个只读 Agent；`fanInOwner: parent-agent`；无真实容量时安全降级为单 Agent。共享 API、Schema、迁移、公共模板和最终集成只由一个 owner 写入。共享契约变化、writeScope 越界、Resource Lock/数据库冲突、关键路径阻塞或净节省低于门槛时立即停止并重算，不继续扩展派发。

仅当入口、数据或环境存在实质不确定性时，在 Parent/叶子计划中记录早期探查的问题、方法、预计分钟数、退出条件和后续正式检查；探查计入共享准备或叶子 active work 一次，不抵扣 verification/fan-in。首轮规划默认限时 30 分钟，到时未解则记录风险并重新估算。普通 REPL、临时脚本及人工观察只用于探索，不能写为验证收据；仅配置中已声明的受管 Micro 能产生 L1 收据，且不能代替叶子聚焦验证或 Parent 一次性 fan-in。探查失败、环境异常、`unknown/lower-bound` 不得判为通过。

只读记录预计/实际墙钟、Active Time、Blocked Time、Coordination Time、Fan-out 节省、Fan-in 返工、WIP Age、Cycle Time、Lead Time、重试/冲突/返工率；这些指标只改进后续规划，不触发自动重派、取消、释放、降级或优先级变化。

## 4. 必要身份与状态同步

1. 先核对 Delegate、管理员预配置 fallback 标签、历史活动实例与现有工作区；存在其他占用时停止并请求显式交接，同一 Issue 不重复并行执行。
2. 保留人类 Assignee，优先 Delegate/App User，不支持时仅用低基数 `agent:<agent-key>` 与 `role:writer`。
3. 读取 → 校验 → 写入 → 重读确认必要身份与状态，结果未知按同一幂等键查询，不盲目追加评论或重建 Issue。
4. Start/Terminal Receipt 可选，不作为开工、合并、Done 或恢复门槛；历史 v1/v2/v3 与交接事件继续读取，冲突仍须核对。可选记录不含个人信息、凭据或本地路径，不修改历史 Receipt。
5. 压缩恢复核对当前 Issue、授权边界、DAG、工作区、HEAD 与实时状态；Git 从 common dir 阶段恢复，不依赖 Linear 收据。

## 5. Linear 不可写时的回退/fallback

Linear 只读或 MCP 不可用且本轮尚未尝试 Linear 写入时，不得声称已登记、领取或同步；只有用户已明确要求执行具体 Issue，且现有上下文足以通过 Ready 与 DAG 门禁时，才可继续本地工作，并明确标记 unregistered / Linear 未同步。写入已尝试但结果不明、部分登记或重读验证失败时，保留现场并停止受影响节点，不切换到未登记执行；自动领单没有本地回退，停止派发。

写能力恢复后先读取当前身份与状态，再按现时事实同步；不回填或倒签 Receipt，不以新建 execution 作为恢复门槛。Reviewer 和 Verifier 保持只读。

## 6. 隔离执行与状态同步

必要身份和状态核对后，write 叶子 Issue 使用一个 Writer、一个命名分支；普通 PR/MR 路径绑定一个 closing PR/MR，显式 local-land 按下述合同完成。顺序执行且工作区干净时允许使用当前 clone；并发 Agent、脏工作区、存在无关改动或明确需要隔离时，必须创建仓库外 worktree。分支使用 <type>/<ISSUE-ID>-<slug>，worktree 使用同级 <repo>-worktrees/<ISSUE-ID>。commit 使用 `Refs <ISSUE-ID>`；GitHub PR 或 GitLab MR 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置且创建后重读确认的等价 closing 语法才可替代。read 节点只产出约定输出和 Verification 证据；aggregate Parent 不创建实现 worktree。父 Agent 在 fan-in 前不得采纳 child 自报作为 Parent 完成证据。

普通 `feat/*`、`fix/*` 精确目标为 `origin/develop`。PR/MR 路径需相应落地授权；显式 local-land 默认 bootstrap 登记隔离树，冻结唯一实际 push URL、目标 ref 与候选 SHA，候选 no-ff 合并和验证后先 ff-only 更新主检出本地 develop，再显式非强制推送并重读远端。主检出须在 develop 且干净，脏时保留任务树暂停落地；remote 模式退役。独立审查可选，必要风险验证与项目门禁仍生效。

`hotfix/*` 从 `origin/main` 创建并先合入 `main`，通过发布门禁后用非 closing PR 回同步 `develop`。正式发布使用独立 aggregate Release Issue、`develop → main` merge-commit PR，并保留 release-please 版本 PR。提升与回同步只用 `Refs <ISSUE-ID>`；GitHub Release、制品、发布 smoke、回同步证据齐全才可关闭 Release Issue。回同步失败即发布阻塞，不静默 cherry-pick 成两套历史。Agent 不创建、切换或推送 `release/*`。

Git credential helper 仅由其配置的 Git transport 透明使用；提取或转用输出登录网页/API 需要独立 credentialUse 与对应外部写入授权。原始凭据和 helper 输出不得落盘，credential query、包装脚本或辅助文件不得写入仓库或 worktree。

创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方 target 等于声明 ref；计算 merge-base，并确认它等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代。不一致时阻断创建。创建后重读标题、source、target、描述、Issue 链接和 closing 语义。

优先让 Linear 的 GitHub/GitLab 集成或团队自动化推进状态；只有缺少对应自动化且 envelope 允许 linearWrite 时才手工更新，并执行“读取当前值 → 校验允许转换 → 写入 → 重读确认”。正常顺序为 Todo → In Progress（登记确认、实际开工，write 已建分支）→ In Review（PR 退出 Draft，附本轮验证及逐条验收自审）→ Done。Ready to Merge 仅对 main、release/*，必须有 branch protection 所需 review、CI、契约检查和必要 E2E 记录。后退、重开或纠错需单独状态纠错授权及事实原因。

本地完成、测试通过或创建 PR 不等于 Done。write 叶子须有 closing PR/MR 合并到精确目标 ref 的证据，或显式 local-land 的候选验证、本地合并、远端推送确认；后者直接 Todo → In Progress → Done，无需 PR。`integrated_cleanup_pending` 不阻塞 Done / succeeded 和依赖后继，残留资源仍占用，清理重试不再合并或推送；read 叶子须有约定输出和 Verification；aggregate Parent 须所有必需后代成功及 fan-in 验证通过，不能只汇总 child 自报或靠自动关闭。缺合并授权时在 PR ready for review 后结束并报告等待人工合并；Linear 同步不可用或未授权时报告差异后结束，不因同步缺口续跑。除最小身份登记外，新建其他 Issue、改关系、优先级、Assignee、Delegate、Project、Cycle、Parent 或 Contract 需单独授权。

历史 Receipt 的释放、中止、交接事件按 references/execution-receipt.md 只读兼容核对；存在活动冲突时先显式 handoff/release。新执行不强制 Receipt 或终结事件，不能因缺少记录阻塞开工、Done 或恢复；历史 local-work-completed 不能单独证明代码集成。

## 7. 交付与参考

交付时报告本地结果、验证证据、PR/MR/merge 的已观察状态、登记状态及 Linear 是否实际同步。不要把请求已发送、工具不可用或推测状态写成成功。当前 Issue 的已授权 effects 完成即结束；显式整计划允许计划内依赖后继接续，不扫描队列或自动转 monitor；monitor 只观察指定对象，到终点或时间边界停止。建议 Writer In Progress ≤3、In Review ≤2，同一 Issue 仅一个活动运行；异常、撤销或证据不足时停止整个授权后续派发，不自动回收或重派。Done 后回归默认用新回归 Issue 和非 closing revert PR，原 Issue 保持 Done 并追加事实关联；需要重开时另取状态纠错授权。

创建团队模板或管理员配置时，按需读取：

- references/ai-coding-task.md
- references/dag-parent.md
- references/execution-receipt.md
- references/release-issue.md
- references/triage-template.md
- references/workspace-setup.md
- references/symphony-host.md

这些参考不授权修改真实 Workspace；execution-receipt.md 和 symphony-host.md 仅在读取旧记录或迁移历史合同需要时加载，不启用其旧自动领单流程。
