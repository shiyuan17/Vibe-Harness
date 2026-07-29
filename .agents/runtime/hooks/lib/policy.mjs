import path from 'node:path';
import { realpathSync } from 'node:fs';

export const supportedCodexHookEvents = new Set([
  'PreToolUse',
  'PermissionRequest',
]);

const writeToolPattern = /(?:apply_patch|write|edit|delete|remove|move|rename|create)/iu;
const pathKeyPattern = /^(?:file_?path|path|target|destination|directory(?:_?path)?|dir)$/iu;
const globalAgentConfigPattern = /(?:~|\$(?:\{)?HOME(?:\})?|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|[\\/](?:home|Users)[\\/][^\\/]+)[^\r\n]{0,96}[\\/'"]+\.(?:codex|claude|cursor|gemini)(?:[\\/'"]|$)/iu;
const networkCommandPattern = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/iu;
const secretReferencePattern = /(?:\$\{?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\}?|%(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD))%|Authorization\s*:[^\r\n]*(?:KEY|TOKEN|SECRET))/iu;
const egressUploadFlags = new Set(['-F', '--form', '-d', '--data', '--data-binary', '--data-raw', '-T', '--upload-file']);
const urlHostPattern = /https?:\/\/\[?([^\]/:@\s]+)/iu;
const privateEgressPattern = /(?:curl|wget)[^\n]*(?:-F|--form|-d|--data(?:-binary|-raw)?|-T|--upload-file)/iu;

// Build a red-zone matcher from configured path patterns. Each pattern is a
// project-relative path fragment (e.g. `.env`, `auth/`, `.codex/hooks.json`).
// A trailing `/` matches the directory and its descendants; any other entry
// matches the path itself or a `.`-extended sibling (so `.env` also covers
// `.env.production` and `.codex/hooks.json` covers `.codex/hooks.json.bak`).
// The compiled regex mirrors the previous hard-coded projectRedZonePattern so
// behaviour is unchanged when the default patterns from context.mjs are used.
function compileRedZonePattern(redZonePaths) {
  const alternatives = redZonePaths.map((raw) => {
    const escaped = raw.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (raw.endsWith('/')) return `${escaped.slice(0, -1)}(?:\\/|$)`;
    return `${escaped}(?:\\.|$)`;
  });
  return new RegExp(`(?:^|/)(${alternatives.join('|')})`, 'iu');
}

export function redZoneMatcher(redZonePaths) {
  return redZonePaths && redZonePaths.length > 0 ? compileRedZonePattern(redZonePaths) : null;
}

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

  const normalized = {
    cwd: value.cwd,
    event,
    permissionMode: value.permission_mode,
    sessionId: value.session_id,
    toolInput: value.tool_input,
    toolName: value.tool_name,
  };
  return normalized;
}

function isInside(baseDir, candidate) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

function commandFrom(input) {
  for (const key of ['command', 'cmd', 'input']) {
    if (typeof input.toolInput?.[key] === 'string') return input.toolInput[key];
  }
  return '';
}

function shellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (['&&', '||'].includes(pair)) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    if ([';', '|', '\n', '\r'].includes(character)) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function commandTokens(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function gitCommandRisk(segment) {
  const tokens = commandTokens(segment);
  const executableIndex = tokens.findIndex((token) => /(?:^|[\\/])git(?:\.exe)?$/iu.test(token));
  if (executableIndex < 0) return null;
  const args = tokens.slice(executableIndex + 1);
  let index = 0;
  while (index < args.length) {
    const value = args[index].toLowerCase();
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(value)) {
      index += 2;
      continue;
    }
    if (['-p', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(value)) {
      index += 1;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|config-env)=/u.test(value)) {
      index += 1;
      continue;
    }
    break;
  }
  const command = args[index]?.toLowerCase();
  const rest = args.slice(index + 1).map((item) => item.toLowerCase());
  if (!command) return null;
  if (args.some((item) => item.toLowerCase() === '--no-verify')) return 'hook bypass';
  if (command === 'reset' && rest.some((item) => ['--hard', '--merge', '--keep'].includes(item))) return 'destructive reset';
  if (command === 'clean' && !rest.some((item) => item === '-n' || item === '--dry-run' || /^-[a-z]*n[a-z]*$/u.test(item))) return 'destructive clean';
  if (command === 'restore') return 'destructive restore';
  if (command === 'checkout' && (rest.includes('--') || rest.some((item) => ['-f', '--force'].includes(item)))) return 'destructive checkout';
  if (command === 'switch' && rest.some((item) => ['-f', '--force', '--discard-changes'].includes(item))) return 'destructive switch';
  if (command === 'stash' && rest.some((item) => ['clear', 'drop'].includes(item))) return 'destructive stash';
  if (['merge', 'rebase', 'cherry-pick'].includes(command) && rest.includes('--abort')) return 'destructive abort';
  if (command === 'branch' && rest.some((item) => item === '-D' || item === '-d')) return 'destructive branch deletion';
  if (command === 'tag' && rest.includes('-d')) return 'destructive tag deletion';
  if (command === 'config' && rest.includes('--global')) {
    const readOnly = rest.some((item) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(item));
    if (!readOnly) return 'global Git configuration write';
  }
  return null;
}

