import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, pathExists } from './manifest.js';
import { inspectPlaywrightTool, preparePlaywrightTool } from '../../runtime/tools/playwright-cli/run.mjs';

const stateRelativePath = '.loopengine/tool-state/tools.json';
const managedMcpStart = '# LOOPENGINE:MCP:START';
const managedMcpEnd = '# LOOPENGINE:MCP:END';
const maxDiagnosticOutput = 8 * 1024;
const maxToolOutput = 1024 * 1024;

const toolSpecs = [
  {
    id: 'codebaseMemoryMcp',
    packageName: 'codebase-memory-mcp',
    phases: ['dependency-install', 'binary-install', 'index', 'index-verify', 'mcp-handshake'],
    relativeDir: '.agents/loopengine/tools/codebase-memory-mcp',
    version: '0.9.0',
  },
  {
    id: 'playwrightCli',
    packageName: '@playwright/cli',
    phases: ['dependency-install', 'browser-install'],
    relativeDir: '.agents/loopengine/tools/playwright-cli',
    version: '0.1.17',
  },
  {
    id: 'openCodeReview',
    packageName: '@alibaba-group/open-code-review',
    phases: ['dependency-install', 'llm-test'],
    relativeDir: '.agents/loopengine/tools/open-code-review',
    version: '1.7.7',
  },
  {
    id: 'agentmemory',
    packageName: '@agentmemory/mcp',
    phases: ['dependency-install', 'mcp-handshake'],
    relativeDir: '.agents/loopengine/tools/agentmemory',
    version: '0.9.27',
  },
];

function resolveToolSpec(spec, targetDir, mode = 'eager') {
  const toolDir = path.resolve(targetDir, spec.relativeDir);
  assertInsideDir(targetDir, toolDir, `${spec.id} tool directory`);
  return { ...spec, mode, toolDir };
}

