export const VERIFICATION_SCOPES = Object.freeze(['affected', 'layer', 'full']);
export const DEFAULT_VERIFICATION_SCOPE = 'layer';
export const MICRO_CHECK_STATUSES = Object.freeze(['planned', 'passed', 'failed', 'blocked']);

/** @returns {'affected'|'layer'|'full'} */
export function normalizeVerificationScope(value) {
  const scope = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (VERIFICATION_SCOPES.includes(scope)) return /** @type {'affected'|'layer'|'full'} */ (scope);
  if (scope === '') return DEFAULT_VERIFICATION_SCOPE;
  throw new Error(`--scope must be one of ${VERIFICATION_SCOPES.join(', ')}; received ${JSON.stringify(value)}.`);
}

export function normalizeValidationChecks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('validationCommands.checks must be an array');
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`validationCommands.checks[${index}] must be an object`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!id || !command) throw new Error(`validationCommands.checks[${index}] requires id and command`);
    if (seen.has(id)) throw new Error(`validationCommands.checks must not contain duplicate id: ${id}`);
    seen.add(id);
    const layer = typeof item.layer === 'string' ? item.layer.trim() : 'custom';
    const costTier = typeof item.costTier === 'string' ? item.costTier.trim() : 'quick';
    if (!['quick', 'standard', 'deep'].includes(costTier)) {
      throw new Error(`validationCommands.checks[${index}].costTier must be quick, standard, or deep`);
    }
    const scopes = item.scopes === undefined
      ? [...VERIFICATION_SCOPES]
      : Array.isArray(item.scopes)
        ? [...new Set(item.scopes)]
        : null;
    if (!scopes || scopes.some((scope) => !VERIFICATION_SCOPES.includes(scope))) {
      throw new Error(`validationCommands.checks[${index}].scopes must contain affected, layer, or full`);
    }
    if (item.estimatedDurationMs !== undefined
      && (!Number.isInteger(item.estimatedDurationMs) || item.estimatedDurationMs < 0)) {
      throw new Error(`validationCommands.checks[${index}].estimatedDurationMs must be a non-negative integer`);
    }
    if (item.deterministic !== undefined && typeof item.deterministic !== 'boolean') {
      throw new Error(`validationCommands.checks[${index}].deterministic must be boolean`);
    }
    return {
      id,
      command,
      layer,
      costTier,
      scopes,
      deterministic: item.deterministic !== false,
      ...(Number.isInteger(item.estimatedDurationMs) ? { estimatedDurationMs: item.estimatedDurationMs } : {}),
    };
  });
}

