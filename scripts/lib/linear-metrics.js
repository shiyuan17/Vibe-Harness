import { randomUUID } from 'node:crypto';

export const LINEAR_OPERATIONS_SCHEMA = 'vibe-harness.linear-operations/v1';
export const OPERATION_PHASES = Object.freeze([
  'active',
  'blocked',
  'coordination',
  'verification',
  'fan-in',
  'terminal',
]);

const sensitiveKeyPattern = /(?:token|cookie|password|secret|credential|hostname|localpath|workdir|thread|session|username)/iu;

/** @param {any} options */
export function buildOperationsEvent({
  issueId,
  executionId = null,
  phase,
  occurredAt = new Date().toISOString(),
  durationMinutes = null,
  agentCount = null,
  retryCount = null,
  conflictCount = null,
  reworkCount = null,
  reasonCode = null,
  source = 'runtime',
  eventId = randomUUID(),
} = {}) {
  return {
    schema: LINEAR_OPERATIONS_SCHEMA,
    eventId,
    issueId,
    executionId,
    phase,
    occurredAt,
    durationMinutes,
    agentCount,
    retryCount,
    conflictCount,
    reworkCount,
    reasonCode,
    source,
  };
}

export function validateOperationsEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') return { ok: false, errors: ['event must be an object'] };
  if (event.schema !== LINEAR_OPERATIONS_SCHEMA) errors.push(`schema must be ${LINEAR_OPERATIONS_SCHEMA}`);
  for (const field of ['eventId', 'issueId', 'occurredAt', 'source']) {
    if (typeof event[field] !== 'string' || event[field].trim() === '') errors.push(`${field} is required`);
  }
  if (event.executionId !== null && typeof event.executionId !== 'string') errors.push('executionId must be a string or null');
  if (!OPERATION_PHASES.includes(event.phase)) errors.push(`phase must be one of ${OPERATION_PHASES.join(', ')}`);
  if (!Number.isFinite(Date.parse(event.occurredAt))) errors.push('occurredAt must be an RFC3339 timestamp');
  for (const field of ['durationMinutes', 'agentCount', 'retryCount', 'conflictCount', 'reworkCount']) {
    if (event[field] !== null && (!Number.isFinite(event[field]) || event[field] < 0)) {
      errors.push(`${field} must be null or a non-negative number`);
    }
  }
  for (const [key, value] of Object.entries(event)) {
    if (sensitiveKeyPattern.test(key) || (typeof value === 'string' && sensitiveKeyPattern.test(value))) {
      errors.push(`${key} contains a prohibited sensitive field or value`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeOperations(events) {
  const valid = [];
  const errors = [];
  for (const event of events ?? []) {
    const result = validateOperationsEvent(event);
    if (!result.ok) errors.push(...result.errors);
    else valid.push(event);
  }
  const sum = (field) => valid.reduce((total, event) => total + (Number(event[field]) || 0), 0);
  return {
    ok: errors.length === 0,
    errors,
    eventCount: valid.length,
    issueCount: new Set(valid.map((event) => event.issueId)).size,
    phaseCounts: Object.fromEntries(OPERATION_PHASES.map((phase) => [
      phase,
      valid.filter((event) => event.phase === phase).length,
    ])),
    activeMinutes: sum('durationMinutes'),
    retries: sum('retryCount'),
    conflicts: sum('conflictCount'),
    rework: sum('reworkCount'),
    unavailable: errors.length > 0 ? 'invalid-events' : valid.length === 0 ? 'no-events' : null,
  };
}
