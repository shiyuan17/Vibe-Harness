import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_TOOLCHAIN_PATTERN,
  classifyMcpToolName,
  commandTokens,
  commandWrites,
  isReadOnlyShellSegment,
  isReadOnlyToolName,
  isWorkspaceToolName,
  mcpToolPolicy,
  shellInvocation,
  shellSegments,
} from './read-only-commands.mjs';

export const EXECUTION_ENVELOPE_SCHEMA = 'vibe-harness.execution-envelope/v1';
export const EXECUTION_ENVELOPE_SCHEMA_V1 = EXECUTION_ENVELOPE_SCHEMA;
export const EXECUTION_ENVELOPE_SCHEMA_V2 = 'vibe-harness.execution-envelope/v2';

export const EXECUTION_ENVELOPE_MODES = Object.freeze([
  'inspect', 'plan', 'linear-sync', 'execute', 'monitor',
]);
export const EXECUTION_EFFECTS = Object.freeze([
  'linearWrite', 'workspaceWrite', 'gitBranch', 'gitCommit', 'gitPush',
  'mergeRequestWrite', 'credentialUse',
]);
export const EXECUTION_EFFECTS_V2 = Object.freeze([
  'linearWrite', 'workspaceWrite', 'hostWrite', 'externalWrite', 'gitBranch',
  'gitCommit', 'gitPush', 'mergeRequestWrite', 'credentialUse',
]);

const modeSet = new Set(EXECUTION_ENVELOPE_MODES);
const effectSet = new Set(EXECUTION_EFFECTS);
const effectSetV2 = new Set(EXECUTION_EFFECTS_V2);
const modeCeilingsV1 = new Map([
  ['inspect', new Set()],
  ['plan', new Set()],
  ['linear-sync', new Set(['linearWrite'])],
  ['execute', new Set(EXECUTION_EFFECTS)],
  ['monitor', new Set()],
]);
const modeCeilingsV2 = new Map([
  ['inspect', new Set()],
  ['plan', new Set()],
  ['linear-sync', new Set(['linearWrite'])],
  ['execute', new Set(EXECUTION_EFFECTS_V2)],
  ['monitor', new Set()],
]);
const rootKeysV1 = new Set([
  'schema', 'requestId', 'sessionId', 'mode', 'targetIssueIds',
  'allowedEffects', 'forbiddenEffects', 'terminalCondition', 'activeObjective',
  'expiresAt', 'checkpoint',
]);
const requiredRootKeysV1 = [
  'schema', 'requestId', 'sessionId', 'mode', 'targetIssueIds',
  'allowedEffects', 'forbiddenEffects', 'terminalCondition', 'activeObjective',
];
const rootKeysV2 = new Set([
  ...rootKeysV1, 'riskClass', 'scope', 'hostContext',
]);
const requiredRootKeysV2 = [
  ...requiredRootKeysV1, 'riskClass', 'scope', 'hostContext',
];
const checkpointKeysV1 = new Set([
  'activeObjective', 'targetIssueId', 'completedFacts', 'noRepeatSet',
  'nextAction', 'liveStates', 'blockerFingerprint', 'dagStructureHash',
  'dagChangeCursor', 'observedAt',
]);
const requiredCheckpointKeysV1 = [
  'activeObjective', 'targetIssueId', 'completedFacts', 'noRepeatSet',
  'nextAction', 'liveStates', 'blockerFingerprint', 'dagStructureHash',
];
const checkpointKeysV2 = new Set([
  ...checkpointKeysV1, 'headSha', 'continuationCount', 'blockerCount',
]);
const requiredCheckpointKeysV2 = [
  ...requiredCheckpointKeysV1, 'headSha', 'continuationCount', 'blockerCount',
];
const workspaceScopeKeys = new Set([
  'canonicalCwd', 'worktreeRoot', 'gitCommonDir', 'gitDir', 'branch', 'baseRef',
  'baseSha', 'initialHeadSha', 'allowedWriteRoots',
]);
const hostContextKeys = new Set(['source', 'filesystem', 'approval', 'process', 'network', 'observedAt']);
const externalTargetKeys = new Set(['kind', 'id', 'environment']);
const shaPattern = /^[0-9a-fA-F]{40,64}$/u;
const utcTimestampPattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

const linearToolPattern = /(?:^|__)linear(?:__|$)/iu;
const githubToolPattern = /(?:^|__)github(?:__|$)/iu;
const gitlabToolPattern = /(?:^|__)gitlab(?:__|$)/iu;
const linearReadPattern = /(?:^|__)(?:get|list|search|read|find|view|fetch|query)(?:_|__|$)/iu;
const linearWritePattern = /(?:^|__)(?:save|create|update|delete|archive|restore|merge|submit|resolve|cancel|add|remove|set|assign|unassign)(?:_|__|$)/iu;
const mergeRequestObjectPattern = /(?:pull_?request|merge_?request|\bpr\b|\bmr\b)/iu;
const mergeRequestReadPattern = /(?:^|__)(?:get|list|search|read|find|view|fetch|query|diff|checks?|status)(?:_|__|$)/iu;
const mergeRequestWritePattern = /(?:^|__)(?:create|update|edit|merge|close|reopen|ready|comment|note|review|approve|unapprove|revoke|delete|lock|unlock|rebase|revert|subscribe|unsubscribe|todo)(?:_|__|$)/iu;
const credentialToolPattern = /(?:credential|auth|keychain|secret.?service)/iu;
const credentialUsePattern = /(?:^|__)(?:get|read|find|fill|login|authorize|store|save|update|delete|remove)(?:_|__|$)/iu;
const credentialCommandPattern = /(?:\bgit(?:\.exe)?\s+credential(?:\s+(?:fill|approve|reject))?\b|\bgit-credential-[^\s]+|\bcredential-manager(?:-core)?\b|\bgit(?:\.exe)?\s+config\b[^\r\n]*\bcredential\.helper\b|\b(?:gh|glab)(?:\.exe)?\s+auth\b|\bcmdkey(?:\.exe)?\b|\bGet-StoredCredential\b|\bsecurity\s+find-(?:generic|internet)-password\b)/iu;
const webApiCommandPattern = /(?:\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\b(?:gh|glab)(?:\.exe)?\s+api\b)/iu;
const issueIdentifierPattern = /\b[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}\b/giu;
const indirectWritePattern = /(?:WriteAllBytes|WriteAllText|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|--codex-run-as-apply-patch)/iu;

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

