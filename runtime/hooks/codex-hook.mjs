#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { findProjectRoot, readHookSettings } from './lib/context.mjs';
import { evaluateFrozenTestWrite } from './lib/frozen-test-writes.mjs';
import { classifyExecutionEffects, evaluateExecutionEnvelope } from './lib/execution-envelope.mjs';
import { analyzeToolRequest, commandFrom, createHostHookResult, normalizeHostHookInput } from './lib/policy.mjs';
import { isReadOnlyToolName } from './lib/read-only-commands.mjs';
import { inspectRtkHook, routeRtkCommand } from './lib/rtk.mjs';

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 1024 * 1024;
// The host kills a Hook that outlives its own timeout (10s in the installed
// configuration) and then continues the tool call, so the runtime keeps its own
// budget well below that deadline and answers with the same fail-closed
// decision instead of being killed. The budget can only be shortened through
// the parent-owned environment knob, never widened.
const DEFAULT_BUDGET_MS = 5000;
const hookBudgetMs = (() => {
  const override = Number(process.env.VIBE_HARNESS_HOOK_BUDGET_MS);
  if (!Number.isFinite(override) || override <= 0) return DEFAULT_BUDGET_MS;
  return Math.min(DEFAULT_BUDGET_MS, Math.floor(override));
})();
const guardedEvents = new Set(['PermissionRequest', 'PreToolUse']);
export const HOOK_FAILURE_CODES = Object.freeze({
  inputInvalid: 'HOOK_INPUT_INVALID',
  invalidJson: 'HOOK_INPUT_INVALID_JSON',
  inputTooLarge: 'HOOK_INPUT_TOO_LARGE',
  eventMismatch: 'HOOK_EVENT_MISMATCH',
  projectContextUnavailable: 'HOOK_PROJECT_CONTEXT_UNAVAILABLE',
  runtimeError: 'HOOK_RUNTIME_ERROR',
  budgetExceeded: 'HOOK_BUDGET_EXCEEDED',
});
/** @type {Map<string, string>} */
const hookFailureMessages = new Map([
  [HOOK_FAILURE_CODES.inputInvalid, 'Hook input does not match the supported event contract.'],
  [HOOK_FAILURE_CODES.invalidJson, 'Hook input is not valid JSON.'],
  [HOOK_FAILURE_CODES.inputTooLarge, 'Hook input exceeds the safe size limit.'],
  [HOOK_FAILURE_CODES.eventMismatch, 'Hook event does not match the configured lifecycle event.'],
  [HOOK_FAILURE_CODES.projectContextUnavailable, 'Hook project context is unavailable.'],
  [HOOK_FAILURE_CODES.runtimeError, 'Hook runtime could not safely evaluate this event.'],
  [HOOK_FAILURE_CODES.budgetExceeded, 'Hook runtime exceeded its internal budget before a safe decision was available.'],
]);
let currentFailureCode = HOOK_FAILURE_CODES.runtimeError;

function hookFailure(code) {
  currentFailureCode = code;
  return Object.assign(new Error(code), { code });
}

function expectedEventFromArgs(argv) {
  const index = argv.indexOf('--expected-event');
  if (index === -1) return null;
  const expectedEvent = argv[index + 1];
  if (!expectedEvent || expectedEvent.startsWith('--')) throw new Error('Missing expected hook event.');
  return expectedEvent;
}

function hostFromArgs(argv) {
  const index = argv.indexOf('--host');
  if (index === -1) return 'codex';
  const host = argv[index + 1];
  if (!['codex', 'cursor', 'qoder', 'zcode', 'antigravity', 'claude'].includes(host)) throw new Error('Unsupported hook host.');
  return host;
}

/** @param {string} host @param {string | null} expectedEvent @param {string} [code] */
function hookFailureResult(host, expectedEvent, code = currentFailureCode) {
  const reason = '[VIBE_HARNESS_HOOK:' + code + '] ' + hookFailureMessages.get(code);
  return guardedEvents.has(expectedEvent)
    ? createHostHookResult(host, expectedEvent, { action: 'deny', reason })
    : { systemMessage: reason };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw hookFailure(HOOK_FAILURE_CODES.inputTooLarge);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw hookFailure(HOOK_FAILURE_CODES.invalidJson);
  }
}

