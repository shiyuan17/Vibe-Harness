# Linear Triage Intake

建议在 Linear 中创建团队级 Form Template，用于收集进入 Triage 的新 Issue。把 Priority、Suspected Area（label group）和 Decision 设为必填；其余字段尽量降低填写门槛，让报告者只填自己确定的信息。accept 后转入正式工作流时，再用 ai-coding-task.md 补齐 Definition of Ready。

Triage 是团队收件箱：进入 Triage 的 Issue 默认不进入常规视图，必须经 accept / duplicate / decline / snooze 之一处置后才算进入工作流。Agent 只读解释流程，不自动处置、选择、领取或开始 Triage Issue。提交、提及、查看或总结本表均不构成 Agent 执行授权。

## Title

直接陈述任务或问题本身，不写 user story。

## Problem / Repro Steps

- bug：列出可复现步骤、预期与实际结果、环境（版本、平台、账号类型）。
- 非 bug：用一句问题陈述或 ask 描述诉求，交给 assignee 判断方案。

## Impact / Customer Signal

直接引用用户原话并链接原始对话（Slack、工单、邮件），不要改写或概括。写明受影响范围或频次；没有信号时写 None。

## Urgency / Priority

按团队优先级定义填写；配合 Triage 的 priority-before-exit，离开 Triage 前必须有 Priority。

## Suspected Area

label group / project / team，用于驱动 Triage Rules 自动路由。不确定时留空交由 triager 判断。自动路由不得设置 Agent Delegate、创建 Execution Receipt 或启动执行。

## Decision

triager 处置时填写四动作之一：

- accept：确认需要处理，移入团队默认状态（Backlog 或 Todo，Todo 仍须满足 Definition of Ready）。
- duplicate：合并到已存在的 canonical Issue；附件与 customer request 转移，本 Issue 置为 canceled 类。
- decline：不处理，置为 canceled 类并附说明。
- snooze：暂时隐藏，到指定时间或有新活动时返回 Triage。

accept 只表示进入正式工作流，不表示委派、领取或授权 Agent 实现。明确执行仍须引用具体 Issue，或已有当前 Agent Delegate 且由宿主显式启动。

## Optional

- Assignee：通常留给 triager，不强制报告者填写；Assignee 是结果责任人，不等于 Agent Delegate。
- Estimate：进入 Backlog/Todo 后再估，Triage 阶段不强求。
