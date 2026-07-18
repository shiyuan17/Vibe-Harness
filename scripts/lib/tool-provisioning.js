import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertInsideDir, assertSafePathInside, pathExists } from './manifest.js';
import { resolveOcrEndpoint } from './ocr-config.js';
import { inspectPlaywrightTool, preparePlaywrightTool } from '../../runtime/tools/playwright-cli/run.mjs';
import { productIdentity, readProductEnv } from './product-identity.js';
import { projectStateDir } from './project-layout.js';

const managedMcpStart = '# COGNIS:MCP:START';
const managedMcpEnd = '# COGNIS:MCP:END';
const legacyManagedMcpStart = '# LOOPENGINE:MCP:START';
const legacyManagedMcpEnd = '# LOOPENGINE:MCP:END';
const maxDiagnosticOutput = 8 * 1024;
const maxToolOutput = 1024 * 1024;
const execFileAsync = promisify(execFile);
const cognisVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;

const toolSpecs = [
  {
    id: 'codebaseMemoryMcp',
    packageName: 'codebase-memory-mcp',
    phases: ['dependency-install', 'binary-install', 'index', 'index-verify', 'mcp-handshake'],
    relativeDir: '.agents/cognis/tools/codebase-memory-mcp',
    version: '0.9.0',
  },
  {
    id: 'playwrightCli',
    packageName: '@playwright/cli',
    phases: ['dependency-install', 'browser-install'],
    relativeDir: '.agents/cognis/tools/playwright-cli',
    version: '0.1.17',
  },
  {
    id: 'openCodeReview',
    packageName: '@alibaba-group/open-code-review',
    phases: ['dependency-install', 'llm-test'],
    relativeDir: '.agents/cognis/tools/open-code-review',
    version: '1.7.7',
  },
  {
    id: 'agentmemory',
    packageName: '@agentmemory/mcp',
    phases: ['dependency-install', 'mcp-handshake'],
    relativeDir: '.agents/cognis/tools/agentmemory',
    supportLevel: 'preview',
    version: '0.9.27',
  },
];

function resolveToolSpec(spec, targetDir, mode = 'eager') {
  const toolDir = path.resolve(targetDir, spec.relativeDir);
  assertInsideDir(targetDir, toolDir, `${spec.id} tool directory`);
  return { ...spec, mode, toolDir };
}

