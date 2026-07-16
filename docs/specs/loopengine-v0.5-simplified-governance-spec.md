# LoopEngine v0.5 中文精简治理规格

状态：Implemented

版本说明：`v0.5` 是治理规格修订号，不等同于 `package.json` 的产品发布版本；当前 package release 仍按独立语义化版本演进。

## 目标

用最小常驻上下文驱动安全、可验证的 coding-agent 工作，并消除规则、workflow、模板与 task JSON 之间的多源真值。

## 执行合同

默认循环为“获取事实 → 做出决策 → 执行 → 验证 → 交付”。风险档位为快速、轻量和完整；所有任务执行轻量反证，完整或高风险任务完成前必须通过独立 Red Team（红队审查）并保存结构化审查包。

## 任务合同

- `docs/tasks/<任务编号>.md` 是唯一人工任务真值。
- 固定中文字段为工作流档位、当前阶段、当前状态和处理结果。
- 验收标准与完成证据通过 AC-ID 对应。
- 完整档位嵌入中文 JSON 控制块；控制块只保存高风险控制数据。
- 完整任务完成时必须记录红队审查者、项目内审查包路径和“批准”结论；旧的未完成完整任务升级后无需立即补齐。
- 旧 `task.json` 和 backlog JSON 生命周期不再支持。

## Small Change 与多 Agent 契约

- 一个任务只解决一个问题，一个 commit 只表达一个逻辑目的；重构、格式化、依赖升级和业务修改默认拆分，无关清理记录为后续任务。
- Fan-out 只允许交付物独立、写入范围不重叠、依赖和冲突明确的子任务；共享边界或冲突不可判断时串行执行。
- Fan-in 由主 Agent 汇总、去重、解决冲突、审查最终 diff，并在集成位置统一验证；不得用一个大提交掩盖多个独立目的。
- 子任务控制块必须声明目标、输入、写入范围、输出格式、不得修改范围和验证方式。`输入`没有外部依赖时使用 `["无"]`，输出必须指向 report 或明确交付物。
- validator 只结构化校验子任务交接字段；一个任务是否包含多个目的、格式化是否与业务修改混合，由 reviewer 和交付记录判断。

## 资产合同

- `rules/governance-core.md` 是唯一流程规则真值。
- minimal/docs-only 在没有 skills 时使用 task/delivery 模板降级。
- core/full 使用 `using-loopengine`，一次最多选择一个流程、一个专项和一个验证或审查 skill。
- 不再提供 `workflows/`、workflow manifest、旧 task schema 或旧全局生命周期模板。

## 完成标准

- 常驻 AGENTS 与治理内核不超过 90 行。
- 中文任务 parser、Full schema、AC evidence、独立核验和 Red Team 完成门禁均有自动测试。
- `minimal`、`core`、`full`、`docs-only` 四个 canonical profiles 和统一 `--project`/`--write` 安装生命周期通过。
- `pnpm test`、`pnpm check` 与贡献指南中的 smoke 命令全部通过。
