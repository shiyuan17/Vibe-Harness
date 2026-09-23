# serena 语义符号导航规则

serena 是项目内可选的语言服务器（LSP）语义工具（Tier 2 Semantic / LSP）。它通过语言后端提供 symbol、references、definition、type resolution 等实时语义查询，支持 40+ 语言；定位是新鲜度敏感的实时语义导航，不是仓库级索引。

本规则仅在 serena 插件或项目内等价工具已存在时生效；工具不存在时使用仓库搜索和直接文件阅读，不为普通定位任务停机。

## 工具选择

- 仅在需要 symbol、references、definition、type resolution 时启用 serena；文本定位与目录遍历由 `rg`、`fd` 覆盖，结构化语法模式由 ast-grep（见 `ast-grep.md`）覆盖，不重复调用 serena。
- 新鲜度敏感的实时语义（Worktree 中未入索引的变更）用 serena；已入索引的架构、多跳调用链与影响面用 Tier 3 仓库索引（codegraph、codebase-memory-mcp，见 `codebase-memory-mcp.md`），不为单点定义查询触发索引重建。

## 使用顺序

1. symbol 定位用 `find_symbol`，符号全景用 `get_symbols_overview`，精确引用与实现用 `find_referencing_symbols`、`find_implementations`、`find_declaration`。
2. 诊断信息用 `get_diagnostics_for_file` / `get_diagnostics_for_symbol`；文件级操作用 `read_file`、`find_file`、`list_dir`；文本模式用 `search_for_pattern`。
3. 大范围探索先用 `get_symbols_overview` 收窄再取引用，不要对整个仓库逐文件调用符号查询。
4. LSP 结果反映工作区当前状态，引用前仍须回到源码确认上下文与行号。

## 资源预算（Tier 2）

- 仅在需要 symbol、references、definition、type resolution 时启用；同时激活 ≤ 2 个 Worktree，完成 Symbol 分析后释放不再需要的实例。
- LSP 实例按需启动、用完释放，不在空闲会话中常驻，不与 Tier 3 索引任务并行争用资源。

## 写入边界

- serena 的符号级编辑工具（`replace_symbol_body`、`insert_after_symbol`、`insert_before_symbol`、`rename_symbol`、`safe_delete_symbol` 等）以及文件写入工具不作为首选写入路径；写入走宿主原生编辑与项目内既定受管流程。
- `execute_shell_command` 不因 serena 存在而获得任何放行，仍按宿主执行边界处理。

## 降级与证据

- 语言后端不可用、LSP 启动失败或结果与源码冲突时，退回 `rg` 与直接文件阅读，并记录 `tool: serena`、语言、状态、替代命令和覆盖限制。
- 语义查询结果只是导航线索；行为主张必须由源码、测试、命令输出或实际产物支持。

## 规范依据

- https://github.com/oraios/serena
- 上游安装方式为 `uv tool install -p 3.13 serena-agent`，且上游警示不要经 marketplace 安装。
