# Linear 工作流

Linear 保存工作状态、责任、委派与依赖；GitHub 或 GitLab 保存代码、提交、PR/MR、检查与合并状态。Agent 自报、Execution Receipt 或本地工作完成都不能替代代码与合并证据。

默认采用轻量三层工作流：`feat/*、fix/* → develop → main`；紧急修复使用 `hotfix/* → main → develop`。`develop` 是日常集成分支，`main` 是正式发布分支；不创建长期 `release/*` 分支。任务分支应在约两个工作日内合并和删除，超出时优先拆小或用 feature flag 隔离未完成功能。

## Fast Path 卡片

- **默认路径**：Linear 保存状态、责任、委派与依赖，代码、提交与合并证据在 Git；先确认本轮 Issue 与授权，再实现、验证、登记。
- **授权**：本轮用户请求授权且明确指定 Issue、显式调用 `vb-linear-worktree-develop` 执行当前计划、宿主启动已委派的 Issue，或宿主明确启动已授权的具体 Issue，才可登记与执行；Ready、Todo 或队列可见本身不构成 execute 授权。
- **状态**：普通 PR/MR 在 `develop` 上走 Todo → In Progress → In Review → Done；显式 local-land 走 Todo → In Progress → Done；只有带门禁目标（`main`、`release/*`）经过 Ready to Merge。`develop` 不配置服务器端 fast gate，质量责任落在本地候选合并验证与提交前检查。
- **快车道不豁免真实验证**：`develop` 不依赖服务器端门禁，高风险路径仍须按影响面完成必要的契约/集成切片并报告 deferred；独立审查可观察但不是强制收据。
- **计划与执行模式**：普通 Issue 和普通 Parent 只记录必要依赖与验收，不要求墙钟估算或 DAG。只有真实多 Agent 编排才按需加载 `task-decomposition` 的 reference 判断容量与并行收益。
- **继续读全文的信号**：执行授权记录与宿主核验、Definition of Ready、原生 DAG 投影、Receipt 生命周期、并发与隔离、终止与交付。

以下为完整规则，仅当任务超出卡片或命中升级触发时继续读取。

## 1 授权模型

### 显式 vb-linear-worktree-develop

仅在用户明确调用 `vb-linear-worktree-develop` / `$vb-linear-worktree-develop` 时，才按**当前会话的既定任务计划**同步所需 Linear 节点；已有 Issue 直接复用，单节点不强建 Parent，多个独立交付节点才创建 Parent aggregate 与 read/write 子任务 DAG。验收切片不逐一映射为 Issue 或 worktree。该调用明确授权本次计划范围内的 Parent、子任务、原生 blocked-by / blocks 关系及状态/Receipt 写入、worktree、任务提交、普通推送和合并到 `develop`，不授权 PR/MR、force push、历史改写或 `main`。普通 Linear 工作流的既有授权与 closing PR Done 语义不变。本节与已安装的 `vb-linear-worktree-develop` Skill 描述同一模式，修改须同步。

#### 显式执行边界

只执行用户明确授权的 Issue 或当前计划；宿主明确启动已委派的具体 Issue 也须核对原授权。Ready、Todo、队列可见或宿主空闲事件均不授权新任务。活动流程不再提供自动领单入口，不创建新的 Claim/Grant 服务。

显式调用 `vb-linear-worktree-develop` 授权当前已确定的计划内 Parent、子任务及 blocked-by / blocks 原生关系同步；普通显式 Issue 执行只授权当前 Issue 的最小身份、状态和结果同步，不扩展 Parent、Assignee、Priority、Contract、Project、Cycle 或 relations。保留本次已确认 ID 的封闭集合，计划内可按依赖自动接续，不扫描队列领取集合外任务。

显式执行不要求宿主 Claim，也不强制 Start/Terminal Receipt。先读取 Delegate、历史活动 Receipt、现有 worktree 和任务状态；同一 Issue 不允许重复并行执行，活动冲突必须显式 release/handoff，不因取消 Claim 而接管。历史 `vibe-harness.linear-execution/v1`、v2、v3 与事件继续读取兼容；可选 v1 的 source 可为 `explicit-user-request`。历史 Claim/lease/fencing 仅用于核对旧活动实例，不成为新执行的开工或恢复门槛，未知占用先只读核对。

