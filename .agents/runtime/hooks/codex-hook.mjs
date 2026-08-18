#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectRoot, readHookSettings } from './lib/context.mjs';
import { evaluateExecutionEnvelope } from './lib/execution-envelope.mjs';
import { analyzeToolRequest, createHostHookResult, normalizeHostHookInput } from './lib/policy.mjs';
import { inspectRtkHook, routeRtkCommand } from './lib/rtk.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const guardedEvents = new Set(['PermissionRequest', 'PreToolUse']);
export const HOOK_FAILURE_CODES = Object.freeze({
  inputInvalid: 'HOOK_INPUT_INVALID',
  invalidJson: 'HOOK_INPUT_INVALID_JSON',
  inputTooLarge: 'HOOK_INPUT_TOO_LARGE',
  eventMismatch: 'HOOK_EVENT_MISMATCH',
  projectContextUnavailable: 'HOOK_PROJECT_CONTEXT_UNAVAILABLE',
  runtimeError: 'HOOK_RUNTIME_ERROR',
});
const hookFailureMessages = new Map([
  [HOOK_FAILURE_CODES.inputInvalid, 'Hook input does not match the supported event contract.'],
  [HOOK_FAILURE_CODES.invalidJson, 'Hook input is not valid JSON.'],
  [HOOK_FAILURE_CODES.inputTooLarge, 'Hook input exceeds the safe size limit.'],
  [HOOK_FAILURE_CODES.eventMismatch, 'Hook event does not match the configured lifecycle event.'],
  [HOOK_FAILURE_CODES.projectContextUnavailable, 'Hook project context is unavailable.'],
  [HOOK_FAILURE_CODES.runtimeError, 'Hook runtime could not safely evaluate this event.'],
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

function hookFailureResult(host, expectedEvent) {
  const reason = '[VIBE_HARNESS_HOOK:' + currentFailureCode + '] ' + hookFailureMessages.get(currentFailureCode);
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
  const rootDir = await findProjectRoot(input.cwd);
  const settings = await readHookSettings(rootDir);
  const envelopeConfigured = Object.hasOwn(input, 'executionEnvelope')
    || Object.hasOwn(environment, 'VIBE_HARNESS_EXECUTION_ENVELOPE')
    || environment.VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED === '1';
  if (settings.mode === 'off' && !envelopeConfigured) return {};

  const safetyDecision = analyzeToolRequest(input, {
    allowedWriteRoots: settings.allowedWriteRoots,
    allowedEgressHosts: settings.allowedEgressHosts,
    mode: settings.mode,
    projectRoot: rootDir,
    redZonePaths: settings.redZonePaths,
  });
  if (safetyDecision.action === 'deny') {
    return createHostHookResult(host, input.event, safetyDecision, { durationMs: elapsedMs() });
  }
  const envelopeDecision = evaluateExecutionEnvelope(input, {
    environment,
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

export async function evaluateCodexHook(rawInput, options = {}) {
  return evaluateHook(rawInput, { ...options, host: 'codex' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const expectedEvent = expectedEventFromArgs(argv);
  const host = hostFromArgs(argv);
  try {
    const result = await evaluateHook(await readStdin(), { expectedEvent, host });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(hookFailureResult(host, expectedEvent))}\n`);
  }
}
