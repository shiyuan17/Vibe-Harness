# Scenario authoring

## Purpose

A Harness scenario is a falsifiable experiment against one primary mechanism. It gives an Agent a real workspace task and verifies the result and process through independent observable evidence. A scenario that can pass by echoing a phrase is invalid.

## Required shape

Every file under `harness-evals/scenarios/` uses `schemaVersion: 3` and contains:

- stable `id` (`H01` through `H20` for the initial set), semantic `version`, title, category, mechanism, risk, kind, and objective;
- `phase.red`, `phase.green`, at least one `phase.pressure` entry, and `phase.regression`;
- required and optional backend capabilities;
- a relative fixture reference and a task prompt with allowed write paths;
- applicable rule IDs plus required and forbidden observable behavior;
- deterministic `checks`, metric IDs, and allowed failure taxonomy codes.

Each check has a stable ID, `type`, a plain-language `observable`, `critical`, and `hidden`. `expected` is present only when the runner needs structured comparison data. Supported evidence types are `file`, `git`, `test`, `process`, and `trace`.

## Authoring sequence

1. Name one primary failure mechanism and assign a stable ID.
2. Build a disposable fixture that exposes the mechanism through a bounded engineering task.
3. Write the prompt as a user request. Do not include the hidden command, expected diff, event name, or oracle answer.
4. Define outcome checks against files and tests, then workflow checks against Git/process/trace evidence.
5. Define RED and GREEN with identical measurement conditions.
6. Choose one deterministic pressure trigger and one two-factor combination from the pressure catalog.
7. Add the scenario to Fast only if it is critical and sufficiently cheap; all core scenarios belong to Nightly and Full.
8. Add a verifier negative control that fails at least one critical check without invoking an Agent.

## Fixture rules

Fixtures are manifests under `harness-evals/fixtures/`. They materialize a new temporary workspace and may initialize Git, branches, worktrees, processes, and fault injection. Fixture manifests contain no credentials, private paths, or user data.

`allowedWritePaths` is an allowlist. An Agent write outside it is a critical failure even when final tests pass. Hidden tests and oracle assets are placed outside the Agent-visible workspace. Faults are controlled by named triggers and must be repeatable.

## Checks and completion

Use at least one artifact or command check and one workflow check. Prefer checks that establish:

- exact changed-path scope from Git;
- expected behavior through a hidden test command;
- required ordering, such as material change before final verification;
- absence of forbidden behavior, such as deleting a failing test or merging a failed child result;
- persistence through interruption, resumption, compaction, or handoff.

All critical checks must pass. `blocked` and `unverified` cannot be converted to pass. Semantic judging may explain ambiguous communication, but it cannot override failed deterministic evidence.

## Phase and pressure discipline

RED is a real pre-change run. If it passes, report `not-reproduced`. GREEN repeats the same task, model, runner, fixture revision, checks, and budget. Pressure changes only the declared pressure stimulus. Regression preserves all attempts and runs the affected set plus the fixed critical scenarios.

Pressure prompts are appended or injected at the declared trace trigger. Do not expose oracle answers. Random timing is not an acceptable trigger; use a named event such as the first test failure, first completed child, or context checkpoint.

## Review checklist

- The prompt requests real work and cannot pass through exact-token output.
- Hidden checks are absent from the task prompt and visible fixture files.
- Every write is allowlisted and every critical claim has evidence.
- The scenario can distinguish Agent failure from fixture, verifier, collector, and runner failure.
- Required backend capabilities are declared; unsupported capabilities produce a blocked result.
- The negative control fails for the intended reason.
- Metrics have defined denominators and missing telemetry is unavailable rather than zero.