/**
 * A fast-forward-only pull never rewrites local commits, but git still refuses
 * to run it while tracked files carry uncommitted changes. The effect
 * classifier reports that requirement instead of probing the filesystem, so
 * the hook resolves it here with one read-only `git status` right before it can
 * return an allow. Untracked files stay out of the check: a fast-forward does
 * not touch them, so a checkout that only carries untracked files is still safe
 * to sync. Any failure to read the state (no repository, git unavailable,
 * timeout) fails closed rather than assuming a clean tree.
 *
 * @param {{cwd?: string, toolInput?: unknown, toolName?: string}} input
 * @returns {Promise<{action: string, reason: string, reasonCode: string} | null>}
 */
async function evaluateSyncWorkingTreeGuard(input) {
  if (classifyExecutionEffects(input).cleanTreeRequired !== true) return null;
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: input.cwd,
      timeout: 3000,
      windowsHide: true,
    }));
  } catch {
    return {
      action: 'deny',
      reason: 'A fast-forward-only pull could not confirm a clean working tree, so the sync was refused.',
      reasonCode: 'VIBE_HARNESS_SYNC_STATE_UNAVAILABLE',
    };
  }
  if (String(stdout).trim() !== '') {
    return {
      action: 'deny',
      reason: 'A fast-forward-only pull needs a clean tracked working tree; commit or stash the pending changes first.',
      reasonCode: 'VIBE_HARNESS_SYNC_DIRTY_TREE',
    };
  }
  return null;
}

/**
 * @param {unknown} rawInput
 * @param {{environment?: NodeJS.ProcessEnv, expectedEvent?: string | null, host?: string, now?: number | Date, rtkRunner?: (binary: string, command: string, options?: {cwd?: string, maxOutputBytes?: number, timeoutMs?: number}) => Promise<Record<string, any>>}} options
 */
