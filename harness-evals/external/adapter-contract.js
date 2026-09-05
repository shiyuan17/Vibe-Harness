import { createHash } from 'node:crypto';
import path from 'node:path';

import { buildResultV3 } from '../lib/result.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const EXTERNAL_RESULT_SCHEMA_VERSION = 3;
export const DEFAULT_EXTERNAL_CONCURRENCY = 1;

export function assertPinned(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /^(?:latest|main|master|head)$/iu.test(value)) {
    throw new Error(`${label} must be pinned and must not use a floating ref`);
  }
  return value;
}

export function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} must contain only letters, digits, dot, underscore, or hyphen`);
  }
  return value;
}

export function discoverFromManifest(manifest, benchmark) {
  if (manifest?.schemaVersion !== 1 || manifest?.benchmark !== benchmark) {
    throw new Error(`Expected a schemaVersion 1 ${benchmark} sample manifest`);
  }
  assertPinned(manifest.upstream?.revision, 'upstream.revision');
  assertPinned(manifest.dataset?.revision, 'dataset.revision');
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error('sample manifest must contain at least one task');
  }
  const seen = new Set();
  return manifest.tasks.map((task) => {
    assertSafeId(task.id, 'task.id');
    if (seen.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    seen.add(task.id);
    return Object.freeze({
      benchmark,
      dataset: manifest.dataset.name,
      datasetRevision: manifest.dataset.revision,
      id: task.id,
      metadata: task.metadata ?? {},
      upstreamRevision: manifest.upstream.revision,
    });
  });
}

export function createRunIdentity({ benchmark, datasetRevision, taskId, patchHash, verifierRevision }) {
  assertSafeId(taskId, 'taskId');
  assertPinned(datasetRevision, 'datasetRevision');
  assertPinned(verifierRevision, 'verifierRevision');
  if (!/^[a-f0-9]{64}$/u.test(patchHash ?? '')) throw new Error('patchHash must be a SHA-256 hex digest');
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({ benchmark, datasetRevision, patchHash, taskId, verifierRevision }))
    .digest('hex');
  return {
    cacheKey,
    runId: `${benchmark}-${taskId}-${cacheKey.slice(0, 16)}`,
  };
}

export function createCommandPlan({ program, args, cwd, outputDir, runIdentity }) {
  if (typeof program !== 'string' || program.length === 0) throw new Error('program is required');
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new Error('args must be strings');
  if (!path.isAbsolute(cwd) || !path.isAbsolute(outputDir)) throw new Error('cwd and outputDir must be absolute');
  return Object.freeze({
    args: Object.freeze([...args]),
    cacheKey: runIdentity.cacheKey,
    cwd,
    dryRun: true,
    env: Object.freeze({}),
    maxConcurrency: DEFAULT_EXTERNAL_CONCURRENCY,
    outputDir,
    program,
    runId: runIdentity.runId,
    shell: false,
  });
}

export function normalizeExternalResult({ benchmark, task, run, outcome, official, metrics = {}, trace = null }) {
  const allowed = new Set(['passed', 'failed', 'blocked', 'error']);
  if (!allowed.has(outcome)) throw new Error(`Unsupported external outcome: ${outcome}`);
  const traceValue = trace ?? { status: 'unavailable', reason: 'official output did not include a trace reference' };
  const attemptStatus = outcome === 'error' ? 'degraded' : outcome;
  const checkStatus = outcome === 'error' ? 'blocked' : outcome;
  const unified = buildResultV3({
    scenario: { id: task.id, title: task.id, version: task.datasetRevision },
    attempts: [{
      id: 'attempt-1', ordinal: 1, phase: 'external', status: attemptStatus,
      completionClaim: null, verification: { passed: outcome === 'passed', status: checkStatus }, events: [],
    }],
    checks: [{
      id: 'official-verifier', category: 'outcome', severity: 'critical', status: checkStatus,
      code: outcome === 'passed' ? null : `OFFICIAL_${outcome.toUpperCase()}`,
    }],
    traceRefs: traceValue.status === 'available' ? [{ attemptId: 'attempt-1', ...traceValue }] : [],
    fingerprint: {
      measurement: {
        benchmark, dataset: task.dataset, datasetRevision: task.datasetRevision,
        runId: run.runId, cacheKey: run.cacheKey, maxConcurrency: DEFAULT_EXTERNAL_CONCURRENCY,
      },
      harness: {},
    },
    source: { kind: 'external', benchmark, taskId: task.id },
    metrics,
    official,
    external: { outcome, passed: outcome === 'passed', trace: traceValue },
  });
  return {
    ...unified,
    kind: 'external-benchmark',
    benchmark,
    task: { id: task.id, dataset: task.dataset, datasetRevision: task.datasetRevision },
    measurement: unified.fingerprint.measurement,
    outcome,
    passed: outcome === 'passed',
    trace: traceValue,
  };
}

export function scoreToOutcome(score, errored = false) {
  if (errored) return 'error';
  if (score === null || score === undefined) return 'blocked';
  return Number(score) >= 1 ? 'passed' : 'failed';
}
