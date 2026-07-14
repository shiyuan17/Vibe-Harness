import path from 'node:path';

export const supportedCodexHookEvents = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

const writeToolPattern = /(?:apply_patch|write|edit|delete|remove|move|rename|create)/iu;
const pathKeyPattern = /^(?:file_?path|path|target|destination|directory(?:_?path)?|dir)$/iu;
const destructiveGitPatterns = [
  /\bgit\s+reset\s+--hard\b/iu,
  /\bgit\s+clean\s+(?=[^\r\n]*-[a-z]*f)/iu,
  /\bgit\s+(?:checkout|restore)\s+--\s+/iu,
  /\bgit\s+[^\r\n]*--no-verify\b/iu,
  /\bgit\s+config\s+--global\b/iu,
];
const globalAgentConfigPattern = /(?:~|\$HOME|%USERPROFILE%|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|[\\/](?:home|Users)[\\/][^\\/]+)[\\/]+\.(?:codex|claude|cursor|gemini)(?:[\\/]|$)/iu;
const projectRedZonePattern = /(?:^|\/)(?:\.codex\/hooks\.json|\.github\/workflows\/|\.env(?:\.|$)|auth(?:\/|$)|ci\/cd(?:\/|$))/iu;
const networkCommandPattern = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/iu;
const secretReferencePattern = /(?:\$\{?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\}?|%(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD))%|Authorization\s*:[^\r\n]*(?:KEY|TOKEN|SECRET))/iu;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

export function normalizeCodexHookInput(value) {
  assertObject(value, 'Codex hook input');
  const event = value.hook_event_name;
  if (typeof event !== 'string' || !supportedCodexHookEvents.has(event)) {
    throw new Error(`Unsupported hook event: ${String(event)}`);
  }
  if (typeof value.session_id !== 'string' || value.session_id.length === 0) {
    throw new Error('Codex hook input.session_id is required.');
  }
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) {
    throw new Error('Codex hook input.cwd is required.');
  }

  return {
    cwd: value.cwd,
    event,
    lastAssistantMessage: typeof value.last_assistant_message === 'string' ? value.last_assistant_message : '',
    permissionMode: value.permission_mode,
    sessionId: value.session_id,
    source: value.source,
    stopHookActive: value.stop_hook_active === true,
    toolInput: value.tool_input,
    toolName: value.tool_name,
    turnId: value.turn_id,
  };
}

function isInside(baseDir, candidate) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function commandFrom(input) {
  return typeof input.toolInput?.command === 'string' ? input.toolInput.command : '';
}

function collectStructuredPaths(value, key = '', result = []) {
  if (typeof value === 'string' && pathKeyPattern.test(key)) {
    result.push(value);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPaths(item, key, result);
    return result;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectStructuredPaths(childValue, childKey, result);
  }
  return result;
}

function patchPaths(command) {
  return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gmu)].map((match) => match[1].trim());
}

function classifyRisk(input, projectRoot) {
  const command = commandFrom(input);
  if (destructiveGitPatterns.some((pattern) => pattern.test(command))) {
    return { level: 'deny', reason: 'Destructive Git operation or hook bypass is blocked by repository policy.' };
  }
  if (globalAgentConfigPattern.test(command)) {
    return { level: 'deny', reason: 'Writes to global Agent configuration are blocked by repository policy.' };
  }
  if (networkCommandPattern.test(command) && secretReferencePattern.test(command)) {
    return { level: 'deny', reason: 'Possible credential exfiltration is blocked by repository policy.' };
  }

  if (!writeToolPattern.test(input.toolName ?? '')) return null;
  const candidates = [
    ...collectStructuredPaths(input.toolInput),
    ...(input.toolName === 'apply_patch' ? patchPaths(command) : []),
  ];
  for (const candidate of candidates) {
    if (globalAgentConfigPattern.test(candidate)) {
      return { level: 'deny', reason: 'Writes to global Agent configuration are blocked by repository policy.' };
    }
    const absolute = path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    if (!isInside(projectRoot, absolute)) {
      return { level: 'deny', reason: 'Write target escapes the project boundary.' };
    }
  }
  const touchesRedZone = candidates.some((candidate) => {
    const absolute = path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    return projectRedZonePattern.test(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
  });
  if (touchesRedZone) {
    return { level: 'warn', reason: 'The pending write touches a project red-zone; keep explicit approval and verification evidence.' };
  }
  return null;
}

export function analyzeToolRequest(input, { mode = 'guarded', projectRoot = input.cwd } = {}) {
  if (mode === 'off') return { action: 'allow' };
  const risk = classifyRisk(input, projectRoot);
  if (!risk) return { action: 'allow' };
  if (risk.level === 'warn' || mode === 'observe') return { action: 'warn', reason: risk.reason };
  return { action: 'deny', reason: risk.reason };
}

export function createCodexHookResult(event, decision) {
  if (!decision || decision.action === 'allow') return {};
  if (event === 'PermissionRequest' && decision.action !== 'deny') return {};
  if (decision.action === 'warn') {
    return {
      hookSpecificOutput: {
        additionalContext: decision.reason,
        hookEventName: event,
      },
    };
  }
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        decision: { behavior: 'deny', message: decision.reason },
        hookEventName: event,
      },
    };
  }
  if (event === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }
  return { decision: 'block', reason: decision.reason };
}
