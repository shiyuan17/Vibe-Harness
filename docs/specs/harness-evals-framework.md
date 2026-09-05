# Harness Evals Framework

## Status and intent

状态：Implemented

This specification defines the canonical evaluation architecture for Vibe-Harness. It evaluates whether Harness rules, workflows, agents, collaboration, workspace isolation, context handling, verification, and recovery produce reliable observable behavior. It does not treat a correct final patch as sufficient evidence of a successful run.

The framework follows one experiment loop:

```text
RED -> GREEN -> Pressure -> Regression -> Trace Analysis
```

Internal Harness evaluations and external benchmarks use the same result and report model. External benchmark implementations stay behind adapters and retain their official task materializers and verifiers.

## Execution model

```text
Scenario or Benchmark Task
  -> Fixture materialization and preflight checks
  -> Harness Runner -> Agent and optional Subagents
  -> ATIF Trace + event stream + workspace evidence
  -> independent deterministic and semantic verification
  -> metrics + unified Result v3
  -> baseline comparison + regression report
```

The controller, verifier, and semantic judge are evaluation infrastructure. Their time, tokens, and failures are reported separately from the system under test.

### Components

| Component | Responsibility | Input | Output |
| --- | --- | --- | --- |
| Scenario | Declares the mechanism, real task, pressure variants, required capabilities, and acceptance evidence. | Versioned scenario JSON. | Runnable experiment definition. |
| Fixture | Builds a disposable workspace from synthetic files or a pinned public revision. | Fixture manifest and runtime capabilities. | Workspace, initial Git identity, write allowlist, and fault controls. |
| Runner | Owns lifecycle, budgets, process isolation, execution, interruption, resumption, evidence capture, and cleanup. | Scenario, fixture, Harness fingerprint, agent config, budget. | Every attempt, including blocked, cancelled, timed-out, and degraded attempts. |
| Agent/Subagent | Performs the evaluated work. | Task, workspace, Harness policy, tools. | Observable messages, tool actions, filesystem and Git effects. |
| Deterministic Check | Makes one assertion against an artifact, Git state, command result, process state, or trace event. | Read-only evidence context. | `passed`, `failed`, `blocked`, or `unverified` plus evidence references. |
| Verifier | Combines independent checks and optional semantic judging. It never relies on an agent's self-report. | Final workspace, trace, checks, hidden assets. | Outcome, workflow, evidence-integrity, and infrastructure verdicts. |
| Trace | Preserves observable execution without claiming private model reasoning. | Native runner events, tool calls, messages, Git snapshots, verifier events. | Redacted ATIF trajectory, correlated event stream, artifact index, integrity receipt. |
| Metrics | Computes explicitly defined counts, ratios, coverage, and missing-data reasons. | Result attempts and traces. | Outcome, workflow, agent, coordination, and efficiency measurements. |
| Result | Unifies Internal and External outcomes. | Attempts, checks, trace refs, metrics, fingerprints. | Result v3 JSON and report-ready summary. |
| Baseline | Freezes comparable measurement conditions and a Harness fingerprint. | Approved result set. | Immutable candidate or approved baseline. |
| Regression | Compares only compatible result sets and surfaces new failure modes. | Baseline and current results. | Improved, regressed, equivalent, and insufficient-evidence groups. |

## Public contracts

The controller remains Node.js. Python and benchmark-specific dependencies are contained under `harness-evals/external/` and invoked through adapters.

```ts
interface Runner {
  prepare(experiment): Promise<PreparedRun>;
  run(prepared): Promise<Attempt>;
  resume(checkpoint): Promise<Attempt>;
  cancel(runId, reason): Promise<Attempt>;
  collect(runId): Promise<EvidenceBundle>;
  cleanup(runId): Promise<CleanupReceipt>;
}

interface BenchmarkAdapter {
  discover(selection): Promise<BenchmarkTask[]>;
  materialize(task, destination): Promise<FixtureReceipt>;
  evaluate(task, evidence): Promise<OfficialVerdict>;
  normalize(task, verdict, trace): Promise<ResultV3>;
}

interface Check {
  check(readOnlyContext): Promise<CheckResult>;
}

interface Analyzer {
  analyze(trace, checks): Promise<{ metrics: Metric[]; findings: Finding[] }>;
}
```

Runner backends declare capabilities. The canonical capability IDs are `workspace-write`, `git`, `process-control`, `fault-injection`, `resume`, `context-compaction`, `native-subagents`, `worktree`, `merge`, and `token-telemetry`. A missing required capability produces a blocked result; the controller cannot synthesize an event and call the scenario passed.

Scenario v3 is the authoring contract. Result v3 is the common output contract. Readers may adapt legacy suite v1 and run/reference v1-v2 data, but unavailable trace fields and metrics remain explicitly unavailable. Legacy data is never inferred into new evidence.

