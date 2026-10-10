---
id: ADR-0010
title: Symphony-hosted Linear dispatch with durable grants and claims
status: accepted
date: 2026-10-09
review-date: 2027-04-09
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Symphony-hosted Linear dispatch with durable grants and claims

## Context and Problem Statement

ADR-0008 permits bounded host-dispatched auto-claim but explicitly does not supply a dispatcher. Symphony's upstream Elixir implementation polls a tracker, keeps claims in process memory, retries active Issues and exposes a raw Linear GraphQL tool using host credentials. Those behaviors do not meet Vibe-Harness's current v3 Receipt, v2 Envelope, atomic Claim and authorization boundaries.

## Decision Drivers

- Preserve a user's explicit, revocable, limited grant as the sole authority for queue selection.
- Prevent duplicate dispatch across Symphony processes and stale Workers from performing writes.
- Keep credentials and host-only proof outside the Agent and untrusted Issue content.
- Retain v1/v2 Receipt read compatibility and fail closed when registration is incomplete.

## Considered Options

- Use upstream Symphony unchanged and rely on prompt instructions.
- Use only Linear Delegate and write-after-read as a claim.
- Run a Symphony Elixir fork with PostgreSQL-backed grants, claims and a restricted effect broker.

## Decision Outcome

Choose the third option. Start with one repository, one Linear queue and one active Issue. An authenticated operator records the user's explicit authorization through a host CLI with an audit reference, UTC expiry, bounded claim count, exact `origin/develop`, independent effects and explicit confirmation for `mergeRequestWrite`. The CLI does not treat a project file or Issue as an authorization source.

In one PostgreSQL transaction, recheck grant scope, expiry, revocation and quota, then reserve a single Issue under a unique active-claim constraint and a per-Issue increasing fencing token. Occupy quota on successful reservation; failure after reservation does not restore it automatically. Issue a host-owned per-Issue v2 execute Envelope. After revalidating Ready, identity and the full Receipt ledger, claim before registering Delegate and append-only v3 Start Receipt. Confirm all fields on reread before allowing implementation. Expired claims, partial registration, uncertain state and restarted runtimes require reconciliation or explicit handoff; no timeout-based reassignment.

Selection runs on authenticated, deduplicated queue-change or grant-created idle events, not on Agent queue polling. The upstream unconditional dispatch and retry paths must pass the same host gate. Workers receive neither raw Linear mutation tooling nor reusable Git/API credentials; external effects pass through a scoped broker and OS-level filesystem/network restrictions. An authorized closing PR may be squash-merged into `develop` only after current-base verification, stable fast gate and any applicable independent review; Done requires reread merge evidence.

## Consequences

- Vibe-Harness ships the contract and optional integration reference, not the Symphony fork, PostgreSQL service or production activation.
- Upstream Symphony defaults cannot be presented as secure auto-claim, and installing the Skill does not enable dispatch.
- Authorization, database availability, fencing and effect broker are hard runtime dependencies. Any missing guarantee stops dispatch while preserving evidence.
- v1/v2 Receipt records remain readable without migration; new writable executions use v3.

## Confirmation

Require provider-side dual-process transaction, revocation, event replay, lease expiry, restart and credential-bypass tests. Then run consumer contract tests and a bounded real Linear/Git integration with success, refusal and recovery cases. A mock-only test or a single-repository suite does not establish deployment readiness.

## Implementation status (2026-10-10)

The first slice of this decision is implemented and verified in the isolated environment: the Symphony Elixir fork carries the Grant CLI, the PostgreSQL Claim contract, host-signed de-duplicated queue events, the guarded dispatch state machine, scoped Linear/Git effect proxies, the offline sandbox and same-runtime restart reconciliation. Automatic dispatch stays off; `guarded` additionally requires three host environment variables and accepts only one signed single-Issue event, never a poll.

Evidence to date: the SQL contract and role boundary pass on a disposable PostgreSQL 17; the real-database integration case covers two concurrent reservations, a losing two-instance race that consumes no quota, conflicting retries, registration fencing, revocation, review, effect denial and same-runtime restart reconciliation; 52 offline Elixir cases cover Envelope freezing, event signature and replay refusal, forbidden-effect precedence and the credential-free worker context; the consumer accepts a v3 Receipt and v1 terminal event produced by the host code path and refuses tampered variants.

Not yet closed: Linear webhook ingress and signed-event delivery, a real model worker inside the sandbox, the post-worker verification and independent-review gates, and the closing-PR squash-merge sequence (the proxy exposes the scoped calls, but nothing drives them, so a dispatch result always reports `merge: nil`). Production Grant issuance, real queue claims, pushes and automatic merges remain unauthorized until those gaps are closed and the real isolated Linear/Git success, refusal and recovery paths pass.

## Review Trigger

Review when Symphony changes its dispatch or dynamic-tool contract, Linear offers native atomic claims, or the host isolation and broker mechanism changes.

## More Information

- Authorization decision: docs/adr/ADR-0008-bounded-linear-auto-claim.md
- Current rule: docs/rules/linear-workflow.md
- Integration reference: skills/integrations/linear-workflow/references/symphony-host.md
