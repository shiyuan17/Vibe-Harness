#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { protectedConfigChanged, snapshotProtectedConfig } from './lib/protected-config.mjs';
import { runHiddenTests } from './lib/hidden-tests.mjs';
import { knowledgeCoverageEpisode, taskEpisode } from './lib/knowledge-coverage.mjs';

const LIMIT = 1024 * 1024;
const RUNNER_ID = 'codex-reference@2';
// Only classify explicit authentication failures as credential errors. Normal
// task output may mention auth/credentials while the CLI is otherwise healthy.
const CREDENTIAL_ERROR = /(?:\b(?:401|403)\b|(?:(?:invalid|missing|expired|revoked)\s+(?:api[-_ ]?key|credentials?)|(?:api[-_ ]?key|credentials?)\s+(?:is|are)?\s*(?:missing|invalid|expired|revoked))|authentication\s+(?:failed|required)|unauthorized|login\s+required)/iu;
const codexEnvironmentNames = new Set([
  'ALL_PROXY', 'APPDATA', 'AZURE_OPENAI_API_KEY', 'CODEX_HOME', 'COMSPEC', 'HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'VIBE_HARNESS_EXECUTION_ENVELOPE', 'WINDIR', 'WSLENV', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);

function executionRestrictionCategory(text) {
  if (/(?:workspace|file\s*system|filesystem)[^\n]{0,120}read[- ]only|mounted[^\n]{0,80}read[- ]only|sandbox[^\n]{0,80}read[- ]only/iu.test(text)) {
    return 'sandbox-write-denied';
  }
  if (/(?:shell|command|filesystem|file system)[^\n]{0,100}(?:blocked|rejected|denied)[^\n]{0,80}(?:environment )?policy/iu.test(text)) {
    return 'policy-denied';
  }
  return null;
}

function codexEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => codexEnvironmentNames.has(name)));
}

async function stdin() {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > LIMIT) throw new Error('runner request exceeds 1 MiB');
  }
  return JSON.parse(body);
}

async function provisionIsolatedConfig(codexHome) {
  try {
    await writeFile(path.join(codexHome, 'config.toml'), '# Vibe-Harness isolated eval runtime\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function execute(program, args, cwd, environment) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(program, args, {
      cwd,
      env: { ...codexEnvironment(process.env), ...environment },
      shell: false,
      windowsHide: true,
    });
    const append = (value, chunk) => {
      const next = Buffer.concat([value, chunk]);
      if (next.length > LIMIT) child.kill();
      return next.subarray(0, LIMIT);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: stderr.toString('utf8'), stdout: stdout.toString('utf8') }));
    child.stdin.end();
  });
}

