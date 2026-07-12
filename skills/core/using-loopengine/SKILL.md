---
name: using-loopengine
description: 用于在任务开始、风险变化或交付前选择 LoopEngine 流程、专项和验证 Skill。
---

# LoopEngine 路由

先读取 `docs/rules/governance-core.md` 和 `docs/rules/AGENT_SKILL_ROUTING.md`。前者定义流程硬约束，后者定义 Skill 选择与 fallback；本 Skill 只负责执行路由。

1. 判断权限、红区和风险档位。
2. 确认当前处于获取事实、做出决策、执行、验证或交付。
3. 最多选择一个流程 Skill 和一个专项 Skill。
4. 最多选择一个验证或审查 Skill。

快速任务默认直接执行五步循环，不加载规格、计划或审查 Skill。需求仍有关键歧义时使用 `brainstorming`；已有稳定规格且需要多步实施时使用 `writing-plans`；执行计划使用 `executing-plans`；故障使用 `systematic-debugging`。

行为变更使用 `test-driven-development`，完成声明前使用 `verification-before-completion`。完整、高风险、红区、安全、数据、发布或外部契约任务使用 `adversarial-review-packet`；不可用时回退 `code-review-and-quality` 并记录未覆盖审查轴。
