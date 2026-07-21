#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectContext, findProjectRoot, readHookSettings, runEvaluationCheck, runGovernanceCheck } from './lib/context.mjs';
import { validateDeliveryMessage } from './lib/delivery-validation.mjs';
import { analyzeToolRequest, createCodexHookResult, normalizeCodexHookInput } from './lib/policy.mjs';
import { inspectRtkHook, routeRtkCommand, rtkSessionContext } from './lib/rtk.mjs';

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
  if (guardedEvents.has(expectedEvent)) {
    return createCodexHookResult(expectedEvent, { action: 'deny', reason });
  }
  return { systemMessage: reason };
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

  if (input.event === 'PreToolUse' || input.event === 'PermissionRequest') {
    const safetyDecision = analyzeToolRequest(input, {
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
  if (input.event === 'SessionStart' || input.event === 'PostCompact') {
    const rtk = await inspectRtkHook(rootDir, { enabled: settings.rtkEnabled });
    return {
      hookSpecificOutput: {
        additionalContext: `${await buildProjectContext(rootDir)}\n${rtkSessionContext(rtk)}`,
        hookEventName: input.event,
      },
    };
  }
  if (input.event === 'UserPromptSubmit') {
    return {
      hookSpecificOutput: {
        additionalContext: '如果当前请求创建新任务或使任务范围发生实质变化，在首次使用工具前按治理内核输出“任务确认”；普通追问不要重复输出。',
        hookEventName: input.event,
      },
    };
  }
  if (input.event === 'SubagentStart') {
    return {
      hookSpecificOutput: {
        additionalContext: [
          'Work only from the delegated child-task brief and minimum required context.',
          'Stay within its project-relative write scope and do not modify the parent-controlled task Markdown.',
          'Do not delegate, create subagents, or split the task further; report a blocked status and requested split to the parent Agent.',
          'Preserve user changes, do not approve your own work, and return status, change summary, changed paths, verification evidence, unverified items, remaining risks, and next action.',
        ].join(' '),
        hookEventName: input.event,
      },
    };
  }
  if (input.event === 'PostToolUse' && /(?:apply_patch|write|edit)/iu.test(input.toolName ?? '')) {
    return {
      hookSpecificOutput: {
        additionalContext: 'Files changed; keep validation evidence current before claiming completion.',
        hookEventName: input.event,
      },
    };
  }
  if (input.event === 'SubagentStop') {
    return {
      systemMessage: 'Subagent stopped. The parent Agent must inspect the actual diff and claimed evidence, persist the child status in the parent-controlled task Markdown, resolve merge-back state, and rerun affected validation in the integrated target workspace before adoption or completion.',
    };
  }
  if (input.event === 'Stop' && settings.completionGate !== 'off') {
    const [governance, evaluation, delivery] = await Promise.all([
      runGovernanceCheck(rootDir),
      runEvaluationCheck(rootDir, settings.evaluationsEnabled ? settings.validationCommands.eval : null),
      Promise.resolve(validateDeliveryMessage(input.lastAssistantMessage)),
    ]);
    const issues = [];
    if (governance.status === 'unavailable') {
      issues.push('Cognis governance validator is unavailable. Repair or reinstall the expected runtime, then verify again.');
    } else if (!governance.ok) {
      issues.push('Cognis governance validation failed. Fix the evidence or task state, then verify again.');
    }
    if (!evaluation.ok) issues.push('Cognis evaluation validation failed. Fix the Eval-ID evidence or reference, then verify again.');
    if (!delivery.ok) issues.push(`Delivery packet missing: ${delivery.missing.join(', ')}.`);
    if (issues.length === 0) return {};
    const reason = issues.join(' ');
    if (settings.completionGate === 'blocking' && !input.stopHookActive) return { decision: 'block', reason };
    return { systemMessage: input.stopHookActive ? `${reason} Completion was not blocked again.` : reason };
  }
  return {};
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
