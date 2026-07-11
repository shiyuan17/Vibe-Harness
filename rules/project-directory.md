# 项目目录规则

项目目录规则记录所有权和依赖方向，让 Agent 能定位正确变更边界，而不是临时发明新结构。

## 发现顺序

1. 读取仓库入口指令；存在当前状态和架构文档时一并读取。
2. 检查 package/workspace manifest、构建入口、adapter 和模块索引。
3. `codebase-memory-mcp` 可用时确认索引状态并用于结构化定位；否则使用仓库搜索。
4. 编辑前确认最近的测试和验证命令。

## 放置规则

- Put domain behavior with the domain that owns its state and interfaces.
- Shared directories contain capabilities proven reusable by multiple consumers, not convenient dumping grounds.
- Adapters translate between external and internal contracts; they do not own business rules.
- Generated, vendored, build, cache, evidence, and temporary directories are not source ownership locations.
- New top-level directories require an architecture reason, an owner, and documentation of dependency direction.

## 跨边界变更

变更跨模块、package、仓库或服务时，列出每个 owner 和接口，识别兼容与回滚策略，并验证两侧。所有权仍不清晰时停在澄清阶段，不把逻辑散落到多层。

## 完成标准

只有当新增和修改文件都位于声明的所有权边界内、import 遵循预期方向、测试能证明受影响消费者时，变更才算完成。
