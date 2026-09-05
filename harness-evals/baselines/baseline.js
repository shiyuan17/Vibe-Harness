import { createHash } from 'node:crypto';

import { redactTraceValue } from '../traces/atif.js';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createBaseline({ id, results = [], generatedAt = new Date().toISOString(), approved = false } = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(id)) throw new TypeError('baseline id must be a portable identifier');
  if (!Array.isArray(results) || results.some((result) => result.schemaVersion !== 3)) {
    throw new TypeError('baseline results must use schemaVersion 3');
  }
  const manifest = results.map((result) => ({
    resultId: result.id,
    scenarioId: result.scenario.id,
    status: result.status,
    measurementHash: result.fingerprint.measurementHash,
    harnessHash: result.fingerprint.harnessHash,
  }));
  return redactTraceValue({
    schemaVersion: 1,
    id,
    generatedAt,
    status: approved ? 'approved' : 'candidate',
    manifestHash: hash(manifest),
    results,
  });
}
