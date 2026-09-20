import path from 'node:path';
import { realpathSync } from 'node:fs';
import { CONTROL_PLANE_PATHS } from './context.mjs';
import {
  commandTokens,
  commandWrites,
  hasUnsafeShellConstruct,
  isReadOnlyShellSegment,
  shellSegments,
} from './read-only-commands.mjs';
import { rolePresetTier } from './role-permissions.mjs';

export const supportedCodexHookEvents = new Set([
  'PreToolUse',
  'PermissionRequest',
]);

const writeToolPattern = /(?:apply_patch|write|edit|delete|remove|move|rename|create)/iu;
const pathKeyPattern = /^(?:file_?path|path|target|destination|directory(?:_?path)?|dir)$/iu;
// Only the Agent configuration directories that sit directly under a home
// directory are global: `%USERPROFILE%\.codex`, `~/.claude` and friends. A
// project that merely lives under the user profile (for example a temporary
// project) keeps its own `.codex` and must not be treated as global config.
const globalAgentConfigPattern = /(?:~|\$(?:\{)?HOME(?:\})?|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|[\\/](?:home|Users)[\\/][^\\/]+)[\\/'"]\.(?:codex|claude|cursor|gemini)(?:[\\/'"]|$)/iu;
const networkCommandPattern = /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/iu;
const secretReferencePattern = /(?:\$\{?[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PAT|CRED)[A-Z0-9_]*\}?|\$env:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PAT|CRED)[A-Z0-9_]*|%[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*%|Authorization\s*:[^\r\n]*(?:KEY|TOKEN|SECRET|Bearer)|-[HUu]\s+["']?[^"'\s]*(?:KEY|TOKEN|SECRET|PASSWORD|PAT|CRED))/iu;
const egressUploadFlags = new Set(['-F', '--form', '-d', '--data', '--data-binary', '--data-raw', '-T', '--upload-file', '-K', '--config']);
const urlHostPattern = /https?:\/\/\[?(?:[^\s:@/]+@)?([^\]/:@\s]+)/igu;
const privateEgressPattern = /(?:curl|wget)[^\n]*(?:-F|--form|-d|--data(?:-binary|-raw)?|-T|--upload-file|-K|--config)/iu;
const patchToolPattern = /(?:^|__|\.)apply_?patch(?:$|__|\.)/iu;

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
  if (Object.hasOwn(value, 'execution_envelope')) normalized.executionEnvelope = value.execution_envelope;
  else if (Object.hasOwn(value, 'executionEnvelope')) normalized.executionEnvelope = value.executionEnvelope;
  return normalized;
}

const supportedHostHookEvents = new Set(['PreToolUse', 'PermissionRequest']);
const hostEventAliases = new Map([
  ['pretooluse', 'PreToolUse'],
  ['permissionrequest', 'PermissionRequest'],
]);

function hostEvent(value) {
  if (typeof value !== 'string') return null;
  return hostEventAliases.get(value.replaceAll(/[_-]/gu, '').toLowerCase()) ?? null;
}

/**
 * Normalizes the project-level hook payloads used by Cursor, Qoder, and ZCode
 * into the policy's host-neutral request shape. These hosts use different key
 * casing, so validation happens before a request reaches the shared policy.
 */
/** @param {Record<string, any>} value @param {{expectedEvent?: string | null, fallbackCwd?: string, host?: string}} options */
export function normalizeHostHookInput(value, { expectedEvent, fallbackCwd, host } = {}) {
  if (host === 'codex') return normalizeCodexHookInput(value);
  if (host === 'antigravity') {
    assertObject(value, 'antigravity hook input');
    const event = hostEvent(value.event ?? expectedEvent);
    if (!event) throw new Error('Unsupported antigravity hook event.');
    const cwd = value.toolCall?.args?.Cwd ?? value.toolCall?.args?.cwd ?? value.workspacePaths?.[0] ?? fallbackCwd;
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('antigravity hook input workspace path is required.');
    const normalized = {
      cwd,
      event,
      permissionMode: value.permissionMode,
      sessionId: value.conversationId ?? 'antigravity-hook',
      toolInput: value.toolCall?.args ?? {},
      toolName: value.toolCall?.name ?? '',
    };
    if (Object.hasOwn(value, 'execution_envelope')) normalized.executionEnvelope = value.execution_envelope;
    else if (Object.hasOwn(value, 'executionEnvelope')) normalized.executionEnvelope = value.executionEnvelope;
    return normalized;
  }
  if (!['cursor', 'qoder', 'zcode', 'claude'].includes(host)) throw new Error(`Unsupported hook host: ${String(host)}`);
  assertObject(value, `${host} hook input`);
  const event = hostEvent(value.hook_event_name ?? value.hookEventName ?? value.event ?? value.event_name);
  if (!event || !supportedHostHookEvents.has(event)) {
    throw new Error(`Unsupported ${host} hook event.`);
  }
  const cwd = value.cwd ?? value.workspaceRoot ?? value.workspace_root ?? value.projectRoot ?? value.project_root ?? fallbackCwd;
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error(`${host} hook input.cwd is required.`);
  const toolInput = value.tool_input ?? value.toolInput ?? value.tool?.input ?? value.tool?.arguments ?? value.arguments ?? value.input ?? {};
  const normalized = {
    cwd,
    event,
    permissionMode: value.permission_mode ?? value.permissionMode,
    sessionId: value.session_id ?? value.sessionId ?? value.conversationId ?? value.requestId ?? 'host-hook',
    toolInput: typeof toolInput === 'string' ? { command: toolInput } : toolInput,
    toolName: value.tool_name ?? value.toolName ?? value.tool?.name ?? value.name ?? '',
  };
  if (Object.hasOwn(value, 'execution_envelope')) normalized.executionEnvelope = value.execution_envelope;
  else if (Object.hasOwn(value, 'executionEnvelope')) normalized.executionEnvelope = value.executionEnvelope;
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

export function commandFrom(input) {
  for (const key of ['command', 'cmd', 'input']) {
    if (typeof input.toolInput?.[key] === 'string') return input.toolInput[key];
  }
  return '';
}

function gitCommandRisk(segment) {
  const tokens = commandTokens(segment);
  const executableIndex = tokens.findIndex((token) => /(?:^|[\\/])git(?:\.exe)?$/iu.test(token));
  if (executableIndex < 0) return null;
  const args = tokens.slice(executableIndex + 1);
  let index = 0;
  while (index < args.length) {
    const value = args[index].toLowerCase();
    if (value === '-c' && index + 1 < args.length) {
      if (/core\.hookspath\s*=/u.test(args[index + 1].toLowerCase())) return 'hook bypass';
      index += 2;
      continue;
    }
    if (['--git-dir', '--work-tree', '--namespace', '--config-env'].includes(value)) {
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
    if (/^--config-env=/u.test(value) && /core\.hookspath/u.test(value)) return 'hook bypass';
    if (/^-c.*core\.hookspath\s*=/u.test(value)) return 'hook bypass';
    break;
  }
  const command = args[index]?.toLowerCase();
  const rest = args.slice(index + 1).map((item) => item.toLowerCase());
  if (!command) return null;
  if (args.some((item) => item.toLowerCase() === '--no-verify')) return 'hook bypass';
  // For `git commit`, the short flag `-n` is `--no-verify` (hook bypass).
  if (command === 'commit' && rest.some((item) => /^-[a-z]*n[a-z]*$/u.test(item))) return 'hook bypass';
  if (command === 'reset' && rest.some((item) => ['--hard', '--merge', '--keep'].includes(item))) return 'destructive reset';
  if (command === 'clean' && !rest.some((item) => item === '-n' || item === '--dry-run' || /^-[a-z]*n[a-z]*$/u.test(item))) return 'destructive clean';
  if (command === 'restore') return 'destructive restore';
  if (command === 'checkout' && (rest.includes('--') || rest.some((item) => ['-f', '--force'].includes(item)))) return 'destructive checkout';
  if (command === 'switch' && rest.some((item) => ['-f', '--force', '--discard-changes'].includes(item))) return 'destructive switch';
  if (command === 'stash' && rest.some((item) => ['clear', 'drop'].includes(item))) return 'destructive stash';
  if (['merge', 'rebase', 'cherry-pick'].includes(command) && rest.includes('--abort')) return 'destructive abort';
  if (command === 'branch' && rest.some((item) => item === '-D' || item === '-d')) return 'destructive branch deletion';
  if (command === 'tag' && rest.includes('-d')) return 'destructive tag deletion';
  if (command === 'push' && rest.some((item) => ['-f', '--force', '--force-with-lease', '--delete', '-d'].includes(item))) return 'destructive push';
  if (command === 'update-ref' && rest.includes('-d')) return 'destructive ref deletion';
  if (command === 'filter-branch') return 'destructive history rewrite';
  if (command === 'reflog' && rest.includes('expire') && rest.some((item) => item.startsWith('--expire'))) return 'destructive reflog expiry';
  if (command === 'gc' && rest.some((item) => /^--prune(=|$)/u.test(item))) return 'destructive gc prune';
  if (command === 'config' && rest.includes('--global')) {
    const readOnly = rest.some((item) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(item));
    if (!readOnly) return 'global Git configuration write';
  }
  return null;
}

function referencesGlobalAgentConfig(value) {
  return globalAgentConfigPattern.test(value);
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

function extractEgressHosts(command) {
  const hosts = [];
  for (const match of command.matchAll(urlHostPattern)) hosts.push(match[1].toLowerCase());
  return hosts;
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

function classifyRisk(input, projectRoot, allowedWriteRoots, allowedEgressHosts = [], redZonePaths = [], permissionPreset = null) {
  const redZonePattern = redZoneMatcher(redZonePaths);
  const controlPlanePattern = redZoneMatcher(CONTROL_PLANE_PATHS);
  const command = commandFrom(input);
  // apply_patch carries file content rather than a shell command, so payload
  // text such as inline code spans or command substitution is never executed
  // (AC-04a). Shell-only rules are skipped for patch tools and the patch
  // targets alone decide the write-path verdicts below.
  const isPatchTool = patchToolPattern.test(input.toolName ?? '');
  if (!isPatchTool && hasUnsafeShellConstruct(command)) {
    return risk('deny', 'UNSAFE_SHELL_CONSTRUCT', '命令包含命令替换或续行符，无法安全判定，已拒绝。请改写为不含美元符号加圆括号、反引号或不换行的等价写法；确需执行时请由宿主注入 Execution Envelope。');
  }
  const segments = isPatchTool ? [] : shellSegments(command);
  if (segments.some((segment) => gitCommandRisk(segment))) {
    return risk('deny', 'DESTRUCTIVE_GIT', '检测到破坏性 Git 操作或 hook 绕过，已拒绝。请改用非破坏性等价命令（例如用 git stash 代替强制检出）；确需执行时请人工手动执行。');
  }
  for (const segment of segments) {
    if (!referencesGlobalAgentConfig(segment)) continue;
    // Reading or enumerating an Agent configuration directory is not a write,
    // so only effectful segments fall through to the write rule (AC-02).
    if (isReadOnlyShellSegment(segment) && !commandWrites(segment)) continue;
    return risk('deny', 'GLOBAL_AGENT_CONFIG', '检测到对全局 Agent 配置的写入，已拒绝。请改为修改目标项目内的配置；调整全局配置请人工手动执行。');
  }
  if (!isPatchTool && networkCommandPattern.test(command) && secretReferencePattern.test(command)) {
    return risk('deny', 'CREDENTIAL_EXFILTRATION', '检测到可能把凭据发往外部网络，已拒绝。请改用不含凭据的请求，或先通过凭据代理取得授权。');
  }
  if (!isPatchTool && privateEgressPattern.test(command) && redZonePattern) {
    const uploadPaths = egressUploadPaths(command);
    const touchesRedZoneFile = uploadPaths.some((candidate) => {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
      return redZonePattern.test(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
    });
    if (touchesRedZoneFile) {
      return risk('deny', 'CREDENTIAL_EXFILTRATION', '检测到上传红区文件，可能造成凭据外传，已拒绝。请改用非红区文件，或先按流程取得显式授权。');
    }
  }
  if (!isPatchTool && allowedEgressHosts.length > 0 && networkCommandPattern.test(command)) {
    const hosts = extractEgressHosts(command);
    if (hosts.length === 0) {
      return risk('deny', 'EGRESS_VIOLATION', '已配置网络允许列表，但该命令没有可解析的目标地址，已拒绝。请在命令中写明完整的 http 或 https 地址。');
    }
    const violating = hosts.find((host) => !hostAllowed(host, allowedEgressHosts));
    if (violating) {
      return risk('deny', 'EGRESS_VIOLATION', '目标主机不在网络允许列表内，已拒绝。请改用允许列表中的主机，或在项目配置中登记该主机。');
    }
  }

  const shellTargets = isPatchTool ? [] : shellWritePaths(command);
  if (!writeToolPattern.test(input.toolName ?? '') && shellTargets.length === 0) return null;
  const candidates = [
    ...collectStructuredPaths(input.toolInput),
    ...(isPatchTool ? patchPaths(command) : []),
    ...shellTargets,
  ];
  const touchesControlPlane = candidates.some((candidate) => {
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    return controlPlanePattern.test(path.relative(projectRoot, absolute).replaceAll('\\', '/'));
  });
  if (touchesControlPlane) {
    return risk('deny', 'CONTROL_PLANE_WRITE', '检测到直接写入 Vibe-Harness 控制面文件，已拒绝。请改用带 --write 的事务式安装器并显式确认。');
  }
  for (const candidate of candidates) {
    if (referencesGlobalAgentConfig(candidate)) {
      return risk('deny', 'GLOBAL_AGENT_CONFIG', '检测到对全局 Agent 配置的写入，已拒绝。请改为修改目标项目内的配置；调整全局配置请人工手动执行。');
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
      return risk('deny', 'PROJECT_BOUNDARY', '写入目标超出项目边界，已拒绝。请把写入限制在项目目录或已授权的附加目录内。');
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
    return risk('deny', 'RED_ZONE', '写入命中项目红区路径，已拒绝。请改用非红区路径，或按流程显式确认后重试。');
  }
  // At this point the request is a write attempt (write tool or shell write
  // target), so the role permission ceiling applies. Read-only presets deny
  // every write attempt; executable presets deny direct file-write tools but
  // keep shell writes on the Execution Envelope path so validation commands
  // still work (mirrors role-projection sandbox/permission semantics).
  const presetTier = rolePresetTier(permissionPreset);
  if (presetTier === 'read-only') {
    return risk('deny', 'ROLE_PERMISSION_PRESET', '当前角色权限预设为只读（' + permissionPreset + '），不允许任何写入，已拒绝。请在允许写入的角色或主会话中执行该操作。');
  }
  if (presetTier === 'executable' && writeToolPattern.test(input.toolName ?? '')) {
    return risk('deny', 'ROLE_PERMISSION_PRESET', '当前角色权限预设（' + permissionPreset + '）可执行验证命令但不允许直接写入文件，已拒绝。请把文件修改交由具备 workspace-write 能力的角色或主会话执行。');
  }
  return null;
}

export function analyzeToolRequest(input, {
  allowedWriteRoots = [],
  allowedEgressHosts = [],
  mode = 'guarded',
  permissionPreset = null,
  projectRoot = input.cwd,
  redZonePaths = [],
} = {}) {
  if (mode === 'off') return { action: 'allow' };
  const risk = classifyRisk(input, projectRoot, allowedWriteRoots, allowedEgressHosts, redZonePaths, permissionPreset);
  if (!risk) return { action: 'allow' };
  if (risk.level === 'warn' || mode === 'observe') {
    return { action: 'warn', reason: risk.reason, reasonCode: risk.reasonCode };
  }
  return { action: 'deny', reason: risk.reason, reasonCode: risk.reasonCode };
}

/** @param {string} event @param {Record<string, any>} decision @param {{durationMs?: number}} options */
export function createCodexHookResult(event, decision, { durationMs } = {}) {
  if (!decision || decision.action === 'allow') return {};
  const durationSuffix = Number.isFinite(durationMs) && durationMs >= 0 ? `:${Math.round(durationMs)}` : '';
  const reason = decision.reasonCode
    ? `[VIBE_HARNESS_POLICY:${decision.reasonCode}${durationSuffix}] ${decision.reason}`
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

function policyReason(decision, durationMs) {
  const durationSuffix = Number.isFinite(durationMs) && durationMs >= 0 ? `:${Math.round(durationMs)}` : '';
  return decision.reasonCode
    ? `[VIBE_HARNESS_POLICY:${decision.reasonCode}${durationSuffix}] ${decision.reason}`
    : decision.reason;
}

/** Serialize a host-neutral policy decision using the host's hook contract. */
/** @param {string} host @param {string} event @param {Record<string, any>} decision @param {{durationMs?: number}} options */
export function createHostHookResult(host, event, decision, { durationMs } = {}) {
  if (host === 'codex') return createCodexHookResult(event, decision, { durationMs });
  if (host === 'antigravity') {
    const action = decision?.action ?? 'allow';
    const mapped = action === 'deny' ? 'deny' : action === 'force_ask' ? 'force_ask' : action === 'warn' ? 'ask' : 'allow';
    return mapped === 'allow' ? { decision: 'allow' } : { decision: mapped, reason: policyReason(decision, durationMs) };
  }
  if (!decision || decision.action === 'allow') return {};
  const reason = policyReason(decision, durationMs);
  if (host === 'cursor') {
    return decision.action === 'warn'
      ? { additionalContext: reason, continue: true }
      : { continue: false, stopReason: reason };
  }
  if (host === 'qoder' || host === 'zcode' || host === 'claude') {
    if (decision.action === 'warn') return { hookSpecificOutput: { additionalContext: reason, hookEventName: event } };
    if (event === 'PermissionRequest') {
      return { hookSpecificOutput: { decision: { behavior: 'deny', message: reason }, hookEventName: event } };
    }
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  throw new Error(`Unsupported hook host: ${String(host)}`);
}
