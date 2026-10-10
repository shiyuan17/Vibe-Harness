---
name: code-navigation
description: Use before modifying or reasoning about existing code that spans files: locate symbols, trace call paths, and map impact. Not for single-file text, config, or log lookup, or already-located root causes.
---

# 跨文件代码上下文

在改动既有代码或解释其行为之前，把「谁调用谁、这次改动会影响谁」变成可核对的上下文。本 Skill 负责把仓库级语义工具接进来，并给出工具不可用时的降级路径；它不改变授权、安全边界和证据标准。

## 触发

- 需要跨文件定位符号、定义、引用或实现。
- 需要追多跳调用链、影响面或架构概览。
- 准备修改既有代码，但还不确定调用方与被影响范围。
- 单文件文本、配置、日志检索不需要本 Skill，直接用 rg；已经定位到根因的修复也不需要。

## 首次调用：先让工具可见

宿主可能把下列 MCP 工具标记为 deferred，首轮工具清单里看不到。看不到时先按名加载再调用，不要因为「清单里没有」就退回纯文本检索：

1. 按名加载，例如用 tool_search 查询 "codegraph_explore serena find_symbol probe search codebase-memory search_graph"。
2. 加载成功后再按下面的分工调用；某工具确实不存在时按「降级与证据」处理，不假装调用。

## 工具分工

- 仓库级、多跳调用链与自然语言探索：codegraph 的 codegraph_explore（默认入口）。
- 实时符号、引用、定义与类型解析：serena 的 find_symbol / find_referencing_symbols / find_implementations。
- 意图式「找做某事的代码」：probe 的 search。
- 跨文件符号关系、调用链与改动影响面：codebase-memory 的 search_graph / trace_path / detect_changes。

分工、预算与边界以既有规则为准：docs/rules/codegraph.md、docs/rules/serena.md、docs/rules/probe.md、docs/rules/codebase-memory-mcp.md。结构化语法模式用 ast-grep（docs/rules/ast-grep.md），高噪声命令输出压缩用 rtk（docs/rules/rtk.md）；这两项不由本 Skill 接管。

## 降级与证据

- 工具不可用、索引 stale 或 missing、结果与源码冲突时，说明缺少代码图能力并回退到 rg 与直接文件阅读。
- 回退时记录工具名、状态、替代命令与覆盖限制；不假装调用，也不把「工具缺失」当作源码证据。
- 图关系与摘要是导航线索，不是行为证据；行为主张必须回到源码、测试或命令输出核验。
