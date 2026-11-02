import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  RUNTIME_TOOLCHAIN_PATTERN,
  classifyMcpToolName,
  commandWrites,
  hasUnsafeShellConstruct,
  isReadOnlyDataCommand,
  isReadOnlyPowerShellAssignment,
  isReadOnlyShellSegment,
  isReadOnlyToolName,
  isWorkspaceToolName,
  mcpToolPolicy,
  parseMcpToolName,
  shellInvocation,
  shellSegments,
} from './read-only-commands.mjs';
import { resolveGitPushTarget } from '../../lib/git-delivery-target.mjs';
import { parseDeliveryException } from '../../lib/delivery-exception.mjs';

export const EXECUTION_EFFECTS = Object.freeze([
  'linearWrite', 'workspaceWrite', 'hostWrite', 'externalWrite', 'dataEgress', 'gitBranch',
  'gitCommit', 'gitPush', 'mergeRequestWrite', 'credentialUse',
]);

const linearServerPattern = /^linear(?:$|-)/u;
const mergeRequestServerPattern = /^(?:github|gitlab)(?:$|-)/u;
const linearReadPattern = /(?:^|__)(?:get|list|search|read|find|view|fetch|query)(?:_|__|$)/iu;
const linearWritePattern = /(?:^|__)(?:save|create|update|delete|archive|restore|merge|submit|resolve|cancel|add|remove|set|assign|unassign)(?:_|__|$)/iu;
const mergeRequestObjectPattern = /(?:pull_?request|merge_?request|\bpr\b|\bmr\b)/iu;
const mergeRequestReadPattern = /(?:^|__)(?:get|list|search|read|find|view|fetch|query|diff|checks?|status)(?:_|__|$)/iu;
const mergeRequestWritePattern = /(?:^|__)(?:create|update|edit|merge|close|reopen|ready|comment|note|review|approve|unapprove|revoke|delete|lock|unlock|rebase|revert|subscribe|unsubscribe|todo)(?:_|__|$)/iu;
const credentialToolPattern = /(?:credential|auth|keychain|secret.?service)/iu;
const credentialUsePattern = /(?:^|__)(?:get|read|find|fill|login|authorize|store|save|update|delete|remove)(?:_|__|$)/iu;
const credentialCommandPattern = /(?:\bgit(?:\.exe)?\s+credential(?:\s+(?:fill|approve|reject))?\b|\bgit-credential-[^\s]+|\bcredential-manager(?:-core)?\b|\bgit(?:\.exe)?\s+config\b[^\r\n]*\bcredential\.helper\b|\b(?:gh|glab)(?:\.exe)?\s+auth\b|\bcmdkey(?:\.exe)?\b|\bGet-StoredCredential\b|\bsecurity\s+find-(?:generic|internet)-password\b)/iu;
const webApiCommandPattern = /(?:\bcurl(?:\.exe)?\b|\bwget(?:\.exe)?\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\b(?:gh|glab)(?:\.exe)?\s+api\b)/iu;
const indirectWritePattern = /(?:WriteAllBytes|WriteAllText|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|--codex-run-as-apply-patch)/iu;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

