// Shared CLI runtime: constants, process/Git primitives and project facts.
//
// Every module that serves a `run.mjs` subcommand reads its project configuration,
// child-process and Git plumbing from here, so the entry file and the command modules
// cannot drift apart on timeouts, status vocabulary or config location.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitSnapshot } from './git-fingerprint.mjs';
import { gitTimeoutMs } from './git-timeouts.mjs';
import { pathKey } from './worktree-audit.mjs';

import { boundedOutput, normalizePath, redactText } from './cli-output.mjs';

const execFileAsync = promisify(execFile);
export const SCHEMA_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const CHECK_ORDER = ['lint', 'typecheck', 'test', 'eval'];
// Report statuses that map to wrapper exit code 0.
export const PASS_STATUSES = ['passed', 'ready', 'planned', 'reused'];
export const CONFIG_FILE = 'vibe-harness.config.json';
const shellControlPattern = /(?:&&|\|\||[;|&<>`$])|\$\(/u;
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
export function parseArgs(argv) {
  const args = { _: [], json: false, plan: false, allowManual: false, only: null, task: [], acceptance: [], decision: [], blocker: [], failure: [], unitStatus: [] };
  const aliases = new Map([
    ['allow-manual', 'allowManual'],
    ['no-numbers', 'numbers'],
    ['no-reuse', 'noReuse'],
    ['no-verify', 'verify'],
    ['clear-blockers', 'clearBlockers'],
  ]);
  const booleanFlags = new Set(['json', 'plan', 'async', 'allow-manual', 'no-numbers', 'no-reuse', 'no-verify', 'strict', 'write', 'help', 'confirm-red-zone', 'reuse', 'push', 'complete', 'dispatch', 'clear-blockers', 'batch', 'all']);
  const valueFlags = new Set(['project', 'base', 'only', 'reviewed', 'timeout', 'output', 'progress', 'tier', 'scope', 'micro', 'task', 'target', 'base-ref', 'target-mode', 'branch-prefix', 'file', 'from', 'to', 'spec', 'root', 'title', 'goal', 'risk-level', 'stage', 'unit', 'unit-status', 'acceptance', 'decision', 'blocker', 'failure', 'next-action', 'verification', 'plan-file', 'reason', 'approval', 'test-path', 'resume']);
  for (const flag of ['delivery', 'receipt', 'merge-evidence', 'mr', 'service', 'port']) valueFlags.add(flag);
  // Repeatable flags collect into arrays so one invocation can carry several
  // values (task ids, acceptance items, decisions, blockers, failures, unit updates).
  const arrayFlags = new Map([
    ['task', args.task],
    ['test-path', args.testPath ??= []],
    ['acceptance', args.acceptance],
    ['decision', args.decision],
    ['blocker', args.blocker],
    ['failure', args.failure],
    ['unit-status', args.unitStatus],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    if (key === 'paths') {
      const values = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) values.push(argv[++index]);
      if (!values.length) throw new Error('--paths requires at least one path.');
      args.paths = [...(args.paths ?? []), ...values];
      continue;
    }
    if (equals === -1 && booleanFlags.has(key)) {
      // `--no-*` flags turn their aliased key off; every other flag turns on.
      const offFlags = new Set(['no-numbers', 'no-verify']);
      args[aliases.get(key) ?? (key === 'confirm-red-zone' ? 'confirmRedZone' : key)] = offFlags.has(key) ? false : true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    if (arrayFlags.has(key)) arrayFlags.get(key).push(value);
    else if (key === 'base-ref') args.baseRef = value;
    else if (key === 'target-mode') args.targetMode = value;
    else if (key === 'branch-prefix') args.branchPrefix = value;
    else if (key === 'file' || key === 'spec' || key === 'root' || key === 'target') args[key] = value;
    else if (key === 'from' || key === 'to') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) throw new Error(`Option --${key} requires an integer.`);
      args[key] = parsed;
    } else if (key === 'project' || key === 'base') args[key] = value;
    else if (key === 'only') args.only = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (key === 'reviewed') args.reviewed = (args.reviewed ?? []).concat(value.split(',').map((item) => item.trim()).filter(Boolean));
    else if (key === 'timeout') args.timeout = Number.parseInt(value, 10);
    else if (key === 'output') args.output = value;
    else if (key === 'tier') args.tier = value;
    else if (key === 'resume') args.resume = value;
    else if (key === 'scope') args.scope = value;
    else if (key === 'micro') args.micro = value;
    else if (key === 'risk-level') args.riskLevel = value;
    else if (key === 'next-action') args.nextAction = value;
    else if (key === 'title' || key === 'goal' || key === 'stage' || key === 'unit' || key === 'verification' || key === 'reason' || key === 'approval') args[key] = value;
    else if (key === 'plan-file') args.planFile = value;
    else if (['delivery', 'receipt', 'merge-evidence', 'mr', 'service', 'port'].includes(key)) args[key] = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}
export async function readJsonIfExists(filePath) {
  try {
    return { exists: true, value: JSON.parse(await readFile(filePath, 'utf8')), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: null, error: null };
    return { exists: true, value: null, error: redactText(error.message, path.dirname(filePath)) };
  }
}
export async function runFile(program, args, { cwd, timeoutMs = 10_000, env = {} } = {}) {
  try {
    const result = await execFileAsync(program, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
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
export async function probeExecutable(program, cwd) {
  if (path.isAbsolute(program)) {
    try {
      await access(program);
      return true;
    } catch {
      return false;
    }
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await runFile(locator, [program], { cwd, timeoutMs: 5_000 });
  return result.ok;
}
export async function runGit(args, cwd, options = {}) {
  // Every Git call the runtime makes shares one budget: a call killed mid-flight
  // reports `ok: false`, which the worktree and verification paths read as a
  // missing fact rather than as a failure of the operation being checked.
  return runFile('git', args, { cwd, timeoutMs: gitTimeoutMs(), ...options });
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
export function packageManager(packageJson, projectDir) {
  if (typeof packageJson?.packageManager === 'string') return packageJson.packageManager.split('@')[0];
  if (packageJson?.engines?.pnpm) return 'pnpm';
  return null;
}
export async function projectContext(projectDir) {
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
export async function envReport(projectDir) {
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
export async function changesReport(projectDir, args) {
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
export async function readProjectConfig(projectDir) {
  const info = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
  return info.value && typeof info.value === 'object' && !Array.isArray(info.value) ? info.value : {};
}
export function normalizeSlashes(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
}
export function isInsidePath(candidate, parent) {
  const child = pathKey(candidate);
  const base = pathKey(parent);
  return child !== base && child.startsWith(`${base}/`);
}
export function safeRealpath(target) {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return null;
  }
}
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
