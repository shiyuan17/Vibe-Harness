// Verification planning, command execution and review primitives.
//
// The plan/execute half of `verify`: tier and scope parsing, the four check slots,
// command execution with redaction and timeouts, and the review/acceptance projection
// that turns raw command results into the evidence a verification receipt carries.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { spawn } from 'node:child_process';

import { resolveVerificationTiers, selectVerificationChecks } from './verification-plan.mjs';

import { MAX_OUTPUT_CHARS, boundedOutput } from './cli-output.mjs';
import { CHECK_ORDER, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, assertSafeCommand } from './cli-runtime.mjs';

// Verify receipts are their own contract: v2 keeps `blocked` a distinct
// terminal status instead of folding it into `failed`, adds the cost-tier
// surface (tier, deferredChecks, nextTier) and stamps the producing engine so
// the CLI engine receipt (scripts/vibe-harness.js verify, schemaVersion 2,
// engine 'vibe-harness-cli') can be told apart from this one.
export const VERIFY_SCHEMA_VERSION = 2;
export const VERIFY_ENGINE = 'vibe-harness-runtime';
const VERIFY_TIERS = ['quick', 'standard', 'deep'];
const VERIFY_SCOPES = ['affected', 'layer', 'full'];
const DEFAULT_VERIFY_SCOPE = 'layer';
const DEFAULT_VERIFY_TIER = 'quick';
export function timeoutValue(value) {
  return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
    ? value
    : DEFAULT_TIMEOUT_MS;
}
export function configuredChecks(config, projectDir = undefined) {
  const raw = config?.validationCommands;
  if (raw === undefined) return { commands: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { commands: {}, error: 'validationCommands must be an object.' };
  }
  const commands = {};
  for (const name of CHECK_ORDER) {
    const value = raw[name];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') return { commands: {}, error: `validationCommands.${name} must be a string or null.` };
    commands[name] = value.trim();
  }
  if (projectDir) {
    try {
      const plan = resolveVerifyTierPlan({ commands, config, tier: 'deep', only: null, projectDir, explicit: true });
      for (const check of plan.allChecks) commands[check.id] = check.command;
      return { commands, definitions: Object.fromEntries(plan.allChecks.map((check) => [check.id, check])), error: null };
    } catch (error) {
      return { commands, error: error.message };
    }
  }
  return { commands, definitions: {}, error: null };
}
export function parseVerifyTier(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (token === '') return DEFAULT_VERIFY_TIER;
  if (VERIFY_TIERS.includes(token)) return token;
  throw new Error(`--tier must be one of ${VERIFY_TIERS.join(', ')}; received ${JSON.stringify(value)}.`);
}
export function parseVerifyScope(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (token === '') return DEFAULT_VERIFY_SCOPE;
  if (VERIFY_SCOPES.includes(token)) return token;
  throw new Error(`--scope must be one of ${VERIFY_SCOPES.join(', ')}; received ${JSON.stringify(value)}.`);
}
/**
 * Resolve the caller's relevance-review declaration against the selected
 * checks. `all` (or `*`) declares the whole selection; a named check that was
 * not selected is a caller error rather than a silently ignored token.
 *
 * @returns {{ids: string[], blocked: string|null}}
 */
export function resolveReviewedChecks(reviewed, selectedNames) {
  const declared = Array.isArray(reviewed) ? reviewed : [];
  if (declared.includes('all') || declared.includes('*')) return { ids: [...selectedNames], blocked: null };
  const unknown = declared.filter((id) => !selectedNames.includes(id));
  if (unknown.length > 0) {
    return { ids: [], blocked: `--reviewed names checks that are not selected: ${unknown.join(', ')}; selected: ${selectedNames.join(', ') || 'none'}` };
  }
  return { ids: [...new Set(declared)], blocked: null };
}
/**
 * Resolve the layer a receipt-required landing verifies at.
 *
 * `verificationAcceptance` refuses `accepted` while a declared layer is still
 * deferred, so a landing that needs a completion receipt cannot default to a
 * cheap layer of a project that declares higher ones. An unnamed tier
 * escalates to the cheapest layer with no deferred evidence; an explicit
 * `--tier` is honored exactly and reported as a preflight blocker instead.
 *
 * @returns {{blocked: string|null, deferredCount: number, escalatedFrom: string|null, selectedNames: string[], tier: string}}
 */
