---
name: adversarial-review-packet
description: Use when Full or high-risk changes require an independent Red Team review before completion, release, or merge approval.
---

# Red Team（红队审查）包

输出使用 `references/review.md`，按 `docs/reviews/<任务编号>-red-team.md` 保存项目内审查包。

## 前置

保持只读并确认目标 diff、规格、风险档位、验证证据和审查者独立性。实现者不得自我批准；红队审查者可与核验者相同，但必须区别于实现负责人。

## 审查轴

并行核对正确性与边界、安全/滥用路径、架构依赖、测试有效性、发布/回滚、治理合规；涉及 UI 或外部契约时再核对浏览器运行时和契约证据。先报告 findings，按严重度给出位置、触发方式、影响和最小修复方向。

优先按 `code-review-and-quality` 的 OCR 检测和 fallback 获取第二视角；工具不可用时回退到独立人工审查，记录原因与未覆盖轴。`Critical`/`High` 必须修复；`Medium` 必须修复或完成结构化延期。证据、红区确认或必需审查轴缺失时结论不得为“批准”。

任务完成前将控制块中的 `红队审查者`、`红队审查包` 和 `红队审查结论` 与实际审查包同步；只有“批准”可通过治理门禁。
