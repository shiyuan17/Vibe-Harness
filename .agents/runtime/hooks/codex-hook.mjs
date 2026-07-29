#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findProjectRoot, readHookSettings } from './lib/context.mjs';
import { analyzeToolRequest, createCodexHookResult, normalizeCodexHookInput } from './lib/policy.mjs';
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

function hookFailureResult(expectedEvent) {
  const reason = 'HOOK_RUNTIME_ERROR: Cognis could not safely evaluate this hook event.';
  return guardedEvents.has(expectedEvent)
    ? createCodexHookResult(expectedEvent, { action: 'deny', reason })
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

export async function evaluateCodexHook(rawInput, { expectedEvent, rtkRunner } = {}) {
  const input = normalizeCodexHookInput(rawInput);
  if (expectedEvent && input.event !== expectedEvent) {
    throw new Error('Hook event does not match the configured event.');
  }
  const rootDir = await findProjectRoot(input.cwd);
  const settings = await readHookSettings(rootDir);
  if (settings.mode === 'off') return {};

  const safetyDecision = analyzeToolRequest(input, {
    allowedWriteRoots: settings.allowedWriteRoots,
    mode: settings.mode,
    projectRoot: rootDir,
  });
  if (safetyDecision.action !== 'allow' || input.event === 'PermissionRequest') {
    return createCodexHookResult(input.event, safetyDecision);
  }

  const rtk = await inspectRtkHook(rootDir, { enabled: settings.rtkEnabled });
  const rtkDecision = await routeRtkCommand(input, {
    mode: settings.mode,
    projectRoot: rootDir,
    rtk,
    ...(rtkRunner ? { runner: rtkRunner } : {}),
  });
  return createCodexHookResult(input.event, rtkDecision);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expectedEvent = expectedEventFromArgs(process.argv.slice(2));
  try {
    const result = await evaluateCodexHook(await readStdin(), { expectedEvent });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(hookFailureResult(expectedEvent))}\n`);
  }
}
