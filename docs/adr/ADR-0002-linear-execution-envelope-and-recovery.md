---
id: ADR-0002
title: Linear execution envelope, recovery, and delivery boundary
status: proposed
date: 2026-08-15
review-date: 2027-02-15
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [linear-workflow-users]
informed: [vibe-harness-contributors]
supersedes: []
superseded-by: null
---

# Linear execution envelope, recovery, and delivery boundary

## Context and Problem Statement

ADR-0001 defines explicit initiation, execution identity, and native Linear DAG semantics. Those controls are insufficient if a session can broaden effects after a synchronization request, recover an obsolete objective after context compaction, overwrite live state with an old plan, repeatedly traverse an unchanged DAG, or create a change request against an unintended base.

The workflow needs one request-scoped authority boundary that survives recovery without turning Ready state into permission. It also needs provider-neutral GitHub PR and GitLab MR rules and an honest distinction between delivered policy assets and host-enforced runtime controls.

## Decision Drivers

- Preserve the latest user intent across context compaction, retry, and tool reconnection.
- Authorize Linear, workspace, Git, change-request, and credential effects independently.
- Treat live external state as truth and prevent status oscillation caused by stale plans.
- Detect wrong PR/MR targets before external creation.
- Bound DAG reads and execution lifetime without adding a resident dispatcher.
- State which controls are Agent contracts and which require host support.

## Considered Options

- Treat Todo or Ready as sufficient authority to execute the next node.
- Infer all Git and credential effects from a general implementation request.
- Recover from summaries without a structured checkpoint.
- Reapply the old plan when it conflicts with current Linear or provider state.
- Re-read every DAG node after every compaction.
- Use one GitHub-specific PR convention for every provider.
- Introduce a request-scoped envelope, monotonic state protocol, cached DAG digest, and provider-aware delivery checks.

## Decision Outcome

Chosen option: a request-scoped Execution Envelope with fail-closed recovery and provider-aware delivery checks.

Before any write, the current request has a logical vibe-harness.execution-envelope/v1 object. Its modes are inspect, plan, linear-sync, execute, and monitor. Its independently authorized effects are linearWrite, workspaceWrite, gitBranch, gitCommit, gitPush, mergeRequestWrite, and credentialUse; forbidden effects take precedence. linear-sync permits only explicitly requested Linear mutations. Ready, Todo, satisfied dependencies, and queue membership remain conditions, not authority.

The envelope identifies the request, session, target Issue IDs, active objective, allowed and forbidden effects, and terminal condition. Completion of the current terminal condition ends execution. A normal write Issue ends after its authorized local delivery or, when change-request creation is authorized, after the PR/MR is created, re-read, synchronized to In Review, and handed off. Monitoring a human merge or starting another Ready node requires separate explicit initiation.

A recovery checkpoint retains the active objective, unique current Issue, completed facts, no-repeat set, next action, live states, blocker fingerprint, and dagStructureHash in addition to the envelope. When the provider supports a change cursor it also retains the optional dagChangeCursor. The first post-recovery write re-reads current Linear and Git/provider facts and validates the mode, target, and effect. Latest user intent overrides the checkpoint; live state overrides old plans and summaries. Missing or contradictory recovery facts permit read-only inspection only.

Context compaction inside the same runtime retains the existing execution and runtime IDs. A different runtime may not silently adopt an active Receipt; it uses the explicit handoff or release protocol from ADR-0001.

Manual Linear state changes use read, allowed-transition validation, write, and re-read confirmation. Normal code delivery progresses from Todo through In Progress, In Review, Ready to Merge, and Done. A backward, reopen, or correction transition requires separate authorization and a factual reason. In Progress, In Review, or Ready to Merge may not be reset to Todo to recreate an old Ready snapshot.

One user request may perform at most one full DAG traversal. It stores dagStructureHash over node identity, decomposition and dependency edges, kind, trigger, scope, resource locks, repository, and target branch, plus optional dagChangeCursor when the provider supports it. Only the digest and cursor together may prove the structure unchanged and permit delta reads of the current Issue, PR/MR, HEAD, and changed nodes. Without a cursor, the old digest alone cannot skip validation; incomplete visibility fails closed instead of causing another full traversal.

Every write Issue names an exact resolvable remote target ref. The phrase default branch is valid only when repository facts prove it is the implementation baseline. The workflow freezes the target ref and base SHA before implementation. Before PR/MR creation, it verifies the provider target and source merge-base against that baseline; a mismatch blocks external creation.

Commits use Refs followed by the Issue ID. GitHub PR and GitLab MR descriptions use Fixes followed by the Issue ID, or a provider-configured equivalent only after re-read confirms the same closing semantics. Creation is successful only after title, source, target, description, Issue link, and closing behavior are re-read. A Git credential helper is limited to transparent configured Git transport. Extracting or reusing its output for web or API authentication requires independent credential and external-write authority, and no credential or helper artifact may be written into a repository or worktree.

Vibe-Harness delivers these contracts through rules, Skills, templates, schemas, tests, and Eval assets. It does not claim that every host supplies a resident state service or observes every remote tool call. Hosts with structured session state should persist the envelope and checkpoint. Other hosts apply the Agent-level fail-closed contract; Hooks enforce only actions they can observe.

## Consequences

- A Linear synchronization request cannot silently become a coding, Git, or MR task.
- Context recovery continues the unique active objective or stops before writing.
- Live work status does not oscillate to satisfy stale planning snapshots.
- Wrong-base PRs and MRs are blocked before external creation.
- Large DAGs avoid unchanged repeated reads while incomplete evidence still fails closed.
- Credential reuse and provider-specific closing behavior require explicit authority.
- Full enforcement quality depends on host state persistence and tool visibility.

## Confirmation

Conformance is checked by mirrored governance and Linear rules, the Linear Skill and reference templates, the execution-envelope schema, deterministic tests, and recovery-focused Linear Eval cases. Required cases cover no execution after DAG-only synchronization, no next-node continuation, same-objective compaction recovery, live-state precedence, exact target refs, credential-helper isolation, pre-creation merge-base validation, and unchanged-DAG delta reads.

## Review Trigger

Review this decision if hosts provide a standard durable execution-envelope service, Linear provides a native request-scoped execution authorization primitive, Git providers expose a uniform closing contract, or monitoring becomes an explicitly authorized resident-service capability.

## More Information

- ADR-0001: docs/adr/ADR-0001-linear-explicit-execution-and-dag.md
- Linear workflow specification: docs/specs/linear-multi-agent-workflow-spec.md
- Governance rule: rules/governance-core.md
- Linear rule: rules/linear-workflow.md
- Git rule: rules/git-rules.md
- Integration Skill: skills/integrations/linear-workflow/SKILL.md
