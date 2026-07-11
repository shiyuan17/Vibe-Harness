---
name: adversarial-review-packet
description: Use when Full or high-risk changes require independent multi-axis review before release or merge approval.
---

# 对抗式审查包

## 前置

保持只读并确认目标 diff、规格、风险档位、验证证据和审查者独立性。实现者不得自我批准高风险工作。

## 审查轴

并行核对正确性与边界、安全/滥用路径、架构依赖、测试有效性、发布/回滚、治理合规；涉及 UI 或外部契约时再核对浏览器运行时和契约证据。先报告 findings，按严重度给出位置、触发方式、影响和最小修复方向。

优先使用 `open-code-review` 获取第二视角，并以 `code-review-and-quality` 统一判定；工具不可用时回退到独立人工审查，记录原因与未覆盖轴。输出使用 Review Packet，High/Critical、证据缺失或红区确认缺失均阻断。