export function createToolProvisioningPlan({ allowPreview = false, profile, resolvedModules, targetDir, toolIds }) {
  let plan;
  if (Array.isArray(resolvedModules)) {
    const moduleByTool = new Map([
      ['codebaseMemoryMcp', 'codebase-memory'],
      ['playwrightCli', 'playwright'],
      ['openCodeReview', 'open-code-review'],
      ['agentmemory', 'agentmemory'],
    ]);
    plan = toolSpecs
      .filter((spec) => resolvedModules.includes(moduleByTool.get(spec.id)))
      .map((spec) => resolveToolSpec(
        spec,
        targetDir,
        spec.id === 'playwrightCli' && profile === 'core' ? 'lazy' : 'eager',
      ));
  } else if (profile === 'core') {
    plan = [resolveToolSpec(toolSpecs[1], targetDir, 'lazy')];
  } else if (profile !== 'full') {
    plan = [];
  } else {
    plan = toolSpecs.map((spec) => resolveToolSpec(spec, targetDir));
  }
  plan = plan.map((spec) => ({ supportLevel: spec.supportLevel ?? 'stable', ...spec }));
  if (!toolIds?.length) return allowPreview ? plan : plan.filter((spec) => spec.supportLevel !== 'preview');
  const requested = new Set(toolIds);
  const selected = plan.filter((spec) => requested.has(spec.id));
  const unavailable = [...requested].filter((id) => !selected.some((spec) => spec.id === id));
  if (unavailable.length > 0) {
    throw new Error(`Unknown or unavailable tool for profile ${profile}: ${unavailable.join(', ')}`);
  }
  const preview = selected.filter((spec) => spec.supportLevel === 'preview').map((spec) => spec.id);
  if (preview.length > 0 && !allowPreview) {
    throw new Error(`Preview tools require --allow-preview: ${preview.join(', ')}`);
  }
  return selected;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function renderMcpServer(name, server) {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
  ];
  const entries = Object.entries(server.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 0) {
    lines.push('', `[mcp_servers.${name}.env]`);
    for (const [key, value] of entries) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join('\n');
}

function findManagedMcpBlock(content) {
  const canonicalStart = content.indexOf(managedMcpStart);
  const legacyStart = content.indexOf(legacyManagedMcpStart);
  if (canonicalStart !== -1 && legacyStart !== -1) {
    throw Object.assign(new Error('Configuration contains both Cognis and LoopEngine MCP managed blocks.'), {
      code: 'COGNIS_MCP_BLOCK_CONFLICT',
    });
  }
  const start = canonicalStart !== -1 ? canonicalStart : legacyStart;
  if (start === -1) return null;
  const endMarker = canonicalStart !== -1 ? managedMcpEnd : legacyManagedMcpEnd;
  const end = content.indexOf(endMarker, start);
  if (end === -1) throw new Error('Malformed Cognis MCP managed block.');
  return { end, endMarker, start };
}

function stripManagedMcpBlock(content) {
  const found = findManagedMcpBlock(content);
  if (!found) return content;
  return `${content.slice(0, found.start)}${content.slice(found.end + found.endMarker.length)}`.replace(/\n{3,}/gu, '\n\n');
}

export function extractManagedMcpBlock(content) {
  const found = findManagedMcpBlock(content);
  return found ? content.slice(found.start, found.end + found.endMarker.length) : '';
}

export function removeManagedMcpBlock(content) {
  const remaining = stripManagedMcpBlock(content).trim();
  return remaining ? `${remaining}\n` : '';
}

export function mergeManagedMcpBlock(existingContent, servers) {
  const unmanaged = stripManagedMcpBlock(existingContent);
  const conflicts = [];
  const rendered = [];
  for (const [name, server] of Object.entries(servers).sort(([left], [right]) => left.localeCompare(right))) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const duplicate = new RegExp(`^\\s*\\[mcp_servers\\.${escaped}\\]\\s*$`, 'mu');
    if (duplicate.test(unmanaged)) {
      conflicts.push(name);
      continue;
    }
    rendered.push(renderMcpServer(name, server));
  }
  const block = [managedMcpStart, ...rendered.flatMap((item, index) => index === 0 ? [item] : ['', item]), managedMcpEnd].join('\n');
  const prefix = unmanaged.trimEnd();
  return {
    conflicts,
    content: `${prefix ? `${prefix}\n\n` : ''}${block}\n`,
  };
}

function hasOcrCredentials(env) {
  return Boolean(
    (env.OCR_LLM_URL && env.OCR_LLM_TOKEN && env.OCR_LLM_MODEL)
    || env.OPENAI_API_KEY
    || env.ANTHROPIC_API_KEY,
  );
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      child.kill();
      resolve();
    });
    killer.once('close', resolve);
  });
}

function appendOutputTail(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length > maxDiagnosticOutput ? combined.slice(-maxDiagnosticOutput) : combined;
}

function toolCommandError(message, code, output, extra = {}) {
  return Object.assign(new Error(message), {
    code,
    outputTruncated: output.truncated,
    stderr: output.stderr,
    stdout: output.stdout,
    ...extra,
  });
}

