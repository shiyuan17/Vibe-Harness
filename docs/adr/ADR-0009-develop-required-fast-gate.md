---
id: ADR-0009
title: Required fast gate for develop merges
status: accepted
date: 2026-09-27
review-date: 2026-10-25
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Required fast gate for develop merges

## Context and Problem Statement

`develop` remains the daily integration branch, but the previous advisory-only policy allowed broken code to enter the shared branch and shifted detection to the release boundary.

## Decision Drivers

- Keep short-lived task branches and Writer-landed merges.
- Prevent known lint, typecheck and unit regressions from entering `develop`.
- Preserve the complete release gate for `main`, hotfix and release branches.
- Keep emergency bypasses explicit, time-bounded and auditable.

## Considered Options

- Keep `develop` CI advisory-only.
- Require the existing stable `merge-gate` aggregate on `develop`.
- Require the complete release matrix on every `develop` merge.
- Remove `develop` and adopt a trunk-only model.

## Decision Outcome

The existing stable `merge-gate` aggregate is required for `develop` pull requests. Its fast layer must pass lint, typecheck and unit checks, and the change plan may add component or integration checks for affected paths. Release promotion, hotfix and release branches retain the full required gate. Emergency bypasses require explicit time-bounded approval and an auditable record.

## Consequences

- Daily merges gain a bounded remote verification step without adopting the complete release matrix.
- CI latency becomes part of normal merge time and must be monitored.
- Full release verification remains isolated to the release boundary.

## Confirmation

Conformance is checked by the CI workflow, branch policy, merge-gate tests, Linear workflow tests and the Git/Linear documentation parity checks. The required check name is the stable `merge-gate` aggregate.

## Review Trigger

Review this decision after one complete iteration of fast-gate failure rate, merge wait time, revert rate and release-gate escape rate, or when the project changes its branch model.

## More Information

- `docs/rules/git-rules.md`
- `docs/rules/linear-workflow.md`
- `.github/workflows/ci.yml`
