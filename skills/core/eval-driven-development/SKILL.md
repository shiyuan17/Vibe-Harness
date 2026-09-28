---
name: eval-driven-development
description: Use for nondeterministic Agent rules, Skills, prompts, Hooks, or routing—not deterministic logic, bug fixes with known causes, or deterministic refactors.
---

# 评测驱动修改 Agent 行为

知识覆盖观察先匹配当前安装的 Rule 和 Skill，并分别保留选择、调用、验证和停止边界。单个 Episode 或缺少调用证据只能是 needs-more-evidence；两个不同 Episode 在相同 request root、完整清单下都确认无匹配后，才可形成 confirmed-uncovered 并进入 owner 评审。该观察不新增完成门禁，也不得保存提示、Session、绝对用户路径、Secrets、命令或消息正文。

常驻契约见 `docs/rules/eval-driven-development.md`；本 Skill 是按需展开的执行步骤，两者描述同一门禁，修改须同步。

## 执行

1. 用真实输入定义一个会失败的 `Eval-ID`，注明必须行为、禁止行为、风险和确定性断言；capability 变更先确认旧资产能复现失败，旧资产本来就能通过时记为 not-reproduced。
2. 新增或修改 oracle、scoring 或 judge 前先做负控：已知坏样本必须失败，已知好样本不得误判。
3. 修改前冻结 fixture、suite、模型与版本、runner、预算、重复次数、评分标准、rubric 文本、judge 与旧规则/提示指纹的参考结果。
4. 实施最小改动；确定性部分同时运行普通测试。
5. 保持其他实验条件一致，用新规则/提示指纹重跑；被修改资产是实验变量。比较成功率、Token、墙钟、交互、工具调用和错误完成声明，并确认差异超过抖动边界：单轮或只报告成功样本的差异不算改善。
6. critical 必须全部通过且不越过项目配置阈值；reference 更新必须单独审查并显式确认。
7. 确认的真实失败在同一变更内沉淀为 case；长期满分的 case 转入 regression 或替换，不再用作改善信号。

online run 按 `repetitions` 独立运行多轮，输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/逐轮明细）作为可靠性报告；`passAtK` 是至少一轮通过，`passCaretK` 是全部轮次通过，重复次数少时不构成可靠性结论。稳定性只统计多轮 case 并同时报告覆盖率，当前不新增阈值门禁。offline 为确定性 replay，不输出多轮摘要。

online runner 只传入 model/provider/base URL/reasoning/对应 auth 白名单，并把实际 backend、CLI 版本与 repetitions 纳入 fingerprint。execution case 必须用 `allowedWritePaths` 限定写入；未声明写入或 sandbox/runner 基础设施故障按 fail-closed 处理。普通逐轮诊断不得保存 transcript、命令输出或凭据；一次性合成或公开 Fixture 可在工作区外保存持久化前已脱敏的 ATIF 完整可观察 Trace，原始 Trace 不进 Git、完整 Trace 默认留存不超过 30 天，且任何凭据不得落盘。judge 默认与被测模型分离，复用被测模型自评必须显式声明；语义断言未与人工标注对齐前只能作报告信号。

抖动 case 用 `flaky` 标记并隔离到非门禁观察集，限期修复或替换，隔离项仍进入报告。runner 不可用时报告 degraded，同一 campaign 的 degraded attempt 必须随报告汇总。通用 error item 不计入工具调用，预期安全拒绝与意外失败分开统计。不得自动更新 reference、把缺失运行解释为通过，或只报告双方成功的样本。
