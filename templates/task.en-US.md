# <Task ID> <Title>

- Workflow tier: fast / lightweight / full
- Current phase: facts / decision / execution / verification / delivery
- Current status: idle / in_progress / blocked / awaiting_human / awaiting_dependency / verification_failed
- Result: open / completed / wont_do / duplicate / cancelled

## Goal

## Constraints

## Write scope

## Acceptance criteria

| AC-ID | Standard |
| --- | --- |
| AC-01 |  |

## Verification plan

## Evaluation mapping

Keep this section only when Agent behavior changes.

| AC-ID | Eval-ID |
| --- | --- |
| AC-01 | EVAL-EXAMPLE-001 |

## Next action

Add Blocker and Resume hint when waiting. Add Acceptance evidence and Residual risks before completion.

## Full workflow control

Full-tier tasks keep the canonical machine-control JSON required by `full-task-control.schema.json`. New tasks set `"控制版本": 3`. v3 single and parent tasks declare fan-in `集成验证`; parent tasks also declare `子任务` and ordered `执行批次`. Child tasks declare `父任务编号`, `输入`, `输出格式`, `不得修改范围`, `冲突任务`, and `时间盒分钟`. Historical v1/v2 control blocks remain readable under their previous semantics.

```json
{
  "控制版本": 3,
  "任务类型": "单任务",
  "集成验证": ["pnpm check"],
  "责任角色": "Implementer",
  "写入范围": ["src/example.js"],
  "禁止动作": ["Overwrite unowned user changes"],
  "输入": ["None"],
  "输出格式": ["Delivery changes, verification, and risks"],
  "不得修改范围": ["All files outside the write scope"],
  "依赖任务": [],
  "冲突任务": [],
  "并行安全": "独占写入",
  "时间盒分钟": 60,
  "停止条件": "Every acceptance criterion has valid evidence",
  "回滚方案": "Restore the files changed by this task",
  "人工确认": "不需要",
  "核验者": "Independent verifier",
  "红队审查者": "Independent reviewer",
  "红队审查包": "docs/reviews/<Task ID>-red-team.md",
  "红队审查结论": "待审查",
  "独立核验模式": "原生子智能体",
  "合并回主线状态": "不需要"
}
```

For a v2/v3 child, `输出格式` is exactly `["状态", "变更摘要", "变更路径", "验证证据", "未验证项", "剩余风险", "下一步动作"]`.

## Handoff records

Version 3 keeps the machine-readable Handoff array in this same task Markdown. An open task may use an empty array; paused or waiting tasks require a `暂停恢复` record, and completed full tasks require fresh Tester and Reviewer receipts for the current frozen change set. If native roles are unavailable, set `独立核验模式` to `人工等价` and add two `人工等价核验` entries to the control block with role, accountable verifier, project-relative non-empty regular-file evidence, fingerprint, conclusion, and time. Each entry still needs a matching returned Handoff, and the Tester, Reviewer, and implementer must be distinct people.

```json
[]
```

## Acceptance evidence

| AC-ID | Evidence type | Command or artifact | Exit code | Verified at | Verifier | Actual result |
| --- | --- | --- | --- | --- | --- | --- |

Evidence types are command, artifact, manual, review, or evaluation.

## Residual risks