function redactDiagnosticText(value, targetDir) {
  if (!value) return '';
  const projectPath = path.resolve(targetDir);
  const projectPaths = [projectPath, projectPath.replaceAll('\\', '/')];
  let redacted = String(value);
  for (const projectVariant of projectPaths) {
    const projectPattern = new RegExp(projectVariant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
    redacted = redacted.replace(projectPattern, '<project>');
  }
  return redacted
    .replace(/(["'](?:api[-_]?key|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu, '$1[REDACTED]$2')
    .replace(/\b((?:api[-_]?key|password|secret|token)=)[^\s/]+/giu, '$1[REDACTED]')
    .replace(/(^|\s)(--?(?:api[-_]?key|password|secret|token)(?:=|\s+))[^\s]+/giu, '$1$2[REDACTED]')
    .replace(/\b((?:api[-_]?key|password|secret|token)\s*:\s*)[^\s,}"']+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|password|secret|token)=)[^&#\s]+/giu, '$1[REDACTED]')
    .trim();
}

function lastDiagnosticLine(...values) {
  for (const value of values) {
    const lines = value.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const usable = [...lines].reverse().filter((line) => !/^(?:npm (?:error )?A complete log of this run can be found in:|npm warn cleanup|You can install manually:|Try reinstalling:)/iu.test(line));
    const informative = usable.find((line) => /\b(?:error|failed|timeout|e(?:conn|timedout|not|perm|acces|pipe|exist|busy|ai_|host|addr|rr_)[a-z_]*)\b/iu.test(line));
    if (informative) return informative;
    if (usable.length > 0) return usable.at(-1);
    if (lines.length > 0) return lines.at(-1);
  }
  return '';
}

function diagnosticMessage(error, code, stderrTail, stdoutTail) {
  const outputMessage = lastDiagnosticLine(stderrTail, stdoutTail);
  if (outputMessage) return outputMessage;
  if (code === 'TOOL_TIMEOUT') return 'Tool command timed out.';
  if (code === 'TOOL_OUTPUT_LIMIT') return 'Tool command exceeded the output limit.';
  if (code === 'TOOL_START_FAILED' || code === 'MCP_START_FAILED') return 'Tool process could not start.';
  if (code === 'MCP_HANDSHAKE_TIMEOUT') return 'MCP handshake timed out.';
  if (code === 'MCP_STDIN_FAILED') return 'MCP process closed stdin during handshake.';
  if (code === 'INDEX_CORRUPT_REINDEX_REQUIRED') return 'Index database is corrupt; re-index is required.';
  if (code === 'INDEX_PATH_OUTSIDE_ALLOWED_ROOT') return 'Repository path is outside the allowed root.';
  return error?.message || 'Tool command failed.';
}

function createDiagnostic(error, phase, targetDir) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
  const stderrTail = redactDiagnosticText(error?.stderr, targetDir);
  const stdoutTail = redactDiagnosticText(error?.stdout, targetDir);
  const diagnostic = {
    code,
    message: redactDiagnosticText(diagnosticMessage(error, code, stderrTail, stdoutTail), targetDir),
    phase,
    truncated: Boolean(error?.outputTruncated),
  };
  if (Number.isInteger(error?.exitCode)) diagnostic.exitCode = error.exitCode;
  if (stderrTail) diagnostic.stderrTail = stderrTail;
  if (stdoutTail) diagnostic.stdoutTail = stdoutTail;
  return diagnostic;
}

export async function runToolCommand({ args, command, cwd, env, signal, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env,
      shell: false,
      windowsHide: true,
    });
    let outputSize = 0;
    let settled = false;
    const output = { stderr: '', stdout: '', truncated: false };
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) await terminateProcessTree(child);
      if (error) reject(error);
      else resolve(output);
    };
    const abort = () => void finish(toolCommandError('Tool command was cancelled.', 'TOOL_CANCELLED', output));
    const timer = setTimeout(() => void finish(toolCommandError('Tool command timed out.', 'TOOL_TIMEOUT', output)), timeout);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const countOutput = (stream, chunk) => {
      outputSize += chunk.length;
      output[stream] = appendOutputTail(output[stream], chunk);
      if (outputSize > maxToolOutput) {
        output.truncated = true;
        void finish(toolCommandError('Tool command output limit exceeded.', 'TOOL_OUTPUT_LIMIT', output));
      }
    };
    child.stdout.on('data', (chunk) => countOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => countOutput('stderr', chunk));
    child.once('error', () => void finish(toolCommandError('Tool command failed to start.', 'TOOL_START_FAILED', output)));
    child.once('close', (code) => {
      if (code === 0) void finish();
      else void finish(toolCommandError('Tool command failed.', 'TOOL_COMMAND_FAILED', output, { exitCode: code }));
    });
  });
}

const defaultCommandRunner = runToolCommand;

function boundedTimeout(env, fallback) {
  const timeoutLimit = Number.parseInt(readProductEnv(env, 'TOOL_TIMEOUT_MS').value ?? '', 10);
  return Number.isInteger(timeoutLimit) && timeoutLimit >= 1000
    ? Math.min(fallback, timeoutLimit)
    : fallback;
}

async function npmInvocation(args) {
  if (process.platform !== 'win32') return { args, command: 'npm' };
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = (await Promise.all(candidates.map(async (candidate) => await pathExists(candidate) ? candidate : null))).find(Boolean);
  if (!npmCli) throw Object.assign(new Error('npm is unavailable.'), { code: 'NPM_UNAVAILABLE' });
  return { args: [npmCli, ...args], command: process.execPath };
}

