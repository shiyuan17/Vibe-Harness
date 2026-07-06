# LoopEngine v1 抽取计划

## 摘要

从通用化后的协作规则、任务生命周期、workflow packet、skills 和安装器行为中，创建一套内部可复用的 Codex governance 包。

## 阶段

1. 冻结 v1 边界和成功标准。
2. 盘点源治理资产并识别脱敏需求。
3. 搭建独立项目骨架。
4. 将规则通用化为 reusable core。
5. 打包 skills 和 workflow profiles。
6. 实现 Codex adapter 和默认 dry-run 的安装器。
7. 增加验证测试和脱敏检查。
8. 编写用户文档、示例和发布说明。

## 验证

- 单测覆盖安装计划、冲突、红区阻断、manifest 源文件、adapter 映射和脱敏检查。
- `pnpm check` 作为发布门禁。
- 手工 smoke：安装 dry-run 到空目录并检查计划文件。
