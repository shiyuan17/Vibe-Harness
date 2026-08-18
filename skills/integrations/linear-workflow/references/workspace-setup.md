# Linear Workspace 配置清单

本清单供 Workspace/Team 管理员手工配置，不授权 Agent 直接创建或修改外部配置。

## Workflow

为每个参与团队配置固定状态：Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done。不要创建 Blocked 状态；使用 blocked-by / blocks 关系。

默认分支流为 <code>feat/*、fix/* → develop → main</code>，hotfix 为 <code>hotfix/* → main → develop</code>。GitHub 默认分支设为 <code>develop</code>，release-please 明确固定 <code>target-branch: main</code>；普通开发 Issue 合入 <code>develop</code> 后即 Done，发布等待由独立 Release Issue 跟踪。

关闭 Linear 的 Parent/Sub-issue 自动关闭。write 子任务仍须由 closing PR/MR 合并证明完成，aggregate Parent 仍须通过 Fan-in Verification；任何子任务状态变化都不得绕过这些条件。

Triage 建议开启 priority-before-exit，使 Issue 离开 Triage 前必须设置 Priority；Triage Rules 自动路由属可选配置。

## Triage

Triage 是团队收件箱，进入的 Issue 默认不进入常规视图，必须经四动作之一处置：

- accept：确认需要处理，移入团队默认状态（Backlog 或 Todo，Todo 仍须满足 Definition of Ready）。
- duplicate：合并到 canonical Issue，本 Issue 置为 canceled 类。
- decline：不处理，置为 canceled 类并附说明。
- snooze：暂时隐藏，到指定时间或有新活动时返回 Triage。

可选的 Triage Responsibility 和 Triage Rules 只能做团队定义的收件与路由，不得自动选择 Ready Queue、设置 Agent Delegate、写 Execution Receipt 或启动执行。四种处置仍需人工决定。

## Guidance

- Linear 保存工作状态、责任和原生依赖；GitHub 或 GitLab 保存代码、PR/MR、检查与合并状态。
- 人类 Assignee 保持结果责任；Delegate/App User 表示 Agent 产品身份；Execution Receipt 表示具体运行实例；Activity Feed 保存委派历史。
- Todo 必须通过 AI Coding Task 的 Definition of Ready。
- 禁止自动领取：只执行用户明确要求的具体 Issue，或已委派给当前 Agent 且由宿主显式启动的 Issue。
- Parent/Sub-issue 只表示分解，blocked-by / blocks 才表示执行依赖，related 永不表示依赖。
- Reviewer 和 Verifier 只读，不登记 Receipt 或修改 Delegate。
- 每个 Issue 的 Target branch 填写可解析的精确远端 ref；“默认分支”只有确为实现基线时才有效。分支格式为 <type>/<ISSUE-ID>-<slug>，worktree 位于仓库同级的 <repo>-worktrees/<ISSUE-ID>。commit 使用 <code>Refs &lt;ISSUE-ID&gt;</code>，closing GitHub PR 或 GitLab MR 使用 <code>Fixes &lt;ISSUE-ID&gt;</code>；只有提供方配置且创建后重读确认的等价语法才可替代。
- 普通功能和修复使用 <code>origin/develop</code>；hotfix 使用 <code>origin/main</code>。顺序执行且工作区干净时允许当前 clone 的任务分支；并发、脏工作区或需要隔离时使用仓库外 worktree。
- 发布使用 release-issue.md 的 aggregate 模板。<code>develop → main</code> 与 <code>main → develop</code> PR 使用 <code>Refs &lt;ISSUE-ID&gt;</code>，不得再次 closing 已完成开发 Issue。
- 建议开启“复制分支名即移入 Started 状态”，使分支创建自记录为 In Progress。
- 状态自动化和 Agent 手工回写都不得用旧计划覆盖实时状态。手工写入按“读 -> 校验转换 -> 写 -> 重读”执行；后退或纠错需单独授权和原因，不得把 In Progress、In Review 或 Ready to Merge 退回 Todo 以恢复 Ready 统计。
- write 节点 Done 只在 closing PR/MR 合并到声明的精确目标 ref 后成立；aggregate Parent 还需全部必需节点成功和 Fan-in Verification 通过。

## Agent 身份回退

优先使用原生 Delegate/App User。若客户端不支持 Delegate，只允许管理员预先创建低基数、稳定的 agent:<agent-key> 与 role:writer 标签。不得为 execution、runtime、thread 或 session 创建实例级标签，也不得由 Agent 临时创建 fallback 标签。

已有其他 Delegate、其他 agent label 或未终结活动 Receipt 时，Agent 不得覆盖；必须由人工核对工作状态后显式释放或交接。不要配置自动超时、自动回收或自动重派。

## GitHub / GitLab Automation

每个团队分别配置：

- 开始分支或实现活动 -> In Progress。
- Draft PR -> In Progress。
- PR/MR ready for review / review requested -> In Review。
- GitHub/GitLab 报告 stable and mergeable -> Ready to Merge。
- closing PR/MR merged to the declared exact target ref -> Done。
- 添加 branch-specific automation：普通开发只在目标为 <code>develop</code> 时推进开发 Issue；hotfix 只在目标为 <code>main</code> 时推进；发布提升和回同步不得使用开发 Issue 的 closing 语义。
- 启用 branch protection、required review 和 required checks，否则 Ready to Merge 不可靠。

GitHub/GitLab automation 只推进代码状态，不创建或终结 Execution Receipt，也不自动关闭 aggregate Parent。创建 PR/MR 前必须校验 target 与声明 ref 相同，且 source HEAD 对目标 ref 的 merge-base 与冻结 base SHA 一致或为其在同一目标历史上的已验证后代；创建后重读确认 source、target、描述和 closing 关联。

## Custom Views

1. AI Ready Queue：Status = Todo 且没有 blocked-by；仅供人类查看或显式选择，Agent 不自动扫描或领取。
2. AI Working：Status = In Progress，并按 Delegate 或 agent:* 分组。
3. Review Queue：Status = In Review，Priority 降序、Updated 升序。
4. Human Decisions：label = needs:decision。
5. Blocked：存在 blocked-by 关系。

推荐 Writer In Progress 不超过 3，In Review 不超过 2。

## GitHub 分支与发布设置

- <code>develop</code>：只接受短期任务分支，普通 PR 使用 squash merge；低/中风险通过聚焦 CI 后可由作者启用 auto-merge，高风险要求至少一个非作者审批。
- <code>main</code>：只接受同仓库的 <code>develop</code>、<code>hotfix/*</code> 和 <code>release-please--branches--main*</code>；运行完整发布门禁。
- <code>develop → main</code> 与 <code>main → develop</code> 使用 merge commit，保留任务提交和版本回同步历史。
- GitHub Release 成功后创建 <code>main → develop</code> 回同步 PR；检查通过后 auto-merge。失败时 Release Issue 保持未完成并报告分支漂移。
- 保留按需发布并设置每周或双周兜底窗口；发布等待不阻塞开发 Issue。

## MCP

- Writer/Orchestrator：https://mcp.linear.app/mcp
- Reviewer/Verifier：https://mcp.linear.app/mcp/readonly

认证由各宿主原生 OAuth 流程完成。不要把 Token、API key 或 OAuth 凭据写进项目文件。

Git credential helper 只用于其配置的 Git transport。不得提取或转用 helper 输出登录网页/API；该用途需要独立凭据与外部写入授权。credential query、包装脚本或其他辅助文件不得写入仓库或 worktree。

Codex、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 由安装器生成项目配置，随后在宿主内触发 Linear OAuth。Claude 可在项目目录运行 claude mcp add --transport http --scope project linear-server ENDPOINT，其中 ENDPOINT 使用上方与角色匹配的 URL。Gemini 按当前官方宿主文档在项目级 MCP 设置中加入对应 endpoint；不要退回用户级或全局配置。