## Evidence and trust boundary

Each online run uses a disposable synthetic workspace or a pinned public repository revision. Source repositories and user workspaces are never evaluation targets. The runner places hidden checks and evidence storage outside the Agent's write roots.

The persisted evidence bundle contains:

- a redacted native event stream and ATIF trajectory;
- Agent and Subagent lifecycle, parentage, dispatch, wait, handoff, and completion events;
- tool calls and terminal outcomes without credentials;
- file-diff and Git snapshots around material changes and verification;
- tests, builds, replans, interruptions, resumptions, failures, and recoveries;
- an artifact index with hashes and a trace-integrity receipt.

Decision-path analysis covers observable plans, explanations, and actions. It never claims access to hidden chain-of-thought. Credentials and private data are redacted before persistence. Full traces have a default 30-day retention; an approved baseline retains only its redacted evidence bundle, reproducibility manifest, and hashes.

Verifier tests establish final correctness. Workflow checks separately establish whether the Agent itself performed required validation after the last material change. Missing evidence is `unverified`, not success. Every started run emits a result even when infrastructure fails.

## Experiment phases

- **RED** runs the pre-change Harness with a frozen model, backend, budget, task, fixture, and verifier. An already passing run is recorded as `not-reproduced`; the Harness is not weakened to manufacture a failure.
- **Verifier negative control** feeds a known-bad artifact or trajectory to the checks. It validates the evaluator and is never reported as an Agent RED run.
- **GREEN** repeats RED measurement conditions after the smallest trace-supported Harness change.
- **Pressure** adds one deterministic trigger, then a two-factor combination, while keeping the base task and verifier constant.
- **Regression** selects affected scenarios plus the fixed critical set and retains every failed, degraded, blocked, and cancelled attempt.

## Metrics and failure analysis

All ratios report numerator, denominator, coverage, and missing-data reason. The minimum metric set is:

- Outcome: task success, first-pass success, regression pass, false completion, `pass@1`, `pass@k`, and `pass^k`.
- Workflow: compliance, rule violations by severity, verification coverage after final change, replan count, and recovery success.
- Agent: dispatches, delegation/handoff success, duplicate work, coordination failures, conflicts, merge failures, and required-fact loss.
- Efficiency: wall time by stage, tokens for all evaluated agents, tool calls, repeated searches at the same revision, observable context consumption, and compactions.
- Collaboration: parent bottleneck time, unnecessary delegation, and total/agent/coordination/judge cost partitions.

Trace findings use `rule`, `planning`, `reasoning`, `tool`, `context`, `coordination`, `verification`, `recovery`, or `infrastructure`. Fixture, verifier, and collector defects are separate infrastructure-origin codes. Each finding names the first observable deviation, evidence reference, affected Harness mechanism, evidence strength, and a way to validate the causal hypothesis. Causality requires a controlled comparison or ablation.

## Baselines, comparison, and run tiers

Fingerprints separate measurement conditions from the system under test. Measurement conditions include scenario, fixture, verifier, model, CLI, backend, platform, budget, repetition count, and dataset revision. The Harness fingerprint includes rules, workflows, skills, prompts, tools, agents, and context/verification policies. Changes to measurement conditions require a new baseline; Harness changes are the intended comparison variable.

Nightly runs use three independent repetitions by default. Comparisons use paired differences and scenario-clustered 95% bootstrap intervals with a fixed seed. Default materiality bounds, frozen before execution, are five percentage points for success/compliance and ten percent for time/tokens/cost. A critical failure blocks the relevant trusted online gate. Missing samples and infrastructure failures are reported and cannot improve a metric.

The run tiers are:

- **Fast/PR:** schema, verifier negative controls, legacy replay, impact selection, and selected trusted critical online scenarios when credentials are available.
- **Nightly:** H01-H20, pressure variants, legacy canary/execution suites, and single/native-multi comparisons.
- **Full/Release:** the complete Internal set plus pinned SWE-bench, Terminal-Bench, and CooperBench samples and an explicitly budgeted model/agent matrix.

Single-agent and multi-agent runs share the task, initial commit, model, permissions, and aggregate token/cost budget. Multi-agent is beneficial only when it improves success, speed, cost, or context isolation without violating quality guardrails.

## Extension and compatibility rules

- New Internal scenarios follow `harness-evals/docs/scenario-authoring.md`.
- Pressure factors come from `harness-evals/docs/pressure-catalog.md`; new factors require a deterministic trigger and observable recovery expectation.
- Official benchmark results remain intact and are nested in the unified result. Harness workflow checks are additional fields, never replacements for official verification.
- Existing `evals/` assets remain the source of legacy suites. They are read through adapters and are not copied into the new tree.
- Generated traces and raw reports are ignored by default. Only approved redacted baselines, summaries, and reproducibility manifests are committed.
