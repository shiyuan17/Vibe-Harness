---
name: runtime-cross-repo-rollout
description: Use for coordinated contracts and rollout across repositories—not modules in one repo.
---

# 落地跨仓运行时变更

## 执行

1. 识别所有仓库、授权、脏工作区、契约真值、部署边界和回滚责任人。
2. 固定生产者与消费者的字段、状态、错误、权限及兼容策略。
3. 按依赖顺序划分写入范围和独立验证；先证明提供方，再接线消费方。
4. 收集两侧测试、真实接口和最终集成位置的运行证据。
5. 在最终组合上验证成功、失败与回滚路径。

任一仓库缺少授权或存在契约冲突时按 governance-core 暂停受影响操作及依赖，继续可隔离的已授权工作。集成证据缺失时继续可行的验证或报告具体阻塞；mock 或单仓测试不能证明跨仓完成。
