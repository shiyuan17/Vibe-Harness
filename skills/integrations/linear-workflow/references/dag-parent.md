# Linear DAG 聚合根（DAG Parent）

建议把 DAG Root 建为顶层 Parent Issue，并使用本模板。Parent 只负责聚合，不是实现节点；其子 Issue 使用 ai-coding-task.md。Linear 的 Parent/Sub-issue 和原生 blocked-by / blocks 关系是真值，不在描述中维护重复节点或依赖清单。

## 目标（Goal）

描述整个 DAG 完成后的可观察业务或工程结果。

## 背景（Context）

列出共享背景、目标仓库、可解析的精确目标远端 ref、架构约束和必要参考。“默认分支”只有经仓库事实解析后确为实现基线时才有效。

## 整体验收标准（Overall Acceptance Criteria）

- [ ] DAG 整体可观察验收点
- [ ] 所有必需后代节点按自身 kind 成功
- [ ] Fan-in Verification 通过并记录证据

## 共享合同（Shared Contract）

描述所有节点共同消费的 API、schema、事件、配置或行为合同。没有共享合同变化时写 None。共享合同只能有一个明确写入 owner；其他节点消费其稳定输出。

## 范围外（Out of Scope）

- 不属于本 DAG 的路径、合同或产品决定

## 依赖（Dependencies）

只填写 None 或 Managed by Linear relations。Parent/Sub-issue 只表示分解，related 不表示依赖；执行顺序仅由 blocked-by / blocks 决定。

## DAG 元数据（DAG Metadata）

- kind: aggregate
- trigger: all_success | all_done，默认 all_success
- resourceLocks: 稳定逻辑资源名列表，或 None

本地 result 使用 pending / ready / running / unverified / succeeded / failed / blocked / skipped / cancelled，仅作人读解释，不新增平台字段。Canceled / Won't Fix 映射 cancelled，Duplicate 映射 skipped；unverified 与 blocked 非终态，不满足 all_done。

all_success 要求全部直接前驱成功。all_done 只允许聚合终态、清理或失败报告；它可以成功地产出报告，但不能把有失败必需节点的 DAG Root 判为成功。

不定义 optional node：Parent 下所有 descendant node 都是 required。多层 Parent 也必须是 aggregate。

## Agent 编排（仅真实多 Agent 时填写）

普通 Parent 不要求 `wallClock`、Agent 容量、并行收益、Task DAG 或该计划块；只按可观察增量记录验收切片并遵循已有 Linear 原生依赖。只有实际派发多个 Agent 时才追加一个 `linear-plan` JSON block，字段以 `schemas/linear-plan.schema.json` 为准，并按 `task-decomposition` 的按需 reference 判断隔离、容量和收益。`agentPlan.fanInOwner` 固定为 `parent-agent`。旧 v1 计划可读，执行时保守采用 single，不要求为读取而批量迁移。

## 早期探查（存在实质不确定性时选填）

- 待回答问题（入口、数据或环境）：
- 方法与预计分钟数（普通 REPL / 已声明的受管 Micro / 其他只读探查）：
- 退出条件与未解决时的风险：
- 后续正式检查：

首轮规划默认限时 30 分钟，未解决时记录风险并重新估算。探查时间只计入共享准备一次，不减少最终验证时间。普通 REPL、临时脚本或人工观察不能作为完成收据；已声明的受管 Micro 即使通过也仅证明 L1 局部观察。

## Fan-in 验证（Fan-in Verification）

- command or observable end-to-end check
- evidence location or expected observation

Fan-in 必须在所有必需后代进入终态后，从实际合并结果重新验证，不能只汇总子 Agent 自报。验证失败时 Parent 不得 Done。

## 完成策略（Completion Policy）

Parent 只有同时满足以下条件才可 Done：

1. 每个 required write descendant 的 closing GitHub PR 或 GitLab MR 已合并到声明的精确目标 ref；仅显式 `vb-linear-worktree-develop` 的 local-land 节点可改用本地 develop 快照上的 stage 候选 no-ff 合并验证、publish 最新基线重建验证及精确远端推送确认的完整证据。主检出同步单列，清理结果单列且不阻塞 Done，残留资源仍占用。
2. 每个 required read descendant 的约定输出和 Verification 证据已记录。
3. 每个 required aggregate descendant 满足自身 trigger，并通过自身 Fan-in Verification。
4. Root 的 Fan-in Verification 通过并留下事实证据。

任一 required descendant 为 failed、unverified、blocked、skipped、cancelled、Canceled、Duplicate 或 Won't Fix 时，Parent 不得判为成功或 Done。成功的 all_done 报告节点不能覆盖该失败。必须关闭 Workspace 的 Parent/Sub-issue 自动关闭，避免绕过本策略。

## AI 规则（AI Rules）

- 不因 Parent/Sub-issue 关系推断执行顺序。
- Ready、Todo、依赖满足或 DAG Parent 内容不构成执行授权；完成当前请求后不自动选择下一个节点。
- 不自动拆 Issue、移动 Parent、创建节点、补依赖或调整优先级。
- 自依赖、依赖环、不可见依赖、未满足 trigger 或未解决 blocked-by 都阻止开始相关节点。
- 两个 write 节点 Scope 重叠或 Resource Lock 相同时，只有存在从一个到另一个的原生依赖路径才视为已串行；否则停止并请求授权，不自行创建关系。
- 路径不重叠但存在 API、Schema、迁移或行为契约耦合时，指定唯一写入 owner 并建立原生依赖；无法证明隔离时按冲突处理。
- 每次派发 write 节点前重验证 DAG 版本或 hash、依赖、Scope、锁、HEAD 和工作区身份；变化时暂停后继并重新计算 ready 集合。
- 子节点交接至少报告结果、修改文件、base/head、验证命令与退出码、风险和阻塞；交接信息不构成授权。
- 只读取当前 Issue 及必要依赖/冲突范围；保存 dagStructureHash 和可用的 dagChangeCursor。只有两者共同证明结构未变才增量读取；没有可靠游标时允许一次有界重读相关完整范围，仍不完整则 fail-closed，不反复遍历全项目。

显式 local-land：stage 候选验证并持久化 → publish 对齐最新 `origin/develop`、按需重建验证 → 精确远端推送确认即 Done / succeeded；主检出本地同步只作独立结果。清理失败不阻塞后继，但残留路径/端口/resourceLocks 继续占用。Start/Terminal Receipt 可选，无宿主 Claim 仍可执行，同 Issue 不重复并行；不扫描队列抢单。普通 PR/MR 仍需 In Review 与 closing 合并证据，Parent 必需全部后代成功及最终组合行为的 fan-in 验证。