export async function evaluateHook(rawInput, {
  environment = process.env,
  expectedEvent,
  host = 'codex',
  now,
  rtkRunner,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  let input;
  try {
    input = normalizeHostHookInput(rawInput, { expectedEvent, fallbackCwd: process.cwd(), host });
  } catch {
    throw hookFailure(HOOK_FAILURE_CODES.inputInvalid);
  }
  if (expectedEvent && input.event !== expectedEvent) {
    throw hookFailure(HOOK_FAILURE_CODES.eventMismatch);
  }
  try {
    const contextStat = await stat(input.cwd);
    if (!contextStat.isDirectory()) throw hookFailure(HOOK_FAILURE_CODES.projectContextUnavailable);
  } catch (error) {
    if (error?.code === HOOK_FAILURE_CODES.projectContextUnavailable) throw error;
    throw hookFailure(HOOK_FAILURE_CODES.projectContextUnavailable);
  }
  // Read-only tools with no command payload can never reach a deny verdict in
  // policy (the write gate misses them), the envelope (read-only
  // classification) or RTK routing (empty command), so they skip project-root
  // resolution and settings loading. The cwd check above still fails closed
  // first, and this answer matches createHostHookResult's allow shape for
  // every host.
  if (isReadOnlyToolName(String(input.toolName ?? '')) && commandFrom(input) === '') {
    return host === 'antigravity' ? { decision: 'allow' } : {};
  }
  const rootDir = await findProjectRoot(input.cwd);
  const settings = await readHookSettings(rootDir);
  const syncDecision = await evaluateSyncWorkingTreeGuard(input);
  if (syncDecision !== null) {
    return createHostHookResult(host, input.event, syncDecision, { durationMs: elapsedMs() });
  }
  const frozenTestDecision = await evaluateFrozenTestWrite(input, rootDir);
  if (frozenTestDecision.action === 'deny') {
    return createHostHookResult(host, input.event, frozenTestDecision, { durationMs: elapsedMs() });
  }
  // The host injects the acting role's permission preset through the parent-
  // owned environment; the project config can also declare one. The host
  // channel wins and, like the execution envelope, still applies when the
  // project turns the hook off, because role scoping is host authority.
  const hostPreset = typeof environment.VIBE_HARNESS_PERMISSION_PRESET === 'string'
    && environment.VIBE_HARNESS_PERMISSION_PRESET.trim().length > 0
    ? environment.VIBE_HARNESS_PERMISSION_PRESET.trim()
    : null;
  const envelopeConfigured = Object.hasOwn(input, 'executionEnvelope')
    || Object.hasOwn(environment, 'VIBE_HARNESS_EXECUTION_ENVELOPE')
    || environment.VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED === '1';
  if (settings.mode === 'off' && !envelopeConfigured && !hostPreset) return {};
  const permissionPreset = hostPreset ?? settings.permissionPreset ?? null;

  const safetyDecision = analyzeToolRequest(input, {
    allowedWriteRoots: settings.allowedWriteRoots,
    allowedEgressHosts: settings.allowedEgressHosts,
    mode: settings.mode,
    permissionPreset,
    projectRoot: rootDir,
    redZonePaths: settings.redZonePaths,
  });
  if (safetyDecision.action === 'deny') {
    return createHostHookResult(host, input.event, safetyDecision, { durationMs: elapsedMs() });
  }
  const envelopeDecision = evaluateExecutionEnvelope(input, {
    environment,
    permissionPreset,
    ...(now === undefined ? {} : { now }),
  });
  if (envelopeDecision.action !== 'allow') {
    return createHostHookResult(host, input.event, envelopeDecision, { durationMs: elapsedMs() });
  }
  if (safetyDecision.action !== 'allow' || input.event === 'PermissionRequest') {
    return createHostHookResult(host, input.event, safetyDecision, { durationMs: elapsedMs() });
  }

  if (host === 'antigravity') {
    return createHostHookResult(host, input.event, safetyDecision, { durationMs: elapsedMs() });
  }
  if (host !== 'codex') return {};

  const rtk = await inspectRtkHook(rootDir, { enabled: settings.rtkEnabled });
  const rtkDecision = await routeRtkCommand(input, {
    mode: settings.mode,
    projectRoot: rootDir,
    rtk,
    ...(rtkRunner ? { runner: rtkRunner } : {}),
  });
  return createHostHookResult(host, input.event, rtkDecision, { durationMs: elapsedMs() });
}

/** @param {unknown} rawInput @param {{environment?: NodeJS.ProcessEnv, expectedEvent?: string | null, now?: number | Date, rtkRunner?: (binary: string, command: string, options?: {cwd?: string, maxOutputBytes?: number, timeoutMs?: number}) => Promise<Record<string, any>>}} options */
export async function evaluateCodexHook(rawInput, options = {}) {
  return evaluateHook(rawInput, { ...options, host: 'codex' });
}

// A Worktree reaches this entry through its `.agents` junction, so the entry
// path is compared by realpath: a plain resolve/URL comparison made a Worktree
// session skip every safety decision and return no result at all.
const hookEntryPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;
const hookModulePath = await realpath(fileURLToPath(import.meta.url))
  .catch(() => fileURLToPath(import.meta.url));
if (hookEntryPath !== null && hookEntryPath === hookModulePath) {
  const argv = process.argv.slice(2);
  const expectedEvent = expectedEventFromArgs(argv);
  const host = hostFromArgs(argv);
  // One writer per process: whichever path answers first wins, so a budget
  // expiry can never append a second JSON document after a real decision.
  let answered = false;
  const answer = (value) => {
    if (answered) return;
    answered = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const budget = setTimeout(() => {
    answer(hookFailureResult(host, expectedEvent, HOOK_FAILURE_CODES.budgetExceeded));
    process.exit(0);
  }, hookBudgetMs);
  try {
    const result = await evaluateHook(await readStdin(), { expectedEvent, host });
    answer(result);
  } catch {
    answer(hookFailureResult(host, expectedEvent));
  }
  clearTimeout(budget);
}
