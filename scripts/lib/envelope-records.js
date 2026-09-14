// Execution Envelope authoring and pre-flight checks.
//
// docs/rules/governance-core.md requires every effectful call to run under a
// validated Execution Envelope, and docs/adr/ADR-0002 freezes the workspace
// identity a high-risk envelope is bound to. The runtime authority stays
// runtime/hooks/lib/execution-envelope.mjs: this module only derives the
// mechanical parts a caller would otherwise transcribe by hand (workspace
// identity, frozen base ref/SHA, mode effect ceiling) and reports the fields
// that only the host may supply. It never fabricates host proof.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  EXECUTION_EFFECTS,
  EXECUTION_EFFECTS_V2,
  EXECUTION_ENVELOPE_MODES,
  EXECUTION_ENVELOPE_SCHEMA,
  EXECUTION_ENVELOPE_SCHEMA_V2,
  inspectWorkspaceIdentity,
  parseExecutionEnvelope,
} from '../../runtime/hooks/lib/execution-envelope.mjs';
import { validateJsonAgainstSchema } from './schema-validation.js';

export {
  EXECUTION_EFFECTS,
  EXECUTION_EFFECTS_V2,
  EXECUTION_ENVELOPE_MODES,
  EXECUTION_ENVELOPE_SCHEMA,
  EXECUTION_ENVELOPE_SCHEMA_V2,
};

export const DEFAULT_BASE_REF = 'origin/develop';
export const HOST_PROOF_FIELDS = Object.freeze(['source', 'filesystem', 'approval', 'process', 'network', 'observedAt']);
// The runtime denies high-risk execution when the host observation is older
// than five minutes; the same bound is reused here so a draft can be checked
// before it reaches the hook.
export const HOST_PROOF_MAX_AGE_MS = 5 * 60 * 1000;
export const HOST_OWNED_FIELDS = Object.freeze(['requestId', 'sessionId', 'hostContext']);
export const WORKSPACE_IDENTITY_FIELDS = Object.freeze(['canonicalCwd', 'worktreeRoot', 'gitCommonDir', 'gitDir', 'branch']);

