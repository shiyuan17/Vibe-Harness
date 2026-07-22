---
name: using-cognis
description: 在任务开始、失败信号、风险变化或交付前选择最小必要 Cognis 能力。
---

# Cognis 短路由

读取 `docs/rules/governance-core.md` 与 `docs/rules/AGENT_SKILL_ROUTING.md`。

1. 解析 `governance.workflow`；缺失按 `strict`。
2. `adaptive` 默认直接走“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”，不加载流程 Skill 链。
3. 只有关键产品歧义、重复失败、特殊领域知识、复杂验证或完整路径信号出现时，加载一个必要 Skill。
4. `strict` 保留既有生命周期路由与完整交付合同。
5. 安全、外部写入、生产、权限、凭据、红区、不可逆动作和范围扩大始终等待人工确认。

Agent 规则、Skill、模板、adapter 或 Hook 行为变化时，必要入口是 `eval-driven-development`。能力不可用时 fallback 到治理内核与专项规则。验证真实性是治理内核要求；普通完成声明不必再加载验证 Skill。多 Agent 只用于边界与验证独立且有明确墙钟收益的完整任务。
