---
name: eval-driven-development
description: 修改 Agent 规则、Skill、模板、适配器、Hook、提示或其他非确定性行为时使用。
---

# 评测驱动开发

目标是在实现前用可失败的 `Eval-ID` 固定预期行为，并用批准的 reference 发现回归。

1. 为每个行为变化创建一个场景，记录输入、必须行为、禁止行为、风险和对应 `AC-ID`。
2. 修改前运行聚焦 suite，确认案例因目标行为缺失而失败，或记录当前参考结果。
3. 实施满足案例的最小改动；确定性实现同时遵循 `test-driven-development`。
4. 使用相同 suite、runner、模型、Agent 版本和治理 hash 重新运行。
5. critical 必须全部通过，总分和能力域回归不得超过项目阈值。
6. 只把 reference matched 的项目内 run JSON 作为任务“评测”证据。

reference 不匹配或 runner 不可用时报告 degraded，不得自动更新 reference 或把缺少评测解释为通过。无可执行 runtime 时，fallback 到 `docs/rules/eval-driven-development.md` 编写案例并记录人工评测限制。
