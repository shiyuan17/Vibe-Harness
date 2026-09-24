const ADJUDICATED_ATTEMPT_STATUSES = new Set(['passed', 'failed']);

/**
 * Relative billing weights for the token classes providers price apart.
 *
 * Cached input is billed at a fraction of uncached input and output at a
 * multiple of it, so a flat `totalTokens` sum cannot tell a change that trades
 * cache reads for output tokens from one that removes tokens outright. These
 * are relative weights, not prices: the pack has no authoritative price list
 * for every provider and gateway its hosts run on, and publishing invented
 * dollar figures would fabricate evidence. A caller that owns a price list
 * passes its own weights through `buildMetrics({ billingWeights })`.
 */
export const DEFAULT_BILLING_WEIGHTS = Object.freeze({
  cachedInput: 0.1,
  output: 8,
  uncachedInput: 1,
});

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** @param {unknown} value */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function ratioMetric(numerator, denominator, {
  collected = denominator,
  eligible = denominator,
  total = denominator,
  missingReason = null,
} = {}) {
  const state = denominator > 0 ? (collected < eligible ? 'partial' : 'value') : 'unavailable';
  return {
    value: denominator > 0 ? round(numerator / denominator) : null,
    unit: 'ratio',
    numerator,
    denominator,
    coverage: { collected, eligible, total },
    state,
    missingReason: state === 'unavailable' ? (missingReason ?? 'no-eligible-observations') : null,
  };
}

export function scalarMetric(value, unit, {
  collected = Number.isFinite(value) ? 1 : 0,
  eligible = 1,
  total = eligible,
  missingReason = null,
} = {}) {
  const available = Number.isFinite(value);
  return {
    value: available ? value : null,
    unit,
    coverage: { collected: available ? collected : 0, eligible, total },
    state: available ? (collected < eligible ? 'partial' : 'value') : 'unavailable',
    missingReason: available ? null : (missingReason ?? 'telemetry-not-reported'),
  };
}

function attemptEvents(attempts) {
  return attempts.flatMap((attempt) => attempt.events ?? []);
}

/**
 * @param {Array<Record<string, any>>} events
 * @param {string} type
 * @param {(event: Record<string, any>) => boolean} [predicate]
 */
function countEvents(events, type, predicate = () => true) {
  return events.filter((event) => event.type === type && predicate(event)).length;
}

