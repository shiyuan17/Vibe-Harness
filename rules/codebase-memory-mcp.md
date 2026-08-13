# codebase-memory-mcp

codebase-memory-mcp 是可选的代码结构与影响分析能力。只有显式选择 <code>--plugin codebase-memory-mcp</code> 时才安装对应 runtime、项目级 MCP 受管块和本规则；未选择插件时不得假设工具存在。工具存在时，索引验证失败必须标记为 degraded。不得修改全局 Agent 或 MCP 配置，也不得以该能力替代源码和测试证据。

## 适用边界

本规则仅在插件或工具已存在且当前任务需要其结构化能力时生效。插件不存在时使用 <code>rg --files</code>、<code>rg</code> 和直接文件阅读，并明确说明缺少代码图能力。

## 工具选择

- 仅在任务需要跨文件符号关系、实际调用链、架构、数据流或改动影响时使用语义图；单文件语法模式使用项目内 ast-grep，纯文本、配置和日志使用 <code>rg</code>。
- 需要语义图时先调用 <code>list_projects</code> 与 <code>index_status</code>；索引缺失或过期且当前任务确实需要时才调用 <code>index_repository</code>。
- 使用 <code>search_graph</code> 定位精确符号，再调用 <code>get_code_snippet</code> 或固定版本 0.9.0 的 <code>trace_call_path</code>。不得引用新版本独有工具名替代锁定接口。
- 不自动删除其他项目索引，不执行未授权的跨项目索引或 ADR 写入。RTK 不得包装 MCP runtime 或协议流量。

## 使用顺序

1. MCP 工具可用时，先用 <code>list_projects</code> 和 <code>index_status</code> 确认当前仓库索引状态。
2. 当前仓库未索引或索引过期，且任务需要结构化上下文时，使用 <code>index_repository</code> 更新索引。
3. 定位符号和关系时使用 <code>search_graph</code>；追踪调用链时使用 <code>trace_call_path</code>；评估改动影响时使用 <code>detect_changes</code>。
4. 需要全局结构时使用 <code>get_architecture</code>，具体实现仍以 <code>get_code_snippet</code>、<code>search_code</code> 或直接读取源码核验。

## 降级与证据

- MCP 不可用、索引失败或结果与源码冲突时，明确说明缺少代码图能力，并退回仓库搜索和直接文件阅读。
- MCP 结果是导航线索，不是完成证据；行为主张必须由源码、测试、命令输出或实际产物支持。
- 不删除其他项目索引，不在未获授权时执行跨项目索引或 ADR 写入。

## 规范依据

- https://github.com/DeusData/codebase-memory-mcp

## 记忆联动

- 调用 <code>detect_changes</code> 取得近期变更路径后，若变更路径落在记忆条目的关联文件、适用范围或影响范围字段，提示复核对应记忆条目。
- 记忆条目的关联路径建议用 glob 或路径列表，便于与变更结果交叉比对。
- 此联动为导航线索，非完成证据；复核结果以当前源码、测试和命令输出为准。
