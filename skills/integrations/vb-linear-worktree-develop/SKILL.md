---
name: vb-linear-worktree-develop
description: Use only when explicitly requested as Vb Linear Worktree Develop, $vb-linear-worktree-develop, or legacy lwflow to sync a plan to Linear and deliver only its new tasks through develop worktrees; excludes ordinary Linear queries.
---

# Vb Linear Worktree Develop

调用标识：`vb-linear-worktree-develop` / `$vb-linear-worktree-develop`；显示名：`Vb Linear Worktree Develop`。兼容旧触发词 `lwflow` / `$lwflow`，均选择本 Skill，不安装重复入口。

`vb-linear-worktree-develop` / `$vb-linear-worktree-develop` 只处理当前会话已确定的任务计划；不是普通 Linear 查询或自动领单。同步归属：`docs/rules/linear-workflow.md` 的「显式 vb-linear-worktree-develop」及 `docs/rules/git-rules.md` 的「显式 develop flow」，修改须同步。必须有可写 Linear connector、有效执行授权、本地工作区核验及持久 provider 原子 Claim；宿主核验信息只在跨边界操作（Linear 之外的宿主/外部写入、凭据、红区）与宿主事件自动领单时需要；缺一则停止对应步骤，不伪造同步或领取。回退边界：Linear 只读、不可达或不能确认写入时不执行本模式，不转为未登记的本地执行。每次本地落地仅临时使用 `--delivery local-land`，不改默认交付配置。

执行前逐项核对：

- **授权**：Linear 写入、worktree 生命周期、分支、提交与推送逐项确认授权来源：用户显式调用本 Skill 覆盖本轮计划内的本地 worktree 生命周期与提交推送；Linear 写入与任何跨边界效果按 `vibe-harness.execution-envelope/v2` 逐项登记，绑定 requestId、sessionId、targetIssueIds、mode=execute、activeObjective、allowedEffects、forbiddenEffects、terminalCondition，涉及跨边界效果时 riskClass=high，禁止项优先。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；externalTargets 只含目标类型、标识与环境。
- **宿主**：worktree 生命周期只要求本地工作区核验，不需要宿主核验信息。跨边界操作与宿主事件自动领单才要求 hostContext，且必须由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt；Agent 不得自造。缺授权或工作区身份不符时暂停对应写入；缺少宿主证明只暂停依赖它的跨边界步骤，不阻塞建立 worktree、实现与提交，也不得靠重复询问用户解除。
- **入口选择**：宿主提供 worktree 能力时优先用宿主 worktree，从已核实的 `origin/develop` 基线创建并让宿主把会话根切到它；需要 `worktree.mirrors`、`worktree.ports` 或 `worktree.provision` 时才用 `worktree bootstrap`，`land` 只回收该入口登记的工作区。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区或高风险间接写入。

1. 将计划映射为一个 `aggregate` Parent、必要的 read/write 子任务、Scope、验收、验证、共享合同 owner 与 blocked-by / blocks 原生依赖。先核对团队、仓库和计划边界；不能从计划推断的高影响决定先澄清。默认单 Agent、按 DAG 拓扑顺序执行；只有已有隔离证明与实际收益才并行。
2. 只对本轮要创建的 Parent/子任务与关系写入 Linear；每个非幂等写入均先读取并校验目标、使用稳定幂等键或写后重读核对 ID、Parent、字段及原生依赖。结果未知时按同一键查询，绝不盲目重建；记录本轮创建节点 ID 的封闭集合。创建失败或重读不完整时停止并保留已创建的节点清单。
3. 只从这个封闭集合中挑选节点：Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies、Verification 齐全；原生 blocked-by / blocks 依赖满足，无环、缺失前驱、Scope 或 Resource Lock 冲突。related 不算依赖，共享契约只有一个 writer。不扫描、轮询或领取其他 Ready/Todo Issue。
4. 领取顺序为 provider 原子 Claim → Delegate → `vibe-harness.linear-execution/v3` Start Receipt → 重读确认。保留人类 Assignee，检查无其他 Delegate 或活动执行；Claim 固定 claimId、executionId、leaseExpiresAt、fencingToken、claimProvider，Receipt 绑定这些字段和当前身份。结果不明先查同一幂等键，不申请第二套 ID；部分登记、互斥缺失、lease 过期或 fencing 失配时 fail-closed，保留现场供人工核对。每次状态写入都“读取 → 校验 → 写入 → 重读确认”。
5. 每个 write 节点先 fetch 并核实最新 `origin/develop`，主检出须为干净且可快进的 `develop`；建立本地隔离工作区不需要宿主核验——本模式的本地落地只回收 `worktree bootstrap` 创建并登记的仓库外 worktree，因此用该入口从该基线建仓库外 worktree 与 `<type>/<ISSUE-ID>-<slug>` 分支（宿主 worktree 不进入本地落地，只按项目 delivery 走推送任务分支的独立交付路径）。在该 worktree 的会话根内实施、验证并提交 `Refs <ISSUE-ID>`。先 dry-run，再在仍与远端一致的主检出执行 `node .agents/runtime/commands/run.mjs worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --write --push`；仅当 delivery profile 的 `reviewPolicy` 不为 `none` 时补已逐项审定的 `--reviewed` check ID，`reviewPolicy:"none"` 且目标分支恰为 `develop` 时省略，不伪造 reviewed 结论。`--base-ref` 是断言，不是切换参数；不得手动合并绕过验证。高风险缺少肯定的 Independent Review Receipt 时不得落地；目标前进则重建基线并重验。read 节点只提交约定输出及 Verification 证据，不创建实现 worktree。需要直推远端 `develop` 且不更新主检出时，在同一 land 命令上加 `--target-mode remote`：候选在已核实的远端基线上 no-ff 合并并验证，以非强制 refspec 推送 `origin/develop`，远端 SHA 等于候选后才清理任务树与分支；主检出与其原改动保持原状，本地 `develop` 可能落后。
6. 仅当 write 节点具有最新基线的验证通过、no-ff 合并、`origin/develop` 推送成功及 worktree/分支清理证据时才标记该节点 Done；read 节点按约定输出与验证确认。所有必需节点成功后从已合并结果做 Parent fan-in 验证，通过后才更新 Parent 为 Done。报告 Linear ID、Claim/Receipt、状态和 Git/验证证据。

本模式不创建 PR/MR，不操作 `main`。普通 closing PR 的 Done 语义保持不变。Linear 写入不可用、基线漂移、冲突、验证/推送/清理失败时保留现场和已创建 ID，停止当前节点及依赖后继；不把本地成功或未确认请求描述为 Done，不自动回滚、force push、删除未确认合并的分支或强制清理。已推送但清理失败时报告残留，不重放合并。
