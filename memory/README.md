# 本地 Agent Memory

本目录保存 Agent 工具和跨会话恢复所需的辅助记忆。只记录未来 session 仍有价值的观察与恢复线索，不保存 secret、token、凭据或临时闲聊。

若 full profile 安装了 `docs/memory/`，该目录保存项目的 durable governance truth（状态、架构、决策、缺陷、债务和失败护栏）。`.agents/memory/` 不得覆盖 `docs/memory/`、当前源码、测试结果或用户最新指令。

## 文件

- `observations.md`：长期观察、项目陷阱、验证注意事项。
- `decisions.md`：已确认的架构、流程和协作决策。
- `sessions/`：需要跨 session 恢复的摘要或交接记录。

## 使用规则

- 写入前确认内容已验证，且不会泄露敏感信息。
- 记忆不能覆盖当前文件、测试结果或用户最新指令。
- 发现记忆过期时，更新条目并说明新证据。
