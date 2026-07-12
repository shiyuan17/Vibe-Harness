#!/usr/bin/env node
import { buildProjectContext, findProjectRoot, readHookSettings, runGovernanceCheck } from './lib/context.mjs';
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
    const governance = await runGovernanceCheck(rootDir);
    if (!governance.ok && settings.completionGate === 'blocking' && !input.stopHookActive) {
      return { decision: 'block', reason: 'LoopEngine governance validation failed. Fix the evidence or task state, then verify again.' };
    }
    if (!governance.ok) {
      return { systemMessage: 'LoopEngine governance validation is still failing; completion was not blocked again.' };
    }
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