const baseEnvironmentNames = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'ProgramData', 'SHELL', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'WINDIR',
]);

const packageManagerEnvironmentNames = new Set([
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy', 'npm_config_offline',
  'npm_config_prefer_offline', 'npm_config_registry',
]);

const toolEnvironmentNames = Object.fromEntries(
  toolSpecs.map((spec) => [spec.id, packageManagerEnvironmentNames]),
);

const toolCredentialNames = {
  openCodeReview: new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'OCR_LLM_AUTH_HEADER', 'OCR_LLM_EXTRA_HEADERS', 'OCR_LLM_MODEL', 'OCR_LLM_PROTOCOL',
    'OCR_LLM_TIMEOUT', 'OCR_LLM_TOKEN', 'OCR_LLM_URL', 'OCR_USE_ANTHROPIC',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  ]),
};

function allowedEnvironment(spec, env) {
  const allowedNames = new Set([
    ...baseEnvironmentNames,
    ...(toolEnvironmentNames[spec.id] ?? []),
    ...(toolCredentialNames[spec.id] ?? []),
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => allowedNames.has(name)));
}

async function componentEnvironment(spec, targetDir, env, { codebaseMemoryCacheDir } = {}) {
  const stateRoot = path.join(await projectStateDir(targetDir), 'tool-state');
  const npmCache = path.join(stateRoot, 'npm-cache', spec.id);
  const baseEnv = allowedEnvironment(spec, env);
  if (spec.id === 'codebaseMemoryMcp') {
    return {
      ...baseEnv,
      CBM_ALLOWED_ROOT: targetDir,
      CBM_CACHE_DIR: codebaseMemoryCacheDir ?? path.join(stateRoot, 'codebase-memory-mcp/cache'),
      npm_config_cache: npmCache,
    };
  }
  if (spec.id === 'agentmemory') {
    const home = path.join(stateRoot, 'agentmemory/home');
    return { ...baseEnv, HOME: home, USERPROFILE: home, npm_config_cache: npmCache };
  }
  if (spec.id === 'openCodeReview') {
    const home = path.join(stateRoot, 'open-code-review/home');
    return { ...baseEnv, HOME: home, USERPROFILE: home, npm_config_cache: npmCache };
  }
  return { ...baseEnv, npm_config_cache: npmCache };
}

async function phaseRequest(spec, phase, targetDir, env, context = {}) {
  const componentEnv = await componentEnvironment(spec, targetDir, env, context);
  if (phase === 'dependency-install') {
    const npmArgs = ['ci', '--no-audit', '--no-fund', '--ignore-scripts'];
    if (spec.id === 'agentmemory') npmArgs.push('--omit=optional');
    return { ...await npmInvocation(npmArgs), component: spec.id, cwd: spec.toolDir, env: componentEnv, phase, timeout: 600_000 };
  }
  if (phase === 'binary-install') {
    return {
      args: [path.join(spec.toolDir, 'node_modules/codebase-memory-mcp/install.js')],
      command: process.execPath,
      component: spec.id,
      cwd: spec.toolDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'index') {
    return {
    args: [
        path.join(spec.toolDir, 'run.mjs'),
        'cli',
        'index_repository',
        '--repo-path',
        '.',
        '--mode',
        'moderate',
        '--persistence',
        'false',
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'index-verify') {
    return {
      args: [
        path.join(spec.toolDir, 'run.mjs'),
        'cli',
        'index_status',
        '--project',
        context.indexProject,
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'llm-test') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs'), 'llm', 'test'],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'browser-install') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs'), 'install-browser', 'chromium'],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  return {
    args: [path.join(spec.toolDir, 'run.mjs')],
    command: process.execPath,
    component: spec.id,
    cwd: targetDir,
    env: componentEnv,
    phase,
    timeout: 30_000,
  };
}

export async function runMcpHandshake(request) {
  await new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      detached: process.platform !== 'win32',
      env: request.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let settled = false;
    const output = { stderr: '', stdout: '', truncated: false };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminateProcessTree(child).then(() => {
        if (error) reject(error);
        else resolve();
      });
    };
    const timer = setTimeout(() => finish(toolCommandError('MCP handshake timed out.', 'MCP_HANDSHAKE_TIMEOUT', output)), request.timeout);
    child.once('error', () => finish(toolCommandError('MCP process failed to start.', 'MCP_START_FAILED', output)));
    child.stdin.once('error', () => finish(toolCommandError('MCP process closed stdin during handshake.', 'MCP_STDIN_FAILED', output)));
    child.once('exit', (code) => {
      if (!settled) finish(toolCommandError('MCP process exited before handshake.', code === 0 ? 'MCP_EARLY_EXIT' : 'MCP_START_FAILED', output, { exitCode: code }));
    });
    child.stdout.on('data', (chunk) => {
      output.stdout = appendOutputTail(output.stdout, chunk);
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) {
        output.truncated = true;
        finish(toolCommandError('MCP handshake output limit exceeded.', 'MCP_OUTPUT_LIMIT', output));
        return;
      }
      for (const line of buffer.split(/\r?\n/u)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} })}\n`);
          } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
            finish();
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      output.stderr = appendOutputTail(output.stderr, chunk);
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: productIdentity.command, version: cognisVersion }, protocolVersion: '2025-03-26' },
    })}\n`);
  });
}