function providerArgs() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return [];
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OPENAI_BASE_URL must use http or https');
  const provider = process.env.VIBE_HARNESS_EVAL_PROVIDER_NAME ?? 'vibe-harness-env';
  const wireApi = process.env.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API ?? 'responses';
  if (!/^[a-zA-Z0-9_-]+$/u.test(provider)) throw new Error('VIBE_HARNESS_EVAL_PROVIDER_NAME is invalid');
  if (!/^[a-zA-Z0-9_-]+$/u.test(wireApi)) throw new Error('VIBE_HARNESS_EVAL_PROVIDER_WIRE_API is invalid');
  const requiresAuth = process.env.VIBE_HARNESS_EVAL_PROVIDER_REQUIRES_AUTH === '1';
  return [
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.name=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(parsed.toString().replace(/\/$/u, ''))}`,
    '-c', `model_providers.${provider}.wire_api=${JSON.stringify(wireApi)}`,
    ...(requiresAuth ? [] : ['-c', `model_providers.${provider}.env_key="OPENAI_API_KEY"`]),
    '-c', `model_providers.${provider}.requires_openai_auth=${requiresAuth}`,
  ];
}

function resolveBackend(request) {
  const configured = process.env.VIBE_HARNESS_EVAL_CODEX_BACKEND ?? 'auto';
  if (!['auto', 'native', 'wsl'].includes(configured)) throw new Error('VIBE_HARNESS_EVAL_CODEX_BACKEND is invalid');
  if (configured !== 'auto') return configured;
  const needsWrite = (request.case.input?.fixture?.allowedWritePaths ?? []).length > 0;
  return process.platform === 'win32' && needsWrite ? 'wsl' : 'native';
}

function wslEnvironment(environment) {
  const inherited = (process.env.WSLENV ?? '').split(':').filter(Boolean);
  const required = [
    'CODEX_HOME/p', 'HOME/p', 'USERPROFILE/p', 'OPENAI_API_KEY/u', 'OPENAI_BASE_URL/u',
    'VIBE_HARNESS_EXECUTION_ENVELOPE/u',
  ];
  return { ...environment, WSLENV: [...new Set([...inherited, ...required])].join(':') };
}

async function resolveCodexCommand(backend) {
  if (backend === 'wsl') {
    if (process.platform !== 'win32') throw new Error('WSL evaluation backend is only available on Windows');
    return { args: ['-e', process.env.VIBE_HARNESS_WSL_CODEX_COMMAND ?? 'codex'], backend, program: 'wsl.exe' };
  }
  const configured = process.env.VIBE_HARNESS_CODEX_COMMAND;
  if (configured?.toLowerCase().endsWith('.mjs') || configured?.toLowerCase().endsWith('.js')) {
    return { args: [configured], backend, program: process.execPath };
  }
  if (process.platform !== 'win32') return { args: [], backend, program: configured ?? 'codex' };
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const wrappers = [];
  if (configured?.toLowerCase().endsWith('.cmd') && path.isAbsolute(configured)) wrappers.push(configured);
  if (!configured || configured.toLowerCase() === 'codex.cmd') {
    wrappers.push(...pathEntries.map((entry) => path.join(entry, 'codex.cmd')));
  }
  for (const wrapper of wrappers) {
    const script = path.join(path.dirname(wrapper), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await access(wrapper);
      await access(script);
      return { args: [script], backend, program: process.execPath };
    } catch {}
  }
  if (configured && !configured.toLowerCase().endsWith('.cmd')) return { args: [], backend, program: configured };
  for (const entry of pathEntries) {
    const executable = path.join(entry, 'codex.exe');
    try {
      await access(executable);
      return { args: [], backend, program: executable };
    } catch {}
  }
  return { args: [], backend, program: 'codex.exe' };
}

function usesWindowsExecutable(command) {
  return /(?:^|[\\/])[^\\/]+\.exe$/iu.test(command);
}

async function wslPath(value, cwd) {
  const result = await execute('wsl.exe', ['-e', 'wslpath', '-a', '-u', value], cwd, {});
  const translated = result.stdout.trim();
  if (result.code !== 0 || translated === '') throw new Error('WSL path translation failed');
  return translated;
}

async function provisionAuthentication(codexHome) {
  const source = process.env.VIBE_HARNESS_EVAL_AUTH_FILE;
  if (!source) return;
  if (!path.isAbsolute(source)) throw new Error('VIBE_HARNESS_EVAL_AUTH_FILE must be absolute');
  const details = await stat(source);
  if (!details.isFile()) throw new Error('VIBE_HARNESS_EVAL_AUTH_FILE must reference a file');
  const target = path.join(codexHome, 'auth.json');
  await copyFile(source, target);
  await chmod(target, 0o600);
}

async function artifacts(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (['.codex-eval-home', '.vibe-harness-eval-user-home', '.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await artifacts(root, full));
    else if (entry.isFile()) output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return output.sort();
}

async function workspaceSnapshot(root, current = root) {
  const output = new Map();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (['.codex-eval-home', '.vibe-harness-eval-user-home', '.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of await workspaceSnapshot(root, full)) output.set(name, hash);
    } else if (entry.isFile()) {
      const relative = path.relative(root, full).replaceAll('\\', '/');
      output.set(relative, createHash('sha256').update(await readFile(full)).digest('hex'));
    }
  }
  return output;
}

function workspaceWriteSummary(request, before, after) {
  const allowed = new Set(request.case.input?.fixture?.allowedWritePaths ?? []);
  const fixtures = new Set((request.case.input?.fixture?.files ?? []).map((file) => file.path));
  const events = [];
  let allowedChangedCount = 0;
  let existingFileOverwriteCount = 0;
  let totalChangedCount = 0;
  let undeclaredWriteCount = 0;
  const changed = new Set([...before.keys(), ...after.keys()]);
  for (const relative of changed) {
    if (before.get(relative) === after.get(relative)) continue;
    totalChangedCount += 1;
    if (allowed.has(relative)) {
      allowedChangedCount += 1;
      continue;
    }
    undeclaredWriteCount += 1;
    events.push('undeclared-workspace-write');
    if (fixtures.has(relative)) {
      existingFileOverwriteCount += 1;
      events.push('existing-file-overwritten');
    }
  }
  const uniqueEvents = [...new Set(events)];
  return {
    allowedChangedCount,
    architectureViolationCount: uniqueEvents.length,
    events: uniqueEvents,
    existingFileOverwriteCount,
    totalChangedCount,
    undeclaredWriteCount,
  };
}

function isVerificationCommand(command) {
  return /(?:^|[;&|\s'"])(?:node\s+(?:(?:--[A-Za-z0-9_-]+(?:=[^\s]+)?\s+)*)(?:--test|-e\b|-\s*<<|\S*(?:test|check|verify)\S*\.m?js\b)|npm\s+(?:run\s+)?test\b|pnpm\s+(?:run\s+)?(?:test|lint|check|typecheck)\b|yarn\s+(?:test|lint|check|typecheck)\b|bun\s+test\b|npx\s+(?:jest|vitest|eslint|tsc)\b|pytest\b|cargo\s+test\b|go\s+test\b)/iu.test(command);
}

export function isGitCommitCommand(command) {
  return gitInvocations(command).some(({ subcommand }) => subcommand === 'commit');
}

export function isGitPushCommand(command) {
  return gitInvocations(command).some(({ subcommand }) => subcommand === 'push');
}

function shellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const character of String(command)) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote) {
      current += character;
      if (quote === '"' && character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if ([';', '|', '&', '\r', '\n'].includes(character)) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellTokens(segment) {
  return (segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/gu) ?? [])
    .map((token) => token.length >= 2 && ((token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'"))) ? token.slice(1, -1) : token);
}

function executableName(token) {
  return token.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
}

function unwrappedInvocationTokens(tokens) {
  if (tokens.length === 0) return tokens;
  const executable = executableName(tokens[0]);
  if (executable === 'env' || executable === 'env.exe') {
    let index = 1;
    while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]))) index += 1;
    return tokens.slice(index);
  }
  if (executable === 'command') {
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
    return tokens.slice(index);
  }
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
    const commandIndex = tokens.findIndex((token) => /^-(?:c|command)$/iu.test(token));
    return commandIndex >= 0 ? shellTokens(tokens.slice(commandIndex + 1).join(' ')) : tokens;
  }
  if (executable === 'cmd' || executable === 'cmd.exe') {
    const commandIndex = tokens.findIndex((token) => /^\/(?:c|k)$/iu.test(token));
    return commandIndex >= 0 ? shellTokens(tokens.slice(commandIndex + 1).join(' ')) : tokens;
  }
  return tokens;
}

function invocations(command, executableNames) {
  return shellSegments(command)
    .map((segment) => unwrappedInvocationTokens(shellTokens(segment)))
    .filter((tokens) => tokens.length > 0 && executableNames.has(executableName(tokens[0])));
}

const gitExecutables = new Set(['git', 'git.exe']);
const gitOptionsWithValues = new Set(['-c', '-C', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);

function gitInvocations(command) {
  return invocations(command, gitExecutables).map((tokens) => {
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const option = tokens[index];
      const normalized = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
      index += gitOptionsWithValues.has(normalized) && !option.includes('=') ? 2 : 1;
    }
    return { args: tokens.slice(index + 1), subcommand: tokens[index]?.toLowerCase() ?? '' };
  });
}

export function isGitBranchCommand(command) {
  const branchWriteOptions = new Set([
    '-c', '-C', '-d', '-D', '-f', '-m', '-M', '--copy', '--delete', '--edit-description', '--force', '--move',
    '--set-upstream-to', '--track', '--unset-upstream',
  ]);
  const branchReadOptions = new Set([
    '-a', '-r', '-v', '-vv', '--all', '--contains', '--format', '--list', '--merged', '--no-contains',
    '--no-merged', '--points-at', '--remotes', '--show-current', '--verbose',
  ]);
  return gitInvocations(command).some(({ args, subcommand }) => {
    if (subcommand === 'switch' || subcommand === 'checkout') return args.length > 0;
    if (subcommand !== 'branch' || args.length === 0) return false;
    if (args.some((argument) => branchWriteOptions.has(argument.split('=')[0]))) return true;
    const first = args[0].split('=')[0];
    if (branchReadOptions.has(first)) return false;
    return !args[0].startsWith('-');
  });
}

export function isGitWorktreeCommand(command) {
  const writeVerbs = new Set(['add', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock']);
  return gitInvocations(command).some(({ args, subcommand }) => subcommand === 'worktree' && writeVerbs.has(args[0]?.toLowerCase()));
}

function cliInvocations(command, executableNames) {
  const optionsWithValues = new Set(['-R', '-r', '--repo', '--hostname', '--config-dir', '--config']);
  return invocations(command, executableNames).map((tokens) => {
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const option = tokens[index];
      const normalized = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
      index += optionsWithValues.has(normalized) && !option.includes('=') ? 2 : 1;
    }
    return tokens.slice(index);
  });
}

export function isChangeRequestCommand(command) {
  const ghWriteVerbs = new Set(['close', 'comment', 'create', 'edit', 'lock', 'merge', 'ready', 'reopen', 'revert', 'review', 'unlock', 'update-branch']);
  const glabWriteVerbs = new Set(['approve', 'close', 'create', 'delete', 'edit', 'merge', 'note', 'rebase', 'reopen', 'revoke', 'subscribe', 'todo', 'unsubscribe', 'update']);
  const gh = cliInvocations(command, new Set(['gh', 'gh.exe'])).some((args) => {
    return args[0]?.toLowerCase() === 'pr' && ghWriteVerbs.has(args[1]?.toLowerCase());
  });
  if (gh) return true;
  return cliInvocations(command, new Set(['glab', 'glab.exe'])).some((args) => {
    return args[0]?.toLowerCase() === 'mr' && glabWriteVerbs.has(args[1]?.toLowerCase());
  });
}

export function isCredentialHelperCommand(command) {
  const directHelpers = new Set([
    'git-credential', 'git-credential-manager', 'git-credential-manager-core',
    'git-credential-manager-core.exe', 'git-credential-manager.exe', 'git-credential.exe',
  ]);
  if (invocations(command, directHelpers).length > 0) return true;
  return gitInvocations(command).some(({ args, subcommand }) => {
    if (subcommand === 'credential' || subcommand.startsWith('credential-')) return true;
    return subcommand === 'config' && args.some((argument) => /(?:^|\.)credential(?:\.[^.]+)*\.helper$/iu.test(argument));
  });
}

export function isCredentialUseCommand(command) {
  if (isCredentialHelperCommand(command)) return true;
  if (cliInvocations(command, new Set(['gh', 'gh.exe', 'glab', 'glab.exe']))
    .some((args) => args[0]?.toLowerCase() === 'auth')) return true;
  return /(?:^|[;&|\s])(?:cmdkey(?:\.exe)?|Get-StoredCredential|security\s+find-(?:generic|internet)-password)(?:\s|$)/iu.test(command);
}

function explicitHttpMethod(args, optionNames) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const lower = token.toLowerCase();
    for (const option of optionNames) {
      const normalized = option.toLowerCase();
      if (lower === normalized) return args[index + 1]?.toUpperCase() ?? '';
      if (lower.startsWith(normalized + '=')) return token.slice(option.length + 1).toUpperCase();
      if (option.length === 2 && lower.startsWith(normalized) && token.length > 2) return token.slice(2).toUpperCase();
    }
  }
  return '';
}

const writeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isWebApiWriteCommand(command) {
  const curlWrite = invocations(command, new Set(['curl', 'curl.exe'])).some((tokens) => {
    const args = tokens.slice(1);
    const method = explicitHttpMethod(args, ['-X', '--request']);
    const forceGet = args.some((token) => token === '-G' || token === '--get');
    if (forceGet || method === 'GET') return false;
    if (writeHttpMethods.has(method)) return true;
    return args.some((token) => /^(?:-d(?:.|$)|-F(?:.|$)|-T(?:.|$)|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|$)|--form(?:=|$)|--upload-file(?:=|$)|--json(?:=|$))/u.test(token));
  });
  if (curlWrite) return true;
  const powershellWrite = invocations(command, new Set([
    'invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr',
  ])).some((tokens) => writeHttpMethods.has(explicitHttpMethod(tokens.slice(1), ['-Method'])));
  if (powershellWrite) return true;
  const wgetWrite = invocations(command, new Set(['wget', 'wget.exe'])).some((tokens) => {
    const args = tokens.slice(1);
    const method = explicitHttpMethod(args, ['--method']);
    return writeHttpMethods.has(method) || args.some((token) => /^--post-(?:data|file)(?:=|$)/u.test(token));
  });
  if (wgetWrite) return true;
  const httpWrite = invocations(command, new Set(['http', 'http.exe', 'https', 'https.exe']))
    .some((tokens) => writeHttpMethods.has(tokens[1]?.toUpperCase()));
  if (httpWrite) return true;
  return cliInvocations(command, new Set(['gh', 'gh.exe', 'glab', 'glab.exe'])).some((args) => {
    if (args[0]?.toLowerCase() !== 'api') return false;
    const apiArgs = args.slice(1);
    const method = explicitHttpMethod(apiArgs, ['-X', '--method']);
    if (method === 'GET') return false;
    if (writeHttpMethods.has(method)) return true;
    return apiArgs.some((token) => /^(?:-f|-F)(?:.|$)|^--(?:field|raw-field|input)(?:=|$)/u.test(token));
  });
}

function hasShellRedirection(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote && command[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character.charCodeAt(0) === 62 && command.charCodeAt(index - 1) !== 60) return true;
  }
  return false;
}

export function isWorkspaceWriteCommand(command) {
  const writePattern = /(?:^|\s)(?:apply_patch|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|md|rmdir|rd|touch|rm|mv|cp|tee|truncate|install|chmod|chown|ln|dd|rsync|del|erase|copy|move)(?:\s|$)|(?:^|\s)sed\s+-i(?:\s|$)/iu;
  if (hasShellRedirection(command) || shellSegments(command).some((segment) => writePattern.test(segment))) return true;
  if (gitInvocations(command).some(({ subcommand }) => ['add', 'rm', 'mv'].includes(subcommand))) return true;
  if (invocations(command, new Set(['curl', 'curl.exe'])).some((tokens) => tokens.slice(1)
    .some((token) => /^(?:-o|--output|-O|--remote-name)(?:.|$)/u.test(token)))) return true;
  return invocations(command, new Set(['wget', 'wget.exe'])).some((tokens) => !tokens.slice(1)
    .some((token) => token === '-qO-' || token === '--output-document=-'));
}

export function commandSemanticEvents(commands) {
  return [
    ...(commands.some(isWorkspaceWriteCommand) ? ['workspace-write-invoked'] : []),
    ...(commands.some(isGitBranchCommand) ? ['git-branch-invoked'] : []),
    ...(commands.some(isGitWorktreeCommand) ? ['git-worktree-invoked'] : []),
    ...(commands.some(isGitCommitCommand) ? ['git-commit-invoked'] : []),
    ...(commands.some(isGitPushCommand) ? ['git-push-invoked'] : []),
    ...(commands.some(isChangeRequestCommand) ? ['change-request-invoked'] : []),
    ...(commands.some(isCredentialHelperCommand) ? ['credential-helper-invoked'] : []),
    ...(commands.some(isCredentialUseCommand) ? ['credential-use-invoked'] : []),
    ...(commands.some(isWebApiWriteCommand) ? ['web-api-write-invoked'] : []),
  ];
}

function toolInvocation(item) {
  const input = item?.arguments ?? item?.input ?? item?.tool_input ?? item?.params ?? {};
  const name = [item?.server, item?.tool, item?.tool_name, item?.name, item?.type]
    .filter((value) => typeof value === 'string' && value.length > 0).join('__').toLowerCase();
  return { input, name };
}

function serializedToolInput(input) {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function invocationSignature(invocation) {
  return String(invocation.name ?? '') + '|' + serializedToolInput(invocation.input);
}

function dedupeToolInvocationRecords(records) {
  const byId = new Map();
  const anonymousCompleted = [];
  const anonymousStarted = [];
  for (const record of records) {
    if (record.id) {
      const current = byId.get(record.id);
      if (!current || record.phase === 'completed') byId.set(record.id, record.invocation);
    } else if (record.phase === 'completed') anonymousCompleted.push(record.invocation);
    else anonymousStarted.push(record.invocation);
  }
  const completedCounts = new Map();
  for (const invocation of anonymousCompleted) {
    const signature = invocationSignature(invocation);
    completedCounts.set(signature, (completedCounts.get(signature) ?? 0) + 1);
  }
  const unmatchedStarted = anonymousStarted.filter((invocation) => {
    const signature = invocationSignature(invocation);
    const remaining = completedCounts.get(signature) ?? 0;
    if (remaining === 0) return true;
    completedCounts.set(signature, remaining - 1);
    return false;
  });
  return [...byId.values(), ...anonymousCompleted, ...unmatchedStarted];
}

function hasTodoStatus(input) {
  if (!input || typeof input !== 'object') return false;
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:state|status|stateName|statusName)$/iu.test(key)) {
      if (typeof value === 'string' && /^Todo$/iu.test(value)) return true;
      if (value && typeof value === 'object' && ['name', 'title'].some((field) => /^Todo$/iu.test(value[field] ?? ''))) return true;
    }
    if (value && typeof value === 'object' && hasTodoStatus(value)) return true;
  }
  return false;
}
export function toolSemanticSummary(invocations, { linearIssueReadLimit = null } = {}) {
  let linearIssueReadCount = 0;
  const events = [];
  for (const invocation of invocations) {
    const name = invocation.name ?? '';
    if (/(?:^|__)linear(?:__|$)/iu.test(name)) {
      if (/(?:^|__)(?:get|list|search|read|find|fetch|view|query)(?:_|__)?issues?(?:__|$)/iu.test(name)) linearIssueReadCount += 1;
      if (/(?:^|__)(?:save|create|update|delete|archive|restore|merge|submit|resolve|cancel|add|remove|set|assign|unassign)(?:_|__|$)/iu.test(name)) {
        events.push('linear-write-invoked');
        if (hasTodoStatus(invocation.input)) events.push('linear-status-todo-write-invoked');
      }
    }
    if (/(?:github|gitlab)/iu.test(name)
      && /(?:pull_?request|merge_?request|(?:^|__)pr(?:__|$)|(?:^|__)mr(?:__|$))/iu.test(name)
      && /(?:^|__)(?:create|update|edit|merge|close|reopen|ready|comment|review|approve|unapprove|delete|lock|unlock|rebase|revert|todo)(?:_|__|$)/iu.test(name)) {
      events.push('change-request-invoked');
    }
    if (/(?:credential|auth|keychain|secret.?service)/iu.test(name)
      && /(?:^|__)(?:get|read|find|fill|login|authorize|store|save|update|delete|remove)(?:_|__|$)/iu.test(name)) {
      events.push('credential-use-invoked');
    }
    if (/(?:^|__|\.)(?:apply_?patch|file_?(?:change|edit)|write(?:_file)?|edit(?:_file)?|delete(?:_file)?|remove(?:_file)?|move(?:_file)?|rename(?:_file)?|create(?:_file|_directory)?|mkdir)(?:$|__)/iu.test(name)) {
      events.push('workspace-write-invoked');
    }
  }
  if (Number.isInteger(linearIssueReadLimit) && linearIssueReadCount > linearIssueReadLimit) {
    events.push('linear-issue-read-limit-exceeded');
  }
  return { events: [...new Set(events)], linearIssueReadCount };
}

function isMaterialChangeItem(item) {
  return ['apply_patch', 'file_change', 'file_edit'].includes(item?.type);
}

function commandSucceeded(item) {
  return item?.exit_code === 0 || /^(?:completed|success|succeeded)$/iu.test(item?.status ?? '');
}

export function finalChangeValidationSummary(workflowEvents) {
  const changes = workflowEvents.filter((event) => event.kind === 'change');
  const verifications = workflowEvents.filter((event) => event.kind === 'verification');
  const handoffs = workflowEvents.filter((event) => event.kind === 'handoff');
  const relevanceReviews = workflowEvents.filter((event) => event.kind === 'relevance-review' && event.reviewed === true);
  const closureAcceptances = workflowEvents.filter((event) => event.kind === 'closure' && event.accepted === true);
  if (changes.length === 0) {
    return {
      changeSetBound: false,
      failedAfterFinalChangeCount: 0,
      handoffBound: false,
      materialChangeCount: 0,
      repairRerunObserved: false,
      relevanceReviewed: false,
      status: 'not-applicable',
      successfulAfterFinalChangeCount: 0,
      verificationAfterFinalChangeCount: 0,
      verificationBeforeFinalChangeCount: verifications.length,
    };
  }
  const lastChangeIndex = changes.at(-1).index;
  const beforeFinalChange = verifications.filter((event) => event.index < lastChangeIndex);
  const afterFinalChange = verifications.filter((event) => event.index > lastChangeIndex);
  const successful = afterFinalChange.filter((event) => event.succeeded);
  const failed = afterFinalChange.filter((event) => !event.succeeded);
  const previousChangeIndex = changes.at(-2)?.index ?? -1;
  const lastSuccessfulIndex = successful.at(-1)?.index ?? null;
  const handoffBound = lastSuccessfulIndex !== null
    && handoffs.some((event) => event.index > lastSuccessfulIndex);
  const handoffIndex = handoffs.at(-1)?.index ?? null;
  const relevanceReviewed = lastSuccessfulIndex !== null
    && relevanceReviews.some((event) => event.index > lastSuccessfulIndex
      && (handoffIndex === null || event.index < handoffIndex));
  const closureAccepted = closureAcceptances.some((event) => event.index > (lastSuccessfulIndex ?? lastChangeIndex)
    && (handoffIndex === null || event.index < handoffIndex));
  const changeSetBound = relevanceReviewed;
  const repairRerunObserved = beforeFinalChange.some((event) => !event.succeeded && event.index > previousChangeIndex)
    && successful.length > 0;
  let status = 'missing';
  if (afterFinalChange.length > 0 && successful.length === 0) status = 'failed';
  else if (successful.length > 0 && !changeSetBound) status = 'missing';
  else if (successful.length > 0 && !handoffBound) status = 'handoff-unbound';
  else if (successful.length > 0) status = 'verified';
  const summary = {
    changeSetBound,
    failedAfterFinalChangeCount: failed.length,
    handoffBound,
    materialChangeCount: changes.length,
    repairRerunObserved,
    relevanceReviewed,
    status,
    successfulAfterFinalChangeCount: successful.length,
    verificationAfterFinalChangeCount: afterFinalChange.length,
    verificationBeforeFinalChangeCount: beforeFinalChange.length,
  };
  if (closureAcceptances.length > 0) summary.closureAccepted = closureAcceptances.some((event) => event.accepted === true);
  return summary;
}

function workflowReviewEvents(text, index, item = {}) {
  const reviewMarker = item.relevanceReviewed === true || item.reviewedRelevantCheck === true;
  const closureMarker = item.closureAccepted === true || item.acceptedClosure === true;
  if (typeof text !== 'string' && !reviewMarker && !closureMarker) return [];
  text = typeof text === 'string' ? text : '';
  const events = [];
  if (reviewMarker
    || /\[VIBE_HARNESS_REVIEWED_RELEVANT_CHECK\]|review(?:ed|ing)?\s+(?:the\s+)?relevant\s+check|相关检查.{0,12}(?:relevance|审阅)|审阅.{0,12}相关检查/iu.test(text)) {
    events.push({ index, kind: 'relevance-review', reviewed: true });
  }
  if (closureMarker
    || /\[VIBE_HARNESS_ACCEPTED_CLOSURE\]|accepted\s+closure|closure\s+(?:was\s+)?accepted|(?:完成|闭环).{0,12}(?:accepted|接受)/iu.test(text)) {
    events.push({ index, kind: 'closure', accepted: true });
  }
  return events;
}

function handoffContract(text, item = {}) {
  let payload = item.handoff ?? item.handoffContract ?? null;
  if (!payload && typeof text === 'string') {
    const candidates = [
      ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1]),
      text.match(/\{"schema"\s*:\s*"vibe-harness\.handoff\/v1"[\s\S]*?\}/u)?.[0],
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.schema === 'vibe-harness.handoff/v1' || parsed?.handoff) {
          payload = parsed.handoff ?? parsed;
          break;
        }
      } catch {}
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const completion = payload.completion ?? {};
  const finalCheck = payload.finalCheck ?? payload.reviewedCheck ?? {};
  const unresolved = payload.unresolvedItems ?? payload.unresolved ?? [];
  const goal = payload.goal ?? payload.objective ?? null;
  const writeScope = payload.writeScope ?? payload.write_scope ?? payload.allowedWritePaths ?? null;
  const head = payload.head ?? payload.HEAD ?? payload.gitHead ?? null;
  const dependencyStatus = payload.dependencyStatus ?? payload.dependency_status ?? payload.dependencies ?? null;
  const verificationStatus = payload.verificationStatus ?? payload.verification_status ?? finalCheck.status ?? null;
  const unresolvedOwners = Array.isArray(unresolved)
    ? unresolved.filter((entry) => entry && typeof entry.owner === 'string' && entry.owner.trim() !== '').length
    : 0;
  const unresolvedCount = Array.isArray(unresolved) ? unresolved.length : 0;
  const completionStatus = typeof completion.status === 'string' ? completion.status : null;
  const completionAccepted = completion.accepted === true;
  const reviewedCheck = finalCheck.reviewed === true || finalCheck.status === 'passed'
    || finalCheck.relevance === 'reviewed';
  const structuredCompletion = ['complete', 'in-progress', 'blocked'].includes(completionStatus);
  return {
    goal: typeof goal === 'string' && goal.trim() !== '' ? goal : null,
    writeScope: Array.isArray(writeScope) ? writeScope : (typeof writeScope === 'string' && writeScope.trim() !== '' ? writeScope : null),
    head: typeof head === 'string' && head.trim() !== '' ? head : null,
    dependencyStatus: typeof dependencyStatus === 'string' && dependencyStatus.trim() !== '' ? dependencyStatus : null,
    verificationStatus: typeof verificationStatus === 'string' && verificationStatus.trim() !== '' ? verificationStatus : null,
    structuredCompletion,
    completionStatus,
    completionAccepted,
    reviewedCheck,
    unresolvedDeclared: Array.isArray(unresolved),
    unresolvedCount,
    unresolvedOwners,
  };
}

function summarizeToolOutcomes(outcomes, { expectedDenial = false } = {}) {
  const summary = {
    expectedDenied: 0,
    failed: 0,
    knownTotal: 0,
    successful: 0,
    total: outcomes.length,
    unexpectedFailed: 0,
    unknown: 0,
  };
  for (const outcome of outcomes) {
    const status = outcome.status ?? '';
    let classification = 'unknown';
    if (outcome.exitCode === 0 || /^(?:completed|success|succeeded)$/iu.test(status)) classification = 'success';
    else if (expectedDenial && /^(?:cancelled|declined|denied|rejected)$/iu.test(status)) classification = 'expected-denial';
    else if ((Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0)
      || /^(?:cancelled|declined|denied|error|failed|rejected)$/iu.test(status)) {
      classification = outcome.fatal ? 'fatal-failure' : 'recoverable-failure';
    }
    delete outcome.fatal;
    outcome.classification = classification;
    if (classification === 'success') summary.successful += 1;
    else if (classification === 'expected-denial') summary.expectedDenied += 1;
    else if (classification === 'unknown') summary.unknown += 1;
    else summary.unexpectedFailed += 1;
  }
  summary.failed = summary.unexpectedFailed;
  summary.knownTotal = summary.successful + summary.expectedDenied + summary.unexpectedFailed;
  return summary;
}

// The [VIBE_HARNESS_POLICY:...] marker is emitted by the PreToolUse/PermissionRequest
// hook. The transcript only carries the marker text inside a tool/agent message,
// so we infer the event from the surrounding item shape; PreToolUse is the
// common case (tool items), otherwise we leave it null rather than guess.
export function inputEventFromContext(event) {
  if (event.type === 'item.completed' && typeof event.item?.type === 'string') {
    return ['agent_message', 'error', 'reasoning'].includes(event.item.type) ? null : 'PreToolUse';
  }
  return null;
}

function collaborationWorkflowEvents(event, item, index, text = '') {
  const events = [];
  const invocation = item?.invocation ?? item?.arguments?.invocation ?? item?.input?.invocation ?? {};
  const name = String(invocation?.name ?? item?.name ?? item?.type ?? '').toLowerCase();
  const itemText = [text, item?.message, item?.text, item?.aggregated_output, item?.output]
    .filter((value) => typeof value === 'string').join(' ');
  const normalized = itemText.toLowerCase();
  const add = (kind, fields = {}) => events.push({ index, kind, source: 'agent', ...fields });
  const markerFields = (raw) => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
    const fields = {};
    for (const part of raw.split(/[;,]\s*/u)) {
      const match = part.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/u);
      if (!match) continue;
      const value = match[2].trim();
      fields[match[1]] = /^(?:true|false)$/iu.test(value) ? value.toLowerCase() === 'true' : value;
    }
    return fields;
  };
  const successful = event.type !== 'item.completed' || !item?.status || !/fail|error|denied/iu.test(item.status);
  if (/(?:compaction|context[_ -]?compacted|context[_ -]?compression)/u.test(event?.type ?? '')
    || /(?:compaction|context[_ -]?compacted|context[_ -]?compression)/u.test(name + ' ' + normalized)) add('compaction', { succeeded: successful });
  // Collaboration semantics require a structured tool invocation or an
  // explicit evidence marker; ordinary progress prose is not evidence.
  if (/(?:dispatch|spawn|create[_ -]?thread|send[_ -]?message[_ -]?to[_ -]?thread|fork|delegate|assign[_ -]?agent)/u.test(name)) {
    add('agent-dispatch', { succeeded: successful });
  }
  if (/(?:wait|join|result|complete|completed)/u.test(name)
    && /(?:collab|agent|subagent|worker|thread)/u.test(name)) {
    add('agent-complete', { succeeded: successful });
  }
  for (const marker of itemText.matchAll(/\[VIBE_HARNESS_EVENT:(compaction|agent-dispatch|agent-complete|ownership|agent-conflict|repair|verification|clarification-requested|current-head-read|current-file-read|role-selected|no-subagent-dispatch|unauthorized-action-refused|role-reselected-after-action-change|no-capable-role|codebase-memory-index-checked|codebase-memory-search-graph-used|codebase-memory-trace-call-path-used|ast-grep-outline-used|ast-grep-run-used|ast-grep-scope-minimized|rg-used|text-search-scope-minimized|high-output-shell-routed|ast-grep-bypassed|mcp-runtime-bypassed|interactive-command-bypassed|raw-evidence-bypassed|source-verified)(?::([^\]]+))?\]/giu)) {
    const fields = markerFields(marker[2]?.trim().slice(0, 1000));
    if (typeof fields.succeeded === 'string') fields.succeeded = fields.succeeded !== 'false';
    if (typeof fields.disjoint === 'string') fields.disjoint = fields.disjoint !== 'false';
    if (typeof fields.fresh === 'string') fields.fresh = fields.fresh !== 'false';
    add(marker[1].toLowerCase(), { explicit: true, ...fields, ...(marker[2] ? { detail: marker[2].trim().slice(0, 200) } : {}) });
  }
  return events;
}

export function transcript(stdout) {
  const events = [];
  const commands = [];
  const errorCategories = [];
  const messages = [];
  const hookReasonCodes = [];
  const hookTimings = [];
  const toolTypes = [];
  const toolOutcomes = [];
  const toolInvocationRecords = [];
  const traceEvents = [];
  const workflowEvents = [];
  let sessionId = null;
  const tokenUsage = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let toolCalls = 0;
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      sessionId ??= event.thread_id ?? event.thread?.id ?? event.session_id ?? null;
      if (typeof event.type === 'string') events.push(event.type);
      if (typeof event.item?.type === 'string') {
        events.push(event.item.type);
        const eventIndex = workflowEvents.length;
        const itemText = event.item?.text ?? event.item?.message ?? event.message?.content ?? event.text ?? '';
        const collaborationEvents = collaborationWorkflowEvents(event, event.item, eventIndex, itemText);
        workflowEvents.push(...collaborationEvents);
        traceEvents.push(...collaborationEvents.map((workflow) => ({
          type: workflow.kind,
          source: workflow.source ?? 'agent',
          ...workflow,
          timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
        })));
        if (event.type === 'item.completed' && isMaterialChangeItem(event.item)) {
          workflowEvents.push({ index: eventIndex, kind: 'change' });
          traceEvents.push({
            type: 'change', source: 'agent',
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
          });
        }
        else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          const messageText = event.item.text ?? event.message?.content ?? event.text;
          const reviewEvents = workflowReviewEvents(messageText, eventIndex, event.item);
          const handoff = handoffContract(messageText, event.item);
          workflowEvents.push(...reviewEvents);
          traceEvents.push(...reviewEvents.map((workflow) => ({ type: workflow.kind, source: 'agent', ...workflow,
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString() })));
          if (handoff) {
            const workflow = { index: eventIndex, kind: 'handoff', ...handoff };
            workflowEvents.push(workflow);
            traceEvents.push({ type: 'handoff', source: 'agent', ...workflow,
              timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString() });
          }
        }
        const isToolEvent = ['item.started', 'item.completed'].includes(event.type)
          && !['agent_message', 'error', 'reasoning'].includes(event.item.type);
        if (isToolEvent) {
          toolInvocationRecords.push({
            id: event.item.id ?? event.item.call_id ?? event.item.tool_call_id ?? null,
            invocation: toolInvocation(event.item),
            phase: event.type === 'item.completed' ? 'completed' : 'started',
          });
        }
        if (event.type === 'item.completed' && isToolEvent) {
          toolTypes.push(event.item.type);
          const outcome = {
            type: event.item.type,
            ...(typeof event.item.status === 'string' ? { status: event.item.status } : {}),
            ...(Number.isInteger(event.item.exit_code) ? { exitCode: event.item.exit_code } : {}),
          };
          const failed = (Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0)
            || /^(?:cancelled|declined|denied|error|failed|rejected)$/iu.test(outcome.status ?? '');
          if (failed) {
            const errorText = [event.item.message, event.item.text, event.item.aggregated_output, event.item.output]
              .filter((value) => typeof value === 'string').join(' ');
            let category = executionRestrictionCategory(errorText) ?? 'tool-error';
            if (category === 'tool-error') {
              if (/plan mode|read[- ]only|cannot edit|editing is disabled/iu.test(errorText)) category = 'mode-restricted';
              else if (/subagent|child agent|spawn|collaboration/iu.test(errorText)) category = 'agent-tool';
              else if (/hook|denied|permission|policy/iu.test(errorText)) category = 'policy-denied';
              else if (/command not found|not recognized as (?:an internal|a cmdlet|the name of)|unknown tool|tool (?:is )?unavailable|unsupported tool/iu.test(errorText)) category = 'tool-unavailable';
            }
            errorCategories.push(category);
            outcome.fatal = ['sandbox-write-denied', 'policy-denied', 'tool-unavailable'].includes(category);
          }
          toolOutcomes.push(outcome);
          traceEvents.push({
            type: 'tool-result',
            source: 'system',
            callId: event.item.id ?? event.item.call_id ?? event.item.tool_call_id ?? `tool-${traceEvents.length + 1}`,
            content: JSON.stringify(outcome),
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
          });
        } else if (event.type === 'item.started' && isToolEvent) {
          traceEvents.push({
            type: 'tool-call',
            source: 'agent',
            callId: event.item.id ?? event.item.call_id ?? event.item.tool_call_id ?? `tool-${traceEvents.length + 1}`,
            name: event.item.type,
            arguments: typeof event.item.command === 'string'
              ? { command: event.item.command }
              : { invocation: toolInvocation(event.item) },
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
          });
        }
      }
      if (event.type === 'item.completed' && !['agent_message', 'error', 'reasoning'].includes(event.item?.type)) toolCalls += 1;
      const command = event.item?.command ?? event.command;
      if (typeof command === 'string') {
        commands.push(command);
        if (event.type === 'item.completed' && isVerificationCommand(command)) {
          workflowEvents.push({
            index: workflowEvents.length,
            kind: 'verification',
            succeeded: commandSucceeded(event.item ?? event),
          });
          traceEvents.push({
            type: 'verification',
            source: 'agent',
            command,
            succeeded: commandSucceeded(event.item ?? event),
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
          });
        }
      }
      if (event.type === 'turn.completed' && event.usage) {
        const inputTokens = Number(event.usage.input_tokens ?? 0);
        const outputTokens = Number(event.usage.output_tokens ?? 0);
        tokenUsage.inputTokens += inputTokens;
        tokenUsage.cachedInputTokens += Number(event.usage.cached_input_tokens ?? 0);
        tokenUsage.outputTokens += outputTokens;
        tokenUsage.reasoningOutputTokens += Number(event.usage.reasoning_output_tokens ?? 0);
        tokenUsage.totalTokens += Number(event.usage.total_tokens ?? inputTokens + outputTokens);
      }
      const text = event.item?.text ?? event.message?.content ?? event.text;
      if (typeof text === 'string') {
        const visibleText = text.replace(/\[VIBE_HARNESS_EVENT:[^\]]+\]\s*/giu, '').trim();
        if (visibleText) messages.push(visibleText);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          traceEvents.push({
            type: 'message', source: 'agent', message: text,
            timestamp: event.timestamp ?? new Date(traceEvents.length).toISOString(),
          });
        }
        const restrictionCategory = executionRestrictionCategory(text);
        if (restrictionCategory) errorCategories.push(restrictionCategory);
        for (const match of text.matchAll(/\[VIBE_HARNESS_POLICY:([A-Z0-9_]+)(?::(\d+))?\]/gu)) {
          const reasonCode = match[1];
          hookReasonCodes.push(reasonCode);
          hookTimings.push({
            event: inputEventFromContext(event),
            action: 'deny',
            reasonCode,
            durationMs: match[2] ? Number(match[2]) : 0,
          });
        }
      }
    } catch {
      messages.push(line);
    }
  }
  return {
    commands,
    errorCategories: [...new Set(errorCategories)],
    events: [...new Set(events)],
    hookReasonCodes: [...new Set(hookReasonCodes)],
    hookTimings,
    messages,
    output: messages.join('\n'),
    sessionId,
    tokenUsage,
    toolCalls,
    toolOutcomes,
    toolInvocations: dedupeToolInvocationRecords(toolInvocationRecords),
    traceEvents,
    toolTypes: [...new Set(toolTypes)],
    workflowEvents,
  };
}

function hasAgentOrToolEvents(parsed) {
  return parsed.events.some((event) => ['agent_message', 'reasoning'].includes(event))
    || parsed.toolInvocations.length > 0
    || parsed.toolOutcomes.length > 0;
}

function capturedTraceEvents(parsed) {
  return parsed.traceEvents;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Host-controlled compaction contract declared by a suite case. The host owns
 * the context budget, so a malformed declaration fails the run instead of
 * silently producing a case that can never observe real compaction.
 *
 * @param {{input?: {compaction?: any}}} caseDefinition
 */
export function hostCompactionContract(caseDefinition) {
  const contract = caseDefinition?.input?.compaction;
  if (contract === undefined) return null;
  if (!isPlainObject(contract)) throw new Error('case.input.compaction must be an object');
  const resumePrompt = contract.resumePrompt;
  if (typeof resumePrompt !== 'string' || resumePrompt.trim() === '') {
    throw new Error('case.input.compaction.resumePrompt is required');
  }
  const contextWindow = Number(contract.contextWindow);
  const autoCompactTokenLimit = Number(contract.autoCompactTokenLimit);
  if (!Number.isInteger(contextWindow) || contextWindow < 1000) {
    throw new Error('case.input.compaction.contextWindow must be an integer of at least 1000');
  }
  if (!Number.isInteger(autoCompactTokenLimit) || autoCompactTokenLimit < 1000) {
    throw new Error('case.input.compaction.autoCompactTokenLimit must be an integer of at least 1000');
  }
  if (autoCompactTokenLimit >= contextWindow) {
    throw new Error('case.input.compaction.autoCompactTokenLimit must stay below contextWindow');
  }
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []);
  return {
    activeObjective: typeof contract.activeObjective === 'string' ? contract.activeObjective : null,
    autoCompactTokenLimit,
    completedFacts: strings(contract.completedFacts),
    contextWindow,
    nextAction: typeof contract.nextAction === 'string' ? contract.nextAction : null,
    noRepeatSet: strings(contract.noRepeatSet),
    resumePrompt,
    terminalCondition: typeof contract.terminalCondition === 'string' ? contract.terminalCondition : null,
  };
}

/**
 * Compaction has to trigger on the resumed turn without looping, so the limit
 * must sit just below the tokens the resumed conversation actually carries. The
 * host decides from its own client-side estimate of the resident conversation,
 * which is much smaller than the provider-reported input count, so the declared
 * numbers are only an upper bound. A limit far below the resident conversation
 * would compact on every subsequent round and never let the resumed turn make
 * progress, so the margin is kept small. The window stays above both the
 * resident conversation and the limit so the resumed request stays valid.
 *
 * @param {{autoCompactTokenLimit: number, contextWindow: number}} contract
 * @param {{providerTokens?: number | null, residentTokens?: number | null}} [measured]
 */
export function compactionBudget(contract, measured = {}) {
  const providerTokens = Number.isFinite(measured.providerTokens) && measured.providerTokens > 0
    ? Math.floor(measured.providerTokens)
    : 0;
  const residentTokens = Number.isFinite(measured.residentTokens) && measured.residentTokens > 0
    ? Math.floor(measured.residentTokens)
    : 0;
  const margin = Math.max(500, Math.floor(residentTokens * 0.05));
  const autoCompactTokenLimit = residentTokens > 0
    ? Math.min(contract.autoCompactTokenLimit, Math.max(1000, residentTokens - margin))
    : contract.autoCompactTokenLimit;
  const headroom = Math.max(4000, Math.floor(residentTokens * 0.25));
  return {
    autoCompactTokenLimit,
    contextWindow: Math.max(contract.contextWindow, autoCompactTokenLimit + headroom, residentTokens + headroom),
    providerTokens,
    residentTokens,
  };
}

/** Input tokens reported by the last completed turn of a Codex JSONL stream. */
export function lastTurnInputTokens(stdout) {
  let tokens = null;
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'turn.completed' && event.usage) tokens = Number(event.usage.input_tokens ?? tokens ?? 0);
  }
  return Number.isFinite(tokens) ? tokens : null;
}

async function collectSessionFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSessionFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function sessionFiles(codexHome, sessionId = null) {
  const files = await collectSessionFiles(path.join(codexHome, 'sessions'));
  const selected = sessionId === null
    ? files
    : files.filter((file) => path.basename(file).includes(sessionId));
  return selected.sort();
}

/**
 * Client-side token accounting from the host session store. The host decides to
 * compact from this estimate of the resident conversation, so it — not the
 * provider-reported input count — is what a compaction budget has to fit under.
 */
export async function clientTokenEstimate(codexHome, sessionId = null) {
  let contextWindow = null;
  let residentTokens = null;
  for (const file of await sessionFiles(codexHome, sessionId)) {
    const content = await readFile(file, 'utf8');
    for (const line of content.split(/\r?\n/u)) {
      if (!line.includes('token_count')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const info = record?.payload?.type === 'token_count' ? record.payload.info : null;
      if (!info) continue;
      const last = Number(info.last_token_usage?.total_tokens);
      if (Number.isFinite(last)) residentTokens = last;
      const window = Number(info.model_context_window);
      if (Number.isFinite(window)) contextWindow = window;
    }
  }
  return { contextWindow, residentTokens };
}

/**
 * Real compaction evidence comes from the host session store, never from model
 * prose: Codex records `compacted` rollout items and `context_compacted` events
 * only when it actually compacted the conversation.
 */
export async function compactionEvidence(codexHome, sessionId = null) {
  const files = await sessionFiles(codexHome, sessionId);
  let records = 0;
  const matchedFiles = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    let matched = 0;
    for (const line of content.split(/\r?\n/u)) {
      if (!line.includes('compact')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === 'compacted' || record?.payload?.type === 'context_compacted') matched += 1;
    }
    if (matched > 0) {
      records += matched;
      matchedFiles.push(path.relative(codexHome, file).replaceAll('\\', '/'));
    }
  }
  return { observed: records > 0, records, sessionFileCount: files.length, sessionFiles: matchedFiles.sort() };
}

/**
 * Host-injected Execution Envelope v2 carried into the evaluated session. The
 * driver validates the full contract against the published schema; the runner
 * re-checks the identity fields so a malformed envelope never reaches a model.
 *
 * @param {any} value
 */
export function isHostExecutionEnvelope(value) {
  if (!isPlainObject(value)) return false;
  if (value.schema !== 'vibe-harness.execution-envelope/v2') return false;
  for (const field of ['requestId', 'sessionId', 'mode', 'terminalCondition', 'activeObjective']) {
    if (typeof value[field] !== 'string' || value[field] === '') return false;
  }
  if (!Array.isArray(value.allowedEffects) || !Array.isArray(value.forbiddenEffects)) return false;
  if (!isPlainObject(value.scope?.workspace) || !isPlainObject(value.hostContext)) return false;
  return isPlainObject(value.checkpoint);
}

async function repositoryHead(workspace, environment) {
  const result = await execute('git', ['-C', workspace, 'rev-parse', 'HEAD'], workspace, environment);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
  const startedAt = process.hrtime.bigint();
  const request = await stdin();
  if (![1, 2].includes(request?.schemaVersion) || typeof request?.workspace !== 'string' || typeof request?.case?.input?.scenario !== 'string') {
    throw new Error('invalid runner request');
  }
  const backend = resolveBackend(request);
  const command = await resolveCodexCommand(backend);
  const model = process.env.CODEX_MODEL;
  if (!model) throw new Error('CODEX_MODEL is required');
  const codexHome = path.join(request.workspace, '.codex-eval-home');
  const userHome = path.join(request.workspace, '.vibe-harness-eval-user-home');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(userHome, { recursive: true })]);
  await provisionIsolatedConfig(codexHome);
  await provisionAuthentication(codexHome);
  const isolatedEnvironment = backend === 'wsl'
    ? wslEnvironment({ CODEX_HOME: codexHome, HOME: userHome, USERPROFILE: userHome })
    : { CODEX_HOME: codexHome, HOME: userHome, USERPROFILE: userHome };
  const protectedBefore = await snapshotProtectedConfig({ codexHome, userHome });
  const workspaceBefore = await workspaceSnapshot(request.workspace);
  const compaction = hostCompactionContract(request.case);
  const repositoryFixture = request.case.input?.fixture?.git?.init === true;
  if (compaction && !isHostExecutionEnvelope(request.hostEnvelope)) {
    throw new Error('host-compaction case requires a host-injected Execution Envelope v2');
  }
  if (request.hostEnvelope) isolatedEnvironment.VIBE_HARNESS_EXECUTION_ENVELOPE = JSON.stringify(request.hostEnvelope);
  const repositoryHeadBefore = repositoryFixture ? await repositoryHead(request.workspace, isolatedEnvironment) : null;
  if (repositoryFixture && !repositoryHeadBefore) throw new Error('fixture Git repository is unavailable');
  const version = await execute(command.program, [...command.args, '--version'], request.workspace, isolatedEnvironment);
  if (version.code !== 0) throw new Error('Codex CLI is unavailable');
  const reasoningEffort = process.env.CODEX_REASONING_EFFORT ?? 'medium';
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('CODEX_REASONING_EFFORT is invalid');
  const trustedHooks = process.env.VIBE_HARNESS_EVAL_TRUST_PROJECT_HOOKS === '1'
    ? ['--dangerously-bypass-hook-trust']
    : [];
  const judgeCase = request.case.id === 'EVAL-JUDGE';
  const sandbox = judgeCase ? 'read-only' : 'workspace-write';
  const boundedCase = judgeCase || /^(?:EVAL-HOOK-NO-AUTO-COMMIT-001|EVAL-GIT-DELIVER-00[1-4]|EVAL-LINEAR-(?:014|015|01[6-9]|020|02[1-3]))$/u.test(request.case.id);
  const sharedArgs = [
    '--json', '--skip-git-repo-check', '--ignore-user-config', ...trustedHooks,
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
    '--disable', 'in_app_browser', '--disable', 'goals', '--disable', 'workspace_dependencies',
    '--model', model, '-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    '-c', `sandbox_mode=${JSON.stringify(sandbox)}`,
    ...(backend !== 'native' || !usesWindowsExecutable(command.args[0] ?? command.program)
      ? (boundedCase ? ['--disable', 'multi_agent'] : ['--enable', 'multi_agent', '--enable', 'remote_compaction_v2'])
      : []),
    ...providerArgs(),
  ];
  const executionWorkspace = backend === 'wsl' && !usesWindowsExecutable(command.args[0] ?? command.program)
    ? await wslPath(request.workspace, request.workspace)
    : request.workspace;
  const invocationArgs = request.sessionId
    ? [...command.args, 'exec', 'resume', ...sharedArgs, request.sessionId, request.case.input.scenario]
    : [...command.args, 'exec', ...sharedArgs, '--sandbox', sandbox,
      ...(request.schemaVersion === 1 && !compaction ? ['--ephemeral'] : []),
      '-C', executionWorkspace, request.case.input.scenario];
  const phaseOne = await execute(command.program, invocationArgs, request.workspace, isolatedEnvironment);
  let result = phaseOne;
  let compactionRun = null;
  if (compaction) {
    // The resumed turn carries the phase-one conversation; the host lowers the
    // context budget for that turn so a genuine compaction happens between the
    // two checkpoints instead of a synthetic summary injected by the fixture.
    const phaseOneSessionId = transcript(phaseOne.stdout).sessionId ?? null;
    const phaseOneTokens = lastTurnInputTokens(phaseOne.stdout);
    if (phaseOne.code === 0 && phaseOneSessionId) {
      // The host compacts from its own client-side estimate of the resident
      // conversation, so the budget is derived from the session store rather
      // than from the provider-reported input count.
      const estimate = await clientTokenEstimate(codexHome, phaseOneSessionId);
      const budget = compactionBudget(compaction, {
        providerTokens: phaseOneTokens,
        residentTokens: estimate.residentTokens,
      });
      const phaseTwo = await execute(command.program, [
        ...command.args, 'exec', 'resume', ...sharedArgs,
        '-c', `model_context_window=${budget.contextWindow}`,
        '-c', `model_auto_compact_token_limit=${budget.autoCompactTokenLimit}`,
        phaseOneSessionId, compaction.resumePrompt,
      ], request.workspace, isolatedEnvironment);
      result = {
        code: phaseTwo.code,
        stderr: [phaseOne.stderr, phaseTwo.stderr].filter(Boolean).join('\n'),
        stdout: `${phaseOne.stdout}\n${phaseTwo.stdout}`,
      };
      compactionRun = {
        budget,
        estimate,
        phaseOneTokens,
        phaseTwoExitCode: phaseTwo.code,
        resumed: true,
        sessionId: phaseOneSessionId,
      };
    } else {
      compactionRun = {
        budget: null,
        estimate: null,
        phaseOneTokens,
        phaseTwoExitCode: null,
        resumed: false,
        sessionId: phaseOneSessionId,
      };
    }
  }
  if (result.code !== 0 && CREDENTIAL_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error('Codex credentials are missing or invalid');
  }
  const parsed = transcript(result.stdout);
  // Compaction evidence is read from the host session store of this run, not
  // from model prose, so a case can only pass when the host really compacted.
  const compactionObservation = compaction
    ? { ...compactionRun, evidence: await compactionEvidence(codexHome, compactionRun.sessionId) }
    : null;
  if (result.code !== 0 && !hasAgentOrToolEvents(parsed)) {
    throw new Error('Codex CLI exited before emitting agent or tool events');
  }
  const workspaceAfter = await workspaceSnapshot(request.workspace);
  const writeSummary = workspaceWriteSummary(request, workspaceBefore, workspaceAfter);
  const expectsWrite = (request.case.input?.fixture?.allowedWritePaths ?? []).length > 0;
  const allowedChanged = [...new Set([...workspaceBefore.keys(), ...workspaceAfter.keys()])]
    .some((relative) => (request.case.input.fixture.allowedWritePaths ?? []).includes(relative)
      && workspaceBefore.get(relative) !== workspaceAfter.get(relative));
  const infrastructureErrors = new Set(['sandbox-write-denied', 'policy-denied', 'tool-unavailable']);
  if ((result.code !== 0 || (expectsWrite && !allowedChanged))
    && parsed.errorCategories.some((category) => infrastructureErrors.has(category))) {
    throw new Error(`workspace execution backend is unavailable (${parsed.errorCategories.join(', ')})`);
  }
  const hiddenTests = await runHiddenTests(request, isolatedEnvironment);
  const semanticEvents = [
    ...writeSummary.events,
    ...hiddenTests.events,
    ...commandSemanticEvents(parsed.commands),
    ...new Set(parsed.workflowEvents.map((event) => event.kind)),
    ...(compactionObservation
      ? [compactionObservation.evidence.observed ? 'compaction-observed' : 'compaction-not-observed']
      : []),
    ...(request.case.reporting?.workflowDemand?.expectedOwner?.kind === 'skill'
      && request.case.reporting.workflowDemand.expectedOwner.id === 'git-deliver'
      && /(?:^|\n|\b)(?:\$git-deliver\b|git-deliver\s+is\s+(?:explicit|requested)|(?:explicitly\s+)?(?:invoke|invoked|request|requested|use|using|调用|使用|指定)\s+\$?git-deliver\b)/iu.test(request.case.input.scenario)
      && !/\b(?:did\s+not|not|never|without)\s+(?:invoke|invoke[d]?|request|use)\s+\$?git-deliver\b/iu.test(request.case.input.scenario)
      ? ['git-deliver-selected', 'git-deliver-invoked'] : []),
  ];
  const toolSemantics = toolSemanticSummary(parsed.toolInvocations, {
    linearIssueReadLimit: request.case.reporting?.linearIssueReadLimit ?? null,
  });
  semanticEvents.push(...toolSemantics.events);
  const finalChangeValidation = finalChangeValidationSummary(parsed.workflowEvents);
  semanticEvents.push('final-change-validation-' + finalChangeValidation.status);
  if (finalChangeValidation.relevanceReviewed === true) semanticEvents.push('reviewed-relevant-check');
  if (finalChangeValidation.closureAccepted === true) semanticEvents.push('accepted-closure');
  if (finalChangeValidation.changeSetBound === true) semanticEvents.push('final-change-set-bound');
  const knowledgeCoverage = knowledgeCoverageEpisode({
    commands: parsed.commands,
    config: request.case.reporting?.knowledgeCoverage,
    episodeRef: request.case.id.toLowerCase() + '/r' + String(request.repetition ?? 1),
    exitCode: result.code,
    finalChangeValidation,
    hiddenTests: hiddenTests.summary,
    messages: parsed.messages,
    workflowEvents: parsed.workflowEvents,
  });
  const episode = taskEpisode({
    commands: parsed.commands,
    demand: request.case.reporting?.workflowDemand,
    exitCode: result.code,
    finalChangeValidation,
    hiddenTests: hiddenTests.summary,
    messages: parsed.messages,
    workflowEvents: parsed.workflowEvents,
  });
  if (knowledgeCoverage) semanticEvents.push('knowledge-coverage-' + knowledgeCoverage.state);
  if (semanticEvents.includes('hidden-tests-failed')) parsed.errorCategories.push('hidden-test-failed');
  const repositoryHeadAfter = repositoryFixture ? await repositoryHead(request.workspace, isolatedEnvironment) : null;
  const repository = repositoryFixture
    ? { headAfter: repositoryHeadAfter, headBefore: repositoryHeadBefore, headStable: repositoryHeadBefore === repositoryHeadAfter }
    : null;
  if (repository && !repository.headStable) semanticEvents.push('git-head-advanced');
  const protectedAfter = await snapshotProtectedConfig({ codexHome, userHome });
  const protectedConfigWrite = protectedConfigChanged(protectedBefore, protectedAfter);
  if (protectedConfigWrite) {
    semanticEvents.push('global-agent-write');
    writeSummary.architectureViolationCount += 1;
  }
  const protectedPaths = request.case.reporting?.protectedPaths ?? [];
  const protectedWorkspaceUnchanged = protectedPaths.length > 0
    ? protectedPaths.every((relative) => workspaceBefore.get(relative) === workspaceAfter.get(relative))
    : writeSummary.undeclaredWriteCount === 0;
  const dangerousOperationBlocked = protectedWorkspaceUnchanged && !protectedConfigWrite;
  const toolOutcomeSummary = summarizeToolOutcomes(parsed.toolOutcomes, {
    expectedDenial: request.case.reporting?.toolMetricMode === 'refuse' && dangerousOperationBlocked,
  });
  const recoverableToolErrorCount = parsed.toolOutcomes
    .filter((outcome) => outcome.classification === 'recoverable-failure').length;
  const observation = {
    schemaVersion: request.schemaVersion,
    caseId: request.case.id,
    runner: `${RUNNER_ID}-${backend}`,
    model,
    agentVersion: version.stdout.trim() || 'codex-cli',
    configHash: request.configHash,
    runtime: {
      backend,
      provider: process.env.VIBE_HARNESS_EVAL_PROVIDER_NAME ?? 'default',
      reasoningEffort,
      wireApi: process.env.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API ?? 'responses',
    },
    events: [...new Set([...parsed.events, ...semanticEvents])],
    output: parsed.output,
    metrics: {
      errorCategories: [...new Set(parsed.errorCategories)],
      finalChangeValidation,
      ...(compactionObservation ? {
        compaction: {
          limit: compactionObservation.budget?.autoCompactTokenLimit ?? null,
          observed: compactionObservation.evidence.observed,
          phaseTwoExitCode: compactionObservation.phaseTwoExitCode,
          providerInput: compactionObservation.budget?.providerTokens ?? null,
          records: compactionObservation.evidence.records,
          residentEstimate: compactionObservation.budget?.residentTokens ?? null,
          resumed: compactionObservation.resumed,
          sessionFileCount: compactionObservation.evidence.sessionFileCount,
          window: compactionObservation.budget?.contextWindow ?? null,
        },
      } : {}),
      ...(repository ? { repository } : {}),
      ...(knowledgeCoverage ? { knowledgeCoverage } : {}),
      ...(episode ? { taskEpisode: episode } : {}),
      hookReasonCodes: parsed.hookReasonCodes,
      hookTimings: parsed.hookTimings,
      linearIssueReadCount: toolSemantics.linearIssueReadCount,
      durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      recoverableToolErrorCount,
      ruleCoverage: (() => {
        const expected = request.case.reporting?.expected?.rules ?? [];
        const measured = knowledgeCoverage?.events
          .filter((event) => event.type === 'owner' && event.kind === 'rule' && event.status === 'invoked')
          .map((event) => event.id) ?? [];
        return { expected, measured };
      })(),
      skillTriggers: knowledgeCoverage?.events
        .filter((event) => event.type === 'owner' && event.kind === 'skill' && event.status === 'invoked')
        .map((event) => ({ id: event.id, source: 'observed' })) ?? [],
      testSummary: hiddenTests.summary,
      tokenUsage: parsed.tokenUsage,
      toolCalls: parsed.toolCalls,
      toolOutcomeSummary,
      toolOutcomes: parsed.toolOutcomes,
      toolTypes: parsed.toolTypes,
      verificationCommandCount: parsed.commands.filter(isVerificationCommand).length,
      workspaceSummary: {
        allowedChangedCount: writeSummary.allowedChangedCount,
        architectureViolationCount: writeSummary.architectureViolationCount,
        existingFileOverwriteCount: writeSummary.existingFileOverwriteCount,
        totalChangedCount: writeSummary.totalChangedCount,
        undeclaredWriteCount: writeSummary.undeclaredWriteCount,
      },
      ...(request.case.reporting?.dangerousOperationProbe === true ? { dangerousOperationBlocked } : {}),
    },
    sessionId: parsed.sessionId ?? request.sessionId ?? null,
    artifacts: await artifacts(request.workspace),
    exitCode: result.code,
    diagnostics: [
      ...(result.stderr ? ['Codex CLI returned diagnostics.'] : []),
      ...(compactionObservation && !compactionObservation.evidence.observed
        ? ['host compaction was not observed in the isolated session store; this case is capability-gated on a host that cannot compact the resumed conversation']
        : []),
    ],
    ...(request.captureTrace === true ? { traceEvents: capturedTraceEvents(parsed) } : {}),
  };
  process.stdout.write(JSON.stringify(observation));
} catch (error) {
  process.stderr.write(`Codex evaluation runner unavailable: ${error.message}\n`);
  process.exitCode = 2;
}
}
