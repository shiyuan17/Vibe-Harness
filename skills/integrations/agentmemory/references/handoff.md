# Agentmemory 恢复

跨 session 恢复按以下优先级选择路径，逐级回退。恢复后必须复核当前 Git 和文件状态，不得编造 observation。

## 路径 A：MCP 可用

1. 解析并规范化项目路径。
2. 调用 `memory_sessions`；按目录边界匹配 cwd，不使用裸字符串前缀；优先最近的 completed session。
3. 选定后先呈现未回答问题，再用 session 核心概念调用 `memory_recall`（limit 10）。
4. 总结决策、文件、错误和下一步。

## 路径 B：HTTP 回退

MCP 不可用时回退到授权 HTTP：`GET $AGENTMEMORY_URL/agentmemory/sessions` 与 `POST .../agentmemory/recall`，凭据从 `AGENTMEMORY_SECRET` 读取。

## 路径 C：本地 handoff

MCP 与 HTTP 均不可用时使用本地 handoff：

1. 优先读本地记忆库的 `CURRENT.md` 获取活跃上下文指针。
2. `CURRENT.md` 缺失或信息不足时，按 `sessions/` 倒序找最新记录补齐。
3. 明确未访问外部记忆。

## 漂移核验

- 所有时间引用使用绝对日期（YYYY-MM-DD），不得使用"今天/昨天/下周"等相对表达。
- 若 `CURRENT.md` 的 `最后验证` 超过 1 天，恢复后必须先核验当前 Git 状态和文件状态再采信记忆内容；记忆是时间点观察，非实时状态。
- 不得编造 observation；恢复后必须复核当前 Git 和文件状态。
