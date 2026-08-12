---
name: eval-driven-development
description: Use for nondeterministic Agent rules, Skills, prompts, Hooks, or routing.
---

# 评测驱动修改 Agent 行为

知识覆盖观察先匹配当前安装的 Rule 和 Skill，并分别保留选择、调用、验证和停止边界。单个 Episode 或缺少调用证据只能是 needs-more-evidence；两个不同 Episode 在相同 request root、完整清单下都确认无匹配后，才可形成 confirmed-uncovered 并进入 owner 评审。该观察不新增完成门禁，也不得保存提示、Session、绝对用户路径、Secrets、命令或消息正文。

常驻契约见 `docs/rules/eval-driven-development.md`；本 Skill 是按需展开的执行步骤，两者描述同一门禁，修改须同步。

## 执行

1. 用真实输入定义一个会失败的 `Eval-ID`，注明必须行为、禁止行为、风险和确定性断言。
2. 修改前冻结同模型、runner、预算和规则/提示指纹的参考结果。
3. 实施最小改动；确定性部分同时运行普通测试。
4. 用相同条件重跑，比较成功率、Token、墙钟、交互、工具调用和错误完成声明。
5. critical 必须全部通过；reference 变更必须独立审查。

online run 按 `repetitions` 独立运行多轮，输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/逐轮明细）作为可靠性报告；稳定性只统计多轮 case 并同时报告覆盖率，当前不新增阈值门禁。offline 为确定性 replay，不输出多轮摘要。

online runner 只传入 model/provider/base URL/reasoning/对应 auth 白名单，并把实际 backend、CLI 版本与 repetitions 纳入 fingerprint。execution case 必须用 `allowedWritePaths` 限定写入；未声明写入或 sandbox/runner 基础设施故障按 fail-closed 处理，逐轮诊断不得保存 transcript、命令输出或凭据。

runner 不可用时报告 degraded，同一 campaign 的 degraded attempt 必须随报告汇总。通用 error item 不计入工具调用，预期安全拒绝与意外失败分开统计。不得自动更新 reference、把缺失运行解释为通过，或只报告双方成功的样本。