function referencesGlobalAgentConfig(value) {
  return globalAgentConfigPattern.test(value);
}

function commandWrites(segment) {
  if (/(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|tee|rm|mv|cp|sed\s+-i)\b/iu.test(segment)) return true;
  return /(?:^|[^<])>>?/u.test(segment);
}

function shellWritePaths(command) {
  const targets = [];
  for (const match of command.matchAll(/(?:^|[\s\d])>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu)) {
    targets.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const segment of shellSegments(command)) {
    const tokens = commandTokens(segment);
    const executable = tokens.findIndex((token) => /(?:^|[\\/])(?:cp|mv|rm|tee|truncate)(?:\.exe)?$/iu.test(token));
    if (executable < 0) continue;
    const commandName = path.basename(tokens[executable]).toLowerCase().replace(/\.exe$/u, '');
    const operands = tokens.slice(executable + 1).filter((token) => !token.startsWith('-'));
    if (['cp', 'mv'].includes(commandName) && operands.length > 1) targets.push(operands.at(-1));
    if (['rm', 'tee', 'truncate'].includes(commandName)) targets.push(...operands);
  }
  return targets.filter((target) => !['/dev/null', 'NUL', 'nul'].includes(target));
}

function risk(level, reasonCode, reason) {
  return { level, reason, reasonCode };
}

function commandReads(segment) {
  return /^\s*(?:Get-Content|Test-Path|Get-Item|Resolve-Path|cat|type)\b/iu.test(segment);
}

function egressUploadPaths(command) {
  const paths = [];
  for (const segment of shellSegments(command)) {
    const tokens = commandTokens(segment);
    const executable = tokens.findIndex((token) => /(?:^|[\\/])(?:curl|wget)(?:\.exe)?$/iu.test(token));
    if (executable < 0) continue;
    const extract = (operand) => {
      if (!operand) return null;
      const direct = operand.match(/^@(.+)$/u);
      if (direct) return direct[1];
      const named = operand.match(/^[^=@]*=@(.+)$/u);
      if (named) return named[1];
      return null;
    };
    let expectOperand = false;
    for (let index = executable + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (expectOperand) {
        const found = extract(token);
        if (found) paths.push(found);
        expectOperand = false;
        continue;
      }
      if (egressUploadFlags.has(token)) {
        expectOperand = true;
        continue;
      }
      const assignment = token.match(/^(?:-F|--form|-d|--data(?:-binary|-raw)?|-T|--upload-file)=(.*)$/u);
      if (assignment) {
        const found = extract(assignment[1]);
        if (found) paths.push(found);
      }
    }
  }
  return paths;
}

function extractEgressHost(command) {
  const match = command.match(urlHostPattern);
  return match ? match[1].toLowerCase() : null;
}

function hostMatches(host, pattern) {
  const normalized = pattern.toLowerCase();
  if (!normalized.includes('*')) return host === normalized;
  const regex = new RegExp(`^${normalized.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll(/\*/g, '.*')}$`, 'u');
  return regex.test(host);
}

