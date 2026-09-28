import { createHash } from 'node:crypto';

import { buildMetrics } from '../metrics/metrics.js';
import { analyzeTrace, redactTraceValue } from '../traces/atif.js';

function portableId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(value)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const FAILURE_CATEGORY = Object.freeze({
  collector: 'Infrastructure Failure',
  fixture: 'Infrastructure Failure',
  infrastructure: 'Infrastructure Failure',
  outcome: 'Reasoning Failure',
  verification: 'Verification Failure',
  verifier: 'Infrastructure Failure',
  workflow: 'Rule Failure',
});

/**
 * @typedef {object} ResultBuildOptions
 * @property {Record<string, any>} scenario
 * @property {Array<Record<string, any>>} [attempts]
 * @property {Array<Record<string, any>>} [checks]
 * @property {Array<Record<string, any>>} [traceRefs]
 * @property {{measurement?: Record<string, any>, harness?: Record<string, any>}} [fingerprint]
 * @property {string} [generatedAt]
 * @property {Record<string, any>} [source]
 * @property {Array<Record<string, any>>} [failures]
 * @property {Record<string, any>} [metrics]
 * @property {unknown} [official]
 * @property {unknown} [external]
 * @property {Record<string, any>} [analysis]
 */

/** @param {ResultBuildOptions} options */
export function buildResultV3({
  scenario,
  attempts = [],
  checks = [],
  traceRefs = [],
  fingerprint = {},
  generatedAt = new Date().toISOString(),
  source,
  failures,
  metrics,
  official,
  external,
  analysis,
} = /** @type {ResultBuildOptions} */ ({})) {
  if (!scenario || typeof scenario !== 'object') throw new TypeError('scenario is required');
  portableId(scenario.id, 'scenario.id');
  if (!Array.isArray(attempts) || !Array.isArray(checks) || !Array.isArray(traceRefs)) {
    throw new TypeError('attempts, checks, and traceRefs must be arrays');
  }
  const criticalFailures = checks.filter((check) => check.severity === 'critical' && check.status === 'failed');
  const adjudicated = attempts.filter((attempt) => ['passed', 'failed'].includes(attempt.status));
  const hasBlocked = attempts.some((attempt) => ['blocked', 'cancelled', 'degraded'].includes(attempt.status))
    || checks.some((check) => ['blocked', 'unverified'].includes(check.status));
  const baseStatus = criticalFailures.length > 0 || adjudicated.some((attempt) => attempt.status === 'failed')
    ? 'failed'
    : hasBlocked || adjudicated.length === 0
      ? 'blocked'
      : adjudicated.every((attempt) => attempt.status === 'passed')
        ? 'passed'
        : 'partial';
  const isPassingRed = baseStatus === 'passed'
    && attempts.length > 0
    && attempts.every((attempt) => attempt.phase === 'red');
  const status = isPassingRed ? 'not-reproduced' : baseStatus;
  const normalizedFingerprint = {
    measurement: fingerprint.measurement ?? {},
    harness: fingerprint.harness ?? {},
  };
  const normalizedFailures = failures ?? checks.filter((check) => ['failed', 'blocked', 'unverified'].includes(check.status)).map((check) => ({
    taxonomy: check.taxonomy ?? FAILURE_CATEGORY[check.category] ?? 'Unknown Failure',
    code: check.code ?? check.id,
    checkId: check.id,
  }));
  const traceAvailable = attempts.some((attempt) => Array.isArray(attempt.events));
  const normalizedAnalysis = analysis ?? analyzeTrace(
    traceAvailable ? { steps: attempts.flatMap((attempt) => attempt.events ?? []) } : null,
    checks,
  );

  return redactTraceValue({
    schemaVersion: 3,
    id: `${scenario.id}-${hashValue([generatedAt, attempts.map((attempt) => attempt.id)]).slice(0, 12)}`,
    generatedAt,
    source: {
      kind: source?.kind ?? scenario.source ?? 'internal',
      benchmark: source?.benchmark ?? null,
      taskId: source?.taskId ?? scenario.id,
    },
    scenario: {
      id: scenario.id,
      title: scenario.title ?? scenario.id,
      version: scenario.version ?? null,
    },
    status,
    fingerprint: {
      ...normalizedFingerprint,
      measurementHash: hashValue(normalizedFingerprint.measurement),
      harnessHash: hashValue(normalizedFingerprint.harness),
    },
    summary: {
      plannedAttempts: attempts.length,
      startedAttempts: attempts.filter((attempt) => attempt.status !== 'planned').length,
      adjudicatedAttempts: adjudicated.length,
      blockedAttempts: attempts.filter((attempt) => ['blocked', 'degraded'].includes(attempt.status)).length,
      cancelledAttempts: attempts.filter((attempt) => attempt.status === 'cancelled').length,
      criticalFailures: criticalFailures.length,
    },
    attempts,
    checks,
    metrics: { ...buildMetrics({ attempts, checks }), ...(metrics ?? {}) },
    evidence: {
      trace: traceRefs.length > 0
        ? { state: traceRefs.length < attempts.length ? 'partial' : 'value', refs: traceRefs }
        : { state: 'unavailable', refs: [], missingReason: 'trace-not-provided' },
    },
    failures: normalizedFailures,
    analysis: normalizedAnalysis,
    ...(official === undefined ? {} : { official }),
    ...(external === undefined ? {} : { external }),
  });
}
