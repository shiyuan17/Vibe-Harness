---
name: workflow-packet
description: 用于将工作归类为 `Fast Path`、`Lightweight` 或 `Full`，并收集验证证据。
---

# 工作流交付包

选择主工作流，叠加必要修饰器，确定档位，并记录证据。完整流程（`Full`）工作需要 Red Team 和审查证据。

## 触发条件

交付前或风险变化时使用。

## 输出

使用 `templates/workflow-packet.md`。

## 禁止项

不得降级安全、数据库、生产、发布或红区工作。不得将触发完整流程（`Full`）的任务降级为轻量流程（`Lightweight`）；如果任务同时满足多个档位，选择更高档位，不确定时先按更高档位处理。
