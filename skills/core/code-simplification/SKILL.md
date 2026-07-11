---
name: code-simplification
description: Use when working code is harder to understand or maintain than its behavior requires and must be simplified without behavior changes.
---

# 代码精简

先用现有测试和调用方锁定行为。删除重复、无效间接层、死代码和不再需要的兼容分支；优先清晰控制流与现有模式，不为潜在复用创建抽象。每次只做一个可审查的结构变化，并运行相关测试。无法证明行为等价时缩小范围或补 characterization test。输出简化内容、保留的契约、验证证据和未覆盖风险；完成声明使用 `verification-before-completion`。
