# Task Management

Task management keeps scheduling indexes, task manifests, child execution units, and handoff evidence consistent. `task-rules.md` owns lifecycle semantics; this rule owns storage, synchronization, and completion gates.

## Sources of truth

1. A task manifest or external issue is the lifecycle truth for phase, execution status, resolution, and children.
2. A backlog is a scheduling index. It must not silently override a task manifest.
3. Child task documents contain executable scope and evidence; handoff and memory are recovery aids, not lifecycle truth.

When sources disagree, report the conflict and repair the lower-priority index before execution.

## Required task data

- Identity, goal, acceptance criteria, non-goals, owner role, and task kind.
- `phase`, `status`, and `resolution` as separate fields.
- Write scope, forbidden actions, dependencies, conflicts, parallel safety, and human confirmation state.
- Validation commands, evidence, stop condition, rollback plan, `nextAction`, and `resumeHint`.
- `blockedReason` for blocked work and structured external-contract evidence when another repository or service is in scope.

## Parent and child rules

- Keep a task `single` when one write scope and one verification cycle produce a reviewable result.
- A parent coordinates scope, dependency order, integration verification, review, and merge-back; it does not implement child work directly.
- Each child must produce a minimum reviewable result and declare its write scope. Mechanical steps such as “run a command” are not children unless independently deliverable.
- Parallel children require non-overlapping writes or explicit conflict ownership. Unknown overlap means serial execution.
- A parent cannot resolve as done while required children, validation, review, human confirmation, or merge-back remain open.

## Recovery and escalation

Blocked or waiting work must include the reason, the party or condition being awaited, the next action, and a resume hint. High-risk research may use `packetTier: Lightweight` only when it records `implementTier: Full`; the task must upgrade before runtime implementation begins.

## Validation

The installed full governance validator checks lifecycle consistency, blocked-task recovery fields, tier escalation, and parent completion. A validation failure blocks completion; do not edit the validator input merely to silence a valid finding.

## Completion standard

A task is complete only when acceptance criteria map to current evidence, independent review and confirmation gates are satisfied, all worktree changes are merged back, remaining risks have owners, and the scheduling index matches lifecycle truth.
