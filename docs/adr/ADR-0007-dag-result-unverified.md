---
id: ADR-0007
title: DAG result 引入 unverified
status: accepted
date: 2026-09-14
review-date: 2027-03-14
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [rules-users, skill-authors]
supersedes: []
superseded-by: null
---

# DAG result 引入 unverified

## Context and Problem Statement

2026-09-14 的协作规则审查（对照 Anthropic 多 Agent 研究系统、Cognition 上下文工程原则、MAST 多 Agent 失败分类与 Azure 编排模式）发现一处语义冲突：`ai-collab-rules.md` 把 Linear 的「Done 但缺完成证据」映射为本地 `blocked`，而同一文件把 `blocked` 定义为「等待可恢复依赖或必要能力」。缺证据不是等待依赖，两个事实共用一个枚举值会让排障、ready 计算与 all_done 终结判定失去单一解释。

该枚举不是纯文案：`NODE_RESULTS` 同时被 `scripts/lib/task-dag.js`、两份 task 模板、task-decomposition 指南与 Linear 集成 references 消费，属于公共契约，语义含糊会跨文件漂移。

## Decision Drivers

- 状态语义必须自洽：等待依赖、等待能力、已有结论但缺证据是三类不同事实。
- 枚举是公共契约（`NODE_RESULTS`、`vibe-harness.task-dag/v1` 的校验值集、模板与 references），改动必须一次收敛全部消费方。
- 保持仓库既有的去门禁取向：新增状态只解释事实，不新增完成门禁、固定流程或角色门禁。
- 兼容性：既有 DAG 不得失效，结构哈希与 schema 标识保持不变。

## Considered Options

- 扩充 `blocked` 的定义，让它同时覆盖「结论已有但缺证据」。
- 新增非终态 `unverified`，把 Done 缺证据映射过去。
- 把 Done 缺证据映射为 `running`。

## Decision Outcome

选定方案：**新增非终态 `unverified`**。

- 扩充 `blocked` 会让一个词承载两类事实，排障时无法区分"还在等依赖"与"只差证据"，且后续任何只针对其中一类的规则都要额外限定语。
- `running` 表示存在活跃执行者且尚未验证完成，用它表示"结论已产出、只缺证据"会误导恢复与并发判断。
- 新增 `unverified` 后三处消费方仍共享同一枚举：`unverified` 不满足 `all_success`，也不构成 `all_done` 的终结输入，因此不放松任何完成判据。

影响面：`NODE_RESULTS` 由 8 值扩为 9 值；`TERMINAL_RESULTS`、`SUCCESSFUL_RESULTS`、`DAG_NODE_KEYS`、`vibe-harness.task-dag/v1` 标识与结构哈希均不变；本决策扩展 ADR-0004 记录的本地结果集，不改写其历史正文。

## Consequences

- 正面：状态语义自洽，排障能区分"等依赖"与"缺证据"；校验器、模板与 Linear 映射继续共享单一枚举。
- 取舍：枚举多一个值，阅读与实现需要多记一个状态；旧 DAG 不受影响，但引用旧映射的文档必须同步，本轮已同步规则、Linear 映射表、两份 task 模板、en-US 模板、linear 与 task-decomposition references、online canary rubric 与 `.agents` 镜像。

## Confirmation

- `tests/task-dag.test.js` 的 unverified 用例断言该状态合法、不满足 all_success、也不构成 all_done 的终结输入。
- `tests/execution-simplification.test.js` 的锚定断言要求规则文本覆盖全部 `NODE_RESULTS`，并约束 Linear 映射表只使用校验器接受的取值。
- `pnpm lint`、`pnpm validate`、`pnpm test:unit`、`pnpm test:integration`、`pnpm eval:check` 与 `pnpm eval:replay` 通过，且 eval 指纹漂移仅含 rules 与 skills 分组。

## Review Trigger

当需要引入 skip 传播语义、继续新增 result 取值，或 Linear 状态模型变化导致映射表需要改写时，复审本决策。

## More Information

- 规则：`docs/rules/ai-collab-rules.md`（节点状态与触发、Linear 状态到本地 result 映射表）
- 校验器：`scripts/lib/task-dag.js`
- 关联 ADR：ADR-0004（任务拆分治理与 DAG 状态一致性）、ADR-0005（规则治理：SSOT、排版与本地化）
