# codebase-memory-mcp

`codebase-memory-mcp` 是可选的代码结构与影响分析能力。LoopEngine 只提供项目内使用规则，不安装服务；不得修改全局 Agent 或 MCP 配置，也不得以该能力替代源码和测试证据。

## 使用顺序

1. MCP 工具可用时，先用 `list_projects` 和 `index_status` 确认当前仓库索引状态。
2. 当前仓库未索引或索引过期，且任务需要结构化上下文时，使用 `index_repository` 更新索引。
3. 定位符号和关系时使用 `search_graph`；追踪调用链时使用 `trace_call_path`；评估改动影响时使用 `detect_changes`。
4. 需要全局结构时使用 `get_architecture`，具体实现仍以 `get_code_snippet`、`search_code` 或直接读取源码核验。

## 降级与证据

- MCP 不可用、索引失败或结果与源码冲突时，明确说明缺少代码图能力，并退回 `rg --files`、`rg` 和直接文件阅读。
- MCP 结果是导航线索，不是完成证据；行为主张必须由源码、测试、命令输出或实际产物支持。
- 不删除其他项目索引，不在未获授权时执行跨项目索引或 ADR 写入。
