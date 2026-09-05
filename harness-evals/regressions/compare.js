const DEFAULT_THRESHOLDS = Object.freeze({ rate: 0.05, efficiency: 0.10 });

function key(result) {
  return `${result.source.kind}:${result.source.benchmark ?? ''}:${result.scenario.id}`;
}

function failureModes(result) {
  return new Set((result.failures ?? []).map((failure) => `${failure.taxonomy ?? 'Unknown Failure'}:${failure.code ?? 'unknown'}`));
}

function metric(result, group, name) {
  const candidate = result.metrics?.[group]?.[name];
  return candidate?.state === 'value' || candidate?.state === 'partial' ? candidate.value : null;
}

function comparePair(baseline, candidate, thresholds) {
  const reasons = [];
  if (baseline.fingerprint.measurementHash !== candidate.fingerprint.measurementHash) reasons.push('measurement-fingerprint-mismatch');
  const baselineSuccess = metric(baseline, 'outcome', 'taskSuccessRate');
  const candidateSuccess = metric(candidate, 'outcome', 'taskSuccessRate');
  const baselineCompliance = metric(baseline, 'workflow', 'workflowCompliance');
  const candidateCompliance = metric(candidate, 'workflow', 'workflowCompliance');
  const baselineTime = metric(baseline, 'efficiency', 'wallTime');
  const candidateTime = metric(candidate, 'efficiency', 'wallTime');
  const baselineTokens = metric(baseline, 'efficiency', 'tokenUsage');
  const candidateTokens = metric(candidate, 'efficiency', 'tokenUsage');
  const deltas = {
    taskSuccessRate: baselineSuccess === null || candidateSuccess === null ? null : candidateSuccess - baselineSuccess,
    workflowCompliance: baselineCompliance === null || candidateCompliance === null ? null : candidateCompliance - baselineCompliance,
    wallTime: baselineTime === null || candidateTime === null || baselineTime === 0 ? null : (candidateTime - baselineTime) / baselineTime,
    tokenUsage: baselineTokens === null || candidateTokens === null || baselineTokens === 0 ? null : (candidateTokens - baselineTokens) / baselineTokens,
  };
  const baselineModes = failureModes(baseline);
  const newFailures = [...failureModes(candidate)].filter((mode) => !baselineModes.has(mode)).sort();
  const regressed = baseline.status !== 'failed' && candidate.status === 'failed'
    || deltas.taskSuccessRate !== null && deltas.taskSuccessRate <= -thresholds.rate
    || deltas.workflowCompliance !== null && deltas.workflowCompliance <= -thresholds.rate
    || newFailures.length > 0;
  const improved = !regressed && (
    deltas.taskSuccessRate !== null && deltas.taskSuccessRate >= thresholds.rate
    || deltas.workflowCompliance !== null && deltas.workflowCompliance >= thresholds.rate
    || deltas.wallTime !== null && deltas.wallTime <= -thresholds.efficiency
    || deltas.tokenUsage !== null && deltas.tokenUsage <= -thresholds.efficiency
  );
  return {
    scenarioId: candidate.scenario.id,
    status: reasons.length > 0 ? 'insufficient-evidence' : regressed ? 'regressed' : improved ? 'improved' : 'equivalent',
    reasons,
    deltas,
    newFailureModes: newFailures,
  };
}

export function compareResults({ baseline, candidateResults = [], thresholds = DEFAULT_THRESHOLDS } = {}) {
  if (!baseline || !Array.isArray(baseline.results)) throw new TypeError('baseline with results is required');
  if (!Array.isArray(candidateResults)) throw new TypeError('candidateResults must be an array');
  const baselineByKey = new Map(baseline.results.map((result) => [key(result), result]));
  const pairs = candidateResults.map((candidate) => {
    const previous = baselineByKey.get(key(candidate));
    return previous
      ? comparePair(previous, candidate, { ...DEFAULT_THRESHOLDS, ...thresholds })
      : { scenarioId: candidate.scenario.id, status: 'insufficient-evidence', reasons: ['baseline-result-missing'], deltas: {}, newFailureModes: [...failureModes(candidate)].sort() };
  });
  const unpairedBaseline = baseline.results.filter((result) => !candidateResults.some((candidate) => key(candidate) === key(result)));
  for (const result of unpairedBaseline) {
    pairs.push({ scenarioId: result.scenario.id, status: 'insufficient-evidence', reasons: ['candidate-result-missing'], deltas: {}, newFailureModes: [] });
  }
  const newFailureModes = [...new Set(pairs.flatMap((pair) => pair.newFailureModes))].sort();
  const status = pairs.some((pair) => pair.status === 'insufficient-evidence') ? 'insufficient-evidence' : 'comparable';
  const conclusion = status === 'insufficient-evidence'
    ? 'unavailable'
    : pairs.some((pair) => pair.status === 'regressed')
      ? 'regressed'
      : pairs.some((pair) => pair.status === 'improved')
        ? 'improved'
        : 'no-material-change';
  return {
    schemaVersion: 1,
    status,
    conclusion,
    thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
    pairs,
    improvements: pairs.filter((pair) => pair.status === 'improved').map((pair) => pair.scenarioId),
    regressions: pairs.filter((pair) => pair.status === 'regressed').map((pair) => pair.scenarioId),
    equivalent: pairs.filter((pair) => pair.status === 'equivalent').map((pair) => pair.scenarioId),
    insufficientEvidence: pairs.filter((pair) => pair.status === 'insufficient-evidence').map((pair) => pair.scenarioId),
    newFailureModes,
  };
}