async function defaultPhaseRunner(request) {
  if (request.phase === 'mcp-handshake') return runMcpHandshake(request);
  return defaultCommandRunner(request);
}

function diagnosticCode(error) {
  const output = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;
  if (/repo_path\s+is\s+outside\s+the\s+allowed\s+root/iu.test(output)) return 'INDEX_PATH_OUTSIDE_ALLOWED_ROOT';
  if (/(?:index|database|graph).*(?:corrupt|invalid)|corrupt.*(?:index|database|graph)|需要重新索引/iu.test(output)) {
    return 'INDEX_CORRUPT_REINDEX_REQUIRED';
  }
  return typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
}

function publicFailure(spec, phase, error, targetDir) {
  const code = diagnosticCode(error);
  const diagnosticError = Object.assign(new Error(error?.message ?? ''), error, { code });
  return {
    code,
    diagnostic: createDiagnostic(diagnosticError, phase, targetDir),
    phase,
    status: 'degraded',
    version: spec.version,
  };
}

function ready(spec, phase = 'ready', details = {}) {
  return { ...details, phase, status: 'ready', version: spec.version };
}

function toolContractError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseCommandJson(output, code, message) {
  const line = String(output?.stdout ?? '')
    .split(/\r?\n/gu)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  if (!line) throw toolContractError(code, message);
  try {
    return JSON.parse(line);
  } catch {
    throw toolContractError(code, message);
  }
}

function normalizedProjectPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateIndexResult(output) {
  const result = parseCommandJson(output, 'INDEX_OUTPUT_INVALID', 'Index command did not return valid JSON.');
  const hint = typeof result.hint === 'string' ? result.hint : '';
  if (/(?:integrity|database).*(?:corrupt|failed)|corrupt.*(?:index|database)|重新索引|re-?run.*index/iu.test(hint)) {
    throw toolContractError('INDEX_CORRUPT_REINDEX_REQUIRED', 'Index database is corrupt; re-index is required.');
  }
  if (result.status !== 'indexed' || typeof result.project !== 'string' || !result.project.trim()) {
    throw toolContractError('INDEX_RESULT_INVALID', 'Index command did not confirm an indexed project.');
  }
  return result.project;
}

function validateIndexStatus(output, targetDir) {
  const result = parseCommandJson(output, 'INDEX_OUTPUT_INVALID', 'Index verification did not return valid JSON.');
  if (result.status !== 'ready') {
    throw toolContractError('INDEX_NOT_READY', 'Indexed project is not ready.');
  }
  if (typeof result.root_path !== 'string'
    || normalizedProjectPath(result.root_path) !== normalizedProjectPath(targetDir)) {
    throw toolContractError('INDEX_ROOT_MISMATCH', 'Indexed project root does not match the target project.');
  }
  if (!Number.isInteger(result.nodes) || result.nodes < 0
    || !Number.isInteger(result.edges) || result.edges < 0) {
    throw toolContractError('INDEX_STATUS_INVALID', 'Index verification did not return valid graph counts.');
  }
  return {
    edges: result.edges,
    mode: 'moderate',
    nodes: result.nodes,
    status: 'ready',
  };
}

