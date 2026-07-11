# Task Intake

Task intake turns an issue, request, local task, or conversation into an executable start block. It does not redefine task state; lifecycle truth belongs to `task-rules.md`.

## Required fields

- Source and identifier, or an explicit `N/A` when no external source exists.
- Goal, acceptance criteria, non-goals, and impact scope.
- Workflow tier, primary workflow, required modifiers, and risk level.
- Worktree decision, write scope, forbidden actions, validation commands, stop conditions, and rollback plan.

## Entry gate

Before execution, read the source and related specification, inspect version-control status, select the minimum reading path, and identify evidence that can prove each acceptance criterion. If ambiguity changes behavior, contract, security, or validation, return to clarification.

Red-zone work must record scope, reason, validation, rollback, and human confirmation. A parent or child task must additionally declare dependencies, conflicts, parallel safety, and completion ownership.

## Completion standard

The intake is complete only when another engineer or agent can execute it without inventing requirements, interfaces, permissions, or validation evidence.
