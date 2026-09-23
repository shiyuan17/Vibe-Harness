# codegraph 仓库索引探索规则

codegraph 是项目内可选的仓库级代码知识图谱工具（Tier 3 Repository Index）。它把代码库索引成 SQLite 图谱，用于自然语言探索、多跳调用链和影响面分析，与 codebase-memory-mcp 同层分工。

本规则仅在 codegraph 插件或项目内等价工具已存在时生效；工具不存在时使用仓库搜索和直接文件阅读，不为普通定位任务停机。

## 工具选择

- 单点符号、跨文件语义图查询与架构速览交给已配置的 codebase-memory-mcp（见 `codebase-memory-mcp.md`）；多跳调用链、影响面（impact）和自然语言探索优先 codegraph。
- 新鲜度敏感的实时语义（Worktree 中未入索引的变更）使用 serena（见 `serena.md`）或直接源码阅读；codegraph 查询的是索引快照，不是工作区实时状态。
- 纯文本、配置、日志和未知语言使用 `rg`；结构化语法模式使用 ast-grep（见 `ast-grep.md`）。

## 使用顺序

1. 先用 `codegraph status` 查看索引新鲜度；索引陈旧时先按「资源预算」判断是否允许重建，默认不重建。
2. 在 Worktree 中工作时，先用 `git merge-base` 取基线，再用 `git diff --name-only <base>` 圈定与基线的变更集。
3. 默认入口是 `codegraph_explore`（上游默认只暴露该 MCP 工具）：以问题或符号名查询 Base Index，获取相关源码分组与调用路径。
4. 需要精确调用链或影响面时，使用 `codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_node`、`codegraph_search`；这些工具需通过 `CODEGRAPH_MCP_TOOLS` 显式启用。
5. 变更集内的文件以工作区实际内容为准（用 `rg` 和直接阅读核验），未变更部分信任索引；引用行号前必须回到源码核对。

## 资源预算（Tier 3）

- 默认使用 Base Index + Git Diff，不给每个 Worktree 重建完整知识图谱：所有 Worktree 共享主仓库索引，用第 2 步的变更集叠加索引结果。
- 禁止所有 Worktree 自动完整重建索引。只有满足以下条件之一、且 Git Diff 叠加仍不足以覆盖任务需要时，才允许显式重建：大量结构变化；调用关系明显变化；需要准确 impact analysis；主仓库索引已经无法代表当前代码。
- 索引任务默认串行：MAX_CONCURRENT_INDEX = 1。上游一个项目只允许一个 live MCP writer，该单写者锁就是共享索引的机制保障，不要绕过。
- 确需重建时在主仓库执行一次（如 `codegraph index --force` 或 `codegraph sync`），不在各 Worktree 内各自执行。
- Windows 与 WSL 不共享 `.codegraph` 目录（索引位于仓库根 `.codegraph/codegraph.db`），跨环境查询前先确认用的是哪份索引。

## 降级与证据

- 索引 stale 或缺失且不允许重建时，退回 `rg` + codebase-memory-mcp + `git diff` 变更集人工核对，并记录 `tool: codegraph`、索引状态、替代命令和覆盖限制。
- `codegraph_impact` 等影响面结论必须抽样回到源码核验后才可引用；索引结论不是完成证据。
- 不因 codegraph 无法安装而修改全局配置或 PATH；缺失时用可复现的文本搜索继续工作。

## 规范依据

- https://github.com/colbymchenry/codegraph
