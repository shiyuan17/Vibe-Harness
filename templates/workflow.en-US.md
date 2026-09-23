# Full lifecycle workflow

> Recommended steps, not a gate: tailor this flow to task size and risk; the existence of this file adds no fixed process. Quick-tier tasks may skip the entire flow and execute directly; light and full tiers merge or omit stages as needed.

> Long tasks maintain a state anchor per `governance-core.md`: establish it before the first substantive write, update the anchor stage when entering a new review, plan, implement, or verify stage, and read the anchor plus the current diff first on recovery. Delivery maps to the closing checklist of the delivery rules, not a fifth stage value.

> The fan-out boundary matches the collaboration criteria of `ai-collab-rules.md`: the write path stays single-agent by default; read-only exploration and evidence gathering may fan out; parallel writes are allowed only across modules with non-overlapping writeScope, and any shared contract keeps a single writer. Every heavy step of this workflow (whole-repository scans, full Spec/Plan/Tasks, multiple agents, worktrees, full test and documentation runs, deep review) follows the cost-and-escalation criteria in `governance-core.md`.

## Review (review)

- Input: the review request; the objects under review with their baseline (commit, scope); existing docs and reports.
- Output: a findings list and confirmed-correct items; every finding carries symptom, evidence anchor, impact, recommendation, verification status, and boundary, archived with the `finding-report.md` shell.
- Exit criteria: every in-scope object has a conclusion or an explicit unverified boundary.
- New session: when the retrieval surface exceeds one context window or an independent re-check is needed; persist the evidence anchors already gathered before opening one.
- Fan-out: read-only exploration and evidence gathering; sub-agent output is not a substitute for completion evidence — verify actual results before adopting them.
- Stop: when evidence gathering is blocked with no fallback, record the blockage and stop extending the sweep; out-of-scope findings become follow-up actions.

## Plan (plan)

- Input: review findings or a clear implementation goal; the relation chains of critical changes (dependencies, contracts, tests, docs).
- Output: an implementation plan — goal, non-goals, acceptance, impact scope, and implementation units (file scope, verification); the direct-or-split disposition and its rationale.
- Exit criteria: every implementation unit has a clear output and a focused verification method; the relation chains of critical changes are checked.
- New session: when the plan will be handed to multiple parties or sessions, hand it over per unit with node dependencies and write ownership declared per `ai-collab-rules.md`.
- Fan-out: read-only lookups such as relation-chain retrieval; the plan itself is finalized by a single agent.
- Stop: when a product decision needs the user, a write exceeds authorization, or a red-zone action appears, record the blocker and request clarification or approval.

## Implement (implement)

- Input: the implementation plan and its authorization scope; the state anchor for long tasks.
- Output: actual changes; implementation unit status, decisions made, and blockers updated into the anchor or the task record.
- Exit criteria: all implementation units are complete or explicitly blocked; no disposable files are left without an owner.
- New session: update the anchor before the context approaches a compaction boundary; a new session resumes from the anchor plus the current diff instead of re-reading rule bodies.
- Fan-out: read-only exploration; parallel writes only across modules with non-overlapping writeScope, with a single writer per shared contract.
- Stop: stop and request approval before writes that exceed authorization or involve red-zone or irreversible actions; when retries without change make no progress, diagnose or change course.

## Verify (verify)

- Input: the implemented workspace and the completion claim.
- Output: verification receipts — actual commands or manual criteria with results, each bound to passed, failed, blocked, or unverified.
- Exit criteria: verification scope matches the completion claim; failures are fixed and the same or an equivalent check rerun after the last substantive change.
- New session: once receipts are durable (task record or project verification receipts) they can be cited across sessions; after a check passes, do not re-verify without new changes, failures, or unresolved doubts.
- Fan-out: result retrieval and evidence gathering; conclusions come from this run's actual command output, never from sub-agent claims.
- Stop: when required verification is blocked, report the concrete gap and stop — do not write partial completion as complete; retries without change stay bounded.

## Delivery (delivery)

- Input: implementation unit status and verification receipts.
- Output: a delivery record (result, actual changes, verification performed this run), organized with `delivery.md`.
- Exit criteria (closing checklist): implementation unit status agrees with the verification receipts, all decisions made are recorded, blockers are resolved or explicitly handed over, and the next action can be executed independently; disposable files are attributed and cleaned up. Delivery implemented in a worktree first closes the loop through the project entry point `worktree land` — dry-run prints the plan by default, `--write` merges back into the primary checkout's current branch through the verify gate, and push plus branch deletion happen only with an explicit `--push`; an unmerged worktree blocks any "integrated" claim.
- New session: once delivery is complete and the next action is independently executable, that action is the entry point for a new session.
- Fan-out: none; delivery and the closing check stay with a single responsible agent.
- Stop: stop after delivery; do not start supplementary audits or out-of-scope work automatically; when blocked, hand the blockers over explicitly and finish.
