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

Full-tier tasks keep the canonical machine-control JSON required by `full-task-control.schema.json`. New tasks set `"控制版本": 2`. Parent tasks also declare `子任务`, ordered `执行批次`, and `集成验证`; child tasks declare `父任务编号`, `输入`, `输出格式`, `不得修改范围`, `冲突任务`, and `时间盒分钟`. Legacy control blocks without `控制版本` remain readable as v1.

```json
{
  "控制版本": 2,
  "任务类型": "单任务",
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
  "合并回主线状态": "不需要"
}
```

For a v2 child, `输出格式` is exactly `["状态", "变更摘要", "变更路径", "验证证据", "未验证项", "剩余风险", "下一步动作"]`.

## Acceptance evidence

| AC-ID | Evidence type | Command or artifact | Exit code | Verified at | Verifier | Actual result |
| --- | --- | --- | --- | --- | --- | --- |

Evidence types are command, artifact, manual, review, or evaluation.

## Residual risks
