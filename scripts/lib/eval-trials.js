// Multi-trial aggregation for online evaluations.
// Produces per-case pass@k / pass^k summaries without forcing a gating threshold.
// Offline replay is deterministic (repetitions collapse to a single trial), so this
// module is only consumed by the online run path.

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// `trials` is the ordered array of k scoreCase() results for a single case id,
// where index 0 is repetition 1. Each result carries { passed, score }.
export function summarizeTrials(caseId, trials) {
  const repetitions = trials.length;
  const passedTrials = trials.filter((trial) => trial.passed).length;
  const perTrial = trials.map((trial, index) => ({
    repetition: index + 1,
    passed: Boolean(trial.passed),
    score: round(trial.score),
  }));
  const meanScore = repetitions === 0
    ? 0
    : round(trials.reduce((total, trial) => total + trial.score, 0) / repetitions);
  return {
    caseId,
    repetitions,
    passAt1: repetitions === 0 ? 0 : (trials[0].passed ? 1 : 0),
    passAtK: passedTrials >= 1 ? 1 : 0,
    passCaretK: passedTrials === repetitions ? 1 : 0,
    passedTrials,
    meanScore,
    perTrial,
  };
}
