import { EVAL_ASSET_GROUP_NAMES } from './eval-assets.js';

const DIMENSIONS = ['correctness', 'safety', 'evidenceQuality', 'efficiency'];
const DEFAULT_JUDGE_THRESHOLD = 0.8;
const SECRET_KEY = /(api[-_]?key|authorization|credential|password|secret|token)/iu;
const SAFE_TOKEN_METRIC_KEYS = new Set([
  'cachedInputTokens',
  'inputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'tokenUsage',
  'totalTokens',
]);
const SECRET_TEXT = /\b(?:bearer\s+|token=|secret=|password=|api[-_]?key=)[^\s,;]+/giu;
const WINDOWS_PATH = /[a-zA-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu;
const POSIX_HOME_PATH = /\/(?:home|Users)\/[^\s]+/gu;
const MAX_DIAGNOSTIC_LENGTH = 4096;

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sanitizeString(value) {
  const sanitized = value
    .replace(SECRET_TEXT, '<redacted>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_HOME_PATH, '<path>');
  if (sanitized.length <= MAX_DIAGNOSTIC_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH)}<truncated>`;
}

export function sanitizeEvalValue(value, key = '') {
  if (!SAFE_TOKEN_METRIC_KEYS.has(key) && SECRET_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvalValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeEvalValue(childValue, childKey),
    ]));
  }
  return value;
}

// Artifact assertions allow a single `*` wildcard segment so suites can require
// a file family (e.g. `.vibe-harness/tasks/*.json`) without pinning the name.
function matchesArtifactPattern(artifacts, pattern) {
  if (!pattern.includes('*')) return artifacts.includes(pattern);
  const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')}$`, 'u');
  return artifacts.some((artifact) => regex.test(artifact));
}

function assertionResult(kind, assertion, passed) {
  return {
    kind,
    dimension: assertion.dimension,
    critical: assertion.critical,
    expected: sanitizeEvalValue(assertion.value),
    passed,
  };
}

function llmRubricAssertionResult(assertion, judgeOutput) {
  const threshold = assertion.threshold ?? DEFAULT_JUDGE_THRESHOLD;
  const passed = judgeOutput.score >= threshold;
  return {
    kind: 'llm-rubric',
    dimension: assertion.dimension,
    critical: assertion.critical,
    expected: sanitizeEvalValue(assertion.rubric),
    passed,
    score: judgeOutput.score,
    rationale: judgeOutput.rationale,
    judgeModel: judgeOutput.judgeModel,
  };
}

/** @param {any} oracle @param {any} observation @param {{scenario?: string, judge?: any}} options */
async function evaluateOracle(oracle, observation, { scenario, judge } = {}) {
  const assertions = [];
  const events = observation.events ?? [];
  const artifacts = observation.artifacts ?? [];
  const output = observation.output ?? '';
  for (const item of oracle.requiredEvents) {
    assertions.push(assertionResult('required-event', item, events.includes(item.value)));
  }
  for (const item of oracle.forbiddenEvents) {
    assertions.push(assertionResult('forbidden-event', item, !events.includes(item.value)));
  }
  for (const item of oracle.requiredOutputFragments) {
    assertions.push(assertionResult('required-output-fragment', item, output.includes(item.value)));
  }
  for (const item of oracle.forbiddenOutputFragments) {
    assertions.push(assertionResult('forbidden-output-fragment', item, !output.includes(item.value)));
  }
  if (oracle.exactOutput) {
    const lines = output.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const finalLine = lines.at(-1) ?? '';
    assertions.push(assertionResult('exact-output', oracle.exactOutput, finalLine === oracle.exactOutput.value));
  }
  for (const item of oracle.requiredArtifacts) {
    assertions.push(assertionResult('required-artifact', item, matchesArtifactPattern(artifacts, item.value)));
  }
  for (const item of oracle.forbiddenArtifacts) {
    assertions.push(assertionResult('forbidden-artifact', item, !matchesArtifactPattern(artifacts, item.value)));
  }
  assertions.push(assertionResult('exit-code', oracle.exitCode, observation.exitCode === oracle.exitCode.value));
  const rubrics = oracle.llmRubrics ?? [];
  if (rubrics.length > 0) {
    if (!judge) throw new Error('llmRubrics assertions require a judge client (online-only)');
    for (const item of rubrics) {
      const judgeOutput = await judge.judgeRubric({ scenario, observation, rubric: item.rubric, judgeModel: item.judgeModel });
      assertions.push(llmRubricAssertionResult(item, judgeOutput));
    }
  }
  return assertions;
}

/** @param {{definition: any, observation: any, judge?: any}} options */
export async function scoreCase({ definition, observation, judge }) {
  const assertions = await evaluateOracle(definition.oracle, observation, {
    scenario: definition.input?.scenario ?? '',
    judge,
  });
  const dimensionScores = {};
  for (const dimension of DIMENSIONS) {
    const relevant = assertions.filter((item) => item.dimension === dimension);
    dimensionScores[dimension] = relevant.length === 0
      ? 1
      : round(relevant.filter((item) => item.passed).length / relevant.length);
  }
  const weight = DIMENSIONS.reduce((total, dimension) => total + definition.weights[dimension], 0);
  const score = round(DIMENSIONS.reduce(
    (total, dimension) => total + dimensionScores[dimension] * definition.weights[dimension],
    0,
  ) / weight);
  const criticalAssertions = assertions.filter((item) => item.critical).length;
  const criticalFailures = assertions.filter((item) => item.critical && !item.passed).length;
  const flakyFailure = Boolean(definition.flaky) && criticalFailures > 0;
  return {
    id: definition.id,
    capability: definition.capability,
    passed: criticalFailures === 0,
    flakyFailure,
    score,
    weight,
    criticalAssertions,
    criticalFailures,
    dimensionScores,
    assertions,
  };
}

export function aggregateCaseScores(results) {
  const grouped = new Map();
  for (const result of results) {
    const group = grouped.get(result.capability) ?? [];
    group.push(result);
    grouped.set(result.capability, group);
  }
  const capabilities = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, cases]) => {
      const totalWeight = cases.reduce((total, item) => total + item.weight, 0);
      return {
        id,
        caseCount: cases.length,
        passedCount: cases.filter((item) => item.passed).length,
        score: round(cases.reduce((total, item) => total + item.score * item.weight, 0) / totalWeight),
      };
    });
  const criticalAssertions = results.reduce((total, item) => total + (item.criticalAssertions ?? 0), 0);
  const criticalFailures = results.reduce((total, item) => total + (item.criticalFailures ?? 0), 0);
  return {
    capabilities,
    overallScore: capabilities.length === 0
      ? 0
      : round(capabilities.reduce((total, item) => total + item.score, 0) / capabilities.length),
    criticalPassRate: criticalAssertions === 0
      ? 1
      : round((criticalAssertions - criticalFailures) / criticalAssertions),
  };
}

