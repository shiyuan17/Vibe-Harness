---
id: ADR-0011
title: Evidence-bound delivery and owned service lifecycle
status: proposed
date: 2026-10-10
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# Evidence-bound delivery and owned service lifecycle

## Context and Problem Statement

Squash merges do not preserve source ancestry. Cleanup must distinguish an unmerged branch from a proven equivalent merge without weakening dirty-tree, current-verification or process-ownership checks. Existing projects and receipts must remain readable.

## Decision Drivers

- Preserve managed MR squash workflow and legacy compatibility.
- Fail closed on missing merge evidence, stale receipts and unowned processes.

## Considered Options

- Require all users to change to no-ff merges.
- Add explicit delivery profiles and immutable merge evidence.

## Decision Outcome

Use explicit delivery profiles. managed-mr consumes squash evidence without performing merges; local-land keeps the existing isolated no-ff candidate flow. New profiles require a structured completion receipt. Legacy callers receive migration warnings. Services run under a dedicated supervisor holding the actual child relationship rather than trusting registry PIDs.

## Consequences

- Source and merge patch identities justify cleanup without forced branch deletion.
- Checkpoints preserve current units and recovery drift; an event entry does not imply a host listener.
- Unreachable supervisors and unknown descendants require manual recovery and remain blocked.
- Exception dates and ownership are operator facts; missing values stay stale rather than being invented.

## Confirmation

Use disposable Git repositories for valid and invalid squash evidence, target drift, dirty sources, stale receipt writes, legacy no-ff and service ownership. Run installed-runtime contract checks and project dry-runs. Browser/DM8 and live GitLab evidence must be separately reported when unavailable; fixture success does not prove them.

## Review Trigger

Revisit when the host exposes native compaction/message events or a stronger platform process-ownership primitive, or when GitLab evidence fields change.

## More Information

- [Delivery lifecycle](../specs/delivery-lifecycle.md)
- [Git rules](../rules/git-rules.md)
