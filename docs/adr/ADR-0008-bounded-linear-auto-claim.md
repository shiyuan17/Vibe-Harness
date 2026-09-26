---
id: ADR-0008
title: Bounded host-dispatched Linear auto-claim
status: accepted
date: 2026-09-26
review-date: 2027-03-26
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: [ADR-0001]
superseded-by: null
---

# Bounded host-dispatched Linear auto-claim

## Context and Problem Statement

ADR-0001 prohibited all queue claiming because mere readiness cannot authorize execution and the pack has no resident dispatcher. A user can instead explicitly authorize a bounded queue and delegate event selection to a capable host. The host still needs durable grants, cross-instance exclusivity, and per-Issue execution isolation. The original identity, DAG, and append-only history controls remain.

## Decision Drivers

- Permit useful unattended work without treating Todo or queue membership as authority.
- Make the grant revocable and finite in time, quantity, target, and effects.
- Keep the Agent away from queue discovery and prevent simultaneous claims across hosts.
- Preserve existing explicit-execution receipts and their consumers.
- Deliver only portable contracts and validations; do not assert that any host implements dispatch.

## Considered Options

- Continue the unconditional auto-claim prohibition.
- Let any Agent poll Ready Queue and claim Todo Issues.
- Add a resident dispatcher and lease manager to Vibe-Harness.
- Specify event-driven host selection under a separate bounded grant and a fresh per-Issue envelope.

## Decision Outcome

Choose event-driven host dispatch. A user explicitly grants one team or project queue, repository, Agent product identity, exact `origin/develop` target, independent allowed effects, UTC expiry, and positive maximum claim count. The host stores an opaque non-sensitive UUID v4 grant ID and revocation state. Missing, expired, revoked, exhausted, or mismatched grants stop dispatch. The default is one active Issue per grant.

On idle or queue-change events, a capable host chooses a Todo code Issue in the grant's queue by descending Priority, ascending creation time, then Issue ID. It must prove exclusive cross-instance dispatch for that Issue; writing Delegate and reading back is not atomic selection. No Agent scans or polls the queue, and Triage, hotfix, and release work are outside this path.

For each selected Issue, the host rechecks the grant and claim count, then issues a fresh v2 execute Envelope bound to that Issue. The Agent rechecks full Definition of Ready, native dependencies, Scope and Resource Locks, identity and Receipt ledger. It registers Delegate and the Start Receipt before working. The new `vibe-harness.linear-execution/v2` Start Receipt keeps the v1 identity fields, adds required `grantId`, and fixes `source` to `authorized-auto-claim`; v1 explicit and delegated receipts remain unchanged. The same terminal event v1 and one-active-execution-per-Issue conflict rule apply across both versions. The grant ID references, but does not prove, host authority.

Each run ends at its authorized terminal condition. The default auto-claim goal is a confirmed closing PR/MR merge into `develop`, but `gitPush`, `mergeRequestWrite`, and every other required effect must be authorized independently. Risk Evidence and Independent Review Receipt remain prerequisites where applicable. Only after normal completion may the host revalidate expiry, revocation, claim count, and concurrency before starting a new Issue with a new Envelope. Conflict, incomplete registration, or insufficient risk evidence stops dispatch; no automatic release, timeout recovery, or reassignment occurs.

## Consequences

- A host without durable grants, event dispatch, exclusive selection, and v2 enforcement cannot activate automatic claiming.
- Existing v1 receipts and explicit request behavior need no migration.
- Vibe-Harness ships rules, Skill, templates, a v2 receipt validator, tests, and Eval scenarios, not a resident dispatcher or live Linear automation.
- Reviewer and Verifier remain read-only, the human Assignee remains accountable, and Triage decisions remain manual.

## Confirmation

Deterministic tests check v1/v2 receipt validation, shared active-instance conflicts, and installation projection. Online Eval covers valid grants and denies missing, expired, out-of-scope, revoked, conflicting, read-only, or non-exclusive dispatch. No test of real event delivery is claimed without a capable host.

## Review Trigger

Review when hosts expose a standard grant and exclusivity service, Linear gains atomic native claim support, or v2 envelope enforcement changes.

## More Information

- Prior decision: docs/adr/ADR-0001-linear-explicit-execution-and-dag.md
- Execution boundary: docs/adr/ADR-0002-linear-execution-envelope-and-recovery.md
- Current contract: docs/rules/linear-workflow.md
