---
name: runtime-cross-repo-rollout
description: Use when a feature spans multiple repositories or services and must be proven through real runtime contracts end to end.
---

# 跨仓运行时落地

## 前置

识别所有仓库、目标分支、写入权限、脏工作区、契约真值、部署边界和回滚负责人。跨仓、权限、数据或发布工作按高风险处理。

## 执行

1. 用 `api-contract-check` 锁定字段、状态、错误、权限和兼容策略。
2. 按仓库划分写入范围、依赖顺序、独立验证和 merge-back 责任。
3. 先验证提供方契约，再接线消费方；不以 mock 通过代替真实接口证据。
4. 收集接口、日志、测试和必要的浏览器证据。
5. 在最终集成位置运行端到端验证并确认回滚路径。

浏览器工具不可用时回退到人工运行步骤并明确缺口。任一仓库无授权、契约冲突或最终集成未闭环时标记阻塞，不宣称完成；完成声明使用 `verification-before-completion`。
