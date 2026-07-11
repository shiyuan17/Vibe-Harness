# AI Collaboration Rules

AI collaboration separates facts, decisions, implementation, verification, and approval so that model confidence cannot become project truth.

## Evidence boundaries

- Repository files, current command output, external contracts, and explicit human decisions are evidence. Model recollection and generated summaries are hypotheses until checked.
- Never invent APIs, fields, permissions, schemas, test results, deployments, or reviewer approval.
- Tool failures, incomplete reads, stale indexes, and unverified external state must be reported with the fallback used.
- Preserve user changes. If ownership is unclear and overlap matters, stop before editing.

## Roles

- The primary agent owns clarification, scope, integration, and final accounting.
- An implementation agent may report its changes and tests but cannot approve high-risk work it created.
- A test agent proves stated acceptance criteria; it does not redefine scope.
- A reviewer is read-only by default and classifies confirmed findings separately from risks that need evidence.
- Human confirmation remains mandatory for red-zone changes and unresolved business or security decisions.

## Multi-agent and tool use

Parallel work requires independent deliverables, explicit write scopes, dependencies, and conflict rules. External skills and tools supplement local governance; they do not override repository instructions, red-zone gates, or verification requirements.

## Handoff

Record the current phase and status, completed and incomplete work, latest evidence, failed commands, Git/worktree/merge-back state, next action, and resume hint. Do not use memory or a handoff to bypass validation or review.

## Completion standard

Completion requires evidence from the current workspace, an accountable reviewer for high-risk work, and a delivery packet that distinguishes verified results from residual risk.
