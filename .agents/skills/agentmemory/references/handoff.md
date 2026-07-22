# Agentmemory 恢复

解析并规范化项目路径，调用 `memory_sessions`。按目录边界匹配 cwd，不使用裸字符串前缀；优先最近的 completed session。选定后先呈现未回答问题，再用 session 核心概念调用 `memory_recall`（limit 10），总结决策、文件、错误和下一步。

MCP 不可用时回退到授权 HTTP：`GET $AGENTMEMORY_URL/agentmemory/sessions` 与 `POST .../agentmemory/recall`，凭据从 `AGENTMEMORY_SECRET` 读取。仍不可用时使用本地 handoff，并明确未访问外部记忆。不得编造 observation；恢复后必须复核当前 Git 和文件状态。