function withProvisioningMetadata(spec, state, startedAt, { reused = false } = {}) {
  const summaries = {
    degraded: state.diagnostic?.message ?? 'Provisioning failed.',
    pending: 'Provisioning is deferred.',
    'pending-config': 'Provisioning requires additional configuration.',
    ready: reused ? 'Existing compliant tool state reused.' : 'Provisioning completed.',
  };
  return {
    ...state,
    finishedAt: new Date().toISOString(),
    logSummary: summaries[state.status] ?? 'Provisioning state recorded.',
    result: state.status,
    source: `npm:${spec.packageName}@${spec.version}`,
    startedAt,
  };
}

async function runToolPhases(spec, commandRunner, env, targetDir, phases = spec.phases, signal, ocrResolution) {
  const context = {};
  const retriedCorruptIndex = new Set();
  for (const phase of phases) {
    if (spec.id === 'openCodeReview' && phase === 'llm-test' && !hasOcrCredentials(env)) {
      return {
        ...(ocrResolution?.diagnostic ? { diagnostic: ocrResolution.diagnostic } : {}),
        phase: 'llm-config',
        status: 'pending-config',
        version: spec.version,
      };
    }
    try {
      const request = await phaseRequest(spec, phase, targetDir, env, context);
      request.signal = signal;
      request.timeout = boundedTimeout(env, request.timeout);
      const output = await commandRunner(request);
      if (phase === 'index') context.indexProject = validateIndexResult(output);
      if (phase === 'index-verify') context.index = validateIndexStatus(output, targetDir);
    } catch (error) {
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'binary-install'
        && /(?:binary\s+not\s+found|download\s+failed|install\s+failed)/iu.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)
        && await repairCodebaseMemoryBinary(spec)) {
        continue;
      }
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'index'
        && /(?:binary\s+not\s+found|download\s+failed|install\s+failed)/iu.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)
        && await repairCodebaseMemoryBinary(spec)) {
        const retryRequest = await phaseRequest(spec, phase, targetDir, env, context);
        retryRequest.signal = signal;
        retryRequest.timeout = boundedTimeout(env, retryRequest.timeout);
        const retryOutput = await commandRunner(retryRequest);
        context.indexProject = validateIndexResult(retryOutput);
        continue;
      }
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'index'
        && diagnosticCode(error) === 'INDEX_CORRUPT_REINDEX_REQUIRED'
        && !retriedCorruptIndex.has(phase)) {
        retriedCorruptIndex.add(phase);
        const cacheDir = path.join(await projectStateDir(targetDir), 'tool-state/codebase-memory-mcp/cache');
        await assertSafePathInside(targetDir, cacheDir, 'codebase-memory cache');
        await rm(cacheDir, { force: true, recursive: true });
        const projectIndexDir = path.join(targetDir, '.codebase-memory');
        await assertSafePathInside(targetDir, projectIndexDir, 'codebase-memory project index');
        await rm(projectIndexDir, { force: true, recursive: true });
        context.codebaseMemoryCacheDir = cacheDir;
        const retryRequest = await phaseRequest(spec, phase, targetDir, env, context);
        retryRequest.signal = signal;
        retryRequest.timeout = boundedTimeout(env, retryRequest.timeout);
        try {
          const retryOutput = await commandRunner(retryRequest);
          context.indexProject = validateIndexResult(retryOutput);
          continue;
        } catch (retryError) {
          error = retryError;
        }
      }
      error.phase = phase;
      throw error;
    }
  }
  return ready(spec, 'ready', context.index ? { index: context.index } : {});
}

async function lockFingerprint(spec) {
  const lockPath = path.join(spec.toolDir, 'package-lock.json');
  if (!(await pathExists(lockPath))) return null;
  return createHash('sha256').update(await readFile(lockPath)).digest('hex');
}

async function codebaseMemoryRuntimeAvailable(spec) {
  const packageDir = path.join(spec.toolDir, 'node_modules/codebase-memory-mcp');
  const binary = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  return await pathExists(path.join(packageDir, 'bin.js'))
    && await pathExists(path.join(packageDir, 'bin', binary));
}

