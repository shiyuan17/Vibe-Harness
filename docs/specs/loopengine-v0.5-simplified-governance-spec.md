# LoopEngine v0.5 中文精简治理规格

状态：Implemented

## 目标

用最小常驻上下文驱动安全、可验证的 coding-agent 工作，并消除规则、workflow、模板与 task JSON 之间的多源真值。

## 执行合同

默认循环为“获取事实 → 做出决策 → 执行 → 验证 → 交付”。风险档位为快速、轻量和完整；所有任务执行轻量反证，完整或高风险任务要求独立对抗式审查。

## 任务合同

- `docs/tasks/<任务编号>.md` 是唯一人工任务真值。
- 固定中文字段为工作流档位、当前阶段、当前状态和处理结果。
- 验收标准与完成证据通过 AC-ID 对应。
- 完整档位嵌入中文 JSON 控制块；控制块只保存高风险控制数据。
- 旧 `task.json` 和 backlog JSON 生命周期不再支持。

## 资产合同

- `rules/governance-core.md` 是唯一流程规则真值。
- minimal/docs-only 在没有 skills 时使用 task/delivery 模板降级。
- core/full 使用 `using-loopengine`，一次最多选择一个流程、一个专项和一个验证或审查 skill。
- 不再提供 `workflows/`、workflow manifest、旧 task schema 或旧全局生命周期模板。

## 完成标准

- 常驻 AGENTS 与治理内核不超过 90 行。
- 中文任务 parser、Full schema、AC evidence 和独立核验门禁均有自动测试。
- 三个 MVP profiles 和 legacy/internal 安装生命周期通过。
- `pnpm test`、`pnpm check` 与贡献指南中的 smoke 命令全部通过。
