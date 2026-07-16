#!/usr/bin/env node
import { buildProjectContext, findProjectRoot, readHookSettings, runEvaluationCheck, runGovernanceCheck } from './lib/context.mjs';
import { validateDeliveryMessage } from './lib/delivery-validation.mjs';
import { analyzeToolRequest, createCodexHookResult, normalizeCodexHookInput } from './lib/policy.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

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

export async function evaluateCodexHook(rawInput) {
  const input = normalizeCodexHookInput(rawInput);
  const rootDir = await findProjectRoot(input.cwd);
  const settings = await readHookSettings(rootDir);
  if (settings.mode === 'off') return {};

  if (input.event === 'PreToolUse' || input.event === 'PermissionRequest') {
    return createCodexHookResult(input.event, analyzeToolRequest(input, {
      mode: settings.mode,
      projectRoot: rootDir,
    }));
  }
  if (input.event === 'SessionStart' || input.event === 'PostCompact') {
    return {
      hookSpecificOutput: {
        additionalContext: await buildProjectContext(rootDir),
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
        additionalContext: 'Stay within the delegated write scope, preserve user changes, and return verification evidence.',
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
    return { systemMessage: 'Subagent stopped; verify its claimed changes and evidence before adoption.' };
  }
  if (input.event === 'Stop' && settings.completionGate !== 'off') {
    const [governance, evaluation, delivery] = await Promise.all([
      runGovernanceCheck(rootDir),
      runEvaluationCheck(rootDir, settings.evaluationsEnabled ? settings.validationCommands.eval : null),
      Promise.resolve(validateDeliveryMessage(input.lastAssistantMessage)),
    ]);
    const issues = [];
    if (governance.status === 'unavailable') {
      issues.push('LoopEngine governance validator is unavailable. Repair or reinstall the expected runtime, then verify again.');
    } else if (!governance.ok) {
      issues.push('LoopEngine governance validation failed. Fix the evidence or task state, then verify again.');
    }
    if (!evaluation.ok) issues.push('LoopEngine evaluation validation failed. Fix the Eval-ID evidence or reference, then verify again.');
    if (!delivery.ok) issues.push(`Delivery packet missing: ${delivery.missing.join(', ')}.`);
    if (issues.length === 0) return {};
    const reason = issues.join(' ');
    if (settings.completionGate === 'blocking' && !input.stopHookActive) return { decision: 'block', reason };
    return { systemMessage: input.stopHookActive ? `${reason} Completion was not blocked again.` : reason };
  }
  return {};
}

try {
  const result = await evaluateCodexHook(await readStdin());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`LoopEngine hook error: ${error.message}\n`);
  process.exitCode = 2;
}