export function gitInvocation(segment) {
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

function classifyGit(segment, effects, hints) {
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
  // Reading remote state never touches the working tree.
  if (command === 'fetch' || command === 'ls-remote') return true;
  if (command === 'pull') {
    if (lowerArgs.includes('--ff-only')) {
      // A fast-forward-only pull is a plain sync: it cannot create a merge
      // commit and git itself refuses to overwrite local modifications. The
      // hook still requires a clean tracked working tree before allowing one
      // (VIBE_HARNESS_SYNC_DIRTY_TREE), which this classification reports
      // through `cleanTreeRequired`.
      if (hints) hints.cleanTreeRequired = true;
      return true;
    }
    // Every other pull form may create a merge commit or rebase local work, so
    // it stays a workspace write that an host-native permission can authorize.
    effects.add('workspaceWrite');
    return true;
  }
  // Only the printing forms of these two sub-commands are read-only; every
  // other form keeps falling through to the unclassified (fail-closed) path.
  if (command === 'stash' || command === 'submodule') {
    return lowerArgs.includes(command === 'stash' ? 'list' : 'status');
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

// Only this fixed entrypoint has a bounded, inspectable effect surface.
// Arbitrary `ocr` or `node` invocations do not inherit this classification.
function classifyOcrReview(segment, effects, targets) {
  const invocation = shellInvocation(segment);
  if (!invocation || invocation.name !== 'node') return null;
  const args = invocation.args;
  if (!/^(?:\.agents[\\/])?runtime[\\/]commands[\\/]run\.mjs$/iu.test(args[0] ?? '')
    || args[1] !== 'review' || args[2] !== 'ocr') return null;
  const tail = args.slice(3);
  if (tail.length !== 4 || tail[0] !== '--task'
    || !/^[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}$/u.test(tail[1])
    || tail[2] !== '--target') return false;
  let url;
  try { url = new URL(tail[3]); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return false;
  effects.add('dataEgress');
  effects.add('credentialUse');
  targets.push({ kind: 'model-endpoint', id: url.origin, environment: 'remote' });
  return true;
}

function isUnrecognizedReviewCommand(segment) {
  const invocation = shellInvocation(segment);
  return invocation?.name === 'node'
    && /^(?:\.agents[\\/])?runtime[\\/]commands[\\/]run\.mjs$/iu.test(invocation.args[0] ?? '')
    && invocation.args[1] === 'review';
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
  const server = parseMcpToolName(toolName)?.server ?? '';
  if (linearServerPattern.test(server)) {
    if (linearWritePattern.test(toolName)) {
      effects.add('linearWrite');
      return true;
    }
    return linearReadPattern.test(toolName);
  }
  if (mergeRequestServerPattern.test(server) && mergeRequestObjectPattern.test(toolName)) {
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
  // and UI verbs pass, write and execute verbs remain effectful, and an
  // unclassified tool is no longer denied outright.
  return classifyMcpToolName(toolName) === true;
}

export function classifyExecutionEffects(input) {
  const effects = new Set();
  const externalTargets = [];
  const highRiskReasons = new Set();
  // Classification is pure, so the working-tree fact a `git pull --ff-only`
  // depends on is reported out as a requirement instead of being probed here;
  // the hook decides it with one read-only `git status` right before allowing.
  const hints = { cleanTreeRequired: false };
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
    const segments = shellSegments(command);
    // Do not lose a literal path once a later writer consumes its variable.
    // Without dataflow proof such a mixed script stays unknown, not local-write.
    if (segments.some(isReadOnlyPowerShellAssignment)
      && !segments.every((segment) => isReadOnlyShellSegment(segment) && !commandWrites(segment))) unknown = true;
    const executableText = segments.filter((segment) => !isReadOnlyDataCommand(segment)).join('; ');
    if (commandWrites(command)) effects.add('workspaceWrite');
    if (credentialCommandPattern.test(executableText)) effects.add('credentialUse');
    if (indirectWritePattern.test(executableText)) {
      effects.add('workspaceWrite');
      highRiskReasons.add('indirect-runtime-write');
    }
    const review = segments.length === 1 ? classifyOcrReview(segments[0], effects, externalTargets) : null;
    if (review === false) unknown = true;
    if (review === null) addUrlTargets(command, externalTargets);
    for (const segment of review === null ? segments : []) {
      if (isReadOnlyDataCommand(segment)) continue;
      if (isUnrecognizedReviewCommand(segment)) {
        unknown = true;
        continue;
      }
      if (classifyGit(segment, effects, hints) === true) continue;
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
  if (effects.has('dataEgress')) highRiskReasons.add('data-egress');
  if (effects.has('credentialUse')) highRiskReasons.add('credential-use');
  if (unknown) highRiskReasons.add('unclassified-effect');
  return {
    cleanTreeRequired: hints.cleanTreeRequired,
    credentialPersistence: credentialCommandPattern.test(command) && effects.has('workspaceWrite'),
    effects: EXECUTION_EFFECTS.filter((effect) => effects.has(effect)),
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

function gitOutput(cwd, args) {
  try {
    // Bounded like lib/context.mjs: an unbounded Git call inside PreToolUse can
    // outlive the host Hook timeout, and a host timeout is not a blocked call.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

export function ordinaryGitDelivery(input, classification) {
  if (classification.unknown || classification.risk !== 'standard'
    || classification.effects.length !== 1
    || !['gitCommit', 'gitPush'].includes(classification.effects[0])
    || classification.workspaceTargets.length > 0
    || classification.hostTargets.length > 0) return null;
  const command = commandFrom(input);
  if (shellSegments(command).length !== 1 || commandWrites(command) || hasUnsafeShellConstruct(command)) return null;
  const invocation = shellInvocation(command);
  if (!invocation || invocation.name !== 'git' || invocation.tokens.length !== invocation.args.length + 1) return null;
  const globalArgs = [...invocation.args];
  let cwd = input.cwd;
  while (globalArgs[0] === '-C' || globalArgs[0]?.startsWith('-C')) {
    const option = globalArgs.shift();
    const directory = option === '-C' ? globalArgs.shift() : option.slice(2);
    if (directory === undefined) return null;
    cwd = path.resolve(cwd, directory);
    const original = gitOutput(input.cwd, ['rev-parse', '--show-toplevel']);
    const resolved = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
    if (!original || !resolved || original !== resolved) return null;
  }
  const [operation, ...args] = globalArgs;
  if (operation === 'commit') {
    if (classification.externalTargets.length) return null;
    const audit = args.includes('--allow-empty');
    const messages = [];
    let hasMessage = false;
    for (let index = 0; index < args.length; index += 1) {
      const option = args[index];
      if (['--allow-empty', '--signoff', '-s', '-S', '--gpg-sign', '--no-gpg-sign'].includes(option)) continue;
      if (/^(?:--gpg-sign=|-S).+/u.test(option)) continue;
      const attached = /^(--message=|--file=|-m|-F)(.+)$/u.exec(option);
      const flag = attached ? attached[1].replace(/=$/u, '') : option;
      if (!['-m', '--message', '-F', '--file'].includes(flag)) return null;
      const value = attached ? attached[2] : args[++index];
      if (!value || value === '-') return null;
      const file = ['-F', '--file'].includes(flag);
      if (audit && file) return null;
      if (!file) messages.push(value);
      hasMessage = true;
    }
    if (!hasMessage) return null;
    if (audit) {
      try {
        const record = parseDeliveryException(messages.join('\n\n'));
        const head = gitOutput(input.cwd, ['rev-parse', 'HEAD']);
        const branch = gitOutput(input.cwd, ['branch', '--show-current']);
        if (!record?.affectedCommit || record.affectedCommit !== head
          || record.targetRef !== `refs/heads/${branch}`
          || gitOutput(input.cwd, ['diff', '--cached', '--name-only', '-z'])
          || record.tree !== gitOutput(input.cwd, ['rev-parse', `${head}^{tree}`])) return null;
      } catch { return null; }
    }
    return 'gitCommit';
  }
  if (operation !== 'push') return null;
  if (resolveGitPushTarget(input.cwd, args)) return 'gitPush';
  const currentBranch = gitOutput(input.cwd, ['branch', '--show-current']);
  if (!currentBranch) return null;
  if (/^(?:main$|master$|release)/iu.test(currentBranch)) {
    return deny('GIT_DELIVERY_PROTECTED_BRANCH', '保护分支不得直接推送，请使用已批准的集成流程。');
  }
  return null;
}


function deny(reasonCode, reason) {
  return { action: 'deny', reason, reasonCode };
}
