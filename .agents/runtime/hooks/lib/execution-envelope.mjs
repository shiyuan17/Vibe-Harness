export const EXECUTION_ENVELOPE_SCHEMA = 'vibe-harness.execution-envelope/v1';

export const EXECUTION_ENVELOPE_MODES = Object.freeze([
  'inspect', 'plan', 'linear-sync', 'execute', 'monitor',
]);
export const EXECUTION_EFFECTS = Object.freeze([
  'linearWrite', 'workspaceWrite', 'gitBranch', 'gitCommit', 'gitPush',
  'mergeRequestWrite', 'credentialUse',
]);

const modeSet = new Set(EXECUTION_ENVELOPE_MODES);
const effectSet = new Set(EXECUTION_EFFECTS);
const modeCeilings = new Map([
  ['inspect', new Set()],
  ['plan', new Set()],
  ['linear-sync', new Set(['linearWrite'])],
  ['execute', new Set(EXECUTION_EFFECTS)],
  ['monitor', new Set()],
]);
const rootKeys = new Set([
  'schema', 'requestId', 'sessionId', 'mode', 'targetIssueIds',
  'allowedEffects', 'forbiddenEffects', 'terminalCondition', 'activeObjective',
  'expiresAt', 'checkpoint',
]);
const requiredRootKeys = [
  'schema', 'requestId', 'sessionId', 'mode', 'targetIssueIds',
  'allowedEffects', 'forbiddenEffects', 'terminalCondition', 'activeObjective',
];
const checkpointKeys = new Set([
  'activeObjective', 'targetIssueId', 'completedFacts', 'noRepeatSet',
  'nextAction', 'liveStates', 'blockerFingerprint', 'dagStructureHash',
  'dagChangeCursor', 'observedAt',
]);
const requiredCheckpointKeys = [
  'activeObjective', 'targetIssueId', 'completedFacts', 'noRepeatSet',
  'nextAction', 'liveStates', 'blockerFingerprint', 'dagStructureHash',
];
const utcTimestampPattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

const readOnlyToolPattern = /^(?:read|glob|grep|search|view|inspect|list|websearch|webfetch)$/iu;
const workspaceToolPattern = /(?:^|__|\.)(?:apply_?patch|write(?:_file)?|edit(?:_file)?|delete(?:_file)?|remove(?:_file)?|move(?:_file)?|rename(?:_file)?|create(?:_file|_directory)?|mkdir)(?:$|__)/iu;
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
const shellWorkspaceWritePattern = /(?:^|\s)(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|md|rmdir|rd|touch|rm|mv|cp|tee|truncate|install|chmod|chown|ln|dd|rsync|del|erase|copy|move|sed\s+-i)(?:\s|$)/iu;
const credentialCommandPattern = /(?:\bgit(?:\.exe)?\s+credential(?:\s+(?:fill|approve|reject))?\b|\bgit-credential-[^\s]+|\bcredential-manager(?:-core)?\b|\bgit(?:\.exe)?\s+config\b[^\r\n]*\bcredential\.helper\b|\b(?:gh|glab)(?:\.exe)?\s+auth\b|\bcmdkey(?:\.exe)?\b|\bGet-StoredCredential\b|\bsecurity\s+find-(?:generic|internet)-password\b)/iu;
const webApiCommandPattern = /(?:\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\b(?:gh|glab)(?:\.exe)?\s+api\b)/iu;
const shellReadOnlyPattern = /^\s*(?:(?:Get-Content|Test-Path|Get-Item|Get-ChildItem|Resolve-Path|Get-Location|Select-String|Measure-Object|cat|type|ls|dir|pwd|rg|grep|find|where|which|head|tail|wc|stat|file|tree|echo|Write-Output)\b|(?:node|npm|pnpm|yarn|git|gh|glab)(?:\.exe|\.cmd)?\s+(?:--version|-v)\b)/iu;
const arbitraryRuntimePattern = /(?:^|[\\/])(?:node|npm|npx|pnpm|yarn|python|python3|py|ruby|perl|deno|bun)(?:\.exe|\.cmd)?$/iu;
const issueIdentifierPattern = /\b[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}\b/giu;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isString(value, { maxLength, minLength = 0 } = {}) {
  if (typeof value !== 'string' || value.length < minLength) return false;
  return maxLength === undefined || value.length <= maxLength;
}

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

