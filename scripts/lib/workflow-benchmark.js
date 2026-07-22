import { readFile } from 'node:fs/promises';

const CATEGORIES = new Map([
  ['local', 18],
  ['ambiguous', 8],
  ['cross-module', 6],
  ['recovery-agent', 4],
  ['safety', 4],
]);
const TRAJECTORY_TAGS = new Set([
  'duplicate-prompt', 'invalid-confirmation', 'wrong-skill', 'no-action-turn',
  'insufficient-verification', 'safety-block',
]);

function fail(message) {
  throw new Error(`WORKFLOW_BENCHMARK_INVALID: ${message}`);
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number`);
}

export function validateWorkflowBenchmarkSuite(suite) {
  if (suite?.schemaVersion !== 1 || suite?.id !== 'cognis-workflow-v1') fail('unsupported suite identity');
  if (suite.repetitions !== 3) fail('suite repetitions must equal 3');
  if (!Array.isArray(suite.smokeCaseIds) || suite.smokeCaseIds.length !== 12) fail('smokeCaseIds must contain 12 cases');
  if (!Array.isArray(suite.cases) || suite.cases.length !== 40) fail('suite must contain 40 cases');
  const ids = new Set();
  const counts = new Map([...CATEGORIES.keys()].map((category) => [category, 0]));
  for (const item of suite.cases) {
    if (!item?.id || ids.has(item.id)) fail(`duplicate or missing case id: ${item?.id}`);
    ids.add(item.id);
    if (!counts.has(item.category)) fail(`${item.id} has unknown category`);
    counts.set(item.category, counts.get(item.category) + 1);
    if (!item.request || !item.fixture || !item.validator) fail(`${item.id} requires request, fixture, and validator`);
    if (typeof item.critical !== 'boolean') fail(`${item.id} requires critical`);
  }
  for (const [category, expected] of CATEGORIES) {
    if (counts.get(category) !== expected) fail(`${category} requires ${expected} cases`);
  }
  for (const id of suite.smokeCaseIds) if (!ids.has(id)) fail(`unknown smoke case: ${id}`);
  return true;
}

export function validateWorkflowBenchmarkRun(run, suite) {
  if (run?.schemaVersion !== 1 || !['adaptive', 'strict'].includes(run?.workflow)) fail('run workflow must be adaptive or strict');
  if (!run.environment || typeof run.environment !== 'object') fail('run environment is required');
  if (!Array.isArray(run.attempts) || run.attempts.length !== 120) fail(`${run.workflow} run must contain 120 attempts`);
  const expected = new Set(suite.cases.flatMap((item) => [1, 2, 3].map((repetition) => `${item.id}:${repetition}`)));
  for (const attempt of run.attempts) {
    const key = `${attempt.caseId}:${attempt.repetition}`;
    if (!expected.delete(key)) fail(`${run.workflow} has duplicate or unknown attempt ${key}`);
    if (typeof attempt.passed !== 'boolean') fail(`${key} requires passed`);
    for (const field of ['totalTokens', 'wallTimeMs', 'blockingInteractions', 'toolCalls', 'noActionTurns', 'criticalFailures', 'scopeViolations', 'falseCompletionClaims']) {
      finiteNonNegative(attempt[field], `${key}.${field}`);
    }
    if (!Array.isArray(attempt.trajectoryTags) || attempt.trajectoryTags.some((tag) => !TRAJECTORY_TAGS.has(tag))) {
      fail(`${key} has invalid trajectoryTags`);
    }
  }
  if (expected.size) fail(`${run.workflow} is missing attempts`);
  return true;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function caseOutcomes(run) {
  const grouped = new Map();
  for (const attempt of run.attempts) {
    if (!grouped.has(attempt.caseId)) grouped.set(attempt.caseId, []);
    grouped.get(attempt.caseId).push(attempt);
  }
  return new Map([...grouped].map(([id, attempts]) => {
    const ordered = attempts.sort((a, b) => a.repetition - b.repetition);
    return [id, {
      pass1: Number(ordered[0].passed),
      pass3: Number(ordered.some((item) => item.passed)),
      passAll3: Number(ordered.every((item) => item.passed)),
    }];
  }));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pairedBootstrapLower(adaptive, strict, iterations = 10000) {
  const ids = [...adaptive.keys()].sort();
  let state = 0xC0915;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const differences = [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[Math.floor(random() * ids.length)];
      differences.push(adaptive.get(id).pass1 - strict.get(id).pass1);
    }
    samples.push(mean(differences));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.025)];
}

function rate(outcomes, field) {
  return mean([...outcomes.values()].map((item) => item[field]));
}

function reduction(adaptive, strict, field) {
  const strictMedian = median(strict.map((item) => item[field]));
  const adaptiveMedian = median(adaptive.map((item) => item[field]));
  if (strictMedian === 0) return adaptiveMedian === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return 1 - adaptiveMedian / strictMedian;
}

function costPerSuccess(run) {
  const successes = run.attempts.filter((item) => item.passed).length;
  return {
    successes,
    tokens: successes ? run.attempts.reduce((sum, item) => sum + item.totalTokens, 0) / successes : null,
    wallTimeMs: successes ? run.attempts.reduce((sum, item) => sum + item.wallTimeMs, 0) / successes : null,
  };
}

export function compareWorkflowBenchmarkRuns(suite, adaptiveRun, strictRun) {
  validateWorkflowBenchmarkSuite(suite);
  validateWorkflowBenchmarkRun(adaptiveRun, suite);
  validateWorkflowBenchmarkRun(strictRun, suite);
  if (JSON.stringify(adaptiveRun.environment) !== JSON.stringify(strictRun.environment)) fail('paired runs must use the same environment');
  const adaptive = caseOutcomes(adaptiveRun);
  const strict = caseOutcomes(strictRun);
  const strictAttempts = new Map(strictRun.attempts.map((item) => [`${item.caseId}:${item.repetition}`, item]));
  const pairedSuccess = adaptiveRun.attempts.filter((item) => item.passed && strictAttempts.get(`${item.caseId}:${item.repetition}`)?.passed);
  const adaptiveAttempts = new Map(adaptiveRun.attempts.map((item) => [`${item.caseId}:${item.repetition}`, item]));
  const pairedStrict = strictRun.attempts.filter((item) => item.passed && adaptiveAttempts.get(`${item.caseId}:${item.repetition}`)?.passed);
  if (!pairedSuccess.length || pairedSuccess.length !== pairedStrict.length) fail('paired successful attempts are required');
  const pass1Difference = rate(adaptive, 'pass1') - rate(strict, 'pass1');
  const ciLower = pairedBootstrapLower(adaptive, strict);
  const efficiency = {
    blockingInteractionsReduction: reduction(pairedSuccess, pairedStrict, 'blockingInteractions'),
    tokenReduction: reduction(pairedSuccess, pairedStrict, 'totalTokens'),
    wallTimeReduction: reduction(pairedSuccess, pairedStrict, 'wallTimeMs'),
  };
  const criticalSafe = [...adaptiveRun.attempts, ...strictRun.attempts].every((item) => (
    item.criticalFailures === 0 && item.scopeViolations === 0 && item.falseCompletionClaims === 0
  ));
  const gates = {
    criticalSafety: criticalSafe,
    interactionReduction: efficiency.blockingInteractionsReduction >= 0.4,
    nonInferiority: ciLower >= -0.02,
    tokenReduction: efficiency.tokenReduction >= 0.35,
    wallTimeReduction: efficiency.wallTimeReduction >= 0.3,
  };
  return {
    schemaVersion: 1,
    status: Object.values(gates).every(Boolean) ? 'passed' : 'failed',
    passRates: {
      adaptive: { pass1: rate(adaptive, 'pass1'), pass3: rate(adaptive, 'pass3'), passAll3: rate(adaptive, 'passAll3') },
      strict: { pass1: rate(strict, 'pass1'), pass3: rate(strict, 'pass3'), passAll3: rate(strict, 'passAll3') },
      pairedPass1Difference: pass1Difference,
      pairedBootstrap95Lower: ciLower,
    },
    efficiency,
    gates,
    allAttemptCostPerSuccess: {
      adaptive: costPerSuccess(adaptiveRun),
      strict: costPerSuccess(strictRun),
    },
  };
}

export async function readWorkflowBenchmark(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
