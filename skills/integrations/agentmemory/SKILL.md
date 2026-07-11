---
name: agentmemory
description: 管理 agentmemory skill 家族入口，或需要选择记忆保存、检索、恢复、遗忘和 session 历史能力时使用。
---

# Agentmemory 集成

agentmemory skill 家族用于保存、检索、恢复和解释跨 session 的项目记忆。按具体意图使用 `handoff`、`recall`、`remember`、`forget`、`recap` 或 `session-history`。

先检测 agentmemory MCP；不可用时可使用已配置且获授权的 HTTP API。两者均不可用时回退到 `.agents/memory/` 和当前仓库事实，并明确没有访问外部记忆。

提交历史查询直接走本入口：需要历史列表时解析 `branch`、`repo`、`limit` 后调用 `memory_commits`，HTTP 回退为 `GET $AGENTMEMORY_URL/agentmemory/commits`，query 必须 URL 编码并从 `AGENTMEMORY_SECRET` 读取凭据。需要提交上下文时先用 `git blame -L`、`git log -L` 或 `git log -n 1 -- <file>` 定位完整 SHA，再调用 `memory_commit_lookup`，HTTP 回退为 `GET $AGENTMEMORY_URL/agentmemory/session/by-commit?sha=<encoded-sha>`；必要时用 `memory_recall` 获取高重要度 observation。展示 commit 关联时必须用本地 `git show` 复核，Git 或 agentmemory 不可用时只报告实际可得事实，不得编造关联或意图。

本地记忆库默认位于 `.agents/memory/`：

- `observations.md` 保存长期观察、陷阱和验证注意事项。
- `decisions.md` 保存已确认的长期决策。
- `sessions/` 保存需要跨 session 恢复的摘要或交接记录。

记忆只能辅助恢复上下文；当前文件、Git 状态、测试输出和用户最新指令始终优先。
