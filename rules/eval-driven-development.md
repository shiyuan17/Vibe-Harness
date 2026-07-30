# 评测驱动开发

修改 Agent 规则、Skill、模板、适配器、Hook 或其他非确定性行为前，先用 `Eval-ID` 定义可观察的失败场景。纯确定性代码行为继续使用测试驱动开发；评测不能代替单元测试。

- 先记录输入、必须和禁止行为、风险等级、评分维度及对应 `AC-ID`。
- 修改前运行聚焦评测并保留失败或当前参考结果；不得先改 reference 让变更通过。
- 修改后使用相同 suite、runner、模型和规则/提示 fingerprint 比较结果。
- critical 断言必须全部通过；reference 不匹配、缺失或自动更新均不能作为完成证据。
- reference 更新必须单独审查并显式确认，不能保存凭据、绝对路径或原始敏感对话。
- 真实 Agent 评测只能在一次性项目中运行，不得把评测任务直接指向源仓库或用户工作区。

项目状态 `baseline` 描述安装与验证状态；evaluation `reference` 描述批准的评测结果，两者不得混用。

online run 对每个 case 按 `repetitions` 独立运行多轮并输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/逐轮明细）；当前仅作报告指标，不新增阈值门禁。offline 是确定性 replay，不输出多轮摘要。

oracle 支持八类断言：七类确定性（event/output-fragment/artifact/exit-code）加 `llm-rubric`（LLM-as-judge 语义断言）。`llm-rubric` 仅 online：judge 调用非确定，offline suite 禁止包含 `llmRubrics`；judge 不可用按 fail-closed 转 degraded。

case 可声明 `flaky: true`：critical 失败记录但不阻断（从 `criticalPassRate` 排除，`status` 判定忽略）。case 可声明 `kind`（`standard`/`variation`/`edge`/`adversarial`）：可选元数据标签，当前不加计数门禁。

本规则是常驻契约；按需展开的执行步骤见 `eval-driven-development` Skill（`.agents/skills/eval-driven-development/SKILL.md`），两者描述同一门禁，修改须同步。
