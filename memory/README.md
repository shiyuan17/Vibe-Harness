# 本地 Agent Memory

本目录保存 Agent 工具和跨会话恢复所需的辅助记忆。只记录未来 session 仍有价值的观察与恢复线索，不保存 secret、token、凭据或临时闲聊。

若 full profile 安装了 `docs/memory/`，该目录保存项目的 durable governance truth（状态、架构、决策、缺陷、债务和失败护栏）。`.agents/memory/` 不得覆盖 `docs/memory/`、当前源码、测试结果或用户最新指令。

## 文件

- `CURRENT.md`：当前活跃上下文指针，跨 session 恢复的首选入口。
- `observations.md`：长期观察、项目陷阱、验证注意事项。
- `decisions.md`：已确认的架构、流程和协作决策。
- `sessions/`：需要跨 session 恢复的摘要或交接记录。

## 使用规则

正式架构决策统一记录在 docs/adr/。本地 decisions.md 只保存运行态恢复所需的简短决策，不替代正式 ADR。

- 只存非派生事实；以下内容可从仓库或工具直接读取，不记录：目录结构、依赖清单、代码模式、架构、文件路径、git 历史、调试方案、已存在于文档的内容。
- 写入前确认内容已验证，且不会泄露敏感信息。
- 记忆不能覆盖当前文件、测试结果或用户最新指令。
- 本地恢复时优先读 `CURRENT.md`，再按需读 observations、decisions 和 sessions。
- 发现记忆过期时，更新条目并说明新证据。
- 当上下文接近压缩边界或完成一个里程碑时，先写 `CURRENT.md` 检查点再做下一步。
- 单个记忆文件建议不超过 200 行；超过时按主题或时间拆分（如 `observations-2026Q3.md`），定期合并重复条目。审计方法见 agentmemory skill 的 [references/audit.md](../skills/agentmemory/references/audit.md)。
