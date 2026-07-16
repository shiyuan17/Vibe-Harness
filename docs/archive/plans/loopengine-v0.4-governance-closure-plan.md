# LoopEngine v0.4 Governance Closure Implementation Plan

Status: Completed. This document is retained for implementation history only.

> **For agentic workers:** Execute inline with test-driven development. Each task must finish its own red-green cycle before the next task starts.

**Goal:** Make LoopEngine's lifecycle, task evidence, review, verification, and CI contracts internally consistent and machine-enforced.

**Architecture:** Keep manifests and Markdown as the installable governance surface, extend the existing zero-dependency runtime validators for semantic gates, and add a separate CLI command for executing target-project checks. Preserve both existing installer lifecycles.

**Tech Stack:** Node.js ESM, Node test runner, JSON Schema 2020-12, Markdown, GitHub Actions, pnpm 10.

## Global Constraints

- MVP writes use `--project <path> --target codex --write`.
- legacy/internal writes use `--target <path> --apply --confirm-red-zone`.
- `validate --project` remains read-only and never executes target commands.
- No global Agent configuration writes and no overwrite without `--force`.
- Reusable core assets must contain no project-specific identifiers.

### Task 1: Unify lifecycle and review documentation

**Files:** `AGENTS.md`, `README.md`, `README.zh-CN.md`, `docs/architecture.md`, `docs/specs/loopengine-v1-spec.md`, `rules/workflow.md`, `rules/task-lifecycle.md`, `rules/task-rules.md`, `rules/review-rules.md`, `workflows/full.md`, `templates/review-packet.md`.

- [x] Add regression assertions for the command table, nine-stage wording, and Medium deferral contract.
- [x] Run focused tests and confirm they fail on the existing contradictions.
- [x] Update the documents while preserving legacy compatibility.
- [x] Run focused tests and confirm they pass.

### Task 2: Enforce task acceptance evidence

**Files:** `schemas/task.schema.json`, `runtime/governance/lib/task-validation.mjs`, `tests/manifest-schema.test.js`, `tests/governance-runtime.test.js`.

- [x] Add failing tests for done tasks without owner, verifier, structured criteria, and matching evidence.
- [x] Extend the schema with structured criteria, evidence, timebox, and deferral types while preserving open-task compatibility.
- [x] Extend semantic validation for done tasks and parent/child ownership.
- [x] Run governance and schema tests.

### Task 3: Add explicit project verification

**Files:** `scripts/loopengine.js`, `scripts/lib/project-verification.js`, `tests/project-verification.test.js`, `README.md`, `README.zh-CN.md`.

- [x] Add failing CLI tests for success, missing command, manual-command refusal, explicit manual execution, and propagated failure.
- [x] Implement sequential command execution with structured output and no shell interpolation.
- [x] Wire `verify --project` without changing `validate --project`.
- [x] Run focused CLI tests.

### Task 4: Add failure and retrospective artifacts

**Files:** `templates/failure-report.md`, `templates/retrospective-template.md`, `adapters/codex/install-map.json`, `scripts/lib/pack-validation.js`, manifest and rules tests.

- [x] Add failing tests requiring both templates and their semantic fields.
- [x] Add templates and install mappings for core/full as appropriate.
- [x] Upgrade pack validation beyond bare section-name checks for these contracts.
- [x] Run pack and adapter tests.

### Task 5: Add CI lifecycle gates

**Files:** `.github/workflows/ci.yml`, `scripts/smoke-lifecycles.js`, `package.json`, tests for script/CI declarations.

- [x] Add failing structural tests for CI and a cross-platform smoke command.
- [x] Implement a Node temporary-directory smoke runner for both lifecycles.
- [x] Add `smoke:lifecycle` and CI commands.
- [x] Run the smoke command locally.

### Task 6: Full review and verification

- [x] Review the complete diff for correctness, clarity, architecture, security, and test coverage.
- [x] Run `pnpm test`, `pnpm check`, `git diff --check`, both explicit lifecycle smoke sequences, and `pnpm smoke:lifecycle`.
- [x] Record any unverified item and do not claim completion while one remains.