export function normalizeMicroChecks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('validationCommands.micro must be an array');
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`validationCommands.micro[${index}] must be an object`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const entry = typeof item.entry === 'string' ? item.entry.trim() : '';
    const legacy = Boolean(command);
    if (!id || (!legacy && (!kind || !entry))) {
      throw new Error(`validationCommands.micro[${index}] requires id and either legacy command or kind+entry`);
    }
    if (legacy && (kind || entry)) throw new Error(`validationCommands.micro[${index}] cannot mix command with structured entry`);
    if (!legacy && !['module', 'rule', 'pure'].includes(kind)) {
      throw new Error(`validationCommands.micro[${index}].kind must be module, rule, or pure`);
    }
    if (entry && (entry.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(entry) || entry.includes('..'))) {
      throw new Error(`validationCommands.micro[${index}].entry must be a project-relative path`);
    }
    if (seen.has(id)) throw new Error(`validationCommands.micro must not contain duplicate id: ${id}`);
    seen.add(id);
    const maxDurationMs = item.maxDurationMs === undefined ? 5000 : item.maxDurationMs;
    const outputLimit = item.maxOutputBytes ?? item.outputLimit ?? 8192;
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 120000) {
      throw new Error(`validationCommands.micro[${index}].maxDurationMs must be between 1 and 120000`);
    }
    if (!Number.isInteger(outputLimit) || outputLimit < 256 || outputLimit > 1048576) {
      throw new Error(`validationCommands.micro[${index}].outputLimit must be between 256 and 1048576`);
    }
    const environment = item.environment === undefined ? 'cold' : item.environment;
    if (!['cold', 'warm'].includes(environment)) {
      throw new Error(`validationCommands.micro[${index}].environment must be cold or warm`);
    }
    const scopes = item.scopes === undefined ? [...VERIFICATION_SCOPES] : item.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => !VERIFICATION_SCOPES.includes(scope))) {
      throw new Error(`validationCommands.micro[${index}].scopes must contain affected, layer, or full`);
    }
    const costTier = item.costTier === undefined ? 'quick' : item.costTier;
    if (!['quick', 'standard', 'deep'].includes(costTier)) {
      throw new Error(`validationCommands.micro[${index}].costTier must be quick, standard, or deep`);
    }
    const allowedEnv = item.allowedEnv === undefined ? [] : item.allowedEnv;
    if (!Array.isArray(allowedEnv) || allowedEnv.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
      throw new Error(`validationCommands.micro[${index}].allowedEnv must contain environment variable names`);
    }
    const expectedExitCodes = item.expectedExitCodes === undefined ? [0] : item.expectedExitCodes;
    if (!Array.isArray(expectedExitCodes) || expectedExitCodes.length === 0 || expectedExitCodes.some((code) => !Number.isInteger(code))) {
      throw new Error(`validationCommands.micro[${index}].expectedExitCodes must be a non-empty integer array`);
    }
    if (item.network !== undefined && item.network !== 'deny') throw new Error(`validationCommands.micro[${index}].network must be deny`);
    if (item.workspaceWrite !== undefined && item.workspaceWrite !== 'deny') throw new Error(`validationCommands.micro[${index}].workspaceWrite must be deny`);
    const promotableTo = item.promotableTo ?? null;
    if (![null, 'unit', 'probe'].includes(promotableTo)) throw new Error(`validationCommands.micro[${index}].promotableTo must be null, unit, or probe`);
    return {
      id,
      ...(legacy ? { command } : { kind, entry, args: item.args ?? {} }),
      ...(legacy ? {} : { costTier, scopes: [...new Set(scopes)], maxOutputBytes: outputLimit, network: 'deny', workspaceWrite: 'deny', allowedEnv: [...allowedEnv], expectedExitCodes, promotableTo }),
      maxDurationMs,
      outputLimit,
      deterministic: item.deterministic !== false,
      environment,
      legacy,
    };
  });
}

export function validationCheckMap(config) {
  return new Map(normalizeValidationChecks(config?.validationCommands?.checks).map((item) => [item.id, item]));
}

export function estimateVerificationCost(checks = [], config = {}) {
  const metadata = validationCheckMap(config);
  let total = 0;
  let known = 0;
  for (const check of checks) {
    const estimate = metadata.get(check.id)?.estimatedDurationMs;
    if (Number.isInteger(estimate)) {
      total += estimate;
      known += 1;
    }
  }
  return {
    estimatedDurationMs: known === checks.length ? total : null,
    estimatedChecks: known,
  };
}

/**
 * @param {{scope?: string, focusedChecks?: Array<{reason?: string}>, changedPaths?: string[], coverageAvailable?: boolean}} options
 */
export function verificationScopeConfidence({
  scope,
  focusedChecks = [],
  changedPaths = [],
  coverageAvailable = false,
} = {}) {
  if (scope === 'full' || changedPaths.length === 0) return 'complete';
  if (scope === 'layer') return coverageAvailable ? 'lower-bound' : 'unknown';
  if (focusedChecks.some((item) => String(item.reason ?? '').includes('文件级聚焦'))) return 'complete';
  return coverageAvailable ? 'lower-bound' : 'unknown';
}
