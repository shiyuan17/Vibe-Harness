import { redactTraceValue } from '../traces/atif.js';

const VALID_STATUSES = new Set(['passed', 'failed', 'blocked', 'unverified', 'not-applicable']);

function normalizeResult(definition, raw) {
  if (raw?.applicable === false) return { status: 'not-applicable' };
  if (raw?.blocked === true) return { status: 'blocked' };
  if (raw?.unverified === true) return { status: 'unverified' };
  if (typeof raw?.passed !== 'boolean') {
    return { status: 'blocked', code: 'CHECK_INVALID_RESULT', diagnostic: 'check did not return a boolean passed field' };
  }
  return { ...raw, status: raw.passed ? 'passed' : 'failed' };
}

export async function runDeterministicCheck(definition, context) {
  if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string') {
    throw new TypeError('check definition requires an id');
  }
  if (typeof definition.check !== 'function') throw new TypeError(`check ${definition.id} requires a check function`);
  if (definition.applicable && !await definition.applicable(context)) {
    return redactTraceValue({
      id: definition.id,
      category: definition.category ?? 'outcome',
      severity: definition.severity ?? 'major',
      status: 'not-applicable',
    });
  }
  let normalized;
  try {
    normalized = normalizeResult(definition, await definition.check(context));
  } catch (error) {
    normalized = {
      status: 'blocked',
      code: 'CHECK_EXECUTION_FAILED',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  if (!VALID_STATUSES.has(normalized.status)) throw new TypeError(`check ${definition.id} returned an invalid status`);
  return redactTraceValue({
    id: definition.id,
    category: definition.category ?? 'outcome',
    severity: definition.severity ?? 'major',
    mechanism: definition.mechanism ?? null,
    stage: definition.stage ?? null,
    ...normalized,
  });
}

export function createDeterministicVerifier(definitions = []) {
  if (!Array.isArray(definitions)) throw new TypeError('check definitions must be an array');
  const ids = definitions.map((definition) => definition.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('check ids must be unique');
  return Object.freeze({
    async verify(context) {
      const checks = [];
      for (const definition of definitions) checks.push(await runDeterministicCheck(definition, context));
      const status = checks.some((check) => check.severity === 'critical' && check.status === 'failed')
        ? 'failed'
        : checks.some((check) => ['blocked', 'unverified'].includes(check.status))
          ? 'blocked'
          : checks.some((check) => check.status === 'failed')
            ? 'failed'
            : 'passed';
      return { status, checks };
    },
  });
}
