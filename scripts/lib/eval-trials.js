// Multi-trial aggregation for online evaluations.
// Produces per-case pass@k / pass^k summaries without forcing a gating threshold.
// Offline replay is deterministic (repetitions collapse to a single trial), so this
// module is only consumed by the online run path.

import { sanitizeEvalValue } from './eval-scoring.js';

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// `trials` is the ordered array of k scoreCase() results for a single case id,
// where index 0 is repetition 1. Each result carries { passed, score }.
export function summarizeTrials(caseId, trials) {
  const repetitions = trials.length;
  const results = trials.map((trial) => trial.caseResult ?? trial);
  const passedTrials = results.filter((trial) => trial.passed).length;
  const perTrial = trials.map((trial, index) => {
    const result = trial.caseResult ?? trial;
    const observation = trial.observation;
    return sanitizeEvalValue({
      repetition: index + 1,
      passed: Boolean(result.passed),
      score: round(result.score),
      criticalFailures: result.criticalFailures ?? 0,
      flakyFailure: Boolean(result.flakyFailure),
      failedAssertions: (result.assertions ?? [])
        .filter((assertion) => !assertion.passed)
        .map(({ critical, dimension, kind }) => ({ critical, dimension, kind })),
      ...(observation ? {
        toolSummary: {
          commandCount: observation.metrics?.commands?.length ?? 0,
          errorCategories: observation.metrics?.errorCategories ?? [],
          hookReasonCodes: observation.metrics?.hookReasonCodes ?? [],
          hookTimings: observation.metrics?.hookTimings ?? [],
          durationMs: observation.metrics?.durationMs ?? 0,
          recoverableToolErrorCount: observation.metrics?.recoverableToolErrorCount ?? 0,
          ruleCoverage: observation.metrics?.ruleCoverage ?? { expected: [], measured: [] },
          skillTriggers: observation.metrics?.skillTriggers ?? [],
          testSummary: observation.metrics?.testSummary,
          tokenUsage: observation.metrics?.tokenUsage,
          toolCalls: observation.metrics?.toolCalls ?? 0,
          toolOutcomeSummary: observation.metrics?.toolOutcomeSummary,
          toolOutcomes: observation.metrics?.toolOutcomes ?? [],
          toolTypes: observation.metrics?.toolTypes ?? [],
          totalTokens: observation.metrics?.tokenUsage?.totalTokens ?? observation.metrics?.totalTokens ?? 0,
          verificationCommandCount: observation.metrics?.verificationCommandCount ?? 0,
          workspaceSummary: observation.metrics?.workspaceSummary,
          ...(typeof observation.metrics?.dangerousOperationBlocked === 'boolean'
            ? { dangerousOperationBlocked: observation.metrics.dangerousOperationBlocked }
            : {}),
        },
        diagnostics: observation.diagnostics ?? [],
      } : {}),
    });
  });
  const meanScore = repetitions === 0
    ? 0
    : round(results.reduce((total, trial) => total + trial.score, 0) / repetitions);
  return {
    caseId,
    repetitions,
    passAt1: repetitions === 0 ? 0 : (results[0].passed ? 1 : 0),
    passAtK: passedTrials >= 1 ? 1 : 0,
    passCaretK: repetitions === 0 ? 0 : (passedTrials === repetitions ? 1 : 0),
    passedTrials,
    meanScore,
    perTrial,
  };
}