export function createToolProvisioningPlan({ profile, resolvedModules, targetDir }) {
  if (Array.isArray(resolvedModules)) {
    const moduleByTool = new Map([
      ['codebaseMemoryMcp', 'codebase-memory'],
      ['playwrightCli', 'playwright'],
      ['openCodeReview', 'open-code-review'],
      ['agentmemory', 'agentmemory'],
    ]);
    return toolSpecs
      .filter((spec) => resolvedModules.includes(moduleByTool.get(spec.id)))
      .map((spec) => resolveToolSpec(
        spec,
        targetDir,
        spec.id === 'playwrightCli' && profile === 'core' ? 'lazy' : 'eager',
      ));
  }
  if (profile === 'core') {
    return [resolveToolSpec(toolSpecs[1], targetDir, 'lazy')];
  }
  if (profile !== 'full') {
    return [];
  }
  return toolSpecs.map((spec) => resolveToolSpec(spec, targetDir));
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

function stripManagedMcpBlock(content) {
  const start = content.indexOf(managedMcpStart);
  if (start === -1) return content;
  const end = content.indexOf(managedMcpEnd, start);
  if (end === -1) throw new Error('Malformed LoopEngine MCP managed block.');
  return `${content.slice(0, start)}${content.slice(end + managedMcpEnd.length)}`.replace(/\n{3,}/gu, '\n\n');
}

export function extractManagedMcpBlock(content) {
  const start = content.indexOf(managedMcpStart);
  if (start === -1) return '';
  const end = content.indexOf(managedMcpEnd, start);
  if (end === -1) throw new Error('Malformed LoopEngine MCP managed block.');
  return content.slice(start, end + managedMcpEnd.length);
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
    child.kill('SIGTERM');
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

async function defaultCommandRunner({ args, command, cwd, env, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    let outputSize = 0;
    let settled = false;
    const output = { stderr: '', stdout: '', truncated: false };
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) await terminateProcessTree(child);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => void finish(toolCommandError('Tool command timed out.', 'TOOL_TIMEOUT', output)), timeout);
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

function boundedTimeout(env, fallback) {
  const timeoutLimit = Number.parseInt(env.LOOPENGINE_TOOL_TIMEOUT_MS ?? '', 10);
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

function componentEnvironment(spec, targetDir, env) {
  const stateRoot = path.join(targetDir, '.loopengine/tool-state');
  const npmCache = path.join(stateRoot, 'npm-cache', spec.id);
  if (spec.id === 'codebaseMemoryMcp') {
    return {
      ...env,
      CBM_ALLOWED_ROOT: targetDir,
      CBM_CACHE_DIR: path.join(stateRoot, 'codebase-memory-mcp/cache'),
      npm_config_cache: npmCache,
    };
  }
  if (spec.id === 'agentmemory') {
    const home = path.join(stateRoot, 'agentmemory/home');
    return { ...env, HOME: home, USERPROFILE: home, npm_config_cache: npmCache };
  }
  if (spec.id === 'openCodeReview') {
    const home = path.join(stateRoot, 'open-code-review/home');
    return { ...env, HOME: home, USERPROFILE: home, npm_config_cache: npmCache };
  }
  return { ...env, npm_config_cache: npmCache };
}

async function phaseRequest(spec, phase, targetDir, env, context = {}) {
  const componentEnv = componentEnvironment(spec, targetDir, env);
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
        targetDir,
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
      params: { capabilities: {}, clientInfo: { name: 'loopengine', version: '0.3.0' }, protocolVersion: '2025-03-26' },
    })}\n`);
  });
}

async function defaultPhaseRunner(request) {
  if (request.phase === 'mcp-handshake') return runMcpHandshake(request);
  return defaultCommandRunner(request);
}

function publicFailure(spec, phase, error, targetDir) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
  return { code, diagnostic: createDiagnostic(error, phase, targetDir), phase, status: 'degraded', version: spec.version };
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

async function runToolPhases(spec, commandRunner, env, targetDir, phases = spec.phases) {
  const context = {};
  for (const phase of phases) {
    if (spec.id === 'openCodeReview' && phase === 'llm-test' && !hasOcrCredentials(env)) {
      return { phase: 'llm-config', status: 'pending-config', version: spec.version };
    }
    try {
      const request = await phaseRequest(spec, phase, targetDir, env, context);
      request.timeout = boundedTimeout(env, request.timeout);
      const output = await commandRunner(request);
      if (phase === 'index') context.indexProject = validateIndexResult(output);
      if (phase === 'index-verify') context.index = validateIndexStatus(output, targetDir);
    } catch (error) {
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

async function readToolState(targetDir) {
  const statePath = path.resolve(targetDir, stateRelativePath);
  assertInsideDir(targetDir, statePath, 'tool state');
  if (!(await pathExists(statePath))) return null;
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeToolState(targetDir, tools, fingerprints) {
  const statePath = path.resolve(targetDir, stateRelativePath);
  assertInsideDir(targetDir, statePath, 'tool state');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ fingerprints, tools, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

export async function provisionProfileTools({ commandRunner, env = process.env, mcpConflicts = [], profile, resolvedModules, targetDir }) {
  const plan = createToolProvisioningPlan({ profile, resolvedModules, targetDir });
  const effectiveCommandRunner = commandRunner ?? (env.LOOPENGINE_TEST_OFFLINE === '1'
    ? async () => { throw Object.assign(new Error('Offline test fixture.'), { code: 'TOOL_TEST_OFFLINE' }); }
    : null);
  const previous = await readToolState(targetDir);
  const tools = {};
  const fingerprints = {};
  for (const spec of plan) {
    if (spec.mode === 'lazy') {
      tools[spec.id] = { phase: 'first-use', status: 'pending', version: spec.version };
      continue;
    }
    await mkdir(spec.toolDir, { recursive: true });
    const fingerprint = await lockFingerprint(spec);
    fingerprints[spec.id] = fingerprint;
    const previousTool = previous?.tools?.[spec.id];
    const reusableStatus = previousTool?.status === 'ready'
      || (spec.id === 'openCodeReview' && previousTool?.status === 'pending-config' && !hasOcrCredentials(env));
    const reusableRuntime = spec.id !== 'codebaseMemoryMcp' || await codebaseMemoryRuntimeAvailable(spec);
    const reusable = (
      fingerprint
      && previous?.fingerprints?.[spec.id] === fingerprint
      && reusableStatus
      && reusableRuntime
      && !mcpConflicts.includes(spec.id === 'codebaseMemoryMcp' ? 'codebase-memory-mcp' : spec.id)
    );
    if (reusable && spec.id !== 'codebaseMemoryMcp') {
      tools[spec.id] = previousTool;
      continue;
    }
    const phases = reusable
      ? spec.phases.filter((phase) => !['dependency-install', 'binary-install'].includes(phase))
      : spec.phases;
    try {
      if (effectiveCommandRunner) {
        tools[spec.id] = await runToolPhases(spec, effectiveCommandRunner, env, targetDir, phases);
      } else if (spec.id === 'playwrightCli') {
        const runCommand = async (command, args, options) => defaultCommandRunner({
          args,
          command,
          cwd: options.cwd,
          env: options.env,
          timeout: boundedTimeout(env, 600_000),
        });
        const result = await preparePlaywrightTool({ runCommand, targetDir, toolDir: spec.toolDir });
        tools[spec.id] = result.status === 'ready' ? ready(spec) : { phase: 'browser-install', status: 'degraded', version: spec.version };
      } else {
        tools[spec.id] = await runToolPhases(spec, defaultPhaseRunner, env, targetDir, phases);
      }
    } catch (error) {
      const phase = spec.phases.find((item) => item === error?.phase) ?? 'provision';
      tools[spec.id] = publicFailure(spec, phase, error, targetDir);
    }
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
        status: 'degraded',
      };
    }
  }
  await writeToolState(targetDir, tools, fingerprints);
  return tools;
}

export async function inspectProfileTools(profile, targetDir, resolvedModules) {
  const statePath = path.resolve(targetDir, stateRelativePath);
  assertInsideDir(targetDir, statePath, 'tool state');
  if (await pathExists(statePath)) {
    const state = await readToolState(targetDir);
    return state?.tools ?? {};
  }
  const tools = {};
  for (const spec of createToolProvisioningPlan({ profile, resolvedModules, targetDir })) {
    if (spec.id === 'playwrightCli') {
      const inspected = await inspectPlaywrightTool({ targetDir, toolDir: spec.toolDir });
      tools[spec.id] = {
        phase: inspected.status === 'ready' ? 'ready' : 'first-use',
        status: inspected.status === 'unavailable' ? 'degraded' : inspected.status,
        version: spec.version,
      };
    } else {
      tools[spec.id] = spec.id === 'openCodeReview' && !hasOcrCredentials(process.env)
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
