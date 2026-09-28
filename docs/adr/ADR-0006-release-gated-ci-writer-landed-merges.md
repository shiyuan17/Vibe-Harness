---
id: ADR-0006
title: Release-gated CI with writer-landed develop merges
status: accepted
date: 2026-09-12
review-date: 2026-10-10
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: [ADR-0003]
superseded-by: null
---

# Release-gated CI with writer-landed develop merges

## Context and Problem Statement

ADR-0003's lightweight GitFlow completed development Issues when a reviewed pull request merged to <code>develop</code>, but it placed a <code>develop-gate</code> required status check on every task pull request and left the merge to a human or to an author-enabled auto-merge. In practice this made small, low-risk Issues wait on CI and on a merge decision long after implementation and local verification were done, turning short tasks into long-lived ones. The repository still needs a stable release boundary and a way to keep develop merges honest.

## Decision Drivers

- Complete ordinary development Issues as soon as their verified code lands on <code>develop</code>.
- Keep CI and release verification at the release boundary, not on every daily merge.
- Let the writer that already holds the Issue registration land its own develop merge.
- Avoid adding a permanent release branch or a second integration surface.
- Keep <code>main</code>'s release-grade verification and Linear's merge-equals-Done evidence intact.

## Considered Options

- Keep ADR-0003 unchanged: <code>develop-gate</code> on every task pull request and a human or author-enabled merge.
- Adopt trunk-based development with no <code>develop</code> branch.
- Move all merge-time CI to the release boundary and let the writer squash-merge its own pull request into <code>develop</code>.
- Let writers push directly to <code>develop</code> without a pull request.

## Decision Outcome

Chosen option: release-gated CI with writer-landed develop merges.

Normal <code>feat/*</code> and <code>fix/*</code> branches still start from <code>origin/develop</code> and squash-merge back to <code>develop</code>, and a completed development Issue still becomes Done only when its closing pull request merges to the declared exact target ref. The <code>develop</code> ruleset no longer requires a status check, and merges to <code>develop</code> require neither remote CI nor a required approval at any risk level; a writer that holds the Issue registration may land its own squash merge once local verification for the change has passed. <code>Ready to Merge</code> is reserved for gated targets (<code>main</code> and any <code>release/*</code>). The full release gate (<code>main-release-gate</code>) runs only for <code>develop</code> to <code>main</code> promotions, <code>hotfix/*</code> to <code>main</code>, and release branches. Hotfix and back-sync behavior is otherwise unchanged.

## Consequences

- Ordinary development Issues stop paying remote CI and merge-approval latency; the writer controls the landing step.
- <code>develop</code> is no longer continuously CI-verified per task, so integration or regression defects may first surface at the release gate; local verification before the merge is the only per-task check, and the release gate must stay strict.
- High-risk changes (public contracts, schemas, installer, runtime or Hook code, security boundaries, red-zone files) can now reach <code>develop</code> without a remote gate; their protection moves entirely to the release boundary and to local verification.
- <code>main</code> keeps release-grade verification, so the release boundary remains the last line of defense.

## Confirmation

Conformance is checked by the Linear workflow rule and Skill, the GitHub delivery configuration, deterministic Linear and risk-evidence tests, mirrored Git and Linear rules, and the release Issue template. The deterministic Linear tests assert the <code>develop</code> fast lane, the writer-landed squash merge, the release-gated CI boundary, and the reduced role of <code>Ready to Merge</code>; the linear-workflow-online Eval suite keeps NO_AUTO_CLAIM.

## Review Trigger

Review this decision when the release gate repeatedly catches defects that should have been detected earlier, when merge conflicts or back-sync failures become material, when continuous deployment becomes the default, or when the cost of a broken <code>develop</code> exceeds the latency this decision removes.

## More Information

- Superseded: docs/adr/ADR-0003-lightweight-gitflow.md
- Linear workflow rule: docs/rules/linear-workflow.md
- Git rule: docs/rules/git-rules.md
- GitHub delivery guide: docs/github-delivery.md
- Linear workflow specification: docs/specs/linear-multi-agent-workflow-spec.md