async function repairCodebaseMemoryBinary(spec) {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('where.exe', ['codebase-memory-mcp'], { windowsHide: true });
    const source = stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
    if (!source) return false;
    const { stdout: version } = await execFileAsync(source, ['--version'], { windowsHide: true });
    if (!version.includes(spec.version)) return false;
    const destination = path.join(spec.toolDir, 'node_modules/codebase-memory-mcp/bin/codebase-memory-mcp.exe');
    await assertSafePathInside(spec.toolDir, destination, 'codebase-memory binary');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return true;
  } catch {
    return false;
  }
}

async function readToolState(targetDir) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  if (!(await pathExists(statePath))) return null;
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeToolState(targetDir, tools, fingerprints) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ fingerprints, tools, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

async function writeProvisioningMarker(targetDir, marker) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  assertInsideDir(targetDir, markerPath, 'provisioning marker');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

async function removeProvisioningMarker(targetDir) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  await rm(markerPath, { force: true });
}

export async function inspectProvisioningMarker(targetDir) {
  const markerPath = path.join(await projectStateDir(targetDir), 'tool-state/provisioning.json');
  await assertSafePathInside(targetDir, markerPath, 'provisioning marker');
  if (!(await pathExists(markerPath))) return null;
  try {
    return JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    return { code: 'PROVISIONING_MARKER_INVALID', status: 'invalid' };
  }
}

export async function provisionProfileTools({ allowPreview = false, commandRunner, env = process.env, force = false, mcpConflicts = [], ocrHomeDir, profile, resolvedModules, signal, targetDir, toolIds }) {
  const plan = createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds });
  const ocrResolution = await resolveOcrEndpoint({ env, homeDir: ocrHomeDir });
  const provisionEnv = { ...env, ...(ocrResolution.env ?? {}) };
  const effectiveCommandRunner = commandRunner ?? (readProductEnv(env, 'TEST_OFFLINE').value === '1'
    ? async () => { throw Object.assign(new Error('Offline test fixture.'), { code: 'TOOL_TEST_OFFLINE' }); }
    : null);
  const provisioningStartedAt = new Date().toISOString();
  const marker = {
    parentPid: process.pid,
    startedAt: provisioningStartedAt,
    status: 'active',
    tools: plan.map((spec) => spec.id),
  };
  let currentTool = null;
  await writeProvisioningMarker(targetDir, marker);
  try {
  const previous = await readToolState(targetDir);
  const tools = {};
  const fingerprints = {};
  for (const spec of plan) {
    currentTool = spec.id;
    await writeProvisioningMarker(targetDir, {
      ...marker,
      currentTool,
      updatedAt: new Date().toISOString(),
    });
    const startedAt = new Date().toISOString();
    if (signal?.aborted) throw Object.assign(new Error('Tool provisioning was cancelled.'), { code: 'TOOL_CANCELLED' });
    await assertSafePathInside(targetDir, spec.toolDir, `${spec.id} tool directory`);
    if (spec.mode === 'lazy') {
      tools[spec.id] = withProvisioningMetadata(
        spec,
        { phase: 'first-use', status: 'pending', version: spec.version },
        startedAt,
      );
      continue;
    }
    await mkdir(spec.toolDir, { recursive: true });
    const fingerprint = await lockFingerprint(spec);
    fingerprints[spec.id] = fingerprint;
    const previousTool = previous?.tools?.[spec.id];
    const reusableStatus = previousTool?.status === 'ready'
      || (spec.id === 'openCodeReview' && previousTool?.status === 'pending-config' && !hasOcrCredentials(provisionEnv));
    const reusableRuntime = spec.id !== 'codebaseMemoryMcp' || await codebaseMemoryRuntimeAvailable(spec);
    const reusable = (
      !force
      && fingerprint
      && previous?.fingerprints?.[spec.id] === fingerprint
      && reusableStatus
      && reusableRuntime
      && !mcpConflicts.includes(spec.id === 'codebaseMemoryMcp' ? 'codebase-memory-mcp' : spec.id)
    );
    if (reusable && spec.id !== 'codebaseMemoryMcp') {
      tools[spec.id] = withProvisioningMetadata(spec, previousTool, startedAt, { reused: true });
      continue;
    }
    const phases = reusable
      ? spec.phases.filter((phase) => !['dependency-install', 'binary-install'].includes(phase))
      : spec.phases;
    try {
      if (effectiveCommandRunner) {
        tools[spec.id] = await runToolPhases(spec, effectiveCommandRunner, provisionEnv, targetDir, phases, signal, ocrResolution);
      } else if (spec.id === 'playwrightCli') {
        const runCommand = async (command, args, options) => defaultCommandRunner({
          args,
          command,
          cwd: options.cwd,
          env: options.env,
          signal,
          timeout: boundedTimeout(env, 600_000),
        });
        const result = await preparePlaywrightTool({
          env: componentEnvironment(spec, targetDir, provisionEnv),
          runCommand,
          targetDir,
          toolDir: spec.toolDir,
        });
        tools[spec.id] = result.status === 'ready' ? ready(spec) : { phase: 'browser-install', status: 'degraded', version: spec.version };
      } else {
        tools[spec.id] = await runToolPhases(spec, defaultPhaseRunner, provisionEnv, targetDir, phases, signal, ocrResolution);
      }
    } catch (error) {
      if (signal?.aborted || error.code === 'TOOL_CANCELLED') throw error;
      const phase = spec.phases.find((item) => item === error?.phase) ?? 'provision';
      tools[spec.id] = publicFailure(spec, phase, error, targetDir);
    }
    tools[spec.id] = withProvisioningMetadata(spec, tools[spec.id], startedAt);
  }
  const conflictIds = {
    agentmemory: 'agentmemory',
    'codebase-memory-mcp': 'codebaseMemoryMcp',
  };
  for (const conflict of mcpConflicts) {
    const id = conflictIds[conflict];
    if (id && tools[id]) {
      tools[id] = {
        ...tools[id],
        code: 'MCP_CONFIG_CONFLICT',
        diagnostic: {
          code: 'MCP_CONFIG_CONFLICT',
          message: `An unmanaged MCP server already uses the ${conflict} name.`,
          phase: 'mcp-config',
          truncated: false,
        },
        phase: 'mcp-config',
        result: 'degraded',
        status: 'degraded',
        logSummary: `An unmanaged MCP server already uses the ${conflict} name.`,
      };
    }
  }
  await writeToolState(targetDir, tools, fingerprints);
  await removeProvisioningMarker(targetDir);
  return tools;
  } catch (error) {
    await writeProvisioningMarker(targetDir, {
      ...marker,
      code: signal?.aborted || error.code === 'TOOL_CANCELLED' ? 'TOOL_CANCELLED' : 'PROVISIONING_INTERRUPTED',
      currentTool,
      finishedAt: new Date().toISOString(),
      status: signal?.aborted || error.code === 'TOOL_CANCELLED' ? 'interrupted' : 'failed',
    });
    throw error;
  }
}

