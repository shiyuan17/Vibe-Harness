---
name: code-navigation
description: Use before modifying or reasoning about existing code that spans files: locate symbols, trace call paths, and map impact. Not for single-file text, config, or log lookup, or already-located root causes.
---

# 跨文件代码上下文

在改动既有代码或解释其行为之前，建立可核对的符号、调用链和影响面上下文。本 Skill 使用宿主提供的 codebase-memory-mcp，不负责工具安装、配置、版本或索引缓存管理。

## 使用方式

1. 首先发现 deferred 的 codebase-memory MCP 查询工具；清单未展示不等于工具不可用。确实不可用时说明限制，回退 rg 与当前源码。
2. 用 `list_projects` 返回的根路径匹配当前工作区，使用实际注册标识；不猜目录名或 ID 算法，不默认共享主检出索引。用 `index_status` 检查可用性和实际提供的新鲜度信号。
3. 按问题选择单一入口：`search_graph` 定位符号，`trace_path` 追调用链，`get_file_outline` 取单文件声明大纲，`detect_changes` 辅助影响分析，`get_architecture` 获取架构；写 Cypher 前先用 `get_graph_schema` 取图结构定义，再按需使用 `query_graph`。
4. 候选路径明确后，调用 `check_index_coverage` 覆盖全部证据路径；否定或穷尽主张还须核对相关 scope、分页及动态关系限制。`ready`、空结果和未记录缺口不证明完整覆盖。
5. 用 `get_code_snippet` 或当前源码核对关键结论。覆盖缺失、陈旧、pending 或 unknown 时，以 rg 和直接阅读补齐对应范围；记录仍未覆盖的部分。

## 边界

- 已索引范围内的文本检索先用 `search_code`，索引外、配置和日志使用 rg；不为了完整流程运行无关图查询。
- 同一任务、同一工作区复用已核对的状态；源码、generation 或工作区变化时核对受影响范围。
- 不自动安装、升级、修改 MCP 配置或全量重建索引；查询失败不触发索引删除。
- 图结果是导航线索，行为主张必须有当前源码、测试或命令证据；未读完分页不得声称不存在、死代码或完整影响面。
- 只读查询、索引缓存操作、项目文件写入和删除索引按实际副作用分别处理，未知工具不整体放行。

同步归属：`docs/rules/codebase-memory-mcp.md`。

## 正反例

- 该用：改动跨多个文件，必须先定位符号、调用方或影响面再动手。
- 不该用：单文件文本、配置或日志查询（直接 rg）；根因或改动点已定位，只需按结论改一处。
- 工具不可用：宿主没有提供 codebase-memory-mcp，或索引未覆盖目标路径时，如实说明限制并回退 rg 与当前源码；不自动安装、升级或重建索引。
