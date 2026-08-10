---
name: linear-workflow
description: Use when executing, reviewing, verifying, refining, or synchronizing explicitly referenced Linear issues in a multi-Agent coding workflow.
---

# Linear 工作流

本 Skill 操作 Linear 工作项，不替代项目治理、Git 规则、测试或人工权限门禁。V1 不自动从队列领单，不创建常驻调度器或 Linear Loop。

## 1. 解析授权与角色

只接受用户明确给出的 Issue，或已委派给当前 Agent 的 Issue。未指定 Issue 时可以只读解释队列或流程，但不得选择、认领或更新任务。

先确定当前角色：Writer 可在授权 Issue 内执行必要写入；Reviewer 和 Verifier 只读。优先使用人类 Assignee + 原生 Agent Delegate；只有客户端不是 Linear Agent 时才使用 agent:* 和 role:* 标签。

## 2. 读取 Issue 真值

通过可用的 Linear connector 读取 Issue 描述、团队 Guidance、状态、Assignee、Delegate、Project、Cycle、labels、relations 和最近相关评论。MCP 不可用时回退到用户提供的内容，并在结果中明确写出未读取或同步 Linear。

不得推断不存在的字段、关系或权限。不要读取无关团队或扩大搜索范围。

## 3. 执行 Ready 门禁

只有 Todo Issue 才能开始实现，并且必须同时满足：

- 用户明确引用或已经委派给当前 Agent。
- Goal、Context、Scope、Out of Scope、Contract、Acceptance Criteria、Dependencies、Verification 均存在。
- 没有未解决的 blocked-by 关系。
- 仓库、目标分支、允许写入范围和验证方式可确定。

不满足时返回具体缺口，不开始编码、不创建分支、不改变状态。需要人类决定时，在已授权写入的前提下添加 needs:decision 和精简评论，然后停止。

## 4. 执行与隔离

叶子 Issue 使用一个 Writer、一个仓库外 worktree、一个 <type>/<ISSUE-ID>-<slug> 分支和一个 closing PR。Reviewer/Verifier 只读核验同一变更，不建立第二套实现所有权。

按项目规则实现、验证和检查实际 diff。不得修改 Out of Scope、改变 Contract、顺手重构或创建额外 Issue。Contract 必须改变时停止并请求决定。

## 5. 同步工作状态

优先让 GitHub Integration 推进状态：

- 分支和实现开始：In Progress。
- Draft PR：仍为 In Progress。
- PR 退出 Draft 并进入审查：In Review。
- required review、CI、契约检查和必要 E2E 通过：Ready to Merge。
- closing PR 合并到目标默认分支：Done。

只有缺少对应自动化且当前任务明确授权 Linear 写入时才手工更新状态。Agent 自报完成、测试通过或 PR 创建都不能直接设为 Done。

在授权 Issue 内只追加事实性的进展、验证、阻塞或决策评论。修改其他 Issue、关系、优先级、Assignee、Delegate、Project、Cycle 或 Contract 前必须获得单独授权。

## 6. 审查与交付

Reviewer 和 Verifier 使用只读 Linear MCP endpoint。即使共享配置暴露写工具，也不得修改 Issue、labels、comments、Assignee、Delegate、priority 或 status。

交付时报告本地结果、验证证据、PR/merge 的已观察状态，以及 Linear 是否实际同步。不要把工具不可用、请求已发送或推测状态写成成功。

需要创建团队模板或管理员配置时，读取 references/ai-coding-task.md 和 references/workspace-setup.md；这些文件是配置清单，不授权直接写入 Linear Workspace。