function validCheckpoint(value) {
  if (!isObject(value) || !hasOnlyKeys(value, checkpointKeys)) return false;
  if (requiredCheckpointKeys.some((key) => !Object.hasOwn(value, key))) return false;
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
  if (!isObject(value) || !hasOnlyKeys(value, rootKeys)) return false;
  if (requiredRootKeys.some((key) => !Object.hasOwn(value, key))) return false;
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
  return !Object.hasOwn(value, 'checkpoint') || validCheckpoint(value.checkpoint);
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
    if (pair === '&&' || pair === '||') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || character === '\n' || character === '\r') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function hasShellRedirection(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>' && command[index - 1] !== '<') return true;
  }
  return false;
}

function commandTokens(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function gitInvocation(segment) {
  const tokens = commandTokens(segment);
  const executableIndex = tokens.findIndex((token) => /(?:^|[\\/])git(?:\.exe)?$/iu.test(token));
  if (executableIndex < 0) return null;
  const args = tokens.slice(executableIndex + 1);
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
  const tokens = commandTokens(segment);
  const executable = tokens.find((token) => arbitraryRuntimePattern.test(token));
  if (!executable) return false;
  const executableIndex = tokens.indexOf(executable);
  const args = tokens.slice(executableIndex + 1);
  if (args.length === 1 && ['--version', '-v'].includes(args[0].toLowerCase())) return true;
  effects.add('workspaceWrite');
  return true;
}

function cliInvocation(segment, executable) {
  const tokens = commandTokens(segment);
  const pattern = new RegExp('(?:^|[\\\\/])' + executable + '(?:\\.exe)?$', 'iu');
  const index = tokens.findIndex((token) => pattern.test(token));
  if (index < 0) return null;
  const args = tokens.slice(index + 1).map((item) => item.toLowerCase());
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
    if (/(?:\s|^)(?:-d|--data(?:-ascii|-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)(?:\s|=)|(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/iu.test(segment)) return false;
    return true;
  }
  if (/\b(?:Invoke-WebRequest|Invoke-RestMethod)\b/iu.test(segment)) {
    if (/\s-OutFile\b/iu.test(segment)) effects.add('workspaceWrite');
    return !/\s-Method\s+(?:POST|PUT|PATCH|DELETE)\b/iu.test(segment);
  }
  if (/\bwget(?:\.exe)?\b/iu.test(segment)) {
    if (!/(?:\s-qO-\b|\s--output-document=-\b)/u.test(segment)) effects.add('workspaceWrite');
    return true;
  }
  return null;
}

function classifyMcpTool(toolName, effects) {
  if (!/^mcp__/iu.test(toolName)) return null;
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
  if (workspaceToolPattern.test(toolName) && /(?:filesystem|file|workspace)/iu.test(toolName)) {
    effects.add('workspaceWrite');
    return true;
  }
  return /(?:^|__)(?:get|list|search|read|find|view|fetch|inspect|query)(?:_|__|$)/iu.test(toolName);
}

export function classifyExecutionEffects(input) {
  const effects = new Set();
  const toolName = String(input.toolName ?? '');
  const command = commandFrom(input);
  let unknown = false;
  const mcpClassification = classifyMcpTool(toolName, effects);
  if (mcpClassification !== null) unknown = !mcpClassification;
  else if (workspaceToolPattern.test(toolName)) effects.add('workspaceWrite');
  else if (readOnlyToolPattern.test(toolName)) unknown = false;
  else if (command.length === 0) unknown = toolName.length > 0;

  if (command.length > 0 && !workspaceToolPattern.test(toolName)) {
    if (shellWorkspaceWritePattern.test(command) || hasShellRedirection(command)) effects.add('workspaceWrite');
    if (credentialCommandPattern.test(command)) effects.add('credentialUse');
    for (const segment of shellSegments(command)) {
      if (classifyGit(segment, effects) === true) continue;
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
      if (shellWorkspaceWritePattern.test(segment) || hasShellRedirection(segment)) continue;
      if (credentialCommandPattern.test(segment)) continue;
      if (!shellReadOnlyPattern.test(segment)) unknown = true;
    }
    // Direct credential-helper output cannot be repurposed into a web/API
    // session under the generic credentialUse capability.
    if (credentialCommandPattern.test(command) && webApiCommandPattern.test(command)) unknown = true;
  }
  return {
    credentialPersistence: credentialCommandPattern.test(command) && effects.has('workspaceWrite'),
    effects: EXECUTION_EFFECTS.filter((effect) => effects.has(effect)),
    readOnly: effects.size === 0 && !unknown,
    unknown,
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
    return deny('EXECUTION_ENVELOPE_TARGET_MISMATCH', 'The tool request targets an Issue outside the active Execution Envelope.');
  }
  if (visibleTargets.size === 0) {
    return deny('EXECUTION_ENVELOPE_TARGET_UNVERIFIED', 'The tool request does not expose a verifiable target Issue.');
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
  if (status === 'missing') return deny('EXECUTION_ENVELOPE_MISSING', 'An Execution Envelope is required for this effectful or unclassified request.');
  if (status === 'session-mismatch') return deny('EXECUTION_ENVELOPE_SESSION_MISMATCH', 'The Execution Envelope is bound to a different host session.');
  if (status === 'expired') return deny('EXECUTION_ENVELOPE_EXPIRED', 'The Execution Envelope has expired.');
  return deny('EXECUTION_ENVELOPE_INVALID', 'The Execution Envelope does not match the supported contract.');
}

export function evaluateExecutionEnvelope(input, { environment = process.env, now = Date.now() } = {}) {
  const classification = classifyExecutionEffects(input);
  const required = environment.VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED === '1';
  const candidate = envelopeInput(input, environment);
  if (!candidate.present) {
    if (!required || classification.readOnly) return { action: 'allow' };
    return invalidEnvelopeDecision('missing');
  }
  if (!validateExecutionEnvelope(candidate.value)) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('invalid');
  }
  const envelope = candidate.value;
  if (envelope.sessionId !== input.sessionId) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('session-mismatch');
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (envelope.expiresAt && Date.parse(envelope.expiresAt) <= nowMs) {
    return classification.readOnly ? { action: 'allow' } : invalidEnvelopeDecision('expired');
  }
  const forbidden = classification.effects.find((effect) => envelope.forbiddenEffects.includes(effect));
  if (forbidden) {
    return deny('EXECUTION_ENVELOPE_EFFECT_FORBIDDEN', 'Execution effect ' + forbidden + ' is explicitly forbidden by the active envelope.');
  }
  const ceiling = modeCeilings.get(envelope.mode);
  const modeViolation = classification.effects.find((effect) => !ceiling.has(effect));
  if (modeViolation) {
    return deny('EXECUTION_ENVELOPE_MODE_VIOLATION', 'Execution mode ' + envelope.mode + ' does not permit effect ' + modeViolation + '.');
  }
  if (classification.credentialPersistence) {
    return deny('EXECUTION_ENVELOPE_CREDENTIAL_PERSISTENCE', 'Direct credential-helper output must not be written to files.');
  }
  if (classification.unknown) {
    return deny('EXECUTION_ENVELOPE_UNKNOWN_EFFECT', 'The tool request has effects that cannot be classified safely.');
  }
  const missing = classification.effects.find((effect) => !envelope.allowedEffects.includes(effect));
  if (missing) {
    return deny('EXECUTION_ENVELOPE_EFFECT_NOT_ALLOWED', 'Execution effect ' + missing + ' is not authorized by the active envelope.');
  }
  const targetMismatch = targetDecision(input, classification, envelope);
  if (targetMismatch) return targetMismatch;
  return { action: 'allow' };
}