Linear 写入遵循读取 → 校验 → 写入 → 重读确认，结果不明先按同一幂等键重读，部分创建保留已确认 ID，不盲目新建。尚未尝试写入且现有上下文足以核对任务与依赖时，可继续本地工作并标记 `unregistered / Linear 未同步`；已尝试但结果未知时停止受影响同步与节点，保留现场。

write 节点优先使用宿主或当前会话已创建的 worktree，并以 `--task <ISSUE-ID>:<branch>` 精确归因；没有可用隔离树时用 `worktree bootstrap` 创建已登记工作区。提交 `Refs <ISSUE-ID>` 后，local-land 按 `git-rules.md` 的 stage/publish 合同执行：`worktree stage` 从本地 develop 快照 no-ff 合并并验证，持久化为 `local_staged`；`worktree publish --batch <id>` 先 fetch 自动对账——候选已含于远端则确认，远端前进时从新基线重建并按完整输入指纹复用或重验——需要终锁才进入短时 FIFO 段，精确推送并重读远端 SHA。主检出或宿主会话不必为 stage 单独登记端口，stage 也不要求主检出一个干净；主检出脏或落后只影响发布后的本地同步，保留用户改动。`--target-mode primary` 是 stage 专属的意图断言；`--target-mode remote` 退役，不得绕过 stage/publish。

local-land 的候选验证与精确远端推送确认后，write 节点即可 Done / succeeded；`local_staged` 只证明本地候选，不能单独支撑 Done。清理失败单列 `integrated_cleanup_pending`，不阻塞依赖后继。残留路径、端口和 resourceLocks 继续占用，后继资源冲突时仍不得派发。read 以输出与 Verification 完成；aggregate Parent 须全部必需后代成功并通过最终组合行为的 fan-in 验证。普通 PR/MR 路径仍以 closing 合并证据完成。

普通独立交付只等待直接前驱和实际冲突资源，不设置全体叶子统一等待屏障；下述显式 Parent 批次仅在发布边界等待全部必需成员。同目标已就绪节点可一次 stage 合批；最终候选收据若已覆盖 Parent 的 fan-in 验收，直接引用，不再重复同一检查。Git 集成事实、Linear 回写结果和清理状态分别报告；仅状态回写延迟不撤销已经核实的 Git 事实，但未知的 Issue 创建、依赖关系写入或执行占用仍先重读确认，不据此猜测后继已就绪。

风险只决定必要验证和隔离，不自动选择 develop flow；独立审查可选，项目明确规定的审查、Hook 与分支保护继续生效。worktree 内部操作按本轮授权和工作区事实执行，跨边界、凭据、红区与外部写入仍遵循 governance-core；不自造宿主证明。

### Parent 单 worktree 批次

显式 `vb-linear-worktree-develop` 执行已授权 Parent 时，默认以其全部必需后代组成同一仓库、同一精确目标 ref 的批次。已有 Issue 直接复用，不限于本轮新建 ID；不读取或认领其他 Parent 的任务。开始、执行期间和发布前重读成员、原生依赖与验收；发现新增、移除或影响执行的依赖变化，暂停受影响步骤并请用户确认范围变更，保留已有提交，再记录原因并同步计划。可见的新成员不自动获得执行授权，旧清单也不允许漏项发布。

整批只设一个 Writer、一个命名分支和一个任务 worktree，以 Parent ID 归属环境与交付来源；Parent 保持 aggregate，代码仍由 write 子任务负责。按原生依赖拓扑顺序实施，无依赖节点按 ID 稳定串行，不为执行顺序添加原生关系。共享 API、Schema、锁文件仍有唯一 owner。任务树内部只有一个活动写单元；交付器的临时候选树允许独立存在。只有明确需要独立交付或实际并行写入时另定批次与隔离，不自动为每个 Issue 建树。

每个代码任务将实现、测试与文档一起暂存，核对工作树与暂存快照一致，运行必要检查后形成关联该 Issue 的 Conventional Commit；提交 Hook 改变提交树时重验。锚点的单元 `done` 代表本地执行完成，绑定已验证的 tree、commit SHA、检查定义、计划版本与成员摘要，不表示 Linear Done 或 DAG succeeded。正常后续提交不使历史证据失效，前驱 SHA 必须仍是当前分支祖先；契约、验收、检查定义或计划变化须重新判断受影响证据。修复追加对应任务的提交，不重写已有 SHA；只读与已交付任务不制造空提交，既有交付事实须核实后复用。

