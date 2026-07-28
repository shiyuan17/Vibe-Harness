---
name: systematic-debugging
description: Use for bugs or failures without a proven cause—not known fixes.
---

# 系统定位故障

先证明根因，再修改代码。

## 执行

1. 稳定复现症状，记录最小输入、环境、期望和实际结果。
2. 定位直接失败点，并沿数据或调用链追踪到最早错误状态。
3. 提出一个可证伪假设；一次只改变一个变量并收集证据。
4. 用失败测试或最小复现固定问题，实施最小修复。
5. 运行聚焦回归及相关套件，确认测试没有弱化。

怀疑测试顺序污染时运行 `find-polluter.sh <test-command> <candidate...>`；不要用固定 sleep、批量猜改或重复尝试掩盖未知根因。

## 交付

报告复现、根因证据、最小修复、回归结果和仍未排除的风险。