function repeatedSearches(events) {
  const seen = new Set();
  let repeated = 0;
  for (const event of events) {
    if (event.type !== 'tool-call' || !/search|find|grep/iu.test(event.name ?? '')) continue;
    const key = JSON.stringify([event.name ?? '', event.query ?? event.arguments ?? null, event.repositoryVersion ?? null]);
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  return repeated;
}

/**
 * @param {Array<Record<string, any>>} attempts
 * @param {string} key
 */
function totalTelemetry(attempts, key) {
  const values = attempts.map((attempt) => attempt[key]).filter(Number.isFinite);
  return {
    total: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
    collected: values.length,
  };
}

/**
 * Splits one attempt's usage into billing classes. Providers report
 * `input_tokens` inclusive of the cached prefix, and reasoning tokens inside
 * `output_tokens`, so both are subtracted out rather than added on. An attempt
 * that carries only a pre-summed `totalTokens` is not collected: guessing the
 * split would silently misprice it.
 *
 * @param {Record<string, any>} attempt
 * @returns {{uncachedInput: number, cachedInput: number, output: number, reasoning: number, input: number} | null}
 */
function attemptBilling(attempt) {
  const usage = attempt?.tokenUsage;
  if (!usage || typeof usage !== 'object') return null;
  const input = finiteOrNull(usage.inputTokens ?? usage.promptTokens);
  const output = finiteOrNull(usage.outputTokens ?? usage.completionTokens);
  if (input === null && output === null) return null;
  const inputTokens = Math.max(0, input ?? 0);
  const outputTokens = Math.max(0, output ?? 0);
  const cachedInput = Math.min(finiteOrNull(usage.cachedInputTokens ?? usage.cachedTokens) ?? 0, inputTokens);
  return {
    cachedInput,
    input: inputTokens,
    output: outputTokens,
    reasoning: Math.min(finiteOrNull(usage.reasoningOutputTokens) ?? 0, outputTokens),
    uncachedInput: inputTokens - cachedInput,
  };
}

/**
 * @param {Array<Record<string, any>>} attempts
 * @param {{cachedInput: number, output: number, uncachedInput: number}} weights
 */
function tokenBilling(attempts, weights) {
  const collected = attempts.map(attemptBilling).filter((entry) => entry !== null);
  const coverage = { collected: collected.length, eligible: attempts.length, total: attempts.length };
  const sum = (key) => collected.reduce((total, entry) => total + entry[key], 0);
  const inputTokens = sum('input');
  const cachedInput = sum('cachedInput');
  const costUnits = collected.length === 0
    ? null
    : (sum('uncachedInput') * weights.uncachedInput)
      + (cachedInput * weights.cachedInput)
      + (sum('output') * weights.output);
  return {
    cachedInputTokens: scalarMetric(collected.length > 0 ? cachedInput : null, 'tokens', coverage),
    cacheHitRate: ratioMetric(cachedInput, inputTokens, coverage),
    costUnits: scalarMetric(costUnits === null ? null : round(costUnits), 'cost-units', coverage),
    outputTokens: scalarMetric(collected.length > 0 ? sum('output') : null, 'tokens', coverage),
    reasoningOutputTokens: scalarMetric(collected.length > 0 ? sum('reasoning') : null, 'tokens', coverage),
    uncachedInputTokens: scalarMetric(collected.length > 0 ? sum('uncachedInput') : null, 'tokens', coverage),
    weights: { ...weights },
  };
}

/** @param {{attempts?: Array<Record<string, any>>, checks?: Array<Record<string, any>>, billingWeights?: {cachedInput: number, output: number, uncachedInput: number}}} options */
export function buildMetrics({ attempts = [], checks = [], billingWeights = DEFAULT_BILLING_WEIGHTS } = {}) {
  const adjudicated = attempts.filter((attempt) => ADJUDICATED_ATTEMPT_STATUSES.has(attempt.status));
  const passed = adjudicated.filter((attempt) => attempt.status === 'passed').length;
  const completionClaims = adjudicated.filter((attempt) => typeof attempt.completionClaim === 'boolean');
  const falseClaims = completionClaims.filter((attempt) => attempt.completionClaim && attempt.verification?.passed === false).length;
  const applicableChecks = checks.filter((check) => check.status !== 'not-applicable');
  const workflowChecks = applicableChecks.filter((check) => check.category === 'workflow');
  const verificationChecks = applicableChecks.filter((check) => check.category === 'verification');
  const recoverable = attempts.filter((attempt) => attempt.recovery?.eligible === true);
  const events = attemptEvents(attempts);
  const duration = totalTelemetry(attempts, 'durationMs');
  const tokenValues = attempts.map((attempt) => attempt.tokenUsage?.totalTokens).filter(Number.isFinite);
  const contextValues = attempts.map((attempt) => attempt.contextUsage?.peakTokens).filter(Number.isFinite);
  const regressionAttempts = adjudicated.filter((attempt) => attempt.phase === 'regression');
  const toolCalls = countEvents(events, 'tool-call');
  const observedEventAttempts = attempts.filter((attempt) => Array.isArray(attempt.events));
  const handoffs = events.filter((event) => event.type === 'handoff');
  const handoffFacts = handoffs.flatMap((event) => {
    const expected = Array.isArray(event.expectedFacts) ? event.expectedFacts : [];
    const present = new Set(Array.isArray(event.presentFacts) ? event.presentFacts : []);
    return expected.map((fact) => present.has(fact));
  });
  const coordinationEvents = events.filter((event) => event.type === 'coordination');

  return {
    outcome: {
      taskSuccessRate: ratioMetric(passed, adjudicated.length, { collected: adjudicated.length, eligible: attempts.length, total: attempts.length }),
      firstPassSuccessRate: ratioMetric(adjudicated[0]?.status === 'passed' ? 1 : 0, adjudicated.length > 0 ? 1 : 0, { collected: adjudicated.length > 0 ? 1 : 0, eligible: 1, total: attempts.length }),
      passAt1: ratioMetric(adjudicated[0]?.status === 'passed' ? 1 : 0, adjudicated.length > 0 ? 1 : 0, { collected: adjudicated.length > 0 ? 1 : 0, eligible: 1, total: attempts.length }),
      passAtK: ratioMetric(adjudicated.some((attempt) => attempt.status === 'passed') ? 1 : 0, adjudicated.length > 0 ? 1 : 0, { collected: adjudicated.length, eligible: attempts.length, total: attempts.length }),
      passCaretK: ratioMetric(adjudicated.length > 0 && adjudicated.every((attempt) => attempt.status === 'passed') ? 1 : 0, adjudicated.length > 0 ? 1 : 0, { collected: adjudicated.length, eligible: attempts.length, total: attempts.length }),
      regressionPassRate: ratioMetric(regressionAttempts.filter((attempt) => attempt.status === 'passed').length, regressionAttempts.length, { missingReason: 'no-regression-attempts' }),
      falseCompletionRate: ratioMetric(falseClaims, completionClaims.length, { collected: completionClaims.length, eligible: adjudicated.length, total: attempts.length, missingReason: 'completion-claims-not-observed' }),
    },
    workflow: {
      workflowCompliance: ratioMetric(workflowChecks.filter((check) => check.status === 'passed').length, workflowChecks.length, { missingReason: 'no-workflow-checks' }),
      ruleViolation: scalarMetric(workflowChecks.length > 0 ? workflowChecks.filter((check) => check.status === 'failed').length : null, 'count', { collected: workflowChecks.length, eligible: workflowChecks.length, total: applicableChecks.length, missingReason: 'no-workflow-checks' }),
      ruleViolationBySeverity: Object.fromEntries(['critical', 'major', 'minor'].map((severity) => [
        severity,
        workflowChecks.filter((check) => check.status === 'failed' && check.severity === severity).length,
      ])),
      verificationCoverage: ratioMetric(verificationChecks.filter((check) => check.status === 'passed').length, verificationChecks.length, { missingReason: 'no-verification-checks' }),
      replanCount: scalarMetric(observedEventAttempts.length > 0 ? countEvents(events, 'replan') : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
      recoverySuccessRate: ratioMetric(recoverable.filter((attempt) => attempt.recovery?.succeeded === true).length, recoverable.length, { missingReason: 'no-recoverable-events' }),
    },
    agent: {
      dispatchCount: scalarMetric(observedEventAttempts.length > 0 ? countEvents(events, 'agent-dispatch') : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
      delegationSuccessRate: ratioMetric(countEvents(events, 'agent-complete', (event) => event.succeeded === true), countEvents(events, 'agent-dispatch'), { missingReason: 'no-agent-dispatches' }),
      handoffSuccessRate: ratioMetric(countEvents(events, 'handoff', (event) => event.succeeded === true), countEvents(events, 'handoff'), { missingReason: 'no-handoffs' }),
      handoffInformationLoss: ratioMetric(handoffFacts.filter((present) => !present).length, handoffFacts.length, { missingReason: 'handoff-facts-not-observed' }),
      duplicateWorkRate: ratioMetric(countEvents(events, 'duplicate-work'), countEvents(events, 'work-unit'), { missingReason: 'work-units-not-observed' }),
      coordinationSuccessRate: ratioMetric(coordinationEvents.filter((event) => event.succeeded === true).length, coordinationEvents.length, { missingReason: 'coordination-not-observed' }),
      coordinationFailureRate: ratioMetric(countEvents(events, 'coordination-failure'), countEvents(events, 'coordination'), { missingReason: 'coordination-not-observed' }),
      agentConflictRate: ratioMetric(countEvents(events, 'agent-conflict'), countEvents(events, 'agent-dispatch'), { missingReason: 'no-agent-dispatches' }),
      mergeFailureRate: ratioMetric(countEvents(events, 'merge', (event) => event.succeeded === false), countEvents(events, 'merge'), { missingReason: 'no-merges' }),
      parentBottleneck: scalarMetric(null, 'ratio', { missingReason: 'scheduler-wait-telemetry-not-reported' }),
      unnecessaryDelegation: scalarMetric(observedEventAttempts.length > 0 ? countEvents(events, 'unnecessary-delegation') : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
    },
    efficiency: {
      wallTime: scalarMetric(duration.total, 'ms', { collected: duration.collected, eligible: attempts.length, total: attempts.length }),
      tokenUsage: scalarMetric(tokenValues.length > 0 ? tokenValues.reduce((sum, value) => sum + value, 0) : null, 'tokens', { collected: tokenValues.length, eligible: attempts.length, total: attempts.length }),
      tokenBilling: tokenBilling(attempts, billingWeights),
      toolCalls: scalarMetric(observedEventAttempts.length > 0 ? toolCalls : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
      repeatedSearch: scalarMetric(observedEventAttempts.length > 0 ? repeatedSearches(events) : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
      contextConsumption: scalarMetric(contextValues.length > 0 ? Math.max(...contextValues) : null, 'tokens', { collected: contextValues.length, eligible: attempts.length, total: attempts.length }),
      compactionCount: scalarMetric(observedEventAttempts.length > 0 ? countEvents(events, 'compaction') : null, 'count', { collected: observedEventAttempts.length, eligible: attempts.length, total: attempts.length }),
      agentCost: scalarMetric(null, 'usd', { missingReason: 'price-telemetry-not-reported' }),
      coordinationCost: scalarMetric(null, 'usd', { missingReason: 'price-telemetry-not-reported' }),
      judgeCost: scalarMetric(null, 'usd', { missingReason: 'price-telemetry-not-reported' }),
      totalCost: scalarMetric(null, 'usd', { missingReason: 'price-telemetry-not-reported' }),
    },
  };
}