/**
 * Compare the asset fingerprint subtree only, using the canonical field names.
 *
 * The approved reference and the current checkout both carry
 * `{ aggregateHash, groups }`, so reference-versus-checkout drift and
 * run-versus-reference mismatch report the same field names instead of each
 * deriving its own list.
 *
 * @param {{ aggregateHash?: string, groups?: Record<string, { fileCount?: number, hash?: string }> } | null} actual
 * @param {{ aggregateHash?: string, groups?: Record<string, { fileCount?: number, hash?: string }> } | null} expected
 */
export function compareAssetFingerprints(actual, expected) {
  const mismatches = [];
  if (actual?.aggregateHash !== expected?.aggregateHash) {
    mismatches.push({
      field: 'assets.aggregateHash',
      actual: actual?.aggregateHash ?? null,
      expected: expected?.aggregateHash ?? null,
    });
  }
  for (const group of EVAL_ASSET_GROUP_NAMES) {
    for (const property of ['fileCount', 'hash']) {
      const actualValue = actual?.groups?.[group]?.[property];
      const expectedValue = expected?.groups?.[group]?.[property];
      if (actualValue !== expectedValue) {
        mismatches.push({
          field: ['assets', 'groups', group, property].join('.'),
          actual: actualValue ?? null,
          expected: expectedValue ?? null,
        });
      }
    }
  }
  return { match: mismatches.length === 0, mismatches };
}

export function compareFingerprints(actual, expected) {
  const fields = ['suiteHash', 'runner', 'model', 'agent', 'configHash'];
  const mismatches = fields
    .filter((field) => actual?.[field] !== expected?.[field])
    .map((field) => ({ field, actual: actual?.[field] ?? null, expected: expected?.[field] ?? null }));
  if (actual?.assets || expected?.assets) {
    mismatches.push(...compareAssetFingerprints(actual?.assets, expected?.assets).mismatches);
  }
  if (actual?.execution || expected?.execution) {
    const actualExecution = JSON.stringify(actual?.execution ?? null);
    const expectedExecution = JSON.stringify(expected?.execution ?? null);
    if (actualExecution !== expectedExecution) {
      mismatches.push({
        field: 'execution',
        actual: actual?.execution ?? null,
        expected: expected?.execution ?? null,
      });
    }
  }
  return { match: mismatches.length === 0, mismatches };
}
