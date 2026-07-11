# Workflow Packet

填写规则：Summary、Dynamic Workflow、Memory 和对应 Evidence 的必填字段不得留空；按触发器必填 Full / Red Team 证据。Red Team 适用于红区、安全、DB、生产、发布、高风险或跨层任务。跨仓 / 外部契约证据在外部契约或跨仓任务中必填。禁止空泛词（TODO、TBD、待定、视情况、后续补充）。字段名保持英文以供 validator 解析，内容使用项目语言。工作流档位表示任务风险档位；安装配置表示 `minimal/core/full` 等资产集合，两者不得混用。

工作流档位（必填）：`Fast Path` / `Lightweight` / `Full`。

## Summary

- Purpose:
- Impact:
- Validation:
- Risks:

## Lifecycle Artifacts

- Clarification:
- Spec:
- Plan:
- Tasks:
- Handoff:
- Retrospective:

## Dynamic Workflow

- Primary Workflow:
- Trigger signals:
- Required modifiers:
- Red-zone confirmation:

## Memory

- Memory:

## Evidence

### Lightweight Evidence

- Validation commands:
- Exit codes:
- Environment:
- Result summary:
- Coverage:
- Unverified items and reasons:

### Full Evidence

- Required test commands:
- Exit codes:
- Environment:
- Actual results:
- Coverage:
- Dynamic simulation:
- Dynamic security:
- Dynamic database:
- Cross-repo evidence:

### Red Team

- Attack path:
- Expected failure point:
- Attack result:
- Residual risk:
- Checker / reviewer source:

## Completion

- Review evidence:
- Rollback plan:
- Unverified items and risks:
