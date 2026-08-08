#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectRoot, readHookSettings } from './lib/context.mjs';
import { analyzeToolRequest, createHostHookResult, normalizeHostHookInput } from './lib/policy.mjs';
import { inspectRtkHook, routeRtkCommand } from './lib/rtk.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const guardedEvents = new Set(['PermissionRequest', 'PreToolUse']);

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
  const reason = 'HOOK_RUNTIME_ERROR: Vibe-Harness could not safely evaluate this hook event.';
  return guardedEvents.has(expectedEvent)
    ? createHostHookResult(host, expectedEvent, { action: 'deny', reason })
    : { systemMessage: reason };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Hook input exceeds 1 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function evaluateHook(rawInput, { expectedEvent, host = 'codex', rtkRunner } = {}) {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  const input = normalizeHostHookInput(rawInput, { expectedEvent, fallbackCwd: process.cwd(), host });
  if (expectedEvent && input.event !== expectedEvent) {
    throw new Error('Hook event does not match the configured event.');
  }
  const rootDir = await findProjectRoot(input.cwd);
  const settings = await readHookSettings(rootDir);
  if (settings.mode === 'off') return {};

  const safetyDecision = analyzeToolRequest(input, {
    allowedWriteRoots: settings.allowedWriteRoots,
    allowedEgressHosts: settings.allowedEgressHosts,
    mode: settings.mode,
    projectRoot: rootDir,
    redZonePaths: settings.redZonePaths,
  });
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
