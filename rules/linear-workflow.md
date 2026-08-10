# Linear 多 Agent 工作流

Linear 保存工作状态、责任和依赖；GitHub 保存代码、提交、PR、检查与合并状态。不得把 Agent 的自报完成当作代码或工作完成证据。

## 工作单元与责任

- 只有叶子 Issue 才是实现单元。一个叶子 Issue 对应一个实现 Agent、一个仓库外 worktree、一个命名分支和一个 closing PR。
- 人类 Assignee 对结果负责，原生 Agent Delegate 负责执行。不支持 Delegate 时才用 agent:* 和 role:* 标签记录执行者与角色。
- Reviewer 和 Verifier 可以核验同一 Issue 或 PR，但默认只读，不取得实现所有权，不修改 Linear、代码、分支或验收条件。
- V1 只处理用户明确引用或已经委派给当前 Agent 的 Issue，不从 Ready Queue 自动领取任务。

## 固定状态

团队使用以下状态名和含义：

1. Triage：新输入，尚未确认是否进入计划。
2. Backlog：确认需要处理，但尚未满足近期执行条件。
3. Todo：满足 Definition of Ready 且没有未解决的 blocked-by 关系，可以立即执行。
4. In Progress：实现者已经开始工作，命名分支和 worktree 已创建；Draft PR 仍保持此状态。
5. In Review：PR 已退出 Draft 并进入审查。
6. Ready to Merge：受保护分支要求的 review、CI、契约检查和必要 E2E 均通过。
7. Done：closing PR 已合并到目标默认分支。

Blocked 不是状态。使用 Linear 的 blocked-by / blocks 关系；阻塞解除后关系转为 related。Canceled、Duplicate、Won't Fix 和 Could not reproduce 使用 canceled 类结果状态。

## Definition of Ready

Todo Issue 必须同时包含 Goal、Context、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies 和 Verification。Dependencies 必须明确写出无依赖或列出关系，Verification 必须给出可重复命令或可观察检查。

任一字段缺失、Contract 有歧义、blocked-by 未解决、所需仓库或目标分支不明时不得开始实现。需要人类产品、架构、权限或风险决定时添加 needs:decision，写明选项和阻塞点，然后停止猜测。不得自行创建额外 Issue、改变 Contract、重排优先级或扩大团队范围。

## Git 与状态自动化

- 分支使用 <type>/<ISSUE-ID>-<slug>，例如 feat/ENG-123-user-search；type 与 Conventional Commits 对齐。
- worktree 位于仓库同级的 <repo>-worktrees/<ISSUE-ID>，不放进仓库目录。
- commit 保持 Conventional Commits；需要关联时使用 Refs ENG-123。PR 标题包含 Issue ID，closing PR 描述使用 Fixes ENG-123。
- 优先用 Linear GitHub Integration 推进状态：开始分支到 In Progress、进入审查到 In Review、稳定可合并到 Ready to Merge、合并到默认分支到 Done。
- Ready to Merge 依赖 GitHub branch protection、required review 和 required checks。没有这些门禁时不得仅凭 Linear 自动化声称可合并。
- Agent 只在团队未配置对应 GitHub 自动化且当前任务明确授权 Linear 写入时手工回写状态。

## Linear 写入边界

读取 Issue、团队 Guidance、状态、依赖、Assignee 和 Delegate 后再行动。已授权 Issue 内可追加事实性的进展、验证、阻塞或决策评论；创建或拆分其他 Issue、改变关系、优先级、Assignee、Delegate、Project、Cycle 或 Contract 需要单独授权。

MCP 不可用时可以使用用户提供的 Issue 内容执行本地工作，但必须明确说明未读取或同步 Linear。不得伪造评论、状态、关系、Delegate、PR、review、CI 或 merge 结果。

Writer 可使用项目明确配置的读写 Linear MCP。Reviewer 和 Verifier 必须使用只读端点；如果共享配置只暴露读写工具，仍然禁止调用任何 Linear 写工具。

## WIP 与视图

推荐 Writer In Progress 不超过 3，In Review 不超过 2；Review Queue 达到上限时停止启动新实现，优先完成审查和合并。推荐维护 AI Ready Queue、AI Working、Review Queue、Human Decisions 和 Blocked 五个共享视图。