export function resolveReceiptTier({ commands, config, explicit, projectDir, tier }) {
  const planAt = (candidate) => resolveVerifyTierPlan({ commands, config, tier: candidate, only: null, projectDir, explicit: true });
  const planned = planAt(tier);
  const base = { deferredCount: planned.deferredChecks.length, escalatedFrom: null, selectedNames: planned.selectedNames, tier: planned.tier };
  if (planned.deferredChecks.length === 0) return { ...base, blocked: null };
  const cleanLayers = VERIFY_TIERS.slice(VERIFY_TIERS.indexOf(tier) + 1)
    .map(planAt)
    .filter((plan) => plan.deferredChecks.length === 0);
  if (explicit || cleanLayers.length === 0) {
    const usable = cleanLayers.map((plan) => plan.tier).join(', ') || 'none';
    return {
      ...base,
      blocked: `--tier ${tier} leaves ${planned.deferredChecks.length} deferred check(s) (${planned.deferredChecks.map((item) => item.name).join(', ')}); an accepted completion receipt needs a layer with no deferred evidence (${usable})`,
    };
  }
  return { blocked: null, deferredCount: 0, escalatedFrom: tier, selectedNames: cleanLayers[0].selectedNames, tier: cleanLayers[0].tier };
}
export function resolveVerifyTierPlan({ commands, config, tier, only, projectDir, explicit = false }) {
  const tiers = resolveVerificationTiers({ config, projectDir });
  const requestedTier = tier;
  if (!explicit && !only && tiers[tier].length === 0) {
    tier = VERIFY_TIERS.find((name) => tiers[name].length > 0) ?? tier;
  }
  const commandStatus = Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, { command }]));
  const plan = selectVerificationChecks({
    tier, tiers, commandStatus, metadata: config.validationCommands?.checks ?? [], projectDir, only,
  });
  const selectionReasonsByCheck = Object.fromEntries(plan.allChecks.map((check) => [
    check.id,
    [`${check.costTier} 层检查覆盖 ${check.cwd && check.cwd !== '.' ? check.cwd : '项目根目录'}；请求执行层为 ${tier}`],
  ]));
  const selectedChecks = plan.selectedChecks.map((check) => ({
    ...check,
    selectionReasons: selectionReasonsByCheck[check.id] ?? [check.reason ?? `${check.costTier} 层验证命令`],
  }));
  const deferredChecks = plan.deferredChecks.map((check) => ({
    ...check,
    selectionReasons: selectionReasonsByCheck[check.id] ?? [check.reason ?? `${check.costTier} 层验证命令`],
  }));
  return {
    ...plan,
    selectedChecks,
    deferredChecks: deferredChecks.map((check) => ({
      name: check.id, tier: check.costTier, command: check.command,
      ...(check.cwd !== '.' ? { cwd: check.cwd } : {}),
      selectionReasons: check.selectionReasons,
    })),
    tier,
    tierFallback: tier === requestedTier ? null : { from: requestedTier, to: tier, reason: '请求层为空，使用最便宜的非空层' },
    slotTiers: Object.fromEntries(plan.allChecks.map((check) => [check.id, check.costTier])),
    selectedNames: selectedChecks.map((check) => check.id),
    selectionReasonsByCheck,
  };
}
export function manualCommand(command) {
  return command.startsWith('manual:') ? command.slice('manual:'.length).trim() : null;
}
export function displayCommand(command, targetDir) {
  return boundedOutput(command, targetDir);
}
export async function executeCommand(command, targetDir, timeoutMs, redactionRoot = targetDir, environment = {}) {
  const tokens = assertSafeCommand(command);
  let [program, ...args] = tokens;
  if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(program)) {
    program = 'cmd.exe';
    args = ['/c', `${tokens[0]}.cmd`, ...args];
  } else if (process.platform === 'win32' && ['mvnw.cmd', './mvnw.cmd', '.\\mvnw.cmd'].includes(program)) {
    if (tokens.some((token) => /[%!\r\n]/u.test(token))) throw new Error('Unsafe Maven Wrapper arguments.');
    program = 'cmd.exe';
    args = ['/d', '/c', tokens[0], ...args];
  } else if (program === 'node') {
    program = process.execPath;
  }
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: targetDir,
      env: { ...process.env, ...environment },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: boundedOutput(stdout, redactionRoot), stderr: boundedOutput(stderr, redactionRoot) });
    };
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      }, 250).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const append = (stream, chunk) => {
      bytes += chunk.length;
      if (stream === 'stdout') stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      else stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      if (bytes > MAX_OUTPUT_BYTES) terminate();
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => finish({ status: 'failed', code: error.code ?? 'START_FAILED', exitCode: null }));
    child.once('close', (code, signal) => {
      if (timedOut) finish({ status: 'failed', code: 'TIMEOUT', exitCode: null, signal });
      else if (bytes > MAX_OUTPUT_BYTES) finish({ status: 'failed', code: 'OUTPUT_LIMIT', exitCode: null, signal });
      else finish({ status: code === 0 ? 'passed' : 'failed', code: code === 0 ? null : 'COMMAND_FAILED', exitCode: code, signal });
    });
  });
}
/**
 * The relevance review of one verification run.
 *
 * Only an explicit marker makes a passed check `relevant`. The planner emits a
 * selection reason for every selected check, so that reason explains a
 * selection but can never be the evidence that a review happened — treating it
 * as evidence would make the acceptance gate attest itself. A cached receipt
 * is not evidence either: its review describes the run that produced it, so it
 * is recomputed against the declaration this invocation carries rather than
 * inherited. `--reviewed` is the caller's declaration.
 */
