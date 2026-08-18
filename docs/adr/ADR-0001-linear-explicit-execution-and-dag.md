---
id: ADR-0001
title: Linear explicit execution identity and native DAG contract
status: accepted
date: 2026-08-15
review-date: 2027-02-15
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Linear explicit execution identity and native DAG contract

## Context and Problem Statement

The Linear integration needs an auditable answer to which Agent product identity and concrete runtime instance is implementing an Issue, while preserving the human accountable owner. It also needs deterministic multi-Agent dependency semantics without duplicating Linear relations in free-form descriptions. Automatic queue claiming would broaden authority, create recovery races, and require a persistent dispatcher outside the Vibe-Harness asset-pack boundary.

## Decision Drivers

- Keep work initiation explicit and bounded to a named Issue.
- Preserve human accountability while distinguishing product identity from a transient runtime instance.
- Prefer Linear-native decomposition and dependency relations over duplicated prose.
- Make retries, recovery, release, abort, and handoff auditable without rewriting history.
- Keep delivery within rules, Skills, templates, installer projections, tests, and Eval assets rather than a resident service.

## Considered Options

- Scan or poll a Ready Queue and automatically claim, lease, expire, or reassign Issues.
- Use only the human Assignee or overwrite it with an Agent identity.
- Encode every runtime instance in high-cardinality labels.
- Maintain a second dependency list in the Issue description.
- Edit a single mutable execution comment as ownership changes.
- Use explicit initiation, layered identities, native relations, and append-only versioned receipts.

## Decision Outcome

Chosen option: explicit initiation, layered identities, native relations, and append-only versioned receipts.

Vibe-Harness does not automatically claim work. A Writer may start only when a user explicitly requests work on a specific Issue, or when that Issue is already delegated to the current Agent and the host explicitly starts it. Queue scanning, polling, webhook dispatchers, Linear Loops, leader leases, automatic timeout recovery, and automatic reassignment are excluded.

The human Assignee remains the accountable owner. Linear Delegate/App User records the Agent product identity, an immutable vibe-harness.linear-execution/v1 Receipt records the concrete runtime instance, and Linear Activity Feed records delegation and identity changes. When Delegate is unavailable, only administrator-preconfigured low-cardinality agent-key and writer-role labels may be used. Reviewer and Verifier roles remain read-only.

Receipts are append-only. Release, abort, handoff, and local-work-completed are new versioned events that reference the original execution. A resumed or handed-off runtime receives new execution and runtime IDs. Records exclude hostnames, usernames, local paths, credentials, session identifiers, and personal data. No automatic stale-instance recovery occurs; a human verifies the worktree, branch, and PR before an explicit release or handoff.

Linear Parent/Sub-issue is the decomposition truth and does not imply order. Native blocked-by and blocks relations are the execution-dependency truth; related is never a dependency. Description-level Dependencies contains only None or Managed by Linear relations. Agents may detect missing relations, cycles, inaccessible predecessors, write-scope overlap, or resource-lock conflicts, but may not create or change relations without explicit authorization.

Write leaves reach Done only after the closing PR merges to the target default branch. Read leaves require their agreed output and verification evidence. Aggregate Parents require all applicable triggers plus Fan-in Verification; Linear Parent/Sub-issue automatic closing is disabled so it cannot bypass merge or fan-in evidence.

## Consequences

- Linear retains human accountability and an auditable Agent/runtime execution history.
- Existing standalone Issues remain valid with additive defaults and require no migration or backfill.
- Descriptions no longer duplicate the dependency graph, reducing drift from native relations.
- Work does not begin when identity, receipt history, dependency visibility, scope, or logical-lock safety is uncertain.
- Teams perform release and handoff explicitly and disable automatic Parent closure.
- Vibe-Harness does not provide a dispatcher, scheduler, lease manager, or automatic recovery service.

## Confirmation

Conformance is checked by the Linear workflow rule and Skill, the DAG Parent and Execution Receipt reference templates, installer projection tests, deterministic Linear/DAG contract tests, and the linear-workflow-online Eval suite. NO_AUTO_CLAIM remains a critical Eval behavior.

## Review Trigger

Review this decision if Linear introduces a native execution-instance primitive with immutable handoff history, if the product scope expands to an authorized resident dispatcher, or if native dependency and Parent completion semantics materially change.

## More Information

- Linear workflow specification: docs/specs/linear-multi-agent-workflow-spec.md
- Packaged rule: rules/linear-workflow.md
- Integration Skill: skills/integrations/linear-workflow/SKILL.md
- Public references: Linear Assign and delegate issues, AI Agents, Parent and sub-issues, Issue relations, Issue statuses, and Linear MCP documentation.
