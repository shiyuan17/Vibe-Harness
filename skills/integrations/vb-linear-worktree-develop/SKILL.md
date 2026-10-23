---
name: vb-linear-worktree-develop
description: Use only when explicitly requested as Vb Linear Worktree Develop, $vb-linear-worktree-develop, or legacy lwflow to sync a plan to Linear and deliver only its new tasks through develop worktrees; excludes ordinary Linear queries.
---

# Vb Linear Worktree Develop

调用标识：`vb-linear-worktree-develop` / `$vb-linear-worktree-develop`；显示名：`Vb Linear Worktree Develop`。兼容旧触发词 `lwflow` / `$lwflow`，均选择本 Skill，不安装重复入口。

`vb-linear-worktree-develop` / `$vb-linear-worktree-develop` 只处理当前会话已确定的任务计划；不是普通 Linear 查询或自动领单。同步归属：`docs/rules/linear-workflow.md` 与 `docs/rules/git-rules.md`，修改须同步。显式单次调用只要求本轮授权、可核对的 Issue/计划上下文与本地工作区核验；同步必要的状态和结果，不强制 Start/Terminal 评论收据。同一 Issue 不允许重复并行执行；活动自动领单入口已退役。宿主核验仅用于跨边界写入；缺少时只暂停对应动作。显式调用在尚未尝试 Linear 写入时遇只读或不可达，且计划足以核对范围，可继续并标记 `unregistered / Linear 未同步`；结果不明或部分登记时停止受影响节点。每次本地落地只临时使用 `--delivery local-land`。

执行前逐项核对：

- **授权**：本轮显式调用覆盖当前计划内的 Linear Issue/关系/状态/Receipt 写入，以及本地 worktree、分支、提交、普通推送和合并到 `develop`。Agent 从当前请求内部建立逻辑 Envelope，记录 requestId、sessionId、targetIssueIds、mode、activeObjective、allowedEffects、forbiddenEffects 和 terminalCondition；新建 Issue 的目标由当前计划的 team/project 范围约束。用户不填写字段或 Envelope JSON。仅当实际操作涉及 hostWrite、externalWrite、credentialUse、红区或高风险间接写入时，才升级到 `vibe-harness.execution-envelope/v2` 并要求宿主提供 hostContext；PR/MR、force push、历史改写、`main` 和其他越界目标不由本 Skill 授权。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；externalTargets 只含目标类型、标识与环境。
- **宿主**：worktree 生命周期只要求本地工作区核验，不需要宿主核验信息。跨边界操作才要求 hostContext，且必须由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt；Agent 不得自造。缺授权或工作区身份不符时暂停对应写入；缺少宿主证明只暂停依赖它的跨边界步骤，不阻塞建立 worktree、实现与提交，也不得靠重复询问用户解除。
- **独立评审**：OCR 的代码差异外发需要独立的 `dataEgress` 和模型目标授权；仓库内 `run.mjs review ocr` 仅预检，不能签发宿主证明。宿主未提供可信 Broker 时保持 OCR 阻塞，可改用真正独立的宿主原生 Reviewer 按当前 diff 和最终验证收据生成回执；实施 Agent 不得自行签发批准。
- **入口选择**：local-land 默认使用 `worktree bootstrap` 已登记的仓库外 worktree；当前不提供宿主 worktree 导入登记。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区或高风险间接写入。

**显式执行不要求 Claim 或 Start/Terminal Receipt**。用户不填写 `claimId`、`grantId`、fencing 或 Envelope JSON。历史 v1/v2/v3、Delegate 和现有工作区仍参与占用核对；发现活动冲突时请求 handoff/release，不静默接管。可选旧诊断 v1 的 source 为 explicit-user-request，历史 Claim 只作读取兼容，不签发新替代锁服务。

1. 将计划映射为一个 `aggregate` Parent、必要的 read/write 子任务、Scope、验收、验证、共享合同 owner 与 blocked-by / blocks 原生依赖。先核对团队、仓库和计划边界；不能从计划推断的高影响决定先澄清。显式调用授权当前计划，不因缺少宿主 Claim 而停在规划阶段。默认单 Agent、按 DAG 拓扑顺序执行；只有已有隔离证明与实际收益才并行。
2. 只对本轮要创建的 Parent/子任务与关系写入 Linear；每个非幂等写入均先读取并校验目标、使用稳定幂等键或写后重读核对 ID、Parent、字段及原生依赖。结果未知时按同一键查询，绝不盲目重建；记录本轮创建节点 ID 的封闭集合。创建失败或重读不完整时停止并保留已创建的节点清单。
3. 只从这个封闭集合中挑选节点：Goal、Context、Repository、精确 Target branch ref、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies、Verification 齐全；原生 blocked-by / blocks 依赖满足，无环、缺失前驱、Scope 或 Resource Lock 冲突。related 不算依赖，共享契约只有一个 writer。不扫描、轮询或领取其他 Ready/Todo Issue。
4. 显式单次执行读取并核对 Issue 后同步必要状态；写入结果不明时按相同幂等键重读，不盲目追加评论或创建新的执行 ID。同一 Issue 不重复并行；无 Claim 不阻塞无冲突的显式执行。每次状态写入“读取 → 校验 → 写入 → 重读确认”；读取历史 Claim 时发现互斥失效或 fencing 不匹配保留现场。
5. 每个 write 节点从核实的最新 `origin/develop` 用 bootstrap 建立已登记隔离树。共享契约唯一 writer，默认单 Agent 顺序执行；实际并行才核对隔离、依赖、容量及收益。主检出必须在 develop 且干净，有无关改动保留任务树暂停落地。先 dry-run，再 `worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --write --push`；无依赖节点同时 ready 才显式 batch。候选 no-ff 合并与必要验证后，先 ff-only 更新主检出本地 develop，再显式非强制推送冻结 SHA 到唯一实际 origin/develop 地址，并重读 SHA。`--target-mode remote` 已退役，写入前拒绝；独立审查可选，项目明确的门禁继续生效。
6. write 节点在最终候选树验证通过、本地 develop 等于候选 SHA 且远端推送确认后标记 Done / succeeded；清理失败单列 `integrated_cleanup_pending`，不阻塞 Done、依赖后继或 Parent 汇总；残留资源继续占用，重试只清理不重放合并或推送。Parent 只对最终组合行为做一次必要 fan-in 验证，不把只读节点再跑完整矩阵。报告 Linear ID、状态、验证范围与 deferred、Git/推送证据及残留；仅实际有 Claim/Grant 时报告这些并发记录。

本模式不创建 PR/MR，不操作 `main`。普通 closing PR 的 Done 语义保持不变。Linear 工具回退/fallback：仅当显式调用在本轮尚未尝试 Linear 写入时遇到只读或不可达，且已有上下文足以核对任务范围与 DAG，才可继续本地执行并标记 `unregistered / Linear 未同步`；写入已尝试但结果不明、部分登记或重读失败时保留现场并停止受影响节点。自动队列抢单已退役；无法核对 Issue 时停止。基线漂移、冲突、验证或推送失败时保留现场和已创建 ID，停止当前节点及依赖后继；不把本地成功或未确认请求描述为 Done，不自动回滚、force push、删除未确认合并的分支或强制清理。已推送但清理失败时报告残留，不重放合并。
