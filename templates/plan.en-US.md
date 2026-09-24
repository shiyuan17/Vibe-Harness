# <Task ID> <Title>

> This is a handoff-ready execution plan. The reader has only the current repository and this file, not the original conversation.
> Store managed plans at `docs/plans/<task-id>.md`; update the plan before continuing after any substantive deviation.

## Goal

Describe the observable user outcome, why it matters, and how to demonstrate it.

## Non-goals

State behavior, interfaces, directories, and delivery boundaries that must not change.

## Current Facts and Boundaries

- Relevant entry points, modules, and configuration:
- Allowed write scope:
- Protected assets:
- Environment and authorization prerequisites:

## Decided Approach

Record implementation, compatibility, rollback, and key tradeoffs. Do not leave choices that would change implementation order unresolved.

## Plan of Work

Describe independently verifiable increments, their files or entry points, dependencies, and outputs. Verify each increment before starting dependent work.

## Validation and Acceptance

Give every acceptance criterion a stable ID, command or manual check, expected result, and required evidence.

| Acceptance ID | Criterion | Command or action | Expected result | Evidence |
|---|---|---|---|---|
| A-001 |  |  |  |  |

## Execution Units

The machine-readable block below is the handoff and dispatch contract: a reviewer, CI, or `task plan-check` reads only this block to learn what may change, in what order, and which acceptance ID proves each step.
`allowedScope` bounds the files this plan may write, `protectedAssets` lists assets no unit may touch; a unit that writes outside the scope, hits a protected asset, depends on an unknown unit or a cycle, or cites an acceptance ID that is missing from the table makes `plan-check` fail with `VIBE_HARNESS_PLAN_SCOPE_VIOLATION`, `VIBE_HARNESS_PLAN_DEPENDENCY_INVALID`, or `VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND`.
Legacy plans may omit the block (reported only as the `VIBE_HARNESS_PLAN_UNITS_MISSING` warning); new plans must fill it in.

```plan-units
{
  "allowedScope": ["docs/**", "runtime/**"],
  "protectedAssets": ["evals/**"],
  "units": [
    {
      "id": "U1",
      "title": "Independently verifiable increment",
      "files": ["runtime/commands/run.mjs"],
      "dependsOn": [],
      "acceptance": ["A-001"]
    }
  ]
}
```

## Plan Drift Log

When the goal, scope, interface, dependency, acceptance, or rollback changes, pause affected work, record the reason and impact, update this plan, then continue.

| Revision | Time | Deviation and reason | Impact | Action |
|---|---|---|---|---|
| 1 |  | Initial plan |  |  |

## Progress and Recovery

- Current stage: plan / implement / verify
- Completed increments:
- Current increment:
- Blockers:
- Next action:

## Decision Log

| Decision | Rationale | Time |
|---|---|---|
|  |  |  |

## Evidence and Rollback

Record actual verification commands, exit codes, summaries, code/plan fingerprints, and applicable screenshots, HTTP responses, build output, or diffs. Explain safe rollback or retry.

## Revision Notes

For every plan edit, append what changed, why it changed, and which acceptance criteria or increments are affected.
