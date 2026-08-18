---
id: ADR-0003
title: Lightweight GitFlow for development integration and release promotion
status: accepted
date: 2026-08-17
review-date: 2026-09-14
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Lightweight GitFlow for development integration and release promotion

## Context and Problem Statement

Running the complete release matrix for every development pull request makes small Linear Issues expensive to finish. At the same time, pushing every merged task directly to <code>main</code> couples daily integration to release-please and release verification. The repository needs a stable release branch without turning feature branches or a new <code>release/*</code> branch into long-lived integration surfaces.

## Decision Drivers

- Complete ordinary development Issues as soon as their reviewed code is integrated.
- Keep release verification and version publication isolated to the stable branch.
- Preserve Conventional Commits for release-please without reopening completed Issues.
- Keep task branches short-lived and avoid a permanent release branch.
- Make hotfix recovery and version-file synchronization deterministic.

## Considered Options

- Continue merging every task directly to <code>main</code> and run the complete release matrix for every pull request.
- Adopt trunk-based development with feature flags and no persistent integration branch.
- Adopt full GitFlow with long-lived <code>develop</code> and <code>release/*</code> branches.
- Adopt a lightweight three-layer model with short-lived task branches, <code>develop</code>, and <code>main</code>.

## Decision Outcome

Chosen option: lightweight GitFlow.

Normal <code>feat/*</code> and <code>fix/*</code> branches start from <code>origin/develop</code>, use squash merge, and close their Linear development Issue when the pull request merges to <code>develop</code>. A standalone Issue with no Parent, dependencies, or resource locks uses the single-task fast path. A clean sequential workspace may use the current clone; concurrent work, a dirty workspace, unrelated branch changes, or explicit isolation requires a separate worktree.

Release promotion uses a dedicated aggregate Release Issue and a merge-commit pull request from <code>develop</code> to <code>main</code>. The promotion description uses <code>Refs &lt;ISSUE-ID&gt;</code> and does not close already completed development Issues. After promotion, release-please remains explicitly targeted at <code>main</code>; its version pull request is reviewed and merged as the second release step. The Release Issue becomes Done only after the GitHub Release, assets, release smoke evidence, and <code>main</code> to <code>develop</code> back-sync all succeed.

Urgent fixes start from <code>origin/main</code> on <code>hotfix/*</code>, squash merge to <code>main</code>, and close their hotfix Issue there. A non-closing merge-commit pull request immediately back-syncs <code>main</code> to <code>develop</code>. The same back-sync follows every successful release so version files and release commits cannot be overwritten by a later promotion.

GitHub's default branch becomes <code>develop</code> only after release-please is pinned to <code>main</code>, the two CI gates and branch-source policy are active, and <code>develop</code> is created from a clean current <code>origin/main</code>. <code>main</code> accepts pull requests only from same-repository <code>develop</code>, <code>hotfix/*</code>, and release-please branches. No long-lived <code>release/*</code> branch is introduced.

CI exposes two stable required checks. <code>develop-gate</code> runs lightweight risk inspection for drafts and, for ready pull requests, <code>pnpm check</code>, <code>git diff --check</code>, risk evidence, and change-matrix-selected documentation, Skill, Eval, integration, or lifecycle checks. <code>main-release-gate</code> runs the complete cross-platform, Eval, integration, lifecycle, runtime, pack, and release verification suite. Low- and medium-risk changes may use author-enabled auto-merge after required checks. Public contracts, schemas, installer, runtime or Hook code, security boundaries, red-zone files, and release changes require full validation and at least one latest approving review from a non-author.

Linear branch-specific automation advances creation to In Progress, ready-for-review pull requests to In Review, passing required checks to Ready to Merge, and a closing merge into the declared target branch to Done. Release promotion and back-sync use non-closing references. These workspace automations remain administrator-applied configuration and are not inferred from local repository files.

## Consequences

- Ordinary tasks stop paying the full release verification cost and are not blocked by a release window.
- <code>main</code> represents released or actively releasing stable code; <code>develop</code> represents reviewed integrated code that may not be released yet.
- The repository gains one persistent integration branch and therefore requires automated back-sync and branch-source enforcement.
- Task branches should live no longer than about two working days; larger work is split or hidden behind a feature flag.
- If the product moves to continuous deployment, the extra integration branch should be reevaluated in favor of trunk-based development.

## Confirmation

Conformance is checked by branch-policy and approval scripts, deterministic Linear and risk-evidence tests, mirrored Git and Linear rules, the Release Issue template, GitHub Actions syntax checks, and four rehearsals: an ordinary feature pull request, a release promotion, a hotfix, and a release back-sync. Operational metrics are reviewed after four weeks: development pull-request lead time, CI wait time, branch lifetime, release frequency, back-sync failure rate, and merge-conflict rate. The target is at least a 50 percent reduction in low-risk task merge time while <code>main</code> retains release-grade verification.

## Review Trigger

Review this decision after the four-week observation window, when continuous deployment becomes the default, when back-sync failures or merge conflicts become material, or when GitHub and Linear provide a simpler equivalent release-boundary contract.

## More Information

- Linear workflow rule: rules/linear-workflow.md
- Git rule: rules/git-rules.md
- GitHub delivery guide: docs/github-delivery.md
- Linear workflow specification: docs/specs/linear-multi-agent-workflow-spec.md
- Release Issue template: skills/integrations/linear-workflow/references/release-issue.md
