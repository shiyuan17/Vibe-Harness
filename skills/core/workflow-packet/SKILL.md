---
name: workflow-packet
description: 用于将工作归类为 Fast Path、Lightweight 或 Full，并收集验证证据。
---

# 工作流 Packet

选择主 workflow，叠加必要修饰器，确定档位，并记录证据。Full 工作需要 Red Team 和 review 证据。

## 触发条件

交付前或风险变化时使用。

## 输出

使用 `templates/workflow-packet.md`。

## 禁止项

不得降级 security、database、production、release 或红区工作。
