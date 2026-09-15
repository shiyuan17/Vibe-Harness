# <Task ID> <Title>

> Optional human-readable note.

- Workflow tier: quick / light / full
- Status: in progress / waiting / blocked / complete / cancelled
- Risk level: low / medium / high

## Source

## Goal

## Non-goals

## Acceptance

- [ ]

## Impact scope

## Dependency chain (dependencies / contracts / tests / docs)

## Execution disposition

> Record the rationale for direct or split implementation only when useful; it is not required for every Plan. Declare necessary dependencies when collaborating. This disposition grants no new authority, and host Plan mode remains read-only.

> Use `task-decomposition` when an existing plan needs a Goal, Task DAG, and host-neutral node execution prompts. Keep the result copyable in the response by default; write it here only when long-task recovery needs a durable note.

## Implementation task split (complete only when the plan is split)

> Complete this table when dependencies, isolation, or independent parallel work justify splitting; each task needs a clear result and verification, not a separate commit. Vibe-Harness does not parse it or use it as a completion gate.

| Task | Goal | Depends on | Change scope | Constraints | Acceptance criteria | Verification | Output |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |

## Collaboration Graph (complete only when collaborating)

> Complete this table when two or more work units have ordering dependencies, parallel writes, or a shared contract. Vibe-Harness does not parse it or use it as a completion gate.

> Field names and value domains follow the table below; field semantics are not restated here: the result enumeration and terminal states, writeScope and Resource Lock, pre-dispatch revalidation, node handoff evidence, and the Linear projection rules are owned by `ai-collab-rules.md`, and their Linear carriers and sources of truth by `linear-workflow.md`.

| id | kind (read / write / aggregate) | output | dependsOn | trigger (all_success / all_done) | writeScope | resourceLocks | verification | result |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

## Full project analysis (only when explicitly requested or impact cannot be narrowed)

- Technology stack:
- Directory structure:
- Business flow:
- Data flow:
- Module dependencies:

## Execution and verification

## Go/no-go decision

## Next action

## Risks
