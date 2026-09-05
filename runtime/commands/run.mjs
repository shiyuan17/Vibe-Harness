#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 8 * 1024;
const CHECK_ORDER = ['lint', 'typecheck', 'test', 'eval'];
const CONFIG_FILE = 'vibe-harness.config.json';

const shellControlPattern = /(?:&&|\|\||[;|&<>`$])|\$\(/u;
const sensitiveKeyPattern = /(?:api[-_]?key|auth(?:orization|token)?|cookie|credential|password|secret|session|token|username)/iu;

function normalizePath(value) {
  return String(value).replaceAll('\\', '/');
}

function redactText(value, targetDir) {
  if (value === undefined || value === null) return '';
  const projectPath = path.resolve(targetDir);
  let result = String(value);
  for (const variant of [projectPath, normalizePath(projectPath)]) {
    result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '<project>');
  }
  return result
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[-_]?key|password|secret|token)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/\b([a-z0-9_-]*(?:api[-_]?key|auth(?:orization|token)?|cookie|credential|password|secret|session|token|username)[a-z0-9_-]*=)[^\s/]+/giu, '$1[REDACTED]')
    .trim();
}

function boundedOutput(value, targetDir) {
  const text = redactText(value, targetDir);
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}

function splitCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('Command is empty.');
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (tokens.length === 0) throw new Error('Command is empty.');
  return tokens;
}

export function assertSafeCommand(command) {
  const tokens = splitCommand(command);
  for (const token of tokens) {
    if (shellControlPattern.test(token)) {
      const error = new Error('Command contains shell metacharacters and cannot be executed safely.');
      error.code = 'VIBE_HARNESS_UNSAFE_COMMAND';
      throw error;
    }
  }
  return tokens;
}

function parseArgs(argv) {
  const args = { _: [], json: false, plan: false, allowManual: false, only: null };
  const aliases = new Map([
    ['allow-manual', 'allowManual'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (raw === 'json' || raw === 'plan' || raw === 'allow-manual') {
      args[aliases.get(raw) ?? raw] = true;
      continue;
    }
    const equals = raw.indexOf('=');
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    if (key === 'project' || key === 'base') args[key] = value;
    else if (key === 'only') args.only = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (key === 'timeout') args.timeout = Number.parseInt(value, 10);
    else if (key === 'output') args.output = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

async function readJsonIfExists(filePath) {
  try {
    return { exists: true, value: JSON.parse(await readFile(filePath, 'utf8')), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null, error: null };
    return { exists: true, value: null, error: redactText(error.message, path.dirname(filePath)) };
  }
}

async function runFile(program, args, { cwd, timeoutMs = 10_000 } = {}) {
  try {
    const result = await execFileAsync(program, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, error, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function probeExecutable(program, cwd) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await runFile(locator, [program], { cwd, timeoutMs: 5_000 });
  return result.ok;
}

async function runGit(args, cwd) {
  return runFile('git', args, { cwd, timeoutMs: 15_000 });
}

function parseStatusPorcelain(value) {
  const records = String(value ?? '').split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const firstPath = normalizePath(record.slice(3));
    const rename = status.includes('R') || status.includes('C');
    const nextPath = rename ? normalizePath(records[++index] ?? '') : null;
    changes.push({
      status,
      path: firstPath,
      ...(nextPath ? { newPath: nextPath } : {}),
    });
  }
  return changes;
}

function parseNameStatus(value) {
  const records = String(value ?? '').split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const parts = record.split('\t');
    const status = parts[0] ?? '';
    if (parts.length > 1) {
      changes.push({ status, path: normalizePath(parts[1]) });
      continue;
    }
    const pathValue = normalizePath(records[++index] ?? '');
    if (/^[RC]\d{3}$/u.test(status)) {
      const newPath = normalizePath(records[++index] ?? '');
      changes.push({ status, path: newPath, oldPath: pathValue });
    } else if (/^[A-Z?]{1,2}$/u.test(status)) {
      changes.push({ status, path: pathValue });
    }
  }
  return changes;
}

async function gitSnapshot(projectDir) {
  const root = await runGit(['rev-parse', '--show-toplevel'], projectDir);
  if (!root.ok) return { available: false, reason: 'not-a-git-worktree', changes: [] };
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], projectDir);
  const head = await runGit(['rev-parse', 'HEAD'], projectDir);
  return {
    available: status.ok,
    root: status.ok ? normalizePath(root.stdout.trim()) : null,
    head: head.ok ? head.stdout.trim() : null,
    changes: status.ok ? parseStatusPorcelain(status.stdout) : [],
    reason: status.ok ? null : 'git-status-failed',
  };
}

async function gitFingerprint(projectDir) {
  const snapshot = await gitSnapshot(projectDir);
  if (!snapshot.available) return { snapshot, fingerprint: null };
  const hash = createHash('sha256');
  hash.update(snapshot.head ?? '');
  hash.update(JSON.stringify(snapshot.changes));
  return { snapshot, fingerprint: hash.digest('hex') };
}

function packageManager(packageJson, projectDir) {
  if (typeof packageJson?.packageManager === 'string') return packageJson.packageManager.split('@')[0];
  if (packageJson?.engines?.pnpm) return 'pnpm';
  return null;
}

async function projectContext(projectDir) {
  const packageInfo = await readJsonIfExists(path.join(projectDir, 'package.json'));
  const configInfo = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
  const config = configInfo.value && typeof configInfo.value === 'object' && !Array.isArray(configInfo.value)
    ? configInfo.value
    : {};
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
  const topLevel = entries
    .filter((entry) => !['.git', '.agents', '.vibe-harness', 'node_modules'].includes(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 200);
  const commands = config.validationCommands && typeof config.validationCommands === 'object'
    ? config.validationCommands
    : {};
  return {
    project: '.',
    package: {
      exists: packageInfo.exists,
      name: typeof packageInfo.value?.name === 'string' ? packageInfo.value.name : null,
      packageManager: packageManager(packageInfo.value, projectDir),
      scripts: packageInfo.value?.scripts && typeof packageInfo.value.scripts === 'object'
        ? Object.keys(packageInfo.value.scripts).sort()
        : [],
    },
    config: {
      path: CONFIG_FILE,
      exists: configInfo.exists,
      validJson: configInfo.exists && !configInfo.error,
      profile: typeof config.profile === 'string' ? config.profile : null,
      targets: Array.isArray(config.targets) ? config.targets : [],
      validationChecks: CHECK_ORDER.filter((name) => typeof commands[name] === 'string' && commands[name].trim()),
    },
    topLevel,
  };
}

function timeoutValue(value) {
  return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function configuredChecks(config) {
  const raw = config?.validationCommands;
  if (raw === undefined) return { commands: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { commands: {}, error: 'validationCommands must be an object.' };
  }
  const commands = {};
  for (const name of CHECK_ORDER) {
    const value = raw[name];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') return { commands: {}, error: `validationCommands.${name} must be a string or null.` };
    commands[name] = value.trim();
  }
  return { commands, error: null };
}

function manualCommand(command) {
  return command.startsWith('manual:') ? command.slice('manual:'.length).trim() : null;
}

function displayCommand(command, targetDir) {
  return boundedOutput(command, targetDir);
}

async function executeCommand(command, targetDir, timeoutMs) {
  const tokens = assertSafeCommand(command);
  let [program, ...args] = tokens;
  if (process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(program)) {
    program = 'cmd.exe';
    args = ['/c', `${tokens[0]}.cmd`, ...args];
  } else if (program === 'node') {
    program = process.execPath;
  }
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: targetDir,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: boundedOutput(stdout, targetDir), stderr: boundedOutput(stderr, targetDir) });
    };
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      }, 250).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const append = (stream, chunk) => {
      bytes += chunk.length;
      if (stream === 'stdout') stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      else stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      if (bytes > MAX_OUTPUT_BYTES) terminate();
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => finish({ status: 'failed', code: error.code ?? 'START_FAILED', exitCode: null }));
    child.once('close', (code, signal) => {
      if (timedOut) finish({ status: 'failed', code: 'TIMEOUT', exitCode: null, signal });
      else if (bytes > MAX_OUTPUT_BYTES) finish({ status: 'failed', code: 'OUTPUT_LIMIT', exitCode: null, signal });
      else finish({ status: code === 0 ? 'passed' : 'failed', code: code === 0 ? null : 'COMMAND_FAILED', exitCode: code, signal });
    });
  });
}

async function verifyProject(projectDir, args, { planOnly = false } = {}) {
  const configInfo = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
  const config = configInfo.value && typeof configInfo.value === 'object' ? configInfo.value : {};
  const configured = configuredChecks(config);
  const only = args.only;
  const unknownOnly = only?.filter((name) => !CHECK_ORDER.includes(name)) ?? [];
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
  const checks = {};
  if (configured.error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'verify', status: 'failed', error: configured.error, checks: {} };
  }
  if (unknownOnly.length > 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'verify', status: 'failed', error: `Unknown checks: ${unknownOnly.join(', ')}`, checks: {} };
  }
  if (only && only.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'verify', status: 'failed', error: '--only requires at least one check.', checks: {} };
  }
  const selectedNames = CHECK_ORDER.filter((name) => !only || only.includes(name));
  const before = planOnly ? null : await gitFingerprint(projectDir);
  let selectedCount = 0;
  for (const name of CHECK_ORDER) {
    const command = configured.commands[name];
    if (!command) {
      checks[name] = { status: 'not_configured' };
      continue;
    }
    if (!selectedNames.includes(name)) {
      checks[name] = { status: 'not_selected', command: displayCommand(command, projectDir) };
      continue;
    }
    selectedCount += 1;
    const manual = manualCommand(command);
    const executableCommand = manual ?? command;
    let tokens;
    try {
      tokens = assertSafeCommand(executableCommand);
    } catch (error) {
      checks[name] = { status: 'blocked', code: error.code ?? 'UNSAFE_COMMAND', command: displayCommand(command, projectDir) };
      continue;
    }
    if (manual && !args.allowManual) {
      checks[name] = { status: 'blocked', code: 'MANUAL_REQUIRES_ALLOW', command: displayCommand(command, projectDir) };
      continue;
    }
    if (!await probeExecutable(tokens[0] === 'node' ? process.execPath : tokens[0], projectDir)) {
      checks[name] = { status: 'blocked', code: 'MISSING_EXECUTABLE', command: displayCommand(command, projectDir) };
      continue;
    }
    if (planOnly) {
      checks[name] = { status: 'planned', command: displayCommand(command, projectDir) };
      continue;
    }
    const result = await executeCommand(executableCommand, projectDir, timeoutMs);
    checks[name] = {
      status: result.status,
      code: result.code,
      command: displayCommand(command, projectDir),
      exitCode: result.exitCode,
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  }
  if (selectedCount === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'verify', status: 'unverified', checks, error: 'No configured checks selected.' };
  }
  if (planOnly) {
    return { schemaVersion: SCHEMA_VERSION, command: 'verify', status: 'planned', timeoutMs, checks };
  }
  const after = await gitFingerprint(projectDir);
  const stable = before.fingerprint !== null && after.fingerprint !== null
    ? before.fingerprint === after.fingerprint
    : null;
  const failed = Object.values(checks).some((item) => ['blocked', 'failed'].includes(item.status));
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'verify',
    status: failed || stable === false ? 'failed' : 'passed',
    timeoutMs,
    checks,
    verification: {
      before: before.snapshot,
      after: after.snapshot,
      stable,
      status: stable === false ? 'workspace_changed' : failed ? 'checks_failed' : 'verified',
    },
  };
}

async function envReport(projectDir) {
  const context = await projectContext(projectDir);
  const programs = new Set(['node', 'git']);
  if (context.package.packageManager) programs.add(context.package.packageManager);
  const availability = {};
  for (const program of programs) availability[program] = await probeExecutable(program, projectDir);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'env',
    status: 'ready',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    executables: availability,
    config: context.config,
  };
}

async function changesReport(projectDir, args) {
  const snapshot = await gitSnapshot(projectDir);
  const report = { schemaVersion: SCHEMA_VERSION, command: 'changes', status: snapshot.available ? 'ready' : 'unavailable', ...snapshot };
  delete report.root;
  if (args.base && snapshot.available) {
    const diff = await runGit(['diff', '--name-status', '-z', '--find-renames', `${args.base}...HEAD`], projectDir);
    report.base = args.base;
    report.baseDiff = diff.ok ? parseNameStatus(diff.stdout) : [];
    if (!diff.ok) report.baseDiffError = boundedOutput(diff.stderr || diff.error?.message, projectDir);
  }
  return report;
}

function summary(report) {
  const lines = [`command: ${report.command}`, `status: ${report.status}`];
  if (report.command === 'verify') {
    for (const [name, item] of Object.entries(report.checks ?? {})) lines.push(`${name}: ${item.status}`);
  }
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}

export async function runCommand(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';
  if (args.output && !['json', 'summary'].includes(args.output)) throw new Error(`Unknown output format: ${args.output}`);
  const projectDir = path.resolve(cwd, args.project ?? '.');
  let report;
  if (command === 'env') report = await envReport(projectDir);
  else if (command === 'context') report = { schemaVersion: SCHEMA_VERSION, command, status: 'ready', ...(await projectContext(projectDir)) };
  else if (command === 'changes') report = await changesReport(projectDir, args);
  else if (command === 'verify') report = await verifyProject(projectDir, args, { planOnly: args.plan });
  else if (command === 'help') report = { schemaVersion: SCHEMA_VERSION, command, status: 'ready', usage: 'run.mjs <env|context|changes|verify> --project <path> [--json]' };
  else throw new Error(`Unknown command: ${command}`);
  return { args, report, exitCode: ['passed', 'ready', 'planned'].includes(report.status) ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runCommand(argv);
    const output = result.args.output ?? (result.args.json ? 'json' : 'summary');
    process.stdout.write(output === 'summary' ? `${summary(result.report)}\n` : `${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const report = { schemaVersion: SCHEMA_VERSION, command: 'error', status: 'failed', error: redactText(error.message, process.cwd()) };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : null;
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (entryPath && pathToFileURL(entryPath).href === pathToFileURL(modulePath).href) {
  await main();
}