仅同批成员之间的执行依赖可凭有效本地完成证据放行；批外依赖、Linear Done 和 Parent 最终成功仍要求正式交付。此例外只改变批内执行 readiness，不改 `result` 枚举、all_done 或原生关系。批外前驱尚未交付、关系不可见或快照不完整时继续阻断；若外部任务等待本批发布、批内成员又等待该外部任务，报告交付循环并停止，不绕过依赖或擅自拆批。

全部必需成员本地完成、共享工作树和 index 干净后，只将 Parent 与分支最终 HEAD 作为唯一 stage source。stage 记录 Issue→提交映射并验证整批组合与 Parent fan-in，publish 复用远端同步、必要重验、普通推送和 SHA 回读；不得逐子任务 stage、重复传入同一分支或部分发布。发布前仍须重读 Linear 的最新范围；本地工具只能核对已同步的快照，不冒充实时 Linear 读取。

远端确认后先逐项确认子任务 Done，再完成 Parent；已确认的 Git 集成不因 Linear 写入失败撤销。Parent 批次的 publish 保留源任务树、分支、锚点及资源归属，报告 `integrated_cleanup_pending`；状态同步确认后再调用已有 `worktree cleanup --batch <id> --write` 回收。恢复先重读，仅补写缺失状态，不重复 merge/push。共享树存在未解决改动时停止后续写入，保留提交与现场，不自动 stash、rebase、强推或破坏性清理。分别报告本地提交、候选验证、远端确认、Linear 同步和清理；清理失败保留资源归属并仅重试清理。普通 PR/MR、无 Parent 的独立 Issue 和未声明批次的旧计划继续沿用原合同。

## 2 状态模型与责任

团队使用 Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done。Triage 四动作 accept / duplicate / decline / snooze 需要人工确认；Agent 不自动处置。Blocked 不是状态，只使用原生 blocked-by / blocks 关系；related 永不表示依赖，关系解除或调整也需要授权。

| 状态 | 进入条件 | 完成证据 | 允许写入者 |
| --- | --- | --- | --- |
| Todo | Definition of Ready 完整，所有直接前驱满足 trigger，且没有 Scope 或 Resource Lock 冲突 | Definition of Ready 通过且无冲突 | 人工（规划与 Ready 审定） |
| In Progress | 必要身份与状态同步已确认且节点工作已经开始 | 开工事实（Receipt 可选）；write 节点还必须已创建任务分支（需要隔离时同时创建仓库外 worktree），Draft PR 仍保持此状态 | 自动化优先；缺少自动化且 envelope 允许 linearWrite 时 Writer 按协议手工回写 |
| In Review | PR/MR 已退出 Draft 并进入审查 | 审查请求与提供方事实 | 自动化优先；同 In Progress 的手工回写条件 |
| Ready to Merge | 仅用于带门禁的目标分支（`main`、`release/*`）：受保护分支要求的 review、CI、契约检查和必要 E2E 均通过；`develop` 路径不经过此状态 | branch protection 与 required checks 记录 | 自动化（基于门禁事实） |
| Done | 完成证据全部成立 | write 叶子由 closing PR/MR 合并到声明的精确目标 ref，或显式 local-land 的 stage 候选验证及 publish 远端确认共同证明；read 叶子由约定输出和 Verification 证据证明；aggregate Parent 由全部必需后代成功和 Fan-in Verification 证明 | closing 合并与 fan-in 验证触发的自动化 |

Agent 手工写状态必须执行“读取当前值 → 校验允许转换 → 写入 → 重读确认”。实时状态和提供方事实优先于旧计划、任务模板、DAG 快照或压缩摘要；常规代码流在 `develop` 路径上只前进 Todo → In Progress → In Review → Done（closing PR 合入 `develop`），只有带门禁目标（`main`、`release/*`）才经过 Ready to Merge。任何后退、重开或纠错转换都需要单独的状态纠错授权并记录事实原因，尤其不得为恢复 Ready 清单或旧规划统计把 In Progress、In Review 或 Ready to Merge 退回 Todo。

