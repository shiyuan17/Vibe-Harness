import { buildResultV3 } from '../lib/result.js';

function assertionChecks(trial, repetition) {
  const failures = new Set(trial.failedAssertions ?? []);
  if (failures.size === 0) {
    return [{
      id: `legacy-trial-${repetition}`,
      category: 'outcome',
      severity: 'critical',
      status: trial.passed ? 'passed' : 'failed',
      code: trial.passed ? null : 'LEGACY_TRIAL_FAILED',
    }];
  }
  return [...failures].map((value, index) => ({
    id: `legacy-assertion-${repetition}-${index + 1}`,
    category: 'outcome',
    severity: value?.critical === false ? 'major' : 'critical',
    status: 'failed',
    code: typeof value === 'string' ? value : (value?.kind ?? 'LEGACY_ASSERTION_FAILED'),
  }));
}

export function adaptLegacyRun(run, { sourceKind = 'internal' } = {}) {
  if (!run || ![1, 2].includes(run.schemaVersion)) throw new TypeError('legacy run must use schemaVersion 1 or 2');
  const summaries = run.trialSummaries ?? [];
  return summaries.map((summary) => {
    const attempts = (summary.perTrial ?? []).map((trial, index) => ({
      id: `attempt-${trial.repetition ?? index + 1}`,
      ordinal: trial.repetition ?? index + 1,
      phase: 'legacy',
      status: trial.passed ? 'passed' : 'failed',
      score: Number.isFinite(trial.score) ? trial.score : null,
      durationMs: Number.isFinite(trial.toolSummary?.durationMs) ? trial.toolSummary.durationMs : null,
      tokenUsage: trial.toolSummary?.tokenUsage ?? null,
      events: [],
      completionClaim: null,
      verification: { passed: trial.passed, status: trial.passed ? 'passed' : 'failed' },
      legacy: { repetition: trial.repetition ?? index + 1 },
    }));
    const checks = (summary.perTrial ?? []).flatMap((trial, index) => assertionChecks(trial, trial.repetition ?? index + 1));
    return buildResultV3({
      scenario: {
        id: summary.caseId,
        title: summary.caseId,
        version: run.suite?.version ?? null,
        source: sourceKind,
      },
      attempts,
      checks,
      traceRefs: [],
      fingerprint: {
        measurement: {
          suiteId: run.suite?.id ?? null,
          suiteVersion: run.suite?.version ?? null,
          suiteHash: run.suite?.hash ?? run.fingerprint?.suiteHash ?? null,
          model: run.fingerprint?.model ?? null,
          runner: run.fingerprint?.runner ?? null,
          cli: run.fingerprint?.agent ?? null,
          backend: run.runtime?.backend ?? null,
          provider: run.runtime?.provider ?? null,
          reasoningEffort: run.runtime?.reasoningEffort ?? null,
          repetitions: summary.repetitions ?? attempts.length,
        },
        harness: {
          configHash: run.fingerprint?.configHash ?? null,
          assets: run.fingerprint?.assets ?? null,
        },
      },
      generatedAt: run.generatedAt,
      source: { kind: sourceKind, taskId: summary.caseId },
    });
  });
}

export function adaptLegacyRuns(runs, options) {
  if (!Array.isArray(runs)) throw new TypeError('runs must be an array');
  return runs.flatMap((run) => adaptLegacyRun(run, options));
}
