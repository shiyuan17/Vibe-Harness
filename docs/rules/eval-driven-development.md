# 评测驱动开发

受控知识覆盖观察记录 request root、候选 Rule 或 Skill owner、选择和调用状态、验证结果及停止边界。产物只保留语义 ID、枚举状态和计数，不保留原始提示、私有 Session 标识、绝对用户路径、Secrets、命令或消息正文。既有 owner 被调用且验证与停止边界闭合时记为 covered；证据不足时记为 needs-more-evidence；只有两个不同 Episode 在相同 request root、完整既有 owner 清单下都确认无匹配时才记为 confirmed-uncovered。该观察不新增完成门禁；少于两个可比 Episode 时不得据此提出新 Skill 或 Memory。

修改 Agent 规则、Skill、模板、适配器、Hook 或其他非确定性行为前，先用 `Eval-ID` 定义可观察的失败场景。纯确定性代码行为继续使用测试驱动开发；评测不能代替单元测试。

- 先记录输入、必须和禁止行为、风险等级、评分维度及对应 `AC-ID`。
- 修改前运行聚焦评测并保留失败或当前参考结果；不得先改 reference 让变更通过。
- 修改后使用相同 suite、runner、模型和规则/提示 fingerprint 比较结果。
- critical 断言必须全部通过；reference 不匹配、缺失或自动更新均不能作为完成证据。
- reference 更新必须单独审查并显式确认，不能保存凭据、绝对路径或原始敏感对话。
- 真实 Agent 评测只能在一次性项目中运行，不得把评测任务直接指向源仓库或用户工作区。

项目状态 `baseline` 描述安装与验证状态；evaluation `reference` 描述批准的评测结果，两者不得混用。

online run 对每个 case 按 `repetitions` 独立运行多轮并输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/脱敏逐轮诊断）；稳定性只评价 `repetitions > 1` 的 case 并报告覆盖率，当前不新增阈值门禁。offline 是确定性 replay，不输出多轮摘要。online runtime 只从 Codex 配置或环境变量提取 model/provider/base URL/reasoning/对应 auth 白名单；backend、CLI 版本和非敏感 runtime 参数必须进入 fingerprint。runner、WSL、sandbox 或工具基础设施不可用时 fail-closed 为 degraded，不计为模型失败；同一 campaign 的 degraded attempt 必须保留，不能只报告成功样本。

execution fixture 用 `allowedWritePaths` 声明唯一允许的 workspace 相对写入；未声明创建、修改或删除必须产生 `undeclared-workspace-write` 并触发安全断言。隐藏测试由 harness 执行，不以 fixture 文件暴露给模型。普通 run 产物继续禁止保存 transcript、命令文本和命令输出；仅当 Scenario 声明使用一次性合成或公开 Fixture、证据目录位于被测工作区之外且持久化前完成凭据与绝对用户路径脱敏时，允许保存 ATIF 完整可观察 Trace。原始 Trace 默认不提交 Git，报告只引用脱敏证据及哈希；任何凭据均不得落盘。通用 error item 不得计为工具调用；工具终态区分成功、预期拒绝、可恢复失败、致命失败和未知，且 API 虚构只由 `api-existence` 诊断归因。

oracle 支持八类断言：七类确定性（event/output-fragment/artifact/exit-code）加 `llm-rubric`（LLM-as-judge 语义断言）。`llm-rubric` 仅 online：judge 调用非确定，offline suite 禁止包含 `llmRubrics`；judge 不可用按 fail-closed 转 degraded。

case 可声明 `flaky: true` 以保留抖动诊断信息，但 critical 失败仍计入 `criticalPassRate`，`status` 仍要求所有 case `passed`。case 可声明 `kind`（`standard`/`variation`/`edge`/`adversarial`）：可选元数据标签，当前不加计数门禁。

本规则是常驻契约；按需展开的执行步骤见 `eval-driven-development` Skill（`.agents/skills/eval-driven-development/SKILL.md`），两者描述同一门禁，修改须同步。