`develop` 路径上的 In Review 表示 PR/MR 已退出 Draft，并已附本轮验证证据与实现者对照 Acceptance Criteria 的逐条自审记录；它不表示已有独立人工审查，普通 PR/MR 路径的 Done 由 closing 合并证据成立；显式 local-land 走 Todo → In Progress → Done。

`release/*` 不是日常分支：只有管理员为并行维护历史版本或合规窗口临时创建时才存在，Agent 不创建、不切换也不推送该分支；它一旦存在就按带门禁目标处理，review、CI 与契约要求与 `main` 相同。

`develop` 是日常集成分支：不再把稳定 fast gate 作为服务器端 required gate，接受本地 `worktree stage` / `publish` 的 no-ff 直落与任务分支直推；不要求人工审批。质量责任前移到 stage 候选合并验证（lint、typecheck、unit，并按变更影响追加 component/integration）、publish 最新基线重建后的重验与提交前检查。publish 确认后，主检出本地 develop 仅做安全的 ff-only 同步；脏或领先时报告 `deferred` / `diverged`，不阻塞远端集成。合并前的本地验证与最新目标 ref 的前置、merge queue 与 squash/auto-merge 落地机制以 `git-rules.md` 分支模型与合并条款为准，Writer 只落地自己创建的 closing PR。项目在发布边界配置的完整 required check 仍只对 `develop → main` 提升、`hotfix/* → main` 以及 `release/*` 运行。

快车道不豁免高风险验证：命中 CI workflow、schema、runtime、安全、红区、迁移或凭据路径时按真实影响面选择契约/集成切片；PR/MR 的 Risk Evidence 说明风险来源、实际验证、deferred 与回滚方式。独立审查作为非阻塞观察，不要求唯一 Independent Review Receipt；`develop` 的本地候选合并验证仍必须通过，`main`/发布分支既有平台保护不变。

一个 write 叶子 Issue 对应一个 Writer；按隔离条件使用当前 clone 或宿主/仓库外 worktree，绑定一个命名分支；普通 PR/MR 路径绑定一个 closing PR/MR，显式 local-land 以 stage 候选验证及 publish 远端确认完成。顺序执行且工作区干净时允许在当前 clone 创建任务分支；存在并发 Agent、脏工作区、当前分支含无关改动或任务明确要求隔离时，必须使用仓库外 worktree。read 叶子只绑定一个执行 Agent、约定输出与 Verification 证据，不要求实现 worktree、分支或 PR/MR。存在子 Issue 的 Parent 是 aggregate，不直接实现。独立旧 Issue 可无 Parent，并按 kind=write、trigger=all_success、resourceLocks=None 处理，无需迁移。

## 3 Definition of Ready

节点模型、`result` 枚举、all_success / all_done、ready 与 fail-closed、Scope 和 Resource Lock 语义以 `ai-collab-rules.md` 为唯一规范来源；本规则只定义这些字段在 Linear 上的载体与真值来源（见第 4 节映射表），不重复枚举语义。Linear 的 `Canceled`、`Duplicate`、`Won't Fix` 是外部终态，按该文件的 Linear↔result 映射表统一处理为非 `succeeded`。

状态映射、终态解释、交接缺失和正常 HEAD 前进的处理同样遵循 `ai-collab-rules.md` 的「状态与交接解释」；本地 result 不增加 Linear 描述字段或第二状态真值。Agent 派发重验证只读取当前节点及足够的依赖/冲突范围；只在本轮显式授权的封闭集合内选择节点。

Todo Issue 必须包含 Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies 和 Verification。Target branch 必须能解析到准确远端 ref；“默认分支”只有经仓库事实解析为实际实现基线时才有效，否则返回 NOT_READY_TARGET_BRANCH。Dependencies 只能是 None 或 Managed by Linear relations；描述中的明确依赖陈述必须与原生关系一致，否则不 Ready。自依赖、任意依赖环、不可见前驱、关系读取不完整、未解决的 blocked-by 或未满足 trigger 都阻止开始。

Ready 门禁通过后解析目标远端 ref 并冻结 base SHA；后续分支和 worktree 必须从该基线创建。Ready 仍不授权执行任何未列入 allowedEffects 的动作。