function hostAllowed(host, allowedEgressHosts) {
  if (!host) return true;
  return allowedEgressHosts.some((pattern) => hostMatches(host, pattern));
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

function isInsideAny(baseDirs, candidate) {
  return baseDirs.some((baseDir) => isInside(baseDir, candidate));
}

function classifyRisk(input, projectRoot, allowedWriteRoots, allowedEgressHosts = [], redZonePaths = []) {
  const redZonePattern = redZoneMatcher(redZonePaths);
  const command = commandFrom(input);
  const segments = shellSegments(command);
  if (segments.some((segment) => gitCommandRisk(segment))) {
    return risk('deny', 'DESTRUCTIVE_GIT', 'Destructive Git operation or hook bypass is blocked by repository policy.');
  }
  for (const segment of segments) {
    if (!referencesGlobalAgentConfig(segment)) continue;
    if (commandReads(segment) && !commandWrites(segment)) continue;
    return risk('deny', 'GLOBAL_AGENT_CONFIG', 'Writes to global Agent configuration are blocked by repository policy.');
  }
  if (networkCommandPattern.test(command) && secretReferencePattern.test(command)) {
    return risk('deny', 'CREDENTIAL_EXFILTRATION', 'Possible credential exfiltration is blocked by repository policy.');
  }
  if (privateEgressPattern.test(command) && redZonePattern) {
    const uploadPaths = egressUploadPaths(command);
    const touchesRedZoneFile = uploadPaths.some((candidate) => {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
      return redZonePattern.test(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
    });
    if (touchesRedZoneFile) {
      return risk('deny', 'CREDENTIAL_EXFILTRATION', 'Possible credential exfiltration is blocked by repository policy.');
    }
  }
  if (allowedEgressHosts.length > 0 && networkCommandPattern.test(command)) {
    const host = extractEgressHost(command);
    if (host && !hostAllowed(host, allowedEgressHosts)) {
      return risk('deny', 'EGRESS_VIOLATION', 'Network egress to a host outside the configured allowlist is blocked by repository policy.');
    }
  }

  const shellTargets = shellWritePaths(command);
  if (!writeToolPattern.test(input.toolName ?? '') && shellTargets.length === 0) return null;
  const candidates = [
    ...collectStructuredPaths(input.toolInput),
    ...(input.toolName === 'apply_patch' ? patchPaths(command) : []),
    ...shellTargets,
  ];
  for (const candidate of candidates) {
    if (referencesGlobalAgentConfig(candidate)) {
      return risk('deny', 'GLOBAL_AGENT_CONFIG', 'Writes to global Agent configuration are blocked by repository policy.');
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    const canonicalCandidate = canonicalPath(absolute);
    const canonicalRoots = [projectRoot, ...allowedWriteRoots].map(canonicalPath);
    if (
      !canonicalCandidate
      || canonicalRoots.some((root) => root === null)
      || referencesGlobalAgentConfig(canonicalCandidate)
      || !isInsideAny(canonicalRoots, canonicalCandidate)
    ) {
      return risk('deny', 'PROJECT_BOUNDARY', 'Write target escapes the project boundary.');
    }
  }
  const touchesRedZone = redZonePattern
    ? candidates.some((candidate) => {
        const absolute = path.isAbsolute(candidate)
          ? candidate
          : path.resolve(projectRoot, candidate);
        return redZonePattern.test(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
      })
    : false;
  if (touchesRedZone) {
    return risk('warn', 'RED_ZONE', 'The pending write touches a project red-zone; keep explicit approval and verification evidence.');
  }
  return null;
}

export function analyzeToolRequest(input, {
  allowedWriteRoots = [],
  allowedEgressHosts = [],
  mode = 'guarded',
  projectRoot = input.cwd,
  redZonePaths = [],
} = {}) {
  if (mode === 'off') return { action: 'allow' };
  const risk = classifyRisk(input, projectRoot, allowedWriteRoots, allowedEgressHosts, redZonePaths);
  if (!risk) return { action: 'allow' };
  if (risk.level === 'warn' || mode === 'observe') {
    return { action: 'warn', reason: risk.reason, reasonCode: risk.reasonCode };
  }
  return { action: 'deny', reason: risk.reason, reasonCode: risk.reasonCode };
}

export function createCodexHookResult(event, decision) {
  if (!decision || decision.action === 'allow') return {};
  const reason = decision.reasonCode
    ? `[COGNIS_POLICY:${decision.reasonCode}] ${decision.reason}`
    : decision.reason;
  if (event === 'PermissionRequest' && decision.action !== 'deny') return {};
  if (decision.action === 'warn') {
    return {
      hookSpecificOutput: {
        additionalContext: reason,
        hookEventName: event,
      },
    };
  }
  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        decision: { behavior: 'deny', message: reason },
        hookEventName: event,
      },
    };
  }
  if (event === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return { decision: 'block', reason };
}
