import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from '@iarna/toml';

const SOURCES = new Set(['auto', 'codex', 'env']);
const BACKENDS = new Set(['auto', 'native', 'wsl']);
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

async function isFile(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value.trim();
}

function validateUrl(value, label) {
  const parsed = new URL(requiredString(value, label));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`);
  return parsed.toString().replace(/\/$/u, '');
}

function validateChoice(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  return value;
}

function validateProviderIdentifier(value, label) {
  const normalized = requiredString(value, label);
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) throw new Error(label + ' must contain only letters, digits, hyphens, or underscores');
  return normalized;
}

function runtimeHash(environment, repetitions, cliVersion) {
  const value = {
    backend: environment.VIBE_HARNESS_EVAL_CODEX_BACKEND,
    baseUrl: environment.OPENAI_BASE_URL ?? null,
    cliVersion,
    model: environment.CODEX_MODEL,
    provider: environment.VIBE_HARNESS_EVAL_PROVIDER_NAME ?? null,
    reasoningEffort: environment.CODEX_REASONING_EFFORT,
    repetitions,
    requiresAuth: environment.VIBE_HARNESS_EVAL_PROVIDER_REQUIRES_AUTH === '1',
    runtimeSource: environment.VIBE_HARNESS_EVAL_RUNTIME_SOURCE,
    wireApi: environment.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API ?? null,
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function executeVersion(program, args, env) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child;
    try {
      child = spawn(program, args, { env, shell: false, windowsHide: true });
    } catch {
      resolve('unavailable');
      return;
    }
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => finish('unavailable'));
    child.on('close', (code) => finish(code === 0 && stdout.trim() ? stdout.trim() : 'unavailable'));
    const timer = setTimeout(() => {
      child.kill();
      finish('unavailable');
    }, 30_000);
  });
}

async function windowsCodexScript() {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const wrapper = path.join(entry, 'codex.cmd');
    const script = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await isFile(wrapper) && await isFile(script)) return script;
  }
  return null;
}

async function defaultCliVersion({ backend, environment }) {
  if (backend === 'wsl') {
    if (environment.VIBE_HARNESS_WSL_CODEX_COMMAND) {
      return executeVersion('wsl.exe', ['-e', environment.VIBE_HARNESS_WSL_CODEX_COMMAND, '--version'], process.env);
    }
    const discovered = await executeVersion(
      'wsl.exe',
      ['-e', 'sh', '-lc', 'command -v codex && codex --version'],
      process.env,
    );
    const [command, ...version] = discovered.split(/\r?\n/u).filter(Boolean);
    if (!command?.startsWith('/') || version.length === 0) return 'unavailable';
    environment.VIBE_HARNESS_WSL_CODEX_COMMAND = command;
    return version.join('\n');
  }
  const command = environment.VIBE_HARNESS_CODEX_COMMAND ?? 'codex';
  const version = /\.(?:mjs|js)$/iu.test(command)
    ? await executeVersion(process.execPath, [command, '--version'], process.env)
    : await executeVersion(command, ['--version'], process.env);
  if (version !== 'unavailable' || process.platform !== 'win32') return version;
  const script = await windowsCodexScript();
  if (!script) return 'unavailable';
  environment.VIBE_HARNESS_CODEX_COMMAND = script;
  return executeVersion(process.execPath, [script, '--version'], process.env);
}

function actualBackend(configured, needsWrite, platform) {
  if (configured !== 'auto') return configured;
  return platform === 'win32' && needsWrite ? 'wsl' : 'native';
}

function codexHome(env, homeDir) {
  return path.resolve(env.CODEX_HOME || path.join(homeDir, '.codex'));
}

async function fromCodexConfig({ backend, env, homeDir }) {
  const home = codexHome(env, homeDir);
  const configPath = path.join(home, 'config.toml');
  if (!await isFile(configPath)) return null;
  const config = parseToml(await readFile(configPath, 'utf8'));
  const providerName = config.model_provider === undefined
    ? 'openai'
    : requiredString(config.model_provider, 'Codex config model_provider');
  const provider = config.model_provider === undefined ? null : config.model_providers?.[providerName];
  if (config.model_provider !== undefined && (!provider || typeof provider !== 'object')) {
    throw new Error(`Codex config provider is missing: ${providerName}`);
  }
  const reasoning = config.model_reasoning_effort ?? 'medium';
  validateChoice(reasoning, REASONING_EFFORTS, 'Codex config model_reasoning_effort');
  const authFile = path.join(home, 'auth.json');
  const requiresAuth = provider?.requires_openai_auth !== false;
  if (requiresAuth && !await isFile(authFile)) throw new Error('Codex auth.json is required by the configured provider');
  const configuredCommand = config.shell_environment_policy?.set?.CODEX_CLI_PATH;
  const environment = {
    CODEX_MODEL: requiredString(env.CODEX_MODEL ?? config.model, 'Codex config model'),
    CODEX_REASONING_EFFORT: reasoning,
    VIBE_HARNESS_EVAL_CODEX_BACKEND: backend,
    VIBE_HARNESS_EVAL_PROVIDER_NAME: providerName,
    VIBE_HARNESS_EVAL_PROVIDER_REQUIRES_AUTH: requiresAuth ? '1' : '0',
    VIBE_HARNESS_EVAL_PROVIDER_WIRE_API: provider?.wire_api ?? 'responses',
    VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'codex',
    ...(provider ? { OPENAI_BASE_URL: validateUrl(provider.base_url, 'Codex config provider base_url') } : {}),
    ...(requiresAuth ? { VIBE_HARNESS_EVAL_AUTH_FILE: authFile } : {}),
    ...(env.VIBE_HARNESS_CODEX_COMMAND
      ? { VIBE_HARNESS_CODEX_COMMAND: env.VIBE_HARNESS_CODEX_COMMAND }
      : (typeof configuredCommand === 'string' && configuredCommand !== '' ? { VIBE_HARNESS_CODEX_COMMAND: configuredCommand } : {})),
    ...(env.VIBE_HARNESS_WSL_CODEX_COMMAND ? { VIBE_HARNESS_WSL_CODEX_COMMAND: env.VIBE_HARNESS_WSL_CODEX_COMMAND } : {}),
  };
  return { environment, source: 'codex', unset: ['OPENAI_API_KEY'] };
}

function fromEnvironment({ backend, env }) {
  const reasoning = env.CODEX_REASONING_EFFORT ?? 'medium';
  validateChoice(reasoning, REASONING_EFFORTS, 'CODEX_REASONING_EFFORT');
  if (env.VIBE_HARNESS_EVAL_REQUIRE_BASE_URL === '1' && !env.OPENAI_BASE_URL) {
    throw new Error('OPENAI_BASE_URL is required for this evaluation runtime');
  }
  const environment = {
    CODEX_MODEL: requiredString(env.CODEX_MODEL, 'CODEX_MODEL'),
    CODEX_REASONING_EFFORT: reasoning,
    VIBE_HARNESS_EVAL_CODEX_BACKEND: backend,
    VIBE_HARNESS_EVAL_PROVIDER_NAME: validateProviderIdentifier(env.VIBE_HARNESS_EVAL_PROVIDER_NAME ?? 'vibe-harness-env', 'VIBE_HARNESS_EVAL_PROVIDER_NAME'),
    VIBE_HARNESS_EVAL_PROVIDER_REQUIRES_AUTH: '0',
    VIBE_HARNESS_EVAL_PROVIDER_WIRE_API: validateProviderIdentifier(env.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API ?? 'responses', 'VIBE_HARNESS_EVAL_PROVIDER_WIRE_API'),
    VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'env',
    OPENAI_API_KEY: requiredString(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
    ...(env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: validateUrl(env.OPENAI_BASE_URL, 'OPENAI_BASE_URL') } : {}),
    ...(env.VIBE_HARNESS_CODEX_COMMAND ? { VIBE_HARNESS_CODEX_COMMAND: env.VIBE_HARNESS_CODEX_COMMAND } : {}),
    ...(env.VIBE_HARNESS_WSL_CODEX_COMMAND ? { VIBE_HARNESS_WSL_CODEX_COMMAND: env.VIBE_HARNESS_WSL_CODEX_COMMAND } : {}),
  };
  return { environment, source: 'env', unset: [] };
}

export async function resolveEvalRuntime({
  env = process.env,
  homeDir = os.homedir(),
  needsWrite = false,
  platform = process.platform,
  repetitions = 3,
  resolveCliVersion = defaultCliVersion,
} = {}) {
  const source = validateChoice(env.VIBE_HARNESS_EVAL_RUNTIME_SOURCE ?? 'auto', SOURCES, 'VIBE_HARNESS_EVAL_RUNTIME_SOURCE');
  const configuredBackend = validateChoice(env.VIBE_HARNESS_EVAL_CODEX_BACKEND ?? 'auto', BACKENDS, 'VIBE_HARNESS_EVAL_CODEX_BACKEND');
  const backend = actualBackend(configuredBackend, needsWrite, platform);
  let resolved;
  if (source !== 'env') {
    resolved = await fromCodexConfig({ backend, env, homeDir });
    if (!resolved && source === 'codex') throw new Error('Codex config.toml is required for VIBE_HARNESS_EVAL_RUNTIME_SOURCE=codex');
  }
  resolved ??= fromEnvironment({ backend, env });
  const cliVersion = await resolveCliVersion({ backend, environment: resolved.environment });
  resolved.environment.CODEX_CLI_VERSION = cliVersion;
  resolved.environment.VIBE_HARNESS_EVAL_RUNTIME_HASH = runtimeHash(resolved.environment, repetitions, cliVersion);
  return { ...resolved, backend, cliVersion };
}

export function combineEvalConfigHash(projectConfigHash, runtimeHashValue) {
  return createHash('sha256')
    .update(projectConfigHash)
    .update('\0')
    .update(runtimeHashValue || 'runtime-unspecified')
    .digest('hex');
}