export async function inspectProfileTools(profile, targetDir, resolvedModules, toolIds, { allowPreview = false } = {}) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  if (await pathExists(statePath)) {
    const state = await readToolState(targetDir);
    const tools = state?.tools ?? {};
    const allowedIds = createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds }).map((spec) => spec.id);
    return Object.fromEntries(allowedIds.filter((id) => tools[id]).map((id) => [id, tools[id]]));
  }
  const tools = {};
  for (const spec of createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds })) {
    await assertSafePathInside(targetDir, spec.toolDir, `${spec.id} tool directory`);
    if (spec.id === 'playwrightCli') {
      const inspected = await inspectPlaywrightTool({ targetDir, toolDir: spec.toolDir });
      tools[spec.id] = {
        phase: inspected.status === 'ready' ? 'ready' : 'first-use',
        status: inspected.status === 'unavailable' ? 'degraded' : inspected.status,
        version: spec.version,
      };
    } else {
      tools[spec.id] = spec.id === 'openCodeReview' && !(await resolveOcrEndpoint({ env: process.env })).env
        ? { phase: 'llm-config', status: 'pending-config', version: spec.version }
        : { phase: 'install', status: 'pending', version: spec.version };
    }
  }
  return tools;
}

export function toolWarnings(tools) {
  return Object.entries(tools)
    .filter(([, tool]) => tool.status !== 'ready')
    .map(([id, tool]) => ({
      code: `${id.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase()}_${tool.status.replaceAll('-', '_').toUpperCase()}`,
      ...(tool.diagnostic ? { diagnostic: tool.diagnostic } : {}),
      message: tool.diagnostic?.message ?? `${id} is ${tool.status} during ${tool.phase}.`,
      tool: id,
    }));
}