/** @param {unknown} value @param {{maxLength?: number, minLength?: number}} options */
function isString(value, { maxLength, minLength = 0 } = {}) {
  if (typeof value !== 'string' || value.length < minLength) return false;
  return maxLength === undefined || value.length <= maxLength;
}

/** @param {unknown} value @param {{allowedValues?: Set<string>, maxLength?: number, minLength?: number}} options */
function isUniqueStringArray(value, { allowedValues, maxLength, minLength = 0 } = {}) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const item of value) {
    if (!isString(item, { maxLength, minLength })) return false;
    if (allowedValues && !allowedValues.has(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function isUtcTimestamp(value) {
  return typeof value === 'string' && utcTimestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function validCheckpointBase(value, keys, requiredKeys) {
  if (!isObject(value) || !hasOnlyKeys(value, keys)) return false;
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) return false;
  if (!isString(value.activeObjective, { minLength: 1 })) return false;
  if (!isString(value.targetIssueId, { minLength: 1 })) return false;
  if (!isUniqueStringArray(value.completedFacts, { minLength: 1 })) return false;
  if (!isUniqueStringArray(value.noRepeatSet, { minLength: 1 })) return false;
  if (!isString(value.nextAction, { minLength: 1 })) return false;
  if (!isObject(value.liveStates) || !Object.values(value.liveStates).every((state) => isString(state, { minLength: 1 }))) return false;
  if (typeof value.blockerFingerprint !== 'string') return false;
  if (typeof value.dagStructureHash !== 'string') return false;
  if (Object.hasOwn(value, 'dagChangeCursor') && typeof value.dagChangeCursor !== 'string') return false;
  return !Object.hasOwn(value, 'observedAt') || isUtcTimestamp(value.observedAt);
}

export function validateExecutionEnvelope(value) {
  if (!isObject(value) || !hasOnlyKeys(value, rootKeysV1)) return false;
  if (requiredRootKeysV1.some((key) => !Object.hasOwn(value, key))) return false;
  if (value.schema !== EXECUTION_ENVELOPE_SCHEMA) return false;
  if (!isString(value.requestId, { minLength: 1, maxLength: 128 })) return false;
  if (!isString(value.sessionId, { minLength: 1, maxLength: 256 })) return false;
  if (!modeSet.has(value.mode)) return false;
  if (!isUniqueStringArray(value.targetIssueIds, { minLength: 1, maxLength: 128 })) return false;
  if (!isUniqueStringArray(value.allowedEffects, { allowedValues: effectSet })) return false;
  if (!isUniqueStringArray(value.forbiddenEffects, { allowedValues: effectSet })) return false;
  if (!isString(value.terminalCondition, { minLength: 1, maxLength: 512 })) return false;
  if (!isString(value.activeObjective, { minLength: 1, maxLength: 1024 })) return false;
  if (Object.hasOwn(value, 'expiresAt') && !isUtcTimestamp(value.expiresAt)) return false;
  return !Object.hasOwn(value, 'checkpoint')
    || validCheckpointBase(value.checkpoint, checkpointKeysV1, requiredCheckpointKeysV1);
}

function validExternalTarget(value) {
  return isObject(value)
    && hasOnlyKeys(value, externalTargetKeys)
    && isString(value.kind, { minLength: 1, maxLength: 64 })
    && isString(value.id, { minLength: 1, maxLength: 256 })
    && ['local', 'test', 'staging', 'production', 'remote'].includes(value.environment);
}

function validWorkspaceScope(value) {
  if (!isObject(value) || !hasOnlyKeys(value, workspaceScopeKeys)) return false;
  if ([...workspaceScopeKeys].some((key) => !Object.hasOwn(value, key))) return false;
  for (const key of ['canonicalCwd', 'worktreeRoot', 'gitCommonDir', 'gitDir', 'branch', 'baseRef']) {
    if (!isString(value[key], { minLength: 1 })) return false;
  }
  if (!shaPattern.test(value.baseSha) || !shaPattern.test(value.initialHeadSha)) return false;
  return isUniqueStringArray(value.allowedWriteRoots, { minLength: 1 }) && value.allowedWriteRoots.length > 0;
}

function validScope(value) {
  const targetKeys = new Set();
  if (!isObject(value) || !hasOnlyKeys(value, new Set(['workspace', 'externalTargets']))) return false;
  if (!validWorkspaceScope(value.workspace) || !Array.isArray(value.externalTargets)) return false;
  for (const target of value.externalTargets) {
    if (!validExternalTarget(target)) return false;
    const key = target.kind + '\u0000' + target.id + '\u0000' + target.environment;
    if (targetKeys.has(key)) return false;
    targetKeys.add(key);
  }
  return true;
}

function validHostContext(value) {
  return isObject(value)
    && hasOnlyKeys(value, hostContextKeys)
    && [...hostContextKeys].every((key) => Object.hasOwn(value, key))
    && value.source === 'host'
    && ['read-only', 'workspace-write', 'unrestricted'].includes(value.filesystem)
    && ['interactive', 'unavailable'].includes(value.approval)
    && ['isolated', 'unrestricted'].includes(value.process)
    && ['offline', 'allowlisted', 'unrestricted'].includes(value.network)
    && isUtcTimestamp(value.observedAt);
}

function validCheckpointV2(value) {
  return validCheckpointBase(value, checkpointKeysV2, requiredCheckpointKeysV2)
    && shaPattern.test(value.headSha)
    && Number.isInteger(value.continuationCount)
    && value.continuationCount >= 0
    && Number.isInteger(value.blockerCount)
    && value.blockerCount >= 0;
}

export function validateExecutionEnvelopeV2(value) {
  if (!isObject(value) || !hasOnlyKeys(value, rootKeysV2)) return false;
  if (requiredRootKeysV2.some((key) => !Object.hasOwn(value, key))) return false;
  if (value.schema !== EXECUTION_ENVELOPE_SCHEMA_V2) return false;
  if (!isString(value.requestId, { minLength: 1, maxLength: 128 })) return false;
  if (!isString(value.sessionId, { minLength: 1, maxLength: 256 })) return false;
  if (!modeSet.has(value.mode)) return false;
  if (!isUniqueStringArray(value.targetIssueIds, { minLength: 1, maxLength: 128 })) return false;
  if (!isUniqueStringArray(value.allowedEffects, { allowedValues: effectSetV2 })) return false;
  if (!isUniqueStringArray(value.forbiddenEffects, { allowedValues: effectSetV2 })) return false;
  if (!isString(value.terminalCondition, { minLength: 1, maxLength: 512 })) return false;
  if (!isString(value.activeObjective, { minLength: 1, maxLength: 1024 })) return false;
  if (!['standard', 'high'].includes(value.riskClass)) return false;
  if (!validScope(value.scope) || !validHostContext(value.hostContext)) return false;
  if (Object.hasOwn(value, 'expiresAt') && !isUtcTimestamp(value.expiresAt)) return false;
  return !Object.hasOwn(value, 'checkpoint') || validCheckpointV2(value.checkpoint);
}

export function parseExecutionEnvelope(value) {
  if (validateExecutionEnvelope(value)) {
    return { enforcementGrade: 'contract-only/degraded', envelope: value, riskClass: 'standard', version: 1 };
  }
  if (validateExecutionEnvelopeV2(value)) {
    const enforced = value.riskClass === 'high'
      && value.hostContext.source === 'host'
      && value.hostContext.process === 'isolated';
    return {
      enforcementGrade: enforced ? 'host-verified/high-risk' : 'scoped/standard',
      envelope: value,
      riskClass: value.riskClass,
      version: 2,
    };
  }
  return null;
}

function commandFrom(input) {
  for (const key of ['command', 'cmd', 'input']) {
    if (typeof input.toolInput?.[key] === 'string') return input.toolInput[key];
  }
  return '';
}

function isInside(baseDir, candidate) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectStructuredPaths(value, paths = [], key = '') {
  if (typeof value === 'string') {
    if (/^(?:file_?path|path|target|destination|directory(?:_?path)?|dir)$/iu.test(key)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPaths(item, paths, key);
    return paths;
  }
  if (!isObject(value)) return paths;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    collectStructuredPaths(nestedValue, paths, nestedKey);
  }
  return paths;
}

function externalTarget(kind, id, environment = 'remote') {
  return { environment, id, kind };
}

function addUrlTargets(command, targets) {
  for (const match of command.matchAll(/https?:\/\/\[?(?:[^\s:@/]+@)?([^\]/:@\s]+)/giu)) {
    targets.push(externalTarget('url-host', match[1].toLowerCase()));
  }
}

function gitInvocation(segment) {
  const invocation = shellInvocation(segment);
  if (!invocation || invocation.name !== 'git') return null;
  const args = invocation.args;
  let index = 0;
  while (index < args.length) {
    const value = args[index].toLowerCase();
    if (value === '-c' || ['--git-dir', '--work-tree', '--namespace', '--config-env'].includes(value)) {
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|config-env)=/u.test(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  return { args: args.slice(index + 1), command: args[index]?.toLowerCase() ?? '' };
}

function classifyGit(segment, effects) {
  const invocation = gitInvocation(segment);
  if (!invocation) return null;
  const { args, command } = invocation;
  const lowerArgs = args.map((item) => item.toLowerCase());
  if (command === 'credential' || command.startsWith('credential-')) {
    effects.add('credentialUse');
    return true;
  }
  if (command === 'config' && lowerArgs.some((item) => item.includes('credential.helper'))) {
    effects.add('credentialUse');
    return true;
  }
  if (command === 'commit') {
    effects.add('gitCommit');
    return true;
  }
  if (command === 'push') {
    effects.add('gitPush');
    return true;
  }
  if (command === 'branch') {
    const readFlags = new Set(['-a', '--all', '-r', '--remotes', '-l', '--list', '--show-current', '-v', '-vv', '--verbose', '--contains', '--no-contains', '--merged', '--no-merged', '--format']);
    const modifies = lowerArgs.some((item) => ['-m', '-M', '-c', '-C', '-d', '-D', '-f', '--force', '--move', '--copy', '--delete', '--set-upstream-to', '--unset-upstream'].includes(item))
      || lowerArgs.some((item) => !item.startsWith('-') && !readFlags.has(item));
    if (modifies) effects.add('gitBranch');
    return true;
  }
  if (command === 'switch') {
    effects.add('gitBranch');
    return true;
  }
  if (command === 'checkout') {
    effects.add('gitBranch');
    return true;
  }
  if (['merge', 'rebase', 'cherry-pick'].includes(command)) {
    effects.add('workspaceWrite');
    return true;
  }
  if (command === 'worktree') {
    const operation = lowerArgs.find((item) => !item.startsWith('-')) ?? '';
    if (['add', 'remove', 'move', 'prune', 'repair', 'lock', 'unlock'].includes(operation)) effects.add('gitBranch');
    return ['add', 'remove', 'move', 'prune', 'repair', 'lock', 'unlock', 'list'].includes(operation);
  }
  if (['add', 'rm', 'mv'].includes(command)) {
    effects.add('workspaceWrite');
    return true;
  }
  if (command === 'config') {
    const readOnly = lowerArgs.some((item) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope'].includes(item));
    if (!readOnly) effects.add('workspaceWrite');
    return true;
  }
  if (command === 'remote') {
    const operation = lowerArgs.find((item) => !item.startsWith('-')) ?? '';
    if (['add', 'remove', 'rename', 'set-head', 'set-branches', 'set-url'].includes(operation)) effects.add('workspaceWrite');
    else if (operation === 'prune') effects.add('gitBranch');
    return operation === '' || ['add', 'remove', 'rename', 'set-head', 'set-branches', 'set-url', 'get-url', 'show', 'prune'].includes(operation);
  }
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'grep', 'blame', 'shortlog', 'describe', 'name-rev', 'for-each-ref'].includes(command)) return true;
  return false;
}

function classifyArbitraryRuntime(segment, effects) {
  const invocation = shellInvocation(segment);
  if (!invocation || !RUNTIME_TOOLCHAIN_PATTERN.test(invocation.name)) return false;
  const { args } = invocation;
  if (args.length === 1 && ['--version', '-v'].includes(args[0].toLowerCase())) return true;
  effects.add('workspaceWrite');
  return true;
}

function cliInvocation(segment, executable) {
  const invocation = shellInvocation(segment);
  if (!invocation || invocation.name !== executable) return null;
  const args = invocation.args.map((item) => item.toLowerCase());
  const optionsWithValues = new Set(['-r', '--repo', '--hostname', '--config-dir', '--config']);
  let argumentIndex = 0;
  while (argumentIndex < args.length && args[argumentIndex].startsWith('-')) {
    const option = args[argumentIndex];
    if (optionsWithValues.has(option) && argumentIndex + 1 < args.length) argumentIndex += 2;
    else argumentIndex += 1;
  }
  return args.slice(argumentIndex);
}

function classifyMergeRequestCli(segment, effects) {
  for (const [executable, object] of [['gh', 'pr'], ['glab', 'mr']]) {
    const args = cliInvocation(segment, executable);
    if (!args || args[0] !== object) continue;
    const operation = args[1] ?? '';
    if (['create', 'edit', 'update', 'merge', 'close', 'reopen', 'ready', 'comment', 'note', 'review', 'approve', 'unapprove', 'revoke', 'delete', 'lock', 'unlock', 'rebase', 'revert', 'subscribe', 'unsubscribe', 'todo', 'update-branch'].includes(operation)) {
      effects.add('mergeRequestWrite');
      return true;
    }
    return ['list', 'view', 'status', 'checks', 'diff'].includes(operation);
  }
  return null;
}

function classifyWebCommand(segment, effects) {
  if (/\bcurl(?:\.exe)?\b/iu.test(segment)) {
    if (/(?:\s|^)(?:-o|--output|-O|--remote-name)(?:\s|=)/u.test(segment)) effects.add('workspaceWrite');
    if (/(?:\s|^)(?:-d|--data(?:-ascii|-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)(?:\s|=)|(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/iu.test(segment)) effects.add('externalWrite');
    return true;
  }
  if (/\b(?:Invoke-WebRequest|Invoke-RestMethod)\b/iu.test(segment)) {
    if (/\s-OutFile\b/iu.test(segment)) effects.add('workspaceWrite');
    if (/\s-Method\s+(?:POST|PUT|PATCH|DELETE)\b/iu.test(segment)) effects.add('externalWrite');
    return true;
  }
  if (/\bwget(?:\.exe)?\b/iu.test(segment)) {
    if (!/(?:\s-qO-\b|\s--output-document=-\b)/u.test(segment)) effects.add('workspaceWrite');
    return true;
  }
  return null;
}

function classifySupabase(segment, effects, targets) {
  const invocation = shellInvocation(segment);
  if (!invocation || invocation.name !== 'supabase') return null;
  const { args } = invocation;
  const lowerArgs = args.map((item) => item.toLowerCase());
  const projectRefIndex = lowerArgs.findIndex((item) => item === '--project-ref' || item === '--project-id');
  const inlineProjectRef = args.find((item) => /^--project-(?:ref|id)=/iu.test(item));
  const projectRef = projectRefIndex >= 0 ? args[projectRefIndex + 1] : inlineProjectRef?.split('=', 2)[1];
  if (projectRef) targets.push(externalTarget('supabase-project', projectRef));
  if (lowerArgs[0] === 'projects' && lowerArgs[1] === 'list') {
    effects.add('credentialUse');
    return true;
  }
  if (lowerArgs[0] === 'link') {
    effects.add('credentialUse');
    effects.add('workspaceWrite');
    return true;
  }
  if (lowerArgs[0] === 'db' && lowerArgs[1] === 'push') {
    effects.add('credentialUse');
    effects.add('externalWrite');
    return true;
  }
  return false;
}

function classifyMcpTool(toolName, effects) {
  if (!/^mcp__/iu.test(toolName)) return null;
  // A server whose tool surface this repository pins is answered from its own
  // contract instead of a verb guess: `trace_path` and `index_repository` pass,
  // `manage_adr` writes project files, and `delete_project` stays high-risk.
  const policy = mcpToolPolicy(toolName);
  if (policy === 'read-only') return true;
  if (policy === 'workspace-write') {
    effects.add('workspaceWrite');
    return true;
  }
  if (policy === 'high-risk') return false;
  if (linearToolPattern.test(toolName)) {
    if (linearWritePattern.test(toolName)) {
      effects.add('linearWrite');
      return true;
    }
    return linearReadPattern.test(toolName);
  }
  if ((githubToolPattern.test(toolName) || gitlabToolPattern.test(toolName)) && mergeRequestObjectPattern.test(toolName)) {
    if (mergeRequestWritePattern.test(toolName)) {
      effects.add('mergeRequestWrite');
      return true;
    }
    return mergeRequestReadPattern.test(toolName);
  }
  if (credentialToolPattern.test(toolName) && credentialUsePattern.test(toolName)) {
    effects.add('credentialUse');
    return true;
  }
  if (isWorkspaceToolName(toolName) && /(?:filesystem|file|workspace)/iu.test(toolName)) {
    effects.add('workspaceWrite');
    return true;
  }
  // Everything else is decided by the shared server+verb table (AC-11): read
  // and UI verbs pass, write and execute verbs keep the Envelope path, and an
  // unclassified tool is no longer denied outright.
  return classifyMcpToolName(toolName) === true;
}

export function classifyExecutionEffects(input) {
  const effects = new Set();
  const externalTargets = [];
  const highRiskReasons = new Set();
  const toolName = String(input.toolName ?? '');
  const command = commandFrom(input);
  const structuredPaths = collectStructuredPaths(input.toolInput);
  const workspaceTargets = structuredPaths.map((candidate) => path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(input.cwd, candidate));
  const hostTargets = workspaceTargets.filter((candidate) => !isInside(input.cwd, candidate));
  let unknown = false;
  const mcpClassification = classifyMcpTool(toolName, effects);
  if (mcpClassification !== null) unknown = !mcpClassification;
  else if (isWorkspaceToolName(toolName)) effects.add('workspaceWrite');
  else if (isReadOnlyToolName(toolName)) unknown = false;
  else if (command.length === 0) unknown = toolName.length > 0;

  if (command.length > 0 && !isWorkspaceToolName(toolName)) {
    if (commandWrites(command)) effects.add('workspaceWrite');
    if (credentialCommandPattern.test(command)) effects.add('credentialUse');
    if (indirectWritePattern.test(command)) {
      effects.add('workspaceWrite');
      highRiskReasons.add('indirect-runtime-write');
    }
    addUrlTargets(command, externalTargets);
    for (const segment of shellSegments(command)) {
      if (classifyGit(segment, effects) === true) continue;
      const supabase = classifySupabase(segment, effects, externalTargets);
      if (supabase !== null) {
        highRiskReasons.add('credentialed-external-cli');
        if (!supabase) unknown = true;
        continue;
      }
      const mergeRequest = classifyMergeRequestCli(segment, effects);
      if (mergeRequest !== null) {
        if (!mergeRequest) unknown = true;
        continue;
      }
      const webCommand = classifyWebCommand(segment, effects);
      if (webCommand !== null) {
        if (!webCommand) unknown = true;
        continue;
      }
      if (classifyArbitraryRuntime(segment, effects)) continue;
      if (commandWrites(segment)) continue;
      if (credentialCommandPattern.test(segment)) continue;
      if (!isReadOnlyShellSegment(segment)) unknown = true;
    }
    // Direct credential-helper output cannot be repurposed into a web/API
    // session under the generic credentialUse capability.
    if (credentialCommandPattern.test(command) && webApiCommandPattern.test(command)) unknown = true;
  }
  if (/\bgit(?:\.exe)?\s+worktree\s+move\b/iu.test(command)) highRiskReasons.add('worktree-move');
  if (/--codex-run-as-apply-patch\b/iu.test(command)) highRiskReasons.add('internal-patch-entrypoint');
  if (hostTargets.length > 0) {
    effects.add('hostWrite');
    highRiskReasons.add('host-write');
    if (workspaceTargets.length === hostTargets.length) effects.delete('workspaceWrite');
  }
  if (effects.has('externalWrite')) highRiskReasons.add('external-write');
  if (effects.has('credentialUse')) highRiskReasons.add('credential-use');
  if (unknown) highRiskReasons.add('unclassified-effect');
  return {
    credentialPersistence: credentialCommandPattern.test(command) && effects.has('workspaceWrite'),
    effects: EXECUTION_EFFECTS_V2.filter((effect) => effects.has(effect)),
    externalTargets,
    highRiskReasons: [...highRiskReasons],
    hostTargets,
    immutableWorkspaceOperation: highRiskReasons.has('worktree-move'),
    readOnly: effects.size === 0 && !unknown,
    risk: highRiskReasons.size > 0 ? 'high' : 'standard',
    unknown,
    workspaceTargets,
  };
}

function addIssueIdentifiers(value, targets) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(issueIdentifierPattern)) targets.add(match[0].toUpperCase());
}

function directIssueTargets(toolInput) {
  const targets = new Set();
  const directTargetKeys = new Set(['id', 'issue', 'issueid', 'identifier', 'issueidentifier']);
  if (!isObject(toolInput)) return targets;
  for (const [key, value] of Object.entries(toolInput)) {
    const normalizedKey = key.replaceAll('_', '').toLowerCase();
    if (!directTargetKeys.has(normalizedKey)) continue;
    if (typeof value === 'string') addIssueIdentifiers(value, targets);
    if (Array.isArray(value)) {
      for (const item of value) addIssueIdentifiers(item, targets);
    }
    if (isObject(value)) {
      for (const nestedKey of ['id', 'identifier']) {
        addIssueIdentifiers(value[nestedKey], targets);
      }
    }
  }
  return targets;
}

function mergeRequestIssueTargets(input) {
  const targets = directIssueTargets(input.toolInput);
  const primaryKeys = new Set([
    'title', 'source', 'sourcebranch', 'sourceref', 'head', 'headref', 'branch',
  ]);
  const closingKeys = new Set(['body', 'description']);
  if (isObject(input.toolInput)) {
    for (const [key, value] of Object.entries(input.toolInput)) {
      const normalizedKey = key.replaceAll('_', '').toLowerCase();
      if (primaryKeys.has(normalizedKey)) addIssueIdentifiers(value, targets);
      if (closingKeys.has(normalizedKey) && typeof value === 'string') {
        for (const match of value.matchAll(/\b(?:close[sd]?|fix(?:e[sd]?|ing)?|resolve[sd]?)\s*:?[ \t]+(?:#)?([A-Z][A-Z0-9]{0,15}-[0-9]{1,10})\b/giu)) {
          targets.add(match[1].toUpperCase());
        }
      }
    }
  }

  const tokens = commandTokens(commandFrom(input));
  const primaryOptions = new Set(['--title', '--source', '--source-branch', '--head']);
  const closingOptions = new Set(['--body', '--description']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalsIndex = token.indexOf('=');
    const option = (equalsIndex < 0 ? token : token.slice(0, equalsIndex)).toLowerCase();
    const value = equalsIndex < 0 ? tokens[index + 1] : token.slice(equalsIndex + 1);
    if (primaryOptions.has(option)) addIssueIdentifiers(value, targets);
    if (closingOptions.has(option) && typeof value === 'string') {
      for (const match of value.matchAll(/\b(?:close[sd]?|fix(?:e[sd]?|ing)?|resolve[sd]?)\s*:?[ \t]+(?:#)?([A-Z][A-Z0-9]{0,15}-[0-9]{1,10})\b/giu)) {
        targets.add(match[1].toUpperCase());
      }
    }
    if (equalsIndex < 0 && (primaryOptions.has(option) || closingOptions.has(option))) index += 1;
  }
  return targets;
}

function visibleIssueTargets(input, targetBoundEffects) {
  const identifiers = targetBoundEffects.includes('linearWrite')
    ? directIssueTargets(input.toolInput)
    : new Set();
  if (targetBoundEffects.some((effect) => ['gitBranch', 'gitCommit', 'gitPush'].includes(effect))) {
    addIssueIdentifiers(commandFrom(input), identifiers);
  }
  if (targetBoundEffects.includes('mergeRequestWrite')) {
    for (const target of mergeRequestIssueTargets(input)) identifiers.add(target);
  }
  return identifiers;
}

function targetDecision(input, classification, envelope) {
  const targetBoundEffects = classification.effects.filter((effect) => [
    'linearWrite', 'gitBranch', 'gitCommit', 'gitPush', 'mergeRequestWrite',
  ].includes(effect));
  if (targetBoundEffects.length === 0) return null;
  const visibleTargets = visibleIssueTargets(input, targetBoundEffects);
  const allowedTargets = new Set(envelope.targetIssueIds.map((item) => item.toUpperCase()));
  const mismatch = [...visibleTargets].find((item) => !allowedTargets.has(item));
  if (mismatch) {
    return deny('EXECUTION_ENVELOPE_TARGET_MISMATCH', '该调用面向的 Issue 不在活动 Execution Envelope 的目标范围内，已拒绝。请把调用改为 Envelope 内的 Issue，或重新申请覆盖该 Issue 的 Envelope。');
  }
  if (visibleTargets.size === 0) {
    return deny('EXECUTION_ENVELOPE_TARGET_UNVERIFIED', '该调用没有暴露可核验的目标 Issue，无法确认授权范围，已拒绝。请在 toolInput 中显式给出目标 Issue ID（例如 ENG-123）。');
  }
  return null;
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

function samePath(left, right) {
  const canonicalLeft = canonicalPath(left);
  const canonicalRight = canonicalPath(right);
  if (!canonicalLeft || !canonicalRight) return false;
  return process.platform === 'win32'
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
}

function gitOutput(cwd, args) {
  try {
    // Bounded like lib/context.mjs: an unbounded Git call inside PreToolUse can
    // outlive the host Hook timeout, and a host timeout is not a blocked call.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

function gitPath(cwd, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

export function inspectWorkspaceIdentity(cwd) {
  const worktreeRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  const gitCommonDir = gitOutput(cwd, ['rev-parse', '--git-common-dir']);
  const gitDir = gitOutput(cwd, ['rev-parse', '--git-dir']);
  const branch = gitOutput(cwd, ['branch', '--show-current']);
  const headSha = gitOutput(cwd, ['rev-parse', 'HEAD']);
  if (!worktreeRoot || !gitCommonDir || !gitDir || !branch || !headSha) return null;
  return {
    branch,
    canonicalCwd: canonicalPath(cwd),
    gitCommonDir: canonicalPath(gitPath(cwd, gitCommonDir)),
    gitDir: canonicalPath(gitPath(cwd, gitDir)),
    headSha,
    worktreeRoot: canonicalPath(worktreeRoot),
  };
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function workspaceDecision(input, classification, envelope) {
  const expected = envelope.scope.workspace;
  const actual = inspectWorkspaceIdentity(input.cwd);
  if (!actual) return deny('EXECUTION_ENVELOPE_WORKSPACE_UNAVAILABLE', '无法核验当前 Git 工作区身份，已拒绝。请确认 cwd 位于有效的 Git 工作树中并重试。');
  if (!samePath(actual.canonicalCwd, expected.canonicalCwd)
    || !samePath(actual.worktreeRoot, expected.worktreeRoot)
    || !samePath(actual.gitCommonDir, expected.gitCommonDir)
    || !samePath(actual.gitDir, expected.gitDir)
    || actual.branch !== expected.branch) {
    return deny('EXECUTION_ENVELOPE_WORKSPACE_MISMATCH', '当前 cwd、worktree、Git 目录或分支与活动 Envelope 不一致，已拒绝。请回到 Envelope 记录的工作区与分支重试。');
  }
  if (!isAncestor(input.cwd, expected.baseSha, actual.headSha)
    || !isAncestor(input.cwd, expected.initialHeadSha, actual.headSha)) {
    return deny('EXECUTION_ENVELOPE_HEAD_DIVERGED', '当前 HEAD 不是冻结基线或初始 HEAD 的后代，已拒绝。请先核对历史，必要时重新申请 Envelope。');
  }
  const baseRefSha = gitOutput(input.cwd, ['rev-parse', expected.baseRef]);
  if (!baseRefSha || !isAncestor(input.cwd, expected.baseSha, baseRefSha)) {
    return deny('EXECUTION_ENVELOPE_BASE_REF_MISMATCH', '冻结的基线 SHA 不在当前基线引用历史上，已拒绝。请确认基线引用未被重写，或重新申请 Envelope。');
  }
  if (envelope.checkpoint && envelope.checkpoint.headSha !== actual.headSha) {
    return deny('EXECUTION_ENVELOPE_CHECKPOINT_STALE', '当前 HEAD 与宿主最后一次 checkpoint 不一致，已拒绝。请在宿主侧更新 checkpoint 后重试。');
  }
  const allowedRoots = expected.allowedWriteRoots.map(canonicalPath);
  if (allowedRoots.some((root) => !root)) {
    return deny('EXECUTION_ENVELOPE_WRITE_SCOPE_INVALID', 'Envelope 声明的允许写入根无法安全解析，已拒绝。请修正 Envelope 中的 allowedWriteRoots 路径后重试。');
  }
  const outside = [...classification.workspaceTargets, ...classification.hostTargets]
    .find((target) => !allowedRoots.some((root) => isInside(root, target)));
  if (outside) return deny('EXECUTION_ENVELOPE_WRITE_SCOPE_MISMATCH', '该调用的写入目标超出 Envelope 允许的写入根，已拒绝。请改为允许根内的路径，或重新申请覆盖该路径的 Envelope。');
  return null;
}

function externalTargetDecision(classification, envelope) {
  if (classification.externalTargets.length === 0) {
    return classification.effects.includes('externalWrite')
      ? deny('EXECUTION_ENVELOPE_EXTERNAL_TARGET_UNVERIFIED', '该外部写操作没有暴露可核验的目标，无法确认授权范围，已拒绝。请在命令中写明完整的目标地址或资源标识。')
      : null;
  }
  const allowed = new Set(envelope.scope.externalTargets.map((target) => (
    target.kind + '\u0000' + target.id + '\u0000' + target.environment
  )));
  const mismatch = classification.externalTargets.find((target) => !allowed.has(
    target.kind + '\u0000' + target.id + '\u0000' + target.environment,
  ));
  return mismatch
    ? deny('EXECUTION_ENVELOPE_EXTERNAL_TARGET_MISMATCH', '该调用面向的外部资源不在活动 Envelope 授权范围内，已拒绝。请改为 Envelope 内的目标，或重新申请 Envelope。')
    : null;
}

function highRiskDecision(classification, envelope, nowMs) {
  if (classification.immutableWorkspaceOperation) {
    return deny('EXECUTION_ENVELOPE_WORKTREE_MOVE_FORBIDDEN', '活动任务不能移动自身绑定的 worktree，已拒绝。请新建任务或使用宿主 handoff 迁移工作区。');
  }
  if (envelope.riskClass !== 'high') {
    return deny('EXECUTION_ENVELOPE_RISK_CLASS_REQUIRED', '该请求属于高风险，需要 v2 high-risk Envelope，当前 Envelope 的 riskClass 不足。请由宿主重新签发 riskClass=high 的 Envelope。');
  }
  const host = envelope.hostContext;
  if (host.source !== 'host' || host.process !== 'isolated') {
    return deny('EXECUTION_ENVELOPE_HOST_CONTEXT_INSUFFICIENT', '高风险执行要求宿主提供进程隔离证明，当前 hostContext 不满足，已拒绝。请由宿主注入 source=host 且 process=isolated 的证明。');
  }
  const observedAt = Date.parse(host.observedAt);
  if (observedAt > nowMs || nowMs - observedAt > 5 * 60 * 1000) {
    return deny('EXECUTION_ENVELOPE_HOST_CONTEXT_STALE', '宿主强制证据已过期（超过 5 分钟），已拒绝。请让宿主重新采集并注入 hostContext。');
  }
  if (classification.effects.includes('workspaceWrite') && host.filesystem === 'read-only') {
    return deny('EXECUTION_ENVELOPE_FILESYSTEM_INSUFFICIENT', '宿主文件系统边界为只读，不允许工作区写入，已拒绝。请在允许写入的宿主边界内重试。');
  }
  if (classification.effects.includes('hostWrite') && host.filesystem !== 'unrestricted') {
    return deny('EXECUTION_ENVELOPE_FILESYSTEM_INSUFFICIENT', '宿主目录写入要求显式的 unrestricted 文件系统边界，已拒绝。请让宿主重新签发对应边界。');
  }
  if (classification.effects.includes('externalWrite') && host.network === 'offline') {
    return deny('EXECUTION_ENVELOPE_NETWORK_INSUFFICIENT', '外部写操作要求启用宿主网络边界，当前为 offline，已拒绝。请让宿主重新签发网络边界。');
  }
  const approvalEffects = new Set(['hostWrite', 'externalWrite', 'credentialUse']);
  if (classification.effects.some((effect) => approvalEffects.has(effect)) && host.approval !== 'interactive') {
    return deny('EXECUTION_ENVELOPE_APPROVAL_REQUIRED', '宿主写入、外部写入与凭据使用要求交互式审批，当前 approval 不满足，已拒绝。请提供交互式审批或缩小该请求范围。');
  }
  return null;
}

function deny(reasonCode, reason) {
  return { action: 'deny', reason, reasonCode };
}

function envelopeInput(input, environment) {
  if (Object.hasOwn(input, 'executionEnvelope')) return { present: true, value: input.executionEnvelope };
  if (Object.hasOwn(environment, 'VIBE_HARNESS_EXECUTION_ENVELOPE')) {
    try {
      return { present: true, value: JSON.parse(environment.VIBE_HARNESS_EXECUTION_ENVELOPE) };
    } catch {
      return { present: true, value: null };
    }
  }
  return { present: false, value: null };
}

function invalidEnvelopeDecision(status) {
  if (status === 'missing') return deny('EXECUTION_ENVELOPE_MISSING', '该调用有副作用或无法安全判定，属于「不可判定」，需要 Execution Envelope 才能执行。只读命令无需 Envelope；确需执行请让宿主注入 Envelope，或改写为已登记的只读命令。');
  if (status === 'session-mismatch') return deny('EXECUTION_ENVELOPE_SESSION_MISMATCH', 'Execution Envelope 绑定的是另一个宿主会话，已拒绝。请在当前会话重新签发 Envelope 后重试。');
  if (status === 'expired') return deny('EXECUTION_ENVELOPE_EXPIRED', 'Execution Envelope 已过期，已拒绝。请重新签发有效期内的 Envelope。');
  return deny('EXECUTION_ENVELOPE_INVALID', 'Execution Envelope 不符合受支持契约，已拒绝。请按 docs/schemas/execution-envelope-v2.schema.json 重新签发（缺失字段或版本不匹配都会命中此项）。');
}

/** @param {Record<string, any>} input @param {{environment?: NodeJS.ProcessEnv, now?: number | Date}} options */
export function evaluateExecutionEnvelope(input, { environment = process.env, now = Date.now() } = {}) {
  const classification = classifyExecutionEffects(input);
  const required = environment.VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED === '1';
  const candidate = envelopeInput(input, environment);
  if (!candidate.present) {
    if (classification.readOnly) return { action: 'allow' };
    if (!required && classification.risk !== 'high') return { action: 'allow' };
    return invalidEnvelopeDecision('missing');
  }
  const parsed = parseExecutionEnvelope(candidate.value);
  if (!parsed) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('invalid');
  }
  const { envelope, version } = parsed;
  if (envelope.sessionId !== input.sessionId) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('session-mismatch');
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= nowMs) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('expired');
  }
  const forbidden = classification.effects.find((effect) => envelope.forbiddenEffects.includes(effect));
  if (forbidden) {
    return deny('EXECUTION_ENVELOPE_EFFECT_FORBIDDEN', '活动 Envelope 明确禁止执行效果 ' + forbidden + '，已拒绝。请改用不含该效果的实现，或重新签发不含该禁止项的 Envelope。');
  }
  const ceiling = (version === 1 ? modeCeilingsV1 : modeCeilingsV2).get(envelope.mode);
  const modeViolation = classification.effects.find((effect) => !ceiling.has(effect));
  if (modeViolation) {
    return deny('EXECUTION_ENVELOPE_MODE_VIOLATION', '执行模式 ' + envelope.mode + ' 不允许效果 ' + modeViolation + '，已拒绝。请改用允许该效果的模式（例如 execute）或缩小调用范围。');
  }
  if (classification.credentialPersistence) {
    return deny('EXECUTION_ENVELOPE_CREDENTIAL_PERSISTENCE', '禁止把凭据助手输出直接落盘，已拒绝。请改为只读取所需字段，不要把凭据写入文件。');
  }
  if (version === 1 && classification.risk === 'high') {
    return deny('EXECUTION_ENVELOPE_V1_INSUFFICIENT', 'Execution Envelope v1 无法授权高风险、宿主、外部、凭据或 worktree 拓扑效果，已拒绝。请改用 v2 high-risk Envelope。');
  }
  if (classification.unknown) {
    return deny('EXECUTION_ENVELOPE_UNKNOWN_EFFECT', '该调用的效果无法安全判定，属于「不可判定」，需要 Execution Envelope 才能执行。请改写为已登记的只读命令，或由宿主注入覆盖该调用的 Envelope。');
  }
  if (version === 2 && classification.risk === 'high') {
    const riskDecision = highRiskDecision(classification, envelope, nowMs);
    if (riskDecision) return riskDecision;
  }
  const missing = classification.effects.find((effect) => !envelope.allowedEffects.includes(effect));
  if (missing) {
    return deny('EXECUTION_ENVELOPE_EFFECT_NOT_ALLOWED', '活动 Envelope 未授权执行效果 ' + missing + '，已拒绝。请在 Envelope 的 allowedEffects 中登记该效果后重试。');
  }
  const targetMismatch = targetDecision(input, classification, envelope);
  if (targetMismatch) return targetMismatch;
  if (version === 2 && !classification.readOnly) {
    const workspaceMismatch = workspaceDecision(input, classification, envelope);
    if (workspaceMismatch) return workspaceMismatch;
    const externalMismatch = externalTargetDecision(classification, envelope);
    if (externalMismatch) return externalMismatch;
  }
  return { action: 'allow' };
}
