# 评测驱动开发

修改 Agent 规则、Skill、模板、适配器、Hook 或其他非确定性行为前，先用 `Eval-ID` 定义可观察的失败场景。纯确定性代码行为继续使用测试驱动开发；评测不能代替单元测试。

## 评测类型

- **capability**：当前做不好、改动后应当能做好的行为。先用变更前的资产复现失败（RED）；旧资产本来就能通过时记为 `not-reproduced`，不得为了制造失败削弱评测。
- **regression**：已经稳定通过的关键能力集，用于防回退，期望接近全过，不作为爬山对象。capability 稳定通过后可毕业进 regression，毕业需要单独确认。
- **负控**：新增或修改 oracle、scoring 或 judge 后，先用已知坏样本确认检查会失败，再用已知好样本确认不会误判；未经负控的评测不得支撑改善主张。

## 变更与判定

- 先记录输入、必须和禁止行为、风险等级、评分维度，以及每个维度与 `Eval-ID`、验收项的映射。
- 修改前运行聚焦评测并保留失败或当前参考结果；不得先改 reference 让变更通过。
- 修改后使用相同 fixture、suite、runner、模型配置、预算和评分标准比较结果；分别记录旧、新规则/提示 fingerprint，被修改资产是实验变量，其余条件保持一致。不得用不同实验条件声称规则改善。
- critical 断言必须全部通过；reference 不匹配、缺失或自动更新均不能作为完成证据。
- critical 之外，`criticalPassRate`、`overallScore` 与单 capability 回退还受项目配置阈值的约束（`maxCapabilityRegression`），阈值以项目配置为单一事实源。
- 改善必须有超过抖动边界的差异：单轮、单 case 或只报告成功样本的差异不算改善；重复次数不足以支撑结论时按待补样本处理。
- reference 更新必须单独审查并显式确认，不能保存凭据、绝对路径或原始敏感对话。
- 真实 Agent 评测只能在一次性项目中运行，不得把评测任务直接指向源仓库或用户工作区。

测量条件（模型与版本、judge、CLI、backend、预算、重复次数、fixture、suite、评分标准与 rubric 文本）任一变化都要求新 baseline。项目状态 `baseline` 描述安装与验证状态；evaluation `reference` 描述批准的评测结果，两者不得混用。

## 断言与 judge

oracle 支持八类断言：七类确定性（event/output-fragment/artifact/exit-code）加 `llm-rubric`（LLM-as-judge 语义断言）。

- `llm-rubric` 仅 online：judge 调用非确定，offline suite 禁止包含 `llmRubrics`；judge 不可用按 fail-closed 转 blocked（degraded）。
- judge 默认与被测模型分离；复用被测模型自评时必须显式声明，并记为较弱的语义证据。
- 语义断言进入 critical 门禁前须与人工标注的小样本对齐，对齐不成立时只能作报告信号；critical 语义结论应由确定性断言锚定，或用多次、多 judge 达成一致。
- rubric 文本、judge 模型与阈值属于评分标准，按测量条件变化处理。

## 多轮与稳定性

online run 对每个 case 按 `repetitions` 独立运行多轮并输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/脱敏逐轮诊断）；稳定性只评价 `repetitions > 1` 的 case 并报告覆盖率，当前不新增阈值门禁。`passAtK` 是至少一轮通过（能力上限），`passCaretK` 是全部轮次通过（可靠性下限）；重复次数少时后者不构成可靠性结论。offline 是确定性 replay，不输出多轮摘要。

online runtime 只从 Codex 配置或环境变量提取 model/provider/base URL/reasoning/对应 auth 白名单；backend、CLI 版本和非敏感 runtime 参数必须进入 fingerprint。预算指 token、墙钟与成本的显式上限，随测量条件记录。runner、WSL、sandbox 或工具基础设施不可用时 fail-closed 为 blocked（degraded），不计为模型失败；同一 campaign 的受阻尝试（degraded attempt）必须保留，不能只报告成功样本。

case 可声明 `flaky: true` 以保留抖动诊断信息，但 critical 失败仍计入 `criticalPassRate`，`status` 仍要求所有 case `passed`；抖动 case 必须隔离到非门禁观察集并限期修复或替换，隔离项仍进入报告。case 可声明 `kind`（`standard`/`variation`/`edge`/`adversarial`）：可选元数据标签，当前不加计数门禁。

## 运行面

| 路径 | 能证明 | 不能证明 |
| --- | --- | --- |
| offline replay（contract-replay） | suite、oracle、scoring 与 reference 可确定性复现 | 当前规则、Skill 或 Hook 的真实行为 |
| online / Harness Evals | 声明条件下指定模型与宿主的可观察行为 | 未声明条件的普适结论 |
| `stub-behavioral` | 当前资产下确定性运行时组件的行为合同（Hook 红区/权限判定、聚焦验证 blocked/failed 语义），随资产指纹漂移 | 模型提示遵从、多轮行为或宿主真机行为 |

Harness Evals 是行为评测的规范架构（Scenario v3 / Result v3、RED → GREEN → Pressure → Regression、verifier 负控）；legacy `evals/` 只作为兼容资产来源，不复制也不推断缺失证据。

## 产物与写入边界

execution fixture 用 `allowedWritePaths` 声明唯一允许的 workspace 相对写入；未声明创建、修改或删除必须产生 `undeclared-workspace-write` 并触发安全断言。隐藏测试由 harness 执行，不以 fixture 文件暴露给模型。

- 普通 run 产物继续禁止保存 transcript、命令文本和命令输出；仅当 Scenario 声明使用一次性合成或公开 Fixture、证据目录位于被测工作区之外且持久化前完成凭据与绝对用户路径脱敏时，允许保存 ATIF 完整可观察 Trace。
- 原始 Trace 默认不提交 Git，完整 Trace 默认留存不超过 30 天；报告只引用脱敏证据及哈希；任何凭据均不得落盘。
- 通用 error item 不得计为工具调用；工具终态区分成功、预期拒绝、可恢复失败、致命失败和未知，且 API 虚构只由 `api-existence` 诊断归因。

## 套件治理

- 每个确认的真实失败（用户报告、回归或审计发现）在同一变更内沉淀为 case，避免同一失败模式重复回归。
- 保留不用于调参的 holdout；长期满分的 case 不再提供改善信号，应转入 regression 或替换，而不是继续用来宣称能力提升。

## 知识覆盖观察

受控知识覆盖观察记录 request root、候选 Rule 或 Skill owner、选择和调用状态、验证结果及停止边界。产物只保留语义 ID、枚举状态和计数，不保留原始提示、私有 Session 标识、绝对用户路径、Secrets、命令或消息正文。既有 owner 被调用且验证与停止边界闭合时记为 covered；证据不足时记为 needs-more-evidence；只有两个不同 Episode 在相同 request root、完整既有 owner 清单下都确认无匹配时才记为 confirmed-uncovered。该观察不新增完成门禁；少于两个可比 Episode 时不得据此提出新 Skill 或 Memory。

## 与其他契约的关系

本规则是常驻契约；按需展开的执行步骤见宿主 Skill 根目录下已安装的 `eval-driven-development` Skill 入口，两者描述同一门禁，修改须同步。评测命令入口与行为评测架构以项目自己的评测文档为准。
