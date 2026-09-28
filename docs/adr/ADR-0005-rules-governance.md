---
id: ADR-0005
title: 规则治理：SSOT、排版与本地化
status: accepted
date: 2026-09-11
review-date: 2027-03-11
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [rules-users, skill-authors]
supersedes: []
superseded-by: null
---

# 规则治理：SSOT、排版与本地化

## Context and Problem Statement

2026-09-11 的规则审计发现四类问题：linear-workflow 与 ai-collab-rules 对 DAG 语义存在多处近似重复的复述，漂移风险高；规则排版风格不统一（`<code>` 标签、`->` 箭头、长段落悬挂）；模板、能力目录、Schema 与 CLI 文案中英混杂，并残留过时版本号与硬编码计数；resident 治理预算 92 行不足以容纳列表化、表格化后的治理正文。

## Decision Drivers

- 重复语义会漂移：两份规则各写一份 result 枚举或重验证条款，后续修改容易只改一处。
- 常驻上下文要精简，规则正文要可读：排版需要统一标准，而不是逐文件惯例。
- 仓库以中文为主要文档语言，但机器标记（frontmatter 字段、status 枚举、statusMessage）必须保持可解析。
- 硬编码的版本号与数量统计会随发布变成过时信息。

## Considered Options

- 保持各规则自包含，重复关键语义，依靠人工同步。
- 把全部 DAG 语义集中进单一规则，其他文件只留引用。
- 分层 SSOT：通用语义集中到 ai-collab-rules，linear-workflow 只保留 Linear 载体映射与引用。

## Decision Outcome

选定分层 SSOT，并固化排版与本地化约定。

- ai-collab-rules.md 是节点模型、`result` 枚举、all_success / all_done、ready 与 fail-closed、Scope 和 Resource Lock 语义的唯一规范来源，并维护 Linear 状态到本地 `result` 的映射表；Canceled、Won't Fix 与 Duplicate 一律映射为非成功。
- linear-workflow.md 只定义这些字段在 Linear 上的载体与真值来源（字段映射表），并明确 Parent/Sub-issue、related 与描述依赖清单三条非边；不再复述通用语义。
- 排版标准：规则使用 H2 分节、`→` 箭头和反引号代码样式；映射关系优先表格化；长段落拆为编号列表或短段落。
- 本地化约定：正文使用中文并保留英文术语；frontmatter 字段名、status 枚举、statusMessage 等机器标记不翻译；存量英文 ADR 与 en-US 模板不改写。
- 版本号、Skill 数量等易漂移信息不得硬编码进规则与描述；版本真值留在 package.json 与 runtime 锁定。
- resident 治理预算从 92 行放宽到 150 行：治理正文列表化、表格化后行数自然增加；预算是上限而不是目标，治理核心仍以约 90 行为精简基准。

## Consequences

- 正面：单一规范来源降低漂移风险；映射表让 Linear 投影可逐字段核对；排版与语言约定可被 lint 和复审一致执行。
- 取舍：跨文件阅读需要跟随引用；resident 预算放宽放松了部分硬约束，精简目标依靠评审自律维持。

## Confirmation

resident 预算与重复段落 lint、tests/linear-workflow.test.js 与 tests/execution-simplification.test.js 的锚定断言（引用式断言指向 ai-collab-rules.md），以及 eval reference 指纹重生成，共同证明实现遵循本决策。

## Review Trigger

当 150 行预算再次成为排版瓶颈、Skill 体系引入新的 kind 枚举、或本地化策略需要覆盖更多资产类型时复审本决策。

## More Information

- 协作规则：docs/rules/ai-collab-rules.md
- Linear 工作流规则：docs/rules/linear-workflow.md
- resident 门禁：scripts/lib/pack-validation.js
