# Linear Workspace 配置清单

本清单供 Workspace/Team 管理员手工配置，不授权 Agent 直接创建或修改外部配置。

## Workflow

为每个参与团队配置固定状态：Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done。不要创建 Blocked 状态；使用 blocked-by / blocks 关系。

## Guidance

- Linear 保存工作状态，GitHub 保存代码状态。
- 人类 Assignee 保持结果责任；优先通过 Delegate 指定 Agent。
- Todo 必须通过 AI Coding Task 的 Definition of Ready。
- V1 只执行显式引用或已委派 Issue，不自动领取 Ready Queue。
- Reviewer 和 Verifier 只读。
- 分支格式为 <type>/<ISSUE-ID>-<slug>，worktree 位于仓库外。
- Done 只在 closing PR 合并到目标默认分支后成立。

## GitHub Automation

每个团队分别配置：

- 开始分支或实现活动 -> In Progress。
- Draft PR -> In Progress。
- PR ready for review / review requested -> In Review。
- GitHub 报告 stable and mergeable -> Ready to Merge。
- closing PR merged to target default branch -> Done。
- 启用 branch protection、required review 和 required checks，否则 Ready to Merge 不可靠。

## Custom Views

1. AI Ready Queue：Status = Todo 且没有 blocked-by。
2. AI Working：Status = In Progress，并按 Delegate 或 agent:* 分组。
3. Review Queue：Status = In Review，Priority 降序、Updated 升序。
4. Human Decisions：label = needs:decision。
5. Blocked：存在 blocked-by 关系。

推荐 Writer In Progress 不超过 3，In Review 不超过 2。

## MCP

- Writer/Orchestrator：https://mcp.linear.app/mcp
- Reviewer/Verifier：https://mcp.linear.app/mcp/readonly

认证由各宿主原生 OAuth 流程完成。不要把 Token、API key 或 OAuth 凭据写进项目文件。

Codex、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 由安装器生成项目配置，随后在宿主内触发 Linear OAuth。Claude 可在项目目录运行 claude mcp add --transport http --scope project linear-server ENDPOINT，其中 ENDPOINT 使用上方与角色匹配的 URL。Gemini 按当前官方宿主文档在项目级 MCP 设置中加入对应 endpoint；不要退回用户级或全局配置。
