import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, pathExists } from './manifest.js';
import { inspectPlaywrightTool, preparePlaywrightTool } from '../../runtime/tools/playwright-cli/run.mjs';

const stateRelativePath = '.loopengine/tool-state/tools.json';
const managedMcpStart = '# LOOPENGINE:MCP:START';
const managedMcpEnd = '# LOOPENGINE:MCP:END';

const toolSpecs = [
  {
    id: 'codebaseMemoryMcp',
    packageName: 'codebase-memory-mcp',
    phases: ['dependency-install', 'binary-install', 'index', 'mcp-handshake'],
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

export function createToolProvisioningPlan({ profile, targetDir }) {
  if (profile === 'core') {
    return [resolveToolSpec(toolSpecs[1], targetDir, 'lazy')];
  }
  if (!['full', 'codex-internal'].includes(profile)) {
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

async function defaultCommandRunner({ args, command, cwd, env, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    let outputSize = 0;
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) await terminateProcessTree(child);
      if (error) reject(error);
      else resolve({ stdout: '' });
    };
    const timer = setTimeout(() => void finish(Object.assign(new Error('Tool command timed out.'), { code: 'TOOL_TIMEOUT' })), timeout);
    const countOutput = (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 1024 * 1024) {
        void finish(Object.assign(new Error('Tool command output limit exceeded.'), { code: 'TOOL_OUTPUT_LIMIT' }));
      }
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    child.once('error', () => void finish(Object.assign(new Error('Tool command failed to start.'), { code: 'TOOL_START_FAILED' })));
    child.once('close', (code) => {
      if (code === 0) void finish();
      else void finish(Object.assign(new Error('Tool command failed.'), { code: 'TOOL_COMMAND_FAILED' }));
    });
  });
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

async function phaseRequest(spec, phase, targetDir, env) {
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
        JSON.stringify({ mode: 'moderate', persistence: false, repo_path: targetDir }),
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
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

async function runMcpHandshake(request) {
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
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void terminateProcessTree(child).then(() => {
        if (error) reject(error);
        else resolve();
      });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('MCP handshake timed out.'), { code: 'MCP_HANDSHAKE_TIMEOUT' })), request.timeout);
    child.once('error', () => finish(Object.assign(new Error('MCP process failed to start.'), { code: 'MCP_START_FAILED' })));
    child.once('exit', (code) => {
      if (!settled) finish(Object.assign(new Error('MCP process exited before handshake.'), { code: code === 0 ? 'MCP_EARLY_EXIT' : 'MCP_START_FAILED' }));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) {
        finish(Object.assign(new Error('MCP handshake output limit exceeded.'), { code: 'MCP_OUTPUT_LIMIT' }));
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

function publicFailure(spec, phase, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
  return { code, phase, status: 'degraded', version: spec.version };
}

function ready(spec, phase = 'ready') {
  return { phase, status: 'ready', version: spec.version };
}

async function runToolPhases(spec, commandRunner, env, targetDir) {
  for (const phase of spec.phases) {
    if (spec.id === 'openCodeReview' && phase === 'llm-test' && !hasOcrCredentials(env)) {
      return { phase: 'llm-config', status: 'pending-config', version: spec.version };
    }
    const request = await phaseRequest(spec, phase, targetDir, env);
    try {
      await commandRunner(request);
    } catch (error) {
      error.phase = phase;
      throw error;
    }
  }
  return ready(spec);
}

async function lockFingerprint(spec) {
  const lockPath = path.join(spec.toolDir, 'package-lock.json');
  if (!(await pathExists(lockPath))) return null;
  return createHash('sha256').update(await readFile(lockPath)).digest('hex');
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

export async function provisionProfileTools({ commandRunner, env = process.env, mcpConflicts = [], profile, targetDir }) {
  const plan = createToolProvisioningPlan({ profile, targetDir });
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
    if (
      fingerprint
      && previous?.fingerprints?.[spec.id] === fingerprint
      && reusableStatus
      && !mcpConflicts.includes(spec.id === 'codebaseMemoryMcp' ? 'codebase-memory-mcp' : spec.id)
    ) {
      tools[spec.id] = previousTool;
      continue;
    }
    try {
      if (commandRunner) {
        tools[spec.id] = await runToolPhases(spec, commandRunner, env, targetDir);
      } else if (spec.id === 'playwrightCli') {
        const result = await preparePlaywrightTool({ targetDir, toolDir: spec.toolDir });
        tools[spec.id] = result.status === 'ready' ? ready(spec) : { phase: 'browser-install', status: 'degraded', version: spec.version };
      } else {
        tools[spec.id] = await runToolPhases(spec, defaultPhaseRunner, env, targetDir);
      }
    } catch (error) {
      const phase = spec.phases.find((item) => item === error?.phase) ?? 'provision';
      tools[spec.id] = publicFailure(spec, phase, error);
    }
  }
  const conflictIds = {
    agentmemory: 'agentmemory',
    'codebase-memory-mcp': 'codebaseMemoryMcp',
  };
  for (const conflict of mcpConflicts) {
    const id = conflictIds[conflict];
    if (id && tools[id]) {
      tools[id] = { code: 'MCP_CONFIG_CONFLICT', phase: 'mcp-config', status: 'degraded', version: tools[id].version };
    }
  }
  await writeToolState(targetDir, tools, fingerprints);
  return tools;
}

export async function inspectProfileTools(profile, targetDir) {
  const statePath = path.resolve(targetDir, stateRelativePath);
  assertInsideDir(targetDir, statePath, 'tool state');
  if (await pathExists(statePath)) {
    const state = await readToolState(targetDir);
    return state?.tools ?? {};
  }
  const tools = {};
  for (const spec of createToolProvisioningPlan({ profile, targetDir })) {
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
      message: `${id} is ${tool.status} during ${tool.phase}.`,
      tool: id,
    }));
}
