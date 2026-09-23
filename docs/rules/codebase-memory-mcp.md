# codebase-memory-mcp

codebase-memory-mcp 是可选的代码语义图能力，用于跨文件符号关系、调用链、影响面和架构分析。本规则仅在插件或项目内等价工具已存在且当前任务需要其结构化能力时生效；只有显式选择 `--plugin codebase-memory-mcp` 才会安装项目内 runtime、项目级 MCP 受管块和本规则；未选择插件时不得假设工具存在。不得修改全局 Agent 或 MCP 配置，也不得以语义图替代源码、测试和命令证据。

## 单一入口与缓存位置

- 入口只有一个：宿主 MCP 服务器 `codebase-memory-mcp`，或项目内 `node .agents/runtime/commands/run.mjs codebase-memory <status|refresh> --project . --json`。两者都经过同一个项目 runtime wrapper，因此必然读写同一张图。
- 缓存位于用户私有目录（Windows 为 `%LOCALAPPDATA%\vibe-harness\codebase-memory-mcp\<project-slug>`，其他平台为 XDG cache 下的等价路径），不在仓库内。不要把它移回仓库：0.11.0 拒绝路径链上存在不受信身份写权限的缓存目录，`C:\` 这类根目录默认继承 `Authenticated Users:(M)`，仓库内缓存会直接失败并报 `CBM_CACHE_DIR_NOT_PRIVATE`；修 ACL 不是解法，换私有目录才是。
- 受管 MCP 环境固定 `CBM_MEM_BUDGET_MB=2048` 与 `CBM_WORKERS=2`，并保持 `auto_index`、`auto_watch` 关闭：新鲜度由状态戳加按需 refresh 保证，不靠后台重复索引。
- linked worktree 的索引与查询映射到主检出，`status` 同时返回 `sourceRoot`。图只覆盖主检出已提交的内容，worktree 未提交的新文件与新符号不在图中，必须用 `rg` 补充核验。
- 与 codegraph 同属 Tier 3 仓库索引层：单点符号、语义图查询与架构速览用本工具，多跳调用链、影响面与自然语言探索优先 codegraph（见 `codegraph.md`）。Worktree 场景默认共享主检出索引并叠加 `git diff` 变更集，不为每个 Worktree 重建知识图谱。
- `vibe-harness doctor` 与 `vibe-harness validate --project .` 报告缓存位置、状态戳新鲜度与存在的陈旧副本；`uninstall` 与 `rollback` 在项目 runtime 离开后清理该项目的私有缓存目录。陈旧副本只被报告、不被自动删除，是否清理由人确认。

## 使用顺序

1. 先运行 `node .agents/runtime/commands/run.mjs codebase-memory status --project . --json` 取 `fresh`、`stale` 或 `missing`。判据是状态戳记录的 HEAD 与当前 HEAD 是否一致，`missing` 也可能表示"有图但没人记录它覆盖哪个提交"。
2. 任务确实需要语义图且状态不是 `fresh` 时，运行 `node .agents/runtime/commands/run.mjs codebase-memory refresh --project . --write` 重建索引并刷新状态戳；纯文本任务可以直接用 `rg` 推进。
3. 用 `search_graph` 定位精确符号，用 `trace_path` 追踪实际调用链，用 `detect_changes` 评估改动影响面，需要全局结构时用 `get_architecture`。
4. `index_status` 的 `ready` 只说明图可读，`indexed_at` 才是快照时间；不要把 `ready` 当成新鲜度证据，也不要用它替代第 1 步。
5. 结论必须回到 `get_code_snippet`、`search_code` 或直接读取源码核验，工具结果只是导航线索。

## 工具面与放行边界

锁定版本 0.11.0 暴露 17 个 MCP 工具：`index_repository`、`search_graph`、`query_graph`、`trace_path`、`get_code_snippet`、`get_file_outline`、`get_graph_schema`、`compare_graphs`、`get_architecture`、`search_code`、`list_projects`、`delete_project`、`index_status`、`check_index_coverage`、`detect_changes`、`manage_adr`、`ingest_traces`。

- 只读查询（含 `trace_path`、`index_status`、`check_index_coverage`、`detect_changes`）以及 `index_repository`、`ingest_traces` 直接放行；后两个只重写工具自己的图缓存，可重复执行且不触碰项目文件。
- `manage_adr` 写项目文件，按 workspaceWrite 处理，需要 Execution Envelope；`delete_project` 会删除整个项目索引，属高风险，默认拒绝。
- MCP 不可用时的 CLI 等价写法：`cli list_projects --json` 列出已知项目，`cli index_status --project <name> --json` 取状态与 `indexed_at`，`cli check_index_coverage --project <name> --paths <path> --json` 取覆盖。全部经由项目 runtime wrapper 执行，不要直接调用全局安装的 `codebase-memory-mcp`。

## 降级与证据

- MCP 不可用、索引失败、状态为 `stale` 或 `missing`，或结果与源码冲突时，说明缺少代码图能力并退回 `rg` 与直接文件阅读；记录工具名、状态、替代命令和覆盖限制。
- 语义图不是完成证据；行为主张必须由源码、测试、命令输出或实际产物支持。
- 不删除其他项目的索引，不在未获授权时执行跨项目索引或 ADR 写入。
- 索引验证失败按 degraded 处理，不因图不可用而放宽验收标准，也不静默跳过。

## 规范依据

- https://github.com/DeusData/codebase-memory-mcp

## 记忆联动

- 调用 `detect_changes` 取得近期变更路径后，若变更路径落在记忆条目的关联文件、适用范围或影响范围字段，提示复核对应记忆条目。
- 记忆条目的关联路径建议用 glob 或路径列表，便于与变更结果交叉比对。
- 此联动为导航线索，非完成证据；复核结果以当前源码、测试和命令输出为准。
