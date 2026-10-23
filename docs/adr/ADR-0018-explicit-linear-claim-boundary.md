---
id: ADR-0018
title: 显式 Linear 执行与宿主自动派发的授权/Claim 分离
status: accepted
date: 2026-10-22
review-date: 2027-04-22
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: [ADR-0015]
superseded-by: null
---

# 显式 Linear 执行与宿主自动派发的授权/Claim 分离

## Context and Problem Statement

ADR-0015 将 `vb-linear-worktree-develop` / `lwflow` 的显式入口绑定到宿主 v2 授权与持久原子 Claim。Claim 本来用于宿主自动派发的跨实例互斥，却因此变成显式用户运行的前置材料；真实会话没有宿主注入字段时，用户被要求补填 claimId、grantId、lease、fencing token 和 Envelope，甚至本地 worktree 流程也会被阻断。

授权与互斥是两个不同问题：当前用户明确调用 Skill 并限定本轮计划范围时，已给出显式执行授权；Claim 只证明某次运行占有并发互斥，不应扩大权限范围，也不应转嫁为用户填写的协议字段。自动队列派发仍需 Grant、持久 Claim 与宿主核验，不能沿用显式单次执行的简化路径。

## Decision Drivers

- 显式调用不再要求用户提供宿主内部生成的 Claim、Grant、lease、fencing 或 Envelope 字段。
- 自动派发保留可撤销授权、跨实例原子互斥与逐 Issue 效果限制。
- 现有活动 Receipt、Delegate、部分登记、结果不明及高风险边界继续 fail-closed。
- 不把 Linear 写后重读、Agent 本地锁或 v1 Receipt 描述成原子跨实例互斥。
- 让 Receipt CLI、校验器、JSON Schema、Skill、规则、规格与 Eval 表达同一合同。

## Considered Options

- 要求所有执行都携带 Claim：拒绝。它把自动调度设施误变成用户手填表单，并阻断普通显式单次运行。
- 对任何显式和自动运行都移除 Claim：拒绝。自动队列派发仍需要宿主持久互斥与撤销。
- 按执行来源分离授权与互斥：采纳。显式单次运行默认使用内部 v1 Receipt；宿主可为需要并发保护的显式运行内部提供 Claim/v3；自动派发必须使用 Grant、原子 Claim、fencing 和 v3。

## Decision Outcome

- 显式调用 `vb-linear-worktree-develop` 授权当前会话已经确定的计划范围，包括专用 Skill 明列的 Parent/DAG 与本地交付效果；普通具体 Issue 指令只授权该 Issue 的既有执行范围与最小身份登记。Agent 从本轮请求、目标和工作区事实构造内部授权上下文；不要求用户提交 Claim/Grant/Envelope JSON。无宿主并发互斥时使用 `source=explicit-user-request` 的 v1 Start Receipt。
- v1 的活动记录检查是读前冲突检查，不是原子锁。同一 Issue 的显式 v1 运行按单运行串行，不并行启动。若宿主为显式并发执行提供持久原子 Claim，由宿主生成 claimId、lease、fencing token 和 claimProvider，记录使用不带 Grant 的 Claim-bearing v3 Receipt。
- 宿主自动派发只能在有效、持久、可撤销的 Grant 内选择具体 Issue；宿主必须原子 Claim 并提供 fencing，随后追加带 `grantId` 的 v3 Receipt 与逐 Issue v2 Execution Envelope。任何字段由宿主生成，不从 Issue、项目配置或用户输入推断。缺少能力时停止自动派发，不询问用户手工补字段。
- Claim 只限制并发与过期运行，不增加用户授权的 Issue、Scope、effect 或目标。v2 Start Receipt 保持历史读取兼容；v3 的 Claim 元数据按 JSON Schema 与运行时校验器严格验证，自动来源必须带 UUID v4 `grantId`。
- 普通 worktree、分支、实现、聚焦验证与本地提交继续按显式请求和可核对的 Git 身份授权；跨边界写入、凭据、红区和高风险间接写入仍按 governance-core 要求宿主证明。Linear 写入尚未尝试且已有上下文足以核验范围时，可以降级为 `unregistered / Linear 未同步`；部分或不确定写入不得这样回退。

本决策仅替代 ADR-0015 中“显式 Linear flow 必须具备宿主 v2 执行证明与持久原子 Claim”的前置条件。显式 Skill 入口、当前计划边界、本地 land、不创建 PR/MR、不改默认交付等其他决定继续有效。ADR-0015 的历史正文保留。

## Consequences

- 正面：直接调用 `vb-linear-worktree-develop` 不再因缺少用户无法提供的 Claim 字段而阻断显式单次执行。
- 正面：自动派发仍有独立的 Grant/Claim/v3 边界；显式并发需要互斥时由宿主注入同一内部合同。
- 取舍：没有宿主 Claim 的 v1 不能保证同时启动的多个会话互斥，因此明确禁止同 Issue 并行显式运行。
- 取舍：这只是 portable contract 与验证规则，不交付 Vibe-Harness 常驻调度服务，也不代表任何宿主已启用自动派发。

## Confirmation

- 规则、规格与 Skill 明确区分显式 v1、宿主管理的 Claim-bearing v3 和自动 Grant/Claim/v3。
- Receipt CLI 与运行时校验覆盖完整 Claim 字段、UUID、长度、未来 lease、同一幂等键的内容一致性和坏 lease 拒绝。
- Online Eval 覆盖无 Claim 字段时的显式调用；integration tests 覆盖显式 v1、Claim-bearing v3、自动 Grant/v3 和运行时 Claim 状态转换。
- `docs/adr/catalog.json` 与 `docs/memory/DECISIONS.md` 登记本决策；ADR validator 验证替换关系和索引一致性。

## Review Trigger

- 实际宿主提供不同的显式 Claim 注入或并发控制合同。
- 自动派发不再要求持久 Grant、原子 Claim、fencing 或逐 Issue Envelope。
- v1 活动记录检查获得原子 Compare-and-Set 能力，或出现同时显式启动造成重复运行的事实。

## More Information

- 原入口决策：[ADR-0015](ADR-0015-explicit-develop-flow.md)
- 自动派发授权：[ADR-0008](ADR-0008-bounded-linear-auto-claim.md) 与 [ADR-0010](ADR-0010-symphony-hosted-linear-dispatch.md)
- 现行合同：`docs/rules/governance-core.md`、`docs/rules/linear-workflow.md`、`skills/integrations/linear-workflow/references/execution-receipt.md`
