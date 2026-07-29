---
name: eval-driven-development
description: Use for nondeterministic Agent rules, Skills, prompts, Hooks, or routing.
---

# 评测驱动修改 Agent 行为

常驻契约见 `docs/rules/eval-driven-development.md`；本 Skill 是按需展开的执行步骤，两者描述同一门禁，修改须同步。

## 执行

1. 用真实输入定义一个会失败的 `Eval-ID`，注明必须行为、禁止行为、风险和确定性断言。
2. 修改前冻结同模型、runner、预算和规则/提示指纹的参考结果。
3. 实施最小改动；确定性部分同时运行普通测试。
4. 用相同条件重跑，比较成功率、Token、墙钟、交互、工具调用和错误完成声明。
5. critical 必须全部通过；reference 变更必须独立审查。

online run 按 `repetitions` 独立运行多轮，输出 `trialSummaries`（`passAt1`/`passAtK`/`passCaretK`/逐轮明细）作为可靠性报告；当前不新增阈值门禁。offline 为确定性 replay，不输出多轮摘要。

runner 不可用时报告 degraded。不得自动更新 reference、把缺失运行解释为通过，或只报告双方成功的样本。