const ENVELOPE_SCHEMA_URLS = new Map([
  [1, '../../schemas/execution-envelope.schema.json'],
  [2, '../../schemas/execution-envelope-v2.schema.json'],
]);
const shaPattern = /^[0-9a-fA-F]{40,64}$/u;
const schemaCache = new Map();

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function envelopeSchema(version) {
  if (!schemaCache.has(version)) {
    const url = new URL(ENVELOPE_SCHEMA_URLS.get(version), import.meta.url);
    schemaCache.set(version, JSON.parse(readFileSync(url, 'utf8')));
  }
  return schemaCache.get(version);
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function resolveCommit(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Same canonicalization the runtime applies before comparing frozen paths, so
// a symlinked or differently-cased path does not read as a mismatch.
function canonicalPath(candidate) {
  const suffix = [];
  let current = path.resolve(candidate);
  while (true) {
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function samePath(left, right) {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  if (!canonicalLeft || !canonicalRight) return false;
  return process.platform === 'win32'
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
}

function parseSchemaError(error) {
  const match = /^(\S+)\s+(.*?)\s+\[schema:\s*(.*)\]$/u.exec(error);
  if (!match) return { code: 'ENVELOPE_SCHEMA_VIOLATION', message: error, path: '' };
  const instancePath = match[1].replace(/^envelope\.?/u, '');
  return {
    code: 'ENVELOPE_SCHEMA_VIOLATION',
    message: `${instancePath || 'envelope'} ${match[2]}`,
    path: instancePath,
  };
}

/** The effects a given envelope version can name. */
export function effectsForVersion(version = 2) {
  return version === 1 ? [...EXECUTION_EFFECTS] : [...EXECUTION_EFFECTS_V2];
}

/**
 * Effect ceiling per mode, mirrored from the runtime enforcement table.
 * `evaluateExecutionEnvelope` denies any effect outside the ceiling, so a
 * caller that writes an unreachable effect into `allowedEffects` gets a
 * contradiction that is cheaper to catch at authoring time than at call time.
 */
export function modeEffectCeiling(mode, version = 2) {
  if (mode === 'execute') return effectsForVersion(version);
  if (mode === 'linear-sync') return ['linearWrite'];
  return [];
}

function missingHostFields({ hostContext, requestId, sessionId, version }) {
  const present = {
    // v1 carries no host proof at all, so it is not a missing field there.
    hostContext: version === 2 ? isObject(hostContext) : true,
    requestId: isNonEmptyString(requestId),
    sessionId: isNonEmptyString(sessionId),
  };
  return HOST_OWNED_FIELDS.filter((field) => !present[field]);
}

function semanticProblems(value, version, { cwd, now, workspace }) {
  const problems = [];
  const push = (code, message, severity = 'error', problemPath = '') => {
    problems.push({ code, message, path: problemPath, severity });
  };
  const mode = value.mode;
  const allowedEffects = Array.isArray(value.allowedEffects) ? value.allowedEffects : [];
  const forbiddenEffects = Array.isArray(value.forbiddenEffects) ? value.forbiddenEffects : [];
  const ceiling = modeEffectCeiling(mode, version);
  const outsideCeiling = allowedEffects.filter((effect) => !ceiling.includes(effect));
  if (outsideCeiling.length > 0) {
    push(
      'MODE_CEILING_EXCEEDED',
      `mode ${JSON.stringify(mode)} allows [${ceiling.join(', ')}]; allowedEffects would never be released: ${outsideCeiling.join(', ')}`,
      'error',
      'allowedEffects',
    );
  }
  for (const effect of allowedEffects) {
    if (forbiddenEffects.includes(effect)) {
      push('EFFECT_CONFLICT', `${effect} is both allowed and forbidden; the forbidden rule wins at call time`, 'error', 'forbiddenEffects');
    }
  }
  if (Array.isArray(value.targetIssueIds) && value.targetIssueIds.length === 0) {
    push('ENVELOPE_TARGETS_EMPTY', 'targetIssueIds is empty; target-bound effects cannot be verified against an Issue', 'warning', 'targetIssueIds');
  }
  if (isNonEmptyString(value.expiresAt)) {
    const expiresAt = Date.parse(value.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      push('ENVELOPE_EXPIRED', `expiresAt ${value.expiresAt} is not in the future; effectful calls are denied`, 'error', 'expiresAt');
    }
  }

  if (version === 2) {
    const host = value.hostContext;
    if (!isObject(host)) {
      push('HOST_PROOF_ABSENT', 'hostContext is missing; only the host may supply filesystem/approval/process/network proof', 'error', 'hostContext');
    } else if (host.source !== 'host') {
      push('HOST_PROOF_SOURCE_INVALID', `hostContext.source must be "host", received ${JSON.stringify(host.source ?? null)}`, 'error', 'hostContext.source');
    } else {
      const observedAt = Date.parse(host.observedAt);
      const age = now.getTime() - observedAt;
      if (!Number.isFinite(observedAt)) {
        push('HOST_PROOF_TIMESTAMP_INVALID', 'hostContext.observedAt is not a readable UTC timestamp', 'error', 'hostContext.observedAt');
      } else if (age > HOST_PROOF_MAX_AGE_MS) {
        push(
          'HOST_PROOF_STALE',
          `hostContext.observedAt is ${Math.round(age / 1000)}s old; high-risk execution denies proof older than ${HOST_PROOF_MAX_AGE_MS / 60000} minutes`,
          value.riskClass === 'high' ? 'error' : 'warning',
          'hostContext.observedAt',
        );
      } else if (age < -1000) {
        push('HOST_PROOF_FUTURE', 'hostContext.observedAt is in the future; the hook denies a future observation', 'warning', 'hostContext.observedAt');
      }
    }
  }

  const workspaceScope = version === 2 && isObject(value.scope) ? value.scope.workspace : null;
  if (isObject(workspaceScope)) {
    // Callers that already inspected the workspace pass the identity in, so a
    // draft does not pay for the same five git reads twice.
    const actual = workspace === undefined ? inspectWorkspaceIdentity(cwd) : workspace;
    if (!actual) {
      push(
        'WORKSPACE_UNAVAILABLE',
        'the current cwd is not a readable Git workspace, so the frozen identity cannot be verified; the hook would deny with EXECUTION_ENVELOPE_WORKSPACE_UNAVAILABLE - pass --cwd <workspace>',
        'error',
        'scope.workspace',
      );
      return problems;
    }
    // Branch is a plain ref name, not a path; every other frozen field is one.
    const mismatched = WORKSPACE_IDENTITY_FIELDS.filter((field) => (field === 'branch'
      ? isNonEmptyString(workspaceScope.branch) && workspaceScope.branch !== actual.branch
      : isNonEmptyString(workspaceScope[field]) && !samePath(workspaceScope[field], actual[field])));
    if (mismatched.length > 0) {
      push(
        'WORKSPACE_MISMATCH',
        `frozen workspace identity differs from the current workspace (${mismatched.join(', ')}); the hook would deny with EXECUTION_ENVELOPE_WORKSPACE_MISMATCH`,
        'error',
        'scope.workspace',
      );
      return problems;
    }
    // The frozen base and the initial HEAD are usually the same commit, so the
    // duplicate ancestry read is skipped rather than paid for twice.
    const anchorSha = shaPattern.test(workspaceScope.baseSha ?? '') ? workspaceScope.baseSha : null;
    if (anchorSha !== null && !isAncestor(cwd, anchorSha, actual.headSha)) {
      push('WORKSPACE_BASE_DIVERGED', 'baseSha is not an ancestor of the current HEAD; the hook would deny with EXECUTION_ENVELOPE_HEAD_DIVERGED', 'error', 'scope.workspace.baseSha');
    }
    if (shaPattern.test(workspaceScope.initialHeadSha ?? '')
      && workspaceScope.initialHeadSha !== workspaceScope.baseSha
      && !isAncestor(cwd, workspaceScope.initialHeadSha, actual.headSha)) {
      push('WORKSPACE_HEAD_DIVERGED', 'initialHeadSha is not an ancestor of the current HEAD; the hook would deny with EXECUTION_ENVELOPE_HEAD_DIVERGED', 'error', 'scope.workspace.initialHeadSha');
    }
    // `merge-base --is-ancestor <sha> <ref>` resolves the ref and the ancestry
    // in one call, which is the same check the hook performs.
    if (isNonEmptyString(workspaceScope.baseRef) && anchorSha !== null && !isAncestor(cwd, anchorSha, workspaceScope.baseRef)) {
      push('WORKSPACE_BASE_REF_MISMATCH', `baseSha is not on ${workspaceScope.baseRef}; the hook would deny with EXECUTION_ENVELOPE_BASE_REF_MISMATCH`, 'error', 'scope.workspace.baseRef');
    }
    if (isObject(value.checkpoint) && shaPattern.test(value.checkpoint.headSha) && value.checkpoint.headSha !== actual.headSha) {
      push('CHECKPOINT_STALE', 'checkpoint.headSha differs from the current HEAD; the hook would deny with EXECUTION_ENVELOPE_CHECKPOINT_STALE', 'error', 'checkpoint.headSha');
    }
  }
  return problems;
}

/**
 * Validate an Execution Envelope and re-check it against the current
 * workspace. Structural problems come from the published JSON schema and the
 * runtime parser; the remaining checks mirror what the hook would deny.
 *
 * @param {unknown} value
 * @param {{cwd?: string, now?: Date, workspace?: object|null}} [options] `workspace`
 *   lets a caller that already inspected the workspace identity reuse it.
 */
export function checkEnvelope(value, { cwd = process.cwd(), now = new Date(), workspace } = {}) {
  const problems = [];
  const push = (code, message, severity = 'error', problemPath = '') => {
    problems.push({ code, message, path: problemPath, severity });
  };
  if (!isObject(value)) {
    push('ENVELOPE_NOT_OBJECT', 'an Execution Envelope must be a JSON object');
    return finishCheck({ problems, value, version: null });
  }
  const version = value.schema === EXECUTION_ENVELOPE_SCHEMA
    ? 1
    : value.schema === EXECUTION_ENVELOPE_SCHEMA_V2
      ? 2
      : null;
  if (version === null) {
    push('ENVELOPE_SCHEMA_UNSUPPORTED', `unsupported schema ${JSON.stringify(value.schema ?? null)}; expected ${EXECUTION_ENVELOPE_SCHEMA} or ${EXECUTION_ENVELOPE_SCHEMA_V2}`);
    return finishCheck({ problems, value, version: null });
  }
  for (const error of validateJsonAgainstSchema(value, envelopeSchema(version), 'envelope')) {
    const problem = parseSchemaError(error);
    push(problem.code, problem.message, 'error', problem.path);
  }
  problems.push(...semanticProblems(value, version, { cwd, now, workspace }));
  return finishCheck({ problems, value, version });
}

function finishCheck({ problems, value, version }) {
  const errors = problems.filter((problem) => problem.severity === 'error');
  const parsed = isObject(value) ? parseExecutionEnvelope(value) : null;
  const mode = typeof value?.mode === 'string' ? value.mode : null;
  const allowedEffects = Array.isArray(value?.allowedEffects) ? value.allowedEffects : [];
  return {
    effectsOutsideCeiling: version === null ? [] : allowedEffects.filter((effect) => !modeEffectCeiling(mode, version).includes(effect)),
    enforcementGrade: parsed?.enforcementGrade ?? null,
    errorCount: errors.length,
    mode,
    ok: errors.length === 0,
    problems: problems.sort((left, right) => left.code.localeCompare(right.code)),
    riskClass: parsed?.riskClass ?? (typeof value?.riskClass === 'string' ? value.riskClass : null),
    version,
    warningCount: problems.filter((problem) => problem.severity === 'warning').length,
  };
}

/**
 * Build an Execution Envelope draft for the current workspace.
 *
 * Everything derivable from the workspace is filled in; `requestId`,
 * `sessionId` and `hostContext` are echoed as null unless the host supplied
 * them, and the returned problems say so. A draft is only `valid` once
 * `parseExecutionEnvelope` accepts it.
 *
 * @param {Record<string, any>} options
 */
export function buildEnvelopeDraft({
  activeObjective = null,
  allowedEffects = [],
  allowedWriteRoots = [],
  baseRef = DEFAULT_BASE_REF,
  checkpoint = null,
  cwd = process.cwd(),
  externalTargets = [],
  expiresAt = null,
  forbiddenEffects = [],
  hostContext = null,
  mode = 'inspect',
  now = new Date(),
  requestId = null,
  riskClass = 'standard',
  sessionId = null,
  targetIssueIds = [],
  terminalCondition = null,
  version = 2,
} = {}) {
  const problems = [];
  const push = (code, message, severity = 'error') => problems.push({ code, message, path: '', severity });
  const effects = new Set(effectsForVersion(version));
  for (const effect of [...allowedEffects, ...forbiddenEffects]) {
    if (!effects.has(effect)) push('UNKNOWN_EFFECT', `${effect} is not an effect of Execution Envelope v${version}`);
  }
  if (!EXECUTION_ENVELOPE_MODES.includes(mode)) {
    push('UNKNOWN_MODE', `${JSON.stringify(mode)} is not one of ${EXECUTION_ENVELOPE_MODES.join(', ')}`);
  }
  if (version === 1 && riskClass === 'high') {
    push('V1_CANNOT_AUTHORIZE_HIGH_RISK', 'Execution Envelope v1 is contract-only/degraded and cannot carry high-risk authorization; use v2');
  }
  for (const root of allowedWriteRoots) {
    if (typeof root === 'string' && !path.isAbsolute(root)) {
      push('WRITE_ROOT_NOT_ABSOLUTE', `allowed write root ${root} is relative; the hook resolves roots against its own cwd`, 'warning');
    }
  }

  // Only v2 freezes a workspace identity; a v1 draft is contract-only/degraded
  // and must not report workspace problems it cannot carry.
  const workspace = version === 2 ? inspectWorkspaceIdentity(cwd) : null;
  if (version === 2 && !workspace) push('WORKSPACE_IDENTITY_UNAVAILABLE', 'cwd is not a Git workspace, so branch/HEAD/Git directory identity cannot be frozen');
  const baseSha = workspace ? resolveCommit(cwd, baseRef) : null;
  if (workspace && !baseSha) push('BASE_REF_UNRESOLVED', `base ref ${baseRef} does not resolve to a commit; pass --base-ref for the frozen target ref`);

  const scope = workspace
    ? {
      externalTargets,
      workspace: {
        allowedWriteRoots: allowedWriteRoots.length > 0 ? allowedWriteRoots : [workspace.worktreeRoot],
        baseRef,
        baseSha,
        branch: workspace.branch,
        canonicalCwd: workspace.canonicalCwd,
        gitCommonDir: workspace.gitCommonDir,
        gitDir: workspace.gitDir,
        initialHeadSha: workspace.headSha,
        worktreeRoot: workspace.worktreeRoot,
      },
    }
    : null;

  const shared = {
    activeObjective,
    allowedEffects,
    forbiddenEffects,
    mode,
    requestId,
    sessionId,
    targetIssueIds,
    terminalCondition,
    ...(expiresAt === null ? {} : { expiresAt }),
    ...(checkpoint === null ? {} : { checkpoint }),
  };
  const envelope = version === 1
    ? { schema: EXECUTION_ENVELOPE_SCHEMA, ...shared }
    : { schema: EXECUTION_ENVELOPE_SCHEMA_V2, ...shared, hostContext, riskClass, scope };

  const missing = missingHostFields({ hostContext, requestId, sessionId, version });
  for (const field of missing) {
    if (field === 'hostContext') {
      push('HOST_PROOF_ABSENT', 'hostContext must be injected by the host (source=host); this command never invents host proof');
    } else {
      push(`${field === 'requestId' ? 'REQUEST_ID' : 'SESSION_ID'}_MISSING`, `${field} must be supplied by the requesting session`);
    }
  }

  const check = checkEnvelope(envelope, { cwd, now, workspace: workspace ?? null });
  const filtered = check.problems.filter((problem) => !missing.some(
    (field) => problem.path === field || problem.path.startsWith(`${field}.`),
  ));
  problems.push(...filtered);

  const parsed = parseExecutionEnvelope(envelope);
  const errors = problems.filter((problem) => problem.severity === 'error');
  return {
    enforcementGrade: parsed?.enforcementGrade ?? null,
    envelope,
    hostInjectedFields: missing,
    hostProof: {
      fields: [...HOST_PROOF_FIELDS],
      note: 'hostContext is host-owned evidence; a draft stays invalid until the host injects it',
      required: version === 2,
      status: isObject(hostContext) ? 'provided' : 'absent',
    },
    modeCeiling: modeEffectCeiling(mode, version),
    problems: problems.sort((left, right) => left.code.localeCompare(right.code)),
    // A draft that parses but carries an unresolvable request (for example a
    // high-risk ask on the v1 contract) is not a usable envelope.
    valid: parsed !== null && errors.length === 0,
    version,
    workspace: workspace ?? null,
  };
}

function formatProblems(problems) {
  return problems.map((problem) => `${problem.severity}: ${problem.code} ${problem.message}`);
}

/** Human-readable summary of a `plan` result. */
export function summarizeEnvelopePlan(plan) {
  const lines = [
    `status: ${plan.valid ? 'valid' : 'incomplete'}`,
    `envelope: v${plan.version} mode=${plan.envelope.mode} risk=${plan.envelope.riskClass ?? 'standard'}`,
    `mode effect ceiling: ${plan.modeCeiling.length > 0 ? plan.modeCeiling.join(', ') : '(none)'}`,
  ];
  if (plan.workspace) {
    lines.push(`workspace: branch ${plan.workspace.branch} base ${plan.envelope.scope?.workspace.baseRef ?? 'n/a'}@${(plan.envelope.scope?.workspace.baseSha ?? 'unresolved').slice(0, 12)} head ${plan.workspace.headSha.slice(0, 12)}`);
  }
  if (plan.hostInjectedFields.length > 0) lines.push(`host must inject: ${plan.hostInjectedFields.join(', ')}`);
  lines.push(...formatProblems(plan.problems));
  return lines.join('\n');
}

/** Human-readable summary of a `check` result. */
export function summarizeEnvelopeCheck(check) {
  const lines = [
    `status: ${check.ok ? 'passed' : 'failed'}`,
    `envelope: v${check.version ?? 'unknown'} mode=${check.mode ?? 'unknown'} risk=${check.riskClass ?? 'unknown'}`,
    `enforcement grade: ${check.enforcementGrade ?? 'unrecognized (the hook would deny effectful calls)'}`,
  ];
  lines.push(...formatProblems(check.problems));
  return lines.join('\n');
}
