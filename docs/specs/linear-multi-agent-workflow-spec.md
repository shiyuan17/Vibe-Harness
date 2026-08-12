# Linear 多 Agent 工作流规格

## 状态

状态：Implemented

## 目标

Vibe-Harness 通过显式 integration plugin 提供 Linear 工作流规则、操作 Skill、团队模板和项目级 Remote MCP 配置。Linear 是工作状态、责任和依赖真值，GitHub 是代码、PR、检查和合并真值。

V1 不自动从队列领单、不运行常驻调度器、不创建 Linear Loop，也不直接修改真实 Workspace 的 workflow、template、guidance、view 或 GitHub automation。

## 安装合同

- linear-mcp 选择读写 endpoint https://mcp.linear.app/mcp。
- linear-mcp-readonly 选择 https://mcp.linear.app/mcp/readonly。
- 两者互斥、必须显式选择、不属于任何默认 profile，也不随 plugin all 展开。
- 安装器只管理项目级配置，不保存 Token、API key 或 OAuth 凭据。
- Codex、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 使用项目级配置；Claude 和 Gemini 安装规则与 Skill，并报告 MCP 需要手工配置。

Remote MCP server 使用 url，本地 MCP server 使用 command、args 和 env；同一 server 不得同时使用两种形态。OpenCode 将 remote server 转换为 type remote，其他 JSON adapter 使用 URL 配置，Codex TOML 使用 url 字段。

## 行为合同

固定状态为 Triage、Backlog、Todo、In Progress、In Review、Ready to Merge、Done；Blocked 只使用关系。Todo 必须满足 Definition of Ready 且没有未解决依赖。Triage 是团队收件箱，Issue 必须经 accept / duplicate / decline / snooze 之一处置后才进入工作流；这些决定需要人工确认，V1 Agent 不自动处置 Triage Issue。

V1 只执行用户明确引用或已经委派的 Issue。人类 Assignee 对结果负责，原生 Delegate 负责执行；labels 只作为没有原生 Agent 身份时的回退。叶子 Issue 只有一个 Writer、一个仓库外 worktree、一个分支和一个 closing PR。Reviewer 与 Verifier 只读。

GitHub Integration 优先推进状态；缺少自动化时，只有明确授权的 Writer 才能回写当前 Issue。Done 必须由 closing PR 合并到目标默认分支证明。

## 安全与降级

创建其他 Issue、改变 Contract、关系、优先级、Assignee、Delegate、Project 或 Cycle 需要单独授权。MCP 不可用时回退到用户提供的 Issue 内容，并明确未同步 Linear。不得伪造 Linear、PR、CI、review 或 merge 状态。

## 验证

确定性测试覆盖插件互斥、默认 profile 不变、Remote MCP TOML/JSON/JSONC、同名冲突、红区、安装/validate/uninstall/rollback 和八 adapter 降级。Online Eval 覆盖 Ready、缺字段、blocked relation、禁止自动领单、Reviewer 只读和 merge 后 Done。
