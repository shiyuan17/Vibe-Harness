# CodeGraph

CodeGraph 是可选的本地代码索引。只有目标仓库根目录存在 `.codegraph/` 时才使用；没有该目录时直接跳过，不要擅自初始化。

## 前置条件

- 若 `codegraph` 命令不存在，先运行 `loopengine codegraph install-cli` 安装 CLI。
- 如需配置 Codex MCP，只查看配置片段：`codegraph install --print-config codex`。
- LoopEngine 不自动写入全局 Agent 配置，不自动运行 `codegraph init`。

## 使用顺序

- 理解或定位代码前，若 `.codegraph/` 存在，优先使用 CodeGraph。
- MCP 可用时优先使用 CodeGraph MCP 工具获取上下文。
- Shell fallback 使用 `codegraph context "<task>"`、`codegraph query "<symbol>"`、`codegraph files`。
- 索引缺失、过期或命令失败时，退回普通文件搜索和阅读，并在交付中说明。

