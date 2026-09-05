function metric(result, group, name) {
  const value = result?.metrics?.[group]?.[name];
  return value?.state === 'value' || value?.state === 'partial' ? value.value : null;
}

function relativeImprovement(single, multi) {
  if (single === null || multi === null || single === 0) return null;
  return (single - multi) / single;
}

export function compareAgentConditions({ single, multi, rateThreshold = 0.05, efficiencyThreshold = 0.10 } = {}) {
  if (single?.schemaVersion !== 3 || multi?.schemaVersion !== 3) throw new TypeError('single and multi Result v3 values are required');
  if (single.scenario.id !== multi.scenario.id) throw new Error('single and multi results must use the same scenario');
  const successDelta = metric(multi, 'outcome', 'taskSuccessRate') === null || metric(single, 'outcome', 'taskSuccessRate') === null
    ? null
    : metric(multi, 'outcome', 'taskSuccessRate') - metric(single, 'outcome', 'taskSuccessRate');
  const complianceDelta = metric(multi, 'workflow', 'workflowCompliance') === null || metric(single, 'workflow', 'workflowCompliance') === null
    ? null
    : metric(multi, 'workflow', 'workflowCompliance') - metric(single, 'workflow', 'workflowCompliance');
  const deltas = {
    taskSuccessRate: successDelta,
    workflowCompliance: complianceDelta,
    wallTimeImprovement: relativeImprovement(metric(single, 'efficiency', 'wallTime'), metric(multi, 'efficiency', 'wallTime')),
    tokenImprovement: relativeImprovement(metric(single, 'efficiency', 'tokenUsage'), metric(multi, 'efficiency', 'tokenUsage')),
    contextImprovement: relativeImprovement(metric(single, 'efficiency', 'contextConsumption'), metric(multi, 'efficiency', 'contextConsumption')),
  };
  const qualityProtected = multi.status !== 'failed'
    && (successDelta === null || successDelta >= -rateThreshold)
    && (complianceDelta === null || complianceDelta >= -rateThreshold);
  const benefits = [
    successDelta !== null && successDelta >= rateThreshold ? 'success' : null,
    deltas.wallTimeImprovement !== null && deltas.wallTimeImprovement >= efficiencyThreshold ? 'wall-time' : null,
    deltas.tokenImprovement !== null && deltas.tokenImprovement >= efficiencyThreshold ? 'tokens' : null,
    deltas.contextImprovement !== null && deltas.contextImprovement >= efficiencyThreshold ? 'context' : null,
  ].filter(Boolean);
  const evidenceAvailable = successDelta !== null || Object.values(deltas).some((value) => value !== null);
  return {
    schemaVersion: 1,
    scenarioId: single.scenario.id,
    status: !evidenceAvailable ? 'insufficient-evidence' : qualityProtected && benefits.length > 0 ? 'beneficial' : 'not-beneficial',
    effective: evidenceAvailable && qualityProtected && benefits.length > 0,
    qualityProtected,
    benefits,
    deltas,
  };
}