## 4 原生 DAG（Linear 投影）

DAG 节点可声明 kind（read / write / aggregate）、trigger（all_success / all_done）和 resourceLocks。无 Parent 的旧 Issue 使用上述默认值；有子 Issue 的 Parent 必须是 aggregate。all_success 要求全部直接前驱 succeeded，Canceled、Duplicate、Won't Fix、failed、unverified、blocked、skipped 或 cancelled 都不算成功；unverified 与 blocked 都不是终态。all_done 只允许 aggregate、清理或失败报告节点在全部直接前驱终结后运行，且不能把失败 DAG 或 Root 判为成功。

DAG 字段在 Linear 上的载体与真值来源固定如下，字段语义本身以 `ai-collab-rules.md` 节点模型为准：

| DAG 字段 | Linear 载体 | 真值来源 |
| --- | --- | --- |
| `id` | Issue 编号与 URL | Linear Issue 本体 |
| `kind` | DAG Metadata 或标签 | Issue 声明（read / write / aggregate） |
| `output` | Goal 与 Acceptance Criteria | Issue 描述 |
| `dependsOn` | blocked-by / blocks 原生关系 | Linear relations |
| `trigger` | DAG Metadata | Issue 声明（all_success / all_done） |
| `writeScope` | Scope 字段 | Issue 描述 |
| `resourceLocks` | DAG Metadata | Issue 声明 |
| `verification` | Verification 字段 | Issue 描述 |
| `result` | 状态与完成证据推导 | `ai-collab-rules.md` 的 Linear↔result 映射表 |
| `cleanupPending` | 可选的本地资源状态投影，不要求新增 Linear 字段 | 工作区、端口登记与 land 清理结果；不改变 Done / succeeded |

依赖真值只来自 Linear 原生关系，以下三条是非边：

- Parent/Sub-issue 只表示分解，不隐含顺序。
- blocked-by / blocks 是唯一执行依赖，related 不进入 DAG；related 关系（含 Linear 在阻塞项完成后自动降级、以及在描述或评论中提及 Issue 时自动生成的关系）不参与 `dagStructureHash`，也不影响 ready 判定。前驱是否成功以前驱 Issue 的状态与完成证据为真值，不以其 blocked-by 关系当前是否仍存在为准。
- 描述中的依赖清单不是真值；文本声明依赖但缺少对应原生关系时任务不 Ready。

