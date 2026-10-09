---
id: ADR-0004
title: Task decomposition governance and DAG state consistency
status: accepted
date: 2026-09-11
review-date: 2027-03-11
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [task-decomposition-users, linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Task decomposition governance and DAG state consistency

## Context and Problem Statement

Vibe-Harness uses a single-Agent fast path and an optional lightweight Task DAG for real collaboration. Linear has a separate native DAG projection. Without shared terminology, local results, provider terminal states, dependency changes, and child handoff evidence can be interpreted inconsistently.

## Decision Drivers

- Keep ordinary tasks low ceremony and single-Agent by default.
- Make shared contracts and concurrent writes deterministic.
- Prevent stale DAG plans from dispatching after workspace or contract changes.
- Preserve Linear native relations as the external dependency truth.
- Improve fan-in evidence without adding a runtime scheduler or new authorization effects.

## Considered Options

- Keep local and Linear DAG terminology separate and rely on agent judgment at fan-in.
- Require every task to use a machine-readable DAG and evidence schema.
- Adopt a lightweight human-readable contract with shared states, explicit ownership, and dispatch-time revalidation.

## Decision Outcome

Chosen option: lightweight human-readable governance with optional Task DAGs.

- A simple, reversible task remains on the single-Agent path. Splitting is justified only when boundaries are clear, merging is controllable, and expected parallel benefit exceeds coordination cost.
- Local DAG results use `pending`, `ready`, `running`, `succeeded`, `failed`, `blocked`, `skipped`, and `cancelled`.
- Linear `Canceled`, `Duplicate`, and `Won't Fix` remain provider terminal states and map to non-success locally.
- Shared API, schema, migration, or behavior contracts have one write owner and an explicit dependency. If isolation cannot be proven, treat the nodes as conflicting.
- Before dispatching a write node, revalidate the DAG version or hash, dependencies, scopes, locks, HEAD, and workspace identity. A change pauses successors and requires ready-set recomputation.
- Child handoff reports are human-readable evidence only. They include the result, changed files, base/head, verification command and exit code, risks, and blockers; they never grant authority.
- Local and Linear concurrency limits are separate soft limits and may be constrained by host capacity, API rate limits, project resources, or task budgets.
- Node timeout, attempt limit, cancellation, backoff, and resource budget are optional controls for long-running work. They are not required for ordinary single-Agent tasks.

## Consequences

The governance surface stays low ceremony for ordinary work while making multi-Agent scheduling and fan-in decisions deterministic. This ADR does not add a runtime scheduler, a machine-readable evidence packet, automatic Linear relation changes, or new authorization effects.

## Confirmation

Conformance is checked by the governance rules, task-decomposition Skill, Linear projection, task templates, deterministic tests, and task-delivery Eval cases. Existing single-Agent fast-path and native Linear relation behavior must remain unchanged.

## Review Trigger

Review this decision when a runtime DAG scheduler or machine-readable evidence contract is introduced, when repeated stale-plan or fan-in evidence failures become material, or when Linear provides an equivalent native contract.

## More Information

- Governance rule: docs/rules/ai-collab-rules.md
- Linear workflow rule: docs/rules/linear-workflow.md
- Task decomposition Skill: .agents/skills/task-decomposition/SKILL.md
- Linear DAG template: skills/integrations/linear-workflow/references/dag-parent.md