export function verificationReview({ changedPaths = [], selectedNames = [], checks = {}, reviewed = [] } = {}) {
  const declared = new Set(reviewed);
  const reviewedCheckIds = selectedNames.filter((name) => {
    const check = checks[name];
    // A reused receipt carries no per-check result, so the declaration alone
    // decides; a run that executed checks needs a passed check to declare.
    if (check === undefined) return declared.has(name);
    return ['passed', 'reused'].includes(check?.status)
      && declared.has(name);
  });
  return {
    status: reviewedCheckIds.length > 0 ? 'relevant' : selectedNames.length > 0 ? 'unreviewed' : 'blocked',
    changedPaths: [...changedPaths],
    selectedCheckIds: [...selectedNames],
    ...(reviewedCheckIds.length ? { reviewedCheckIds } : {}),
    reasonCode: reviewedCheckIds.length ? 'RELEVANT_CHECK_REVIEWED' : 'NO_REVIEWED_RELEVANT_CHECK',
  };
}
export function verificationAcceptance({ review, status, snapshotComparison, inputsStable, fingerprint, selectedNames = [], deferredCount = 0 } = {}) {
  const passed = status === 'verified' || status === 'passed' || status === 'reused';
  const stable = snapshotComparison === 'match' && inputsStable !== false && typeof fingerprint === 'string' && fingerprint.length > 0;
  const relevant = review?.status === 'relevant' && (review.reviewedCheckIds ?? []).some((id) => selectedNames.includes(id));
  let reasonCode = 'ACCEPTED';
  if (!passed) reasonCode = 'VERIFICATION_NOT_PASSED';
  else if (deferredCount > 0) reasonCode = 'DEFERRED_CHECKS';
  else if (!stable) reasonCode = 'FINAL_SNAPSHOT_MISMATCH';
  else if (!relevant) reasonCode = review?.status === 'blocked' ? 'REVIEW_BLOCKED' : 'NO_REVIEWED_RELEVANT_CHECK';
  return {
    status: passed && stable && relevant && deferredCount === 0 ? 'accepted' : 'blocked',
    reasonCode,
    finalFingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    selectedCheckIds: [...selectedNames],
    reviewStatus: review?.status ?? 'unreviewed',
  };
}