Scope 是 writeScope 的 Linear 投影，路径验证按 `ai-collab-rules.md` writeScope 条款执行：只接受精确项目相对路径或末尾为 /** 的目录，统一使用 / 并移除前导 ./，拒绝绝对路径、UNC、空路径、.. 和其他复杂 glob，Windows 比较忽略大小写。Scope 重叠或 resourceLocks 相同的串行判定与冲突处理也以 `ai-collab-rules.md` 为准。Agent 只报告冲突、边或环，不自行拆 Issue、改变 Parent、创建或删除关系、调整优先级或创建额外节点。

DAG Parent 模板包含 Goal、整体 Acceptance Criteria、Shared Contract、Out of Scope、Fan-in Verification 和 Completion Policy。所有 descendant 默认必需；任一必需节点非 succeeded 时 Parent 不得 Done。关闭 Linear 的 Parent/Sub-issue 自动关闭，避免绕过 write 完成证据与 fan-in 验证。

单 Agent 是默认执行模式；普通 Parent 不要求 `wallClock`、Agent 容量或收益估算。只有实际派发多个 Agent 时才声明 `executionMode` 与 `agentPlan`；容量、读写上限和并行收益算法以 task-decomposition 的按需 reference 为唯一来源。父 Agent 始终负责 fan-in、冲突处理、最终验证和 Linear 交付。

入口、数据或环境存在实质不确定性时，Parent/叶子计划可记录早期探查的待回答问题、方法、预计分钟数、退出条件和后续正式检查；无不确定性时不要求探查。探查时间只计入共享准备或叶子 active work 一次，不从 verification 或 Parent fan-in 中扣除；首轮规划仍以 30 分钟为默认时间盒，到时未解决则记录风险、重新估算，不无限延长。普通 REPL、临时脚本和人工观察仅帮助定位与选择测试，不写入验证收据；只有项目配置已声明的受管 Micro 才可产生 L1 收据。Micro 通过不替代叶子的聚焦测试或 Parent 一次性 fan-in 集成验证；探查失败、环境异常及 `unknown/lower-bound` 均不得解释为通过。

规划和运行只记录只读运营指标：预计墙钟与实际墙钟、Active Time、Blocked Time、Coordination Time、Fan-out 节省、Fan-in 返工、WIP Age、Cycle Time、Lead Time、重试/冲突/返工率。指标用于改进后续估算，不自动重派、取消、释放、降级或改变 Linear 优先级。

验收切片、依赖计划与多 Agent 并行分别判断；顺序切片也可由单 Agent 执行。已有 Linear DAG 必须遵循，普通固定步骤不强制完整 DAG。只有真实并行时才按 Shared Contract → Parallel Candidate → Fan-in → Final Gate 编排；共享契约变化、writeScope 越界或 Resource Lock 冲突时停止受影响派发。

同一用户请求优先读取当前 Issue 及其必要依赖范围，并保存 dagStructureHash；提供方支持变化游标时另存可选 dagChangeCursor。恢复时只有摘要与游标共同证明结构未变化，才只读取当前 Issue、PR/MR、HEAD 与变化节点；没有可靠游标或无法证明变化边界时，允许一次有界重新读取相关完整范围，仍不得无目的轮询或无限重复全量读取。`dagStructureHash` 覆盖节点 ID、Parent 边、blocked-by / blocks 边、kind、trigger、Scope、Resource Locks、Repository 和精确 Target branch ref，不覆盖 related 关系、评论活动与状态流转。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得为此执行全项目 DAG 遍历。发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系读取不完整时退出快车道，再按上述 DAG 门禁读取足够范围。

路径不重叠但存在 API、Schema、迁移或行为契约耦合时，必须指定唯一写入 owner 并建立原生依赖；无法证明隔离时按冲突处理。每次派发 write 节点前的重验证（DAG 版本或 hash、依赖、Scope、Resource Lock、HEAD 和工作区身份）与子节点交接证据的记录范围，统一遵循 `ai-collab-rules.md` 的对应条款；这些记录仅用于人读交接，不构成执行授权。

## 5 显式执行登记

1. 读取当前 Issue、完整必要原生 relations、team/workspace Guidance，以及判定旧活动记录所需的评论分页。Guidance 不是授权根。
2. 核对 Definition of Ready、仓库、目标 ref、Scope、Verification、依赖成功证据和资源冲突；已有活动 Delegate、Receipt 或 worktree 不自动接管。
3. 保留人类 Assignee，按支持能力同步必要 Delegate/App User 或管理员预配的低基数 `agent:<agent-key>`、`role:writer` 标签，不建实例级标签。
4. 必要身份、状态和结果写后重读确认即可执行；不要求 Start/Terminal Receipt 或 Claim。可选诊断 Receipt 不含个人信息、凭据或本地路径；旧 Receipt 不编辑，必要交接须保留历史。
5. 恢复前重新读取 Issue、工作区、HEAD、目标 ref 与当前进度，实时事实高于摘要；Git 恢复以 common dir 的阶段记录为准，不依赖 Linear 评论收据。

未尝试 Linear 写入且上下文充分时允许本地继续并明确未同步；非幂等写入结果不明先重读，不伪造注册成功。计划内自动接续仍受本轮计划边界、依赖和资源核对约束。

## 6 Git、状态同步与安全

- 分支命名、合并方式与门禁边界以 `git-rules.md` 分支模型条款为唯一规范来源，本节只声明 Linear 绑定。普通功能和修复的精确目标 ref 默认为 `origin/develop`；closing PR 合并到 `develop` 后开发 Issue 即 Done，发布等待不得阻塞或重开它；本地验证与最新目标 ref 的关系按第 2 节快车道条款执行。
- 紧急修复从 `origin/main` 创建 `hotfix/<ISSUE-ID>-<slug>` 并先合入 `main`；正式发布或恢复后必须立即以非 closing PR 将 `main` 回同步到 `develop`。回同步失败是发布阻塞，不得静默 cherry-pick 成两套历史。
- 正式发布使用独立 kind=aggregate Release Issue 和 `develop → main` merge-commit PR；随后保留 release-please 版本 PR。提升与回同步 PR 使用 `Refs <ISSUE-ID>`，不得再次 closing 已 Done 的开发 Issue。Release Issue 只有在 GitHub Release、制品、发布 smoke 和 `main → develop` 回同步全部有证据后才能 Done。
- write 节点的分支命名、`Refs <ISSUE-ID>` / `Fixes <ISSUE-ID>` 关联与 closing 语义以 `git-rules.md` 分支与 PR/MR 条款为准；worktree 位于仓库同级的 `<repo>-worktrees/<ISSUE-ID>`。
- 开始实现前记录精确目标远端 ref 和 base SHA，并从该基线创建分支；PR/MR 创建前的基线与 merge-base 核对、创建后的重读确认按 `git-rules.md` 分支与 PR/MR 条款执行。
- 优先由 Linear 的 GitHub/GitLab 集成或团队已配置自动化推进 In Progress、In Review、Ready to Merge 和 Done。只有缺少对应自动化且当前授权允许 linearWrite 时才按状态写入协议手工回写。
- Ready to Merge 仅对带门禁的目标分支适用，进入条件与完成证据按第 2 节状态表；没有门禁事实时不得仅凭 Linear 自动化声称可合并。
- 已授权 Issue 内可追加事实性的进展、验证、阻塞或决策评论。除最小身份登记及专用 `vb-linear-worktree-develop` 在第 1 节明确授权的计划内 Parent/DAG 写入外，创建 Issue、改变关系、优先级、Assignee、Delegate、Project、Cycle、Parent 或 Contract 都需要单独授权。
- MCP 不可用时可以使用用户提供的 Issue 内容，但必须明确未读取或同步 Linear；不得伪造评论、状态、关系、Delegate、Receipt、PR、review、CI 或 merge 结果。

Git credential helper 按 `git-rules.md` credential helper 条款执行：helper 仅可由其配置的 Git transport 透明使用，网页/API 会话用途必须另有 `credentialUse` 与对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或辅助文件也不得写入仓库或 worktree。

## 7 终止与交付

默认 terminalCondition 为当前 Issue 的已授权交付结果；显式授权整计划时允许依赖就绪的计划内后继自动接续。普通 PR/MR write 保留 In Review 和 closing 合并证据；显式 local-land write 以 stage 验证及 publish 精确远端确认 Done，不要求 PR。清理失败不改变代码集成成功，单列残留且保留资源占用；仅清理重试不得重放合并或推送。read 和 aggregate 按第 2 节完成。同步不可用时报告实际差异，不伪称 Linear 已 Done。不扫描 Ready 队列抢单，不转入无限 monitor。

合并后回归：Done 之后发现缺陷时，默认新建回归 Issue，并以非 closing 语义（`Refs <ISSUE-ID>`）的 revert PR 恢复到目标分支；原 Issue 保持 Done，并追加关联 revert 与事实原因的评论。不得为掩盖回归把 In Progress、In Review 或 Done 退回 Todo；只有需要重新实现或重新计时才使用状态纠错授权并记录事实原因。发布边界的回滚证据仍按 `release-rules.md` 与 Release Issue 模板记录。

推荐 Writer In Progress 不超过 3、In Review 不超过 2，作为 Linear 工作流软上限。长任务可选声明超时、最大尝试次数、取消、退避和资源预算；AI Ready Queue 仅供人查看，Agent 不直接读取它来挑选工作。

本规则直接定义 Linear 工作流的触发、操作顺序、不可写回退与停止边界；已安装的 `linear-workflow` Skill 按需辅助执行，不替代这些要求。两者描述同一工作流，修改须同步。

依赖与责任由 Linear 原生关系承载，集成由 Git 精确远端事实承载，环境占用由资源登记承载。任务文档与锚点只引用。连续切片同 writer 共用 Issue/分支，read 节点不创建实现 worktree；合批只含同目标、已就绪且需要共同验收的节点。Git 已集成而 Done 回写延迟记录同步待处理，不重推；恢复先读当前 Issue，只补缺失转换。创建、关系或归属写入结果不明先重读，不盲目补建，不引入 outbox 或状态数据库。
