#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parseWorktreeList, pathKey, resolveWorktreeRoot, summarizeWorktreeAudit, validateWorktrees } from '../lib/worktree-audit.mjs';

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
  const args = { _: [], json: false, plan: false, allowManual: false, only: null, task: [] };
  const aliases = new Map([
    ['allow-manual', 'allowManual'],
    ['no-numbers', 'numbers'],
  ]);
  const booleanFlags = new Set(['json', 'plan', 'allow-manual', 'no-numbers', 'strict', 'write', 'deep']);
  const valueFlags = new Set(['project', 'base', 'only', 'timeout', 'output', 'task', 'base-ref', 'branch-prefix', 'file', 'from', 'to', 'spec', 'root']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    if (equals === -1 && booleanFlags.has(key)) {
      // `--no-numbers` turns numbering off; every other flag turns its key on.
      args[aliases.get(key) ?? key] = key === 'no-numbers' ? false : true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    if (key === 'task') args.task.push(value);
    else if (key === 'base-ref') args.baseRef = value;
    else if (key === 'branch-prefix') args.branchPrefix = value;
    else if (key === 'file' || key === 'spec' || key === 'root') args[key] = value;
    else if (key === 'from' || key === 'to') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) throw new Error(`Option --${key} requires an integer.`);
      args[key] = parsed;
    } else if (key === 'project' || key === 'base') args[key] = value;
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
  // HEAD plus porcelain status cannot see a file that is already dirty before
  // verification and is rewritten again while the checks run: the status line
  // stays ` M path` and the fingerprint would still claim a stable workspace.
  // Hash the content of every changed path so the receipt matches the claim
  // that the result belongs to the delivered bytes.
  const changes = [...snapshot.changes].sort((left, right) => left.path.localeCompare(right.path));
  for (const change of changes) {
    hash.update(change.status);
    hash.update('\0');
    hash.update(change.path);
    hash.update('\0');
    if (change.newPath) {
      hash.update(change.newPath);
      hash.update('\0');
    }
  }
  for (const relativePath of changedPathList(changes)) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await changedPathContent(snapshot.root ?? projectDir, relativePath));
    hash.update('\0');
  }
  return { snapshot, fingerprint: hash.digest('hex') };
}

function changedPathList(changes) {
  const paths = new Set();
  for (const change of changes) {
    if (change.path) paths.add(change.path);
    if (change.newPath) paths.add(change.newPath);
  }
  return [...paths].sort();
}

async function changedPathContent(rootDir, relativePath) {
  try {
    return await readFile(path.join(rootDir, relativePath));
  } catch {
    // Deleted, unreadable, or otherwise absent paths still contribute a marker
    // so a delete/re-add pair cannot produce the same fingerprint.
    return Buffer.from('<unreadable>', 'utf8');
  }
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

// --- worktree / slice / patch (P0) -----------------------------------------
//
// These commands replace the throwaway scripts an agent used to write into the
// project itself: `git worktree add` plus a hand-built `node_modules` junction
// per worktree, and inline `node -e` snippets that sliced or rewrote files.
// Every command is read-only unless `--write` is passed; nothing here removes a
// branch, and `worktree cleanup` refuses while a branch has not landed.

const IGNORED_SCAN_DIRECTORIES = new Set([
  '.agents', '.git', '.turbo', '.vibe-harness', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);

async function readProjectConfig(projectDir) {
  const info = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
  return info.value && typeof info.value === 'object' && !Array.isArray(info.value) ? info.value : {};
}

function normalizeSlashes(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
}

function isInsidePath(candidate, parent) {
  const child = pathKey(candidate);
  const base = pathKey(parent);
  return child !== base && child.startsWith(`${base}/`);
}

function safeRealpath(target) {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return null;
  }
}

function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_SCAN_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function workspacePatterns(packageJson) {
  const raw = packageJson?.workspaces;
  const patterns = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
  return patterns.filter((item) => typeof item === 'string' && item.trim() !== '');
}

function expandWorkspacePattern(rootDir, pattern) {
  const normalized = normalizeSlashes(pattern).replace(/^\.\//u, '');
  if (normalized.endsWith('/**')) {
    const base = path.resolve(rootDir, normalized.slice(0, -3));
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      for (const name of listDirectories(dir)) {
        const next = path.join(dir, name);
        if (isNestedCheckout(next)) continue;
        found.push(next);
        walk(next, depth + 1);
      }
    };
    walk(base, 0);
    return found;
  }
  if (normalized.endsWith('/*')) {
    const base = path.resolve(rootDir, normalized.slice(0, -2));
    return listDirectories(base)
      .map((name) => path.join(base, name))
      .filter((dir) => !isNestedCheckout(dir));
  }
  return [path.resolve(rootDir, normalized)];
}

/**
 * A directory that owns its own `.git` entry is a separate checkout: a linked
 * worktree, a submodule, or a vendored clone. Its workspace topology belongs to
 * that checkout, so scanning it would report the same package name several
 * times and point a link at another worktree's copy.
 */
function isNestedCheckout(dir) {
  return existsSync(path.join(dir, '.git'));
}

function readPackageJsonSync(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Discover workspace roots and the local packages they declare.
 *
 * A dependency root is a directory that owns a hoisted `node_modules` and a
 * `workspaces` declaration. The local packages are the workspace packages
 * inside it: those must resolve to the worktree's own sources, because Node
 * follows a shared junction back to the main checkout and would otherwise hand
 * a worktree the main checkout's copy.
 */
function discoverWorkspaceTopology(projectDir) {
  const candidates = [];
  const visit = (dir, depth) => {
    const packageJson = readPackageJsonSync(dir);
    if (workspacePatterns(packageJson).length > 0) candidates.push({ dir, packageJson });
    if (depth >= 2) return;
    for (const name of listDirectories(dir)) {
      const next = path.join(dir, name);
      if (isNestedCheckout(next)) continue;
      visit(next, depth + 1);
    }
  };
  visit(projectDir, 0);

  const roots = [];
  const packages = [];
  for (const candidate of candidates) {
    const relativeRoot = normalizeSlashes(path.relative(projectDir, candidate.dir)) || '.';
    roots.push({ dir: relativeRoot, abs: candidate.dir });
    const seen = new Set();
    for (const pattern of workspacePatterns(candidate.packageJson)) {
      for (const dir of expandWorkspacePattern(candidate.dir, pattern)) {
        const key = pathKey(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        const manifest = readPackageJsonSync(dir);
        if (typeof manifest?.name !== 'string' || manifest.name.trim() === '') continue;
        packages.push({
          abs: dir,
          dir: normalizeSlashes(path.relative(projectDir, dir)),
          name: manifest.name.trim(),
          root: relativeRoot,
        });
      }
    }
  }
  return { packages, roots };
}

function readWorktreeConfig(config) {
  const raw = config?.worktree;
  if (raw === undefined) return { value: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, error: 'worktree must be an object.' };
  }
  const value = {};
  for (const key of ['root', 'baseRef']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') return { value: {}, error: `worktree.${key} must be a non-empty string.` };
    value[key] = raw[key].trim();
  }
  for (const key of ['dependencyRoots', 'localPackages']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== 'string' || item.trim() === '')) {
      return { value: {}, error: `worktree.${key} must be an array of non-empty strings.` };
    }
    value[key] = raw[key].map((item) => item.trim());
  }
  return { value, error: null };
}

function resolveWorktreeSettings(projectDir, projectConfig, args) {
  const parsed = readWorktreeConfig(projectConfig);
  if (parsed.error) return { error: parsed.error };
  const configured = parsed.value;
  const discovered = discoverWorkspaceTopology(projectDir);
  const dependencyRoots = (configured.dependencyRoots ?? discovered.roots.map((root) => root.dir))
    .filter((dir) => dir !== '.');
  const wanted = configured.localPackages ? new Set(configured.localPackages) : null;
  const localPackages = discovered.packages.filter((item) => wanted === null || wanted.has(item.name));
  const unknown = wanted === null ? [] : [...wanted].filter((name) => !localPackages.some((item) => item.name === name));
  return {
    baseRef: args.baseRef ?? configured.baseRef ?? 'origin/develop',
    configuredRoot: args.root ?? configured.root ?? null,
    dependencyRoots,
    localPackages,
    projectDir,
    root: resolveWorktreeRoot(projectDir, args.root ?? configured.root),
    unknownLocalPackages: unknown,
  };
}

async function worktreeEntries(projectDir) {
  const top = await runGit(['rev-parse', '--show-toplevel'], projectDir);
  if (!top.ok) return { entries: [], repositoryRoot: null, reason: 'not-a-git-worktree' };
  const listing = await runFile('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: projectDir, timeoutMs: 15_000 });
  if (!listing.ok) return { entries: [], repositoryRoot: normalizePath(top.stdout.trim()), reason: 'worktree-list-failed' };
  return { entries: parseWorktreeList(listing.stdout), repositoryRoot: normalizePath(top.stdout.trim()), reason: null };
}

async function worktreeDirtyMap(entries) {
  const dirty = new Map();
  for (const entry of entries) {
    if (!entry.path || !existsSync(entry.path)) continue;
    const status = await runGit(['status', '--porcelain=v1'], entry.path);
    dirty.set(pathKey(entry.path), status.ok ? status.stdout.trim() !== '' : null);
  }
  return dirty;
}

async function resolveWorktreeIntegration(projectDir, entries, baseRef) {
  const map = new Map();
  const probe = await runGit(['rev-parse', '--verify', '--quiet', baseRef], projectDir);
  if (!probe.ok) return { baseRefResolved: false, map };
  for (const entry of entries) {
    if (entry.primary || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    if (!head.ok) continue;
    const mergeBase = await runGit(['merge-base', entry.branch, baseRef], projectDir);
    const ancestor = await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), baseRef], projectDir);
    map.set(entry.branch, {
      integrated: ancestor.ok,
      mergeBaseSha: mergeBase.ok ? mergeBase.stdout.trim() : null,
      targetRef: baseRef,
    });
  }
  return { baseRefResolved: true, map };
}

function linkDirectory(target, linkPath) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(path.resolve(target), path.resolve(linkPath), type);
}

function ensureRealDirectory(target) {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    return;
  }
  if (lstatSync(target).isSymbolicLink()) {
    // Promote a whole-directory link into a real directory so individual
    // entries can be overridden.
    rmSync(target, { force: true, recursive: true });
    mkdirSync(target, { recursive: true });
  }
}

function packagesForRoot(settings, root) {
  // A package belongs to a dependency root either because its own `workspaces`
  // declaration discovered it there, or because the configured root contains
  // its directory. The second form lets a project name a dependency root that
  // is declared by a parent manifest.
  return settings.localPackages.filter((item) => item.root === root
    || (normalizeSlashes(root) !== '.' && isInsidePath(item.abs, path.resolve(settings.projectDir, root))));
}

/** Link one dependency root of a worktree against the main checkout. */
function linkDependencyRoot(projectDir, worktreePath, settings, root) {
  const mainModules = path.join(projectDir, root, 'node_modules');
  const worktreeModules = path.join(worktreePath, root, 'node_modules');
  const localPackages = packagesForRoot(settings, root);
  if (!existsSync(mainModules)) return { action: 'skipped', reason: `${root}/node_modules is absent in the main checkout`, root };
  if (localPackages.length === 0) {
    if (existsSync(worktreeModules)) rmSync(worktreeModules, { force: true, recursive: true });
    linkDirectory(mainModules, worktreeModules);
    return { action: 'linked', mode: 'directory', root };
  }
  ensureRealDirectory(worktreeModules);
  const localNames = new Set(localPackages.map((item) => item.name));
  const localScopes = new Set(localPackages.filter((item) => item.name.startsWith('@')).map((item) => item.name.split('/')[0]));
  for (const entry of listDirectories(mainModules).concat(listFilesOf(mainModules))) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    if (localScopes.has(entry)) continue;
    const target = path.join(worktreeModules, entry);
    if (existsSync(target)) rmSync(target, { force: true, recursive: true });
    if (localNames.has(entry)) {
      const local = localPackages.find((item) => item.name === entry);
      linkDirectory(path.join(worktreePath, local.dir), target);
      continue;
    }
    linkDirectory(path.join(mainModules, entry), target);
  }
  for (const scope of localScopes) {
    const scopeDir = path.join(worktreeModules, scope);
    mkdirSync(scopeDir, { recursive: true });
    for (const entry of listDirectories(path.join(mainModules, scope))) {
      const name = `${scope}/${entry}`;
      const target = path.join(scopeDir, entry);
      if (existsSync(target)) rmSync(target, { force: true, recursive: true });
      const local = localPackages.find((item) => item.name === name);
      linkDirectory(local ? path.join(worktreePath, local.dir) : path.join(mainModules, scope, entry), target);
    }
    for (const local of localPackages.filter((item) => item.name.startsWith(`${scope}/`))) {
      const target = path.join(scopeDir, local.name.slice(scope.length + 1));
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      linkDirectory(path.join(worktreePath, local.dir), target);
    }
  }
  return { action: 'linked', localPackages: localPackages.map((item) => item.name), mode: 'overlay', root };
}

function listFilesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Remove the dependency links a bootstrap created inside one worktree.
 *
 * `git worktree remove` does not follow a junction, so it deletes the tracked
 * files and then stops, leaving the worktree directory behind. Removing the
 * link directories first lets Git finish the job. Node's recursive removal
 * unlinks a reparse point instead of descending into it, so the main checkout's
 * `node_modules` is never touched.
 */
function removeDependencyLinks(worktreePath, settings) {
  const removed = [];
  for (const root of settings.dependencyRoots) {
    const modules = path.join(worktreePath, root, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!lstatSync(modules).isDirectory()) continue;
    rmSync(modules, { force: true, recursive: true });
    removed.push(`${root}/node_modules`);
  }
  return removed;
}

/** Filesystem evidence for the dependency links of every worktree. */
function worktreeDependencyEvidence(projectDir, entries, settings) {
  const evidence = new Map();
  for (const entry of entries) {
    if (entry.primary || !entry.path || !existsSync(entry.path)) continue;
    const facts = [];
    for (const root of settings.dependencyRoots) {
      const mainModules = path.join(projectDir, root, 'node_modules');
      const worktreeModules = path.join(entry.path, root, 'node_modules');
      if (!existsSync(worktreeModules)) {
        facts.push({ dependencyRoot: root, status: 'missing' });
        continue;
      }
      const localPackages = packagesForRoot(settings, root);
      if (localPackages.length === 0) {
        const resolved = safeRealpath(worktreeModules);
        if (resolved === null || pathKey(resolved) !== pathKey(mainModules)) {
          facts.push({ dependencyRoot: root, resolved, status: 'stale' });
        }
        continue;
      }
      for (const local of localPackages) {
        const linkPath = path.join(worktreeModules, local.name);
        if (!existsSync(linkPath)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, status: 'missing' });
          continue;
        }
        const resolved = safeRealpath(linkPath);
        if (resolved === null || !isInsidePath(resolved, entry.path)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, resolved, status: 'stale' });
        }
      }
    }
    if (facts.length > 0) evidence.set(pathKey(entry.path), facts);
  }
  return evidence;
}

function parseWorktreeTask(value) {
  const parts = String(value).split(':');
  const [id, branch, ...rest] = parts;
  if (!id || id.trim() === '') throw new Error(`--task ${value} has no identifier`);
  return {
    branch: branch === undefined || branch === '' ? null : branch,
    id: id.trim(),
    path: rest.length > 0 ? rest.join(':') : null,
  };
}

async function worktreeListReport(projectDir) {
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'unavailable', error: reason, worktrees: [] };
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'ready', repositoryRoot, worktrees: entries };
}

async function worktreeCheckReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'failed', error: settings.error };
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'unavailable', error: reason };
  const dirty = await worktreeDirtyMap(entries);
  const { baseRefResolved, map } = await resolveWorktreeIntegration(projectDir, entries, settings.baseRef);
  const tasks = args.task.map(parseWorktreeTask).map((task) => ({
    ...task,
    path: task.path ?? path.join(settings.root, task.id),
  }));
  const audit = validateWorktrees(entries, {
    baseRef: settings.baseRef,
    branchPrefix: args.branchPrefix ?? null,
    configuredRoot: settings.root,
    dependencyEvidence: worktreeDependencyEvidence(projectDir, entries, settings),
    dirty,
    integration: map,
    integrationAll: true,
    repositoryRoot,
    tasks,
  });
  if (!baseRefResolved) {
    audit.problems.push({
      code: 'WORKTREE_BASE_REF_UNRESOLVED',
      message: `worktree.baseRef ${settings.baseRef} does not resolve in ${repositoryRoot}; merge-back facts were skipped`,
      severity: 'warning',
    });
    audit.warningCount += 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'check',
    status: audit.ok && !(args.strict && audit.warningCount > 0) ? 'passed' : 'failed',
    audit,
    localPackages: settings.localPackages.map((item) => item.name),
    summary: summarizeWorktreeAudit(audit),
    unknownLocalPackages: settings.unknownLocalPackages,
  };
}

function worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot) {
  const worktreePath = task.path ?? path.join(settings.root, task.id);
  const branch = task.branch ?? `feat/${task.id}-worktree`;
  const steps = [
    {
      command: `git -C ${normalizeSlashes(repositoryRoot)} worktree add ${normalizeSlashes(worktreePath)} -b ${branch} ${settings.baseRef}`,
      kind: 'git-worktree-add',
      path: normalizeSlashes(worktreePath),
    },
  ];
  for (const root of settings.dependencyRoots) {
    const localPackages = packagesForRoot(settings, root);
    steps.push({
      kind: 'link-dependencies',
      localPackages: localPackages.map((item) => item.name),
      mode: localPackages.length > 0 ? 'overlay' : 'directory',
      root,
    });
  }
  return { branch, steps, worktreePath };
}

async function worktreeBootstrapReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: 'bootstrap needs at least one --task <name>[:<branch>[:<path>]]' };
  }
  const { repositoryRoot, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'unavailable', error: reason };
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const plan = worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot);
    if (!args.write) {
      results.push({ ...plan, status: 'planned' });
      continue;
    }
    if (isInsidePath(plan.worktreePath, repositoryRoot)) {
      results.push({ ...plan, error: `${normalizeSlashes(plan.worktreePath)} is inside the repository; use worktree.root outside the project`, status: 'failed' });
      continue;
    }
    const added = await runGit(['worktree', 'add', plan.worktreePath, '-b', plan.branch, settings.baseRef], projectDir);
    if (!added.ok) {
      results.push({ ...plan, error: boundedOutput(added.stderr || added.error?.message || 'git worktree add failed', projectDir), status: 'failed' });
      continue;
    }
    try {
      const links = settings.dependencyRoots.map((root) => linkDependencyRoot(projectDir, plan.worktreePath, settings, root));
      const stale = [];
      for (const root of settings.dependencyRoots) {
        for (const local of packagesForRoot(settings, root)) {
          const linkPath = path.join(plan.worktreePath, root, 'node_modules', local.name);
          const resolved = safeRealpath(linkPath);
          if (resolved === null || !isInsidePath(resolved, plan.worktreePath)) stale.push(local.name);
        }
      }
      if (stale.length > 0) throw new Error(`local packages did not resolve inside the worktree: ${stale.join(', ')}`);
      results.push({ ...plan, links, status: 'passed' });
    } catch (error) {
      // A half-provisioned worktree is worse than none: remove what this run
      // created so the next attempt starts from a known state. `git worktree
      // add -b` above only succeeds when the branch did not exist yet, so the
      // branch is part of this transaction rather than someone else's work.
      await runGit(['worktree', 'remove', '--force', plan.worktreePath], projectDir);
      await runGit(['worktree', 'prune'], projectDir);
      const branchHead = await runGit(['rev-parse', `refs/heads/${plan.branch}`], projectDir);
      const baseHead = await runGit(['rev-parse', settings.baseRef], projectDir);
      const untouched = branchHead.ok && baseHead.ok && branchHead.stdout.trim() === baseHead.stdout.trim();
      const branchDeleted = untouched
        && (await runGit(['branch', '--delete', '--force', plan.branch], projectDir)).ok;
      results.push({
        ...plan,
        branchDeleted,
        error: boundedOutput(error.message, projectDir),
        status: 'failed',
        rolledBack: true,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'bootstrap',
    status: results.every((item) => item.status !== 'failed') ? (args.write ? 'passed' : 'planned') : 'failed',
    results,
    write: Boolean(args.write),
  };
}

async function worktreeCleanupReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: 'cleanup needs at least one --task <name>' };
  }
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'unavailable', error: reason };
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const entry = entries.find((item) => !item.primary && item.path
      && (pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
        || (task.branch !== null && item.branch === task.branch)
        || path.basename(item.path) === task.id));
    if (!entry) {
      results.push({ error: `no worktree matches task ${task.id}`, id: task.id, status: 'failed' });
      continue;
    }
    if (entry.detached || typeof entry.branch !== 'string' || entry.branch === '') {
      results.push({ branch: entry.branch, error: `${entry.path} has no named branch; a detached worktree cannot be proven merged`, id: task.id, path: normalizeSlashes(entry.path), status: 'failed' });
      continue;
    }
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    const ancestor = head.ok ? await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), settings.baseRef], projectDir) : { ok: false };
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    const blocked = [];
    if (!ancestor.ok) blocked.push(`branch ${entry.branch} is not merged into ${settings.baseRef}`);
    if (dirty.ok && dirty.stdout.trim() !== '') blocked.push('the worktree has uncommitted changes');
    if (blocked.length > 0) {
      results.push({ blockers: blocked, branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'planned' });
      continue;
    }
    const removedLinks = removeDependencyLinks(entry.path, settings);
    const removed = await runGit(['worktree', 'remove', entry.path], projectDir);
    if (!removed.ok) {
      results.push({ branch: entry.branch, error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir), id: task.id, path: normalizeSlashes(entry.path), removedLinks, status: 'failed' });
      continue;
    }
    await runGit(['worktree', 'prune'], projectDir);
    results.push({
      branch: entry.branch,
      id: task.id,
      path: normalizeSlashes(entry.path),
      remainingDirectory: existsSync(entry.path),
      removedLinks,
      status: 'passed',
    });
  }
  const failed = results.some((item) => item.status === 'failed' || item.status === 'blocked');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'cleanup',
    status: failed ? 'failed' : args.write ? 'passed' : 'planned',
    results,
    write: Boolean(args.write),
  };
}

async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand}`);
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text) {
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (hadTrailingNewline) lines.pop();
  return { hadTrailingNewline, lines };
}

async function sliceReport(projectDir, args) {
  if (!args.file) return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: 'slice needs --file <path>' };
  const file = path.resolve(projectDir, args.file);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `cannot read ${normalizePath(args.file)}: ${error.code ?? error.message}` };
  }
  const { lines } = splitLines(raw);
  const from = args.from ?? 1;
  const to = args.to ?? lines.length;
  if (!Number.isInteger(from) || from < 1 || to < from || from > lines.length + 1) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `range ${from}-${to} is outside 1-${lines.length}` };
  }
  const numbered = args.numbers !== false;
  const width = String(Math.min(to, lines.length)).length;
  const selected = [];
  for (let index = from; index <= Math.min(to, lines.length); index += 1) {
    const line = lines[index - 1];
    selected.push(numbered ? `${String(index).padStart(width, ' ')} | ${line}` : line);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'slice',
    status: 'ready',
    eol: detectEol(raw) === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(path.relative(projectDir, file) || args.file),
    from,
    lines: selected,
    numbered,
    text: selected.join('\n'),
    to: Math.min(to, lines.length),
    totalLines: lines.length,
  };
}

function applyPatchOps(lines, ops, specDir) {
  const applied = [];
  let current = [...lines];
  let previousStart = Number.POSITIVE_INFINITY;
  for (const [index, op] of ops.entries()) {
    if (!op || typeof op !== 'object') throw Object.assign(new Error(`op[${index}] must be an object`), { code: 'PATCH_OP_INVALID' });
    if (op.kind === 'range') {
      const start = op.startLine;
      const end = op.endLine;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw Object.assign(new Error(`op[${index}] range ${String(start)}-${String(end)} is invalid`), { code: 'PATCH_OP_INVALID' });
      }
      if (start > previousStart) {
        throw Object.assign(new Error(`op[${index}] starts at line ${start} after a later op; list range ops from the highest line number down`), { code: 'PATCH_OP_ORDER_INVALID' });
      }
      previousStart = start;
      const first = current[start - 1];
      const last = current[end - 1];
      if (first === undefined || last === undefined) {
        throw Object.assign(new Error(`op[${index}] range ${start}-${end} is outside the file (${current.length} lines)`), { code: 'PATCH_RANGE_OUT_OF_BOUNDS' });
      }
      if (typeof op.expectStart !== 'string' || !first.includes(op.expectStart)) {
        throw Object.assign(new Error(`op[${index}] start guard failed at line ${start}: ${JSON.stringify(first.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.expectEnd !== 'string' || !last.includes(op.expectEnd)) {
        throw Object.assign(new Error(`op[${index}] end guard failed at line ${end}: ${JSON.stringify(last.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.replaceFrom !== 'string' || op.replaceFrom === '') {
        throw Object.assign(new Error(`op[${index}] needs replaceFrom pointing at a fragment file`), { code: 'PATCH_OP_INVALID' });
      }
      const fragmentPath = path.resolve(specDir, op.replaceFrom);
      let fragmentRaw;
      try {
        fragmentRaw = readFileSync(fragmentPath, 'utf8');
      } catch (error) {
        throw Object.assign(new Error(`op[${index}] cannot read ${op.replaceFrom}: ${error.code ?? error.message}`), { code: 'PATCH_FRAGMENT_UNREADABLE' });
      }
      const { lines: fragment } = splitLines(fragmentRaw);
      current = [...current.slice(0, start - 1), ...fragment, ...current.slice(end)];
      applied.push({ index, kind: 'range', replacedLines: end - start + 1, startLine: start, endLine: end, replacementLines: fragment.length, status: 'applied' });
      continue;
    }
    if (op.kind === 'sequence') {
      const match = Array.isArray(op.match) ? op.match : null;
      const replace = Array.isArray(op.replace) ? op.replace : null;
      if (!match || match.length === 0 || !replace) {
        throw Object.assign(new Error(`op[${index}] needs match and replace line arrays`), { code: 'PATCH_OP_INVALID' });
      }
      const hits = [];
      for (let at = 0; at + match.length <= current.length; at += 1) {
        if (match.every((line, offset) => current[at + offset] === line)) hits.push(at);
      }
      if (hits.length !== 1) {
        throw Object.assign(new Error(`op[${index}] match occurs ${hits.length} times (expected exactly 1)`), { code: 'PATCH_MATCH_NOT_UNIQUE' });
      }
      current = [...current.slice(0, hits[0]), ...replace, ...current.slice(hits[0] + match.length)];
      applied.push({ index, kind: 'sequence', matchLines: match.length, replacementLines: replace.length, startLine: hits[0] + 1, status: 'applied' });
      continue;
    }
    throw Object.assign(new Error(`op[${index}] kind must be "range" or "sequence"`), { code: 'PATCH_OP_INVALID' });
  }
  return { applied, lines: current };
}

async function patchReport(projectDir, args) {
  if (!args.spec) return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'patch needs --spec <spec.json>' };
  const specPath = path.resolve(projectDir, args.spec);
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read spec: ${error.message}` };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.file !== 'string' || !Array.isArray(spec.ops) || spec.ops.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'spec must be { "file": "<path>", "ops": [ ... ] } with at least one op' };
  }
  const specDir = path.dirname(specPath);
  const target = path.resolve(specDir, spec.file);
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read ${normalizePath(spec.file)}: ${error.code ?? error.message}` };
  }
  const eol = detectEol(raw);
  const { hadTrailingNewline, lines } = splitLines(raw);
  let result;
  try {
    result = applyPatchOps(lines, spec.ops, specDir);
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'failed',
      code: error.code ?? 'PATCH_FAILED',
      error: boundedOutput(error.message, projectDir),
      file: normalizePath(spec.file),
      write: Boolean(args.write),
      written: false,
    };
  }
  const nextText = result.lines.join(eol) + (hadTrailingNewline ? eol : '');
  if (!args.write) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'planned',
      dryRun: true,
      eol: eol === '\r\n' ? 'crlf' : 'lf',
      file: normalizePath(spec.file),
      ops: result.applied,
      write: false,
      written: false,
    };
  }
  try {
    writeFileSync(target, nextText);
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot write ${normalizePath(spec.file)}: ${error.code ?? error.message}`, file: normalizePath(spec.file), written: false };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'patch',
    status: 'passed',
    eol: eol === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(spec.file),
    linesAfter: result.lines.length,
    linesBefore: lines.length,
    ops: result.applied,
    write: true,
    written: true,
  };
}

function patchSummary(report) {
  const lines = [`command: ${report.command}`, `status: ${report.status}`];
  if (report.file) lines.push(`file: ${report.file}`);
  if (report.error) lines.push(`error: ${report.error}`);
  for (const op of report.ops ?? []) {
    lines.push(`op[${op.index}] ${op.kind}: ${op.status}${op.startLine ? ` at line ${op.startLine}` : ''}`);
  }
  if (report.written === false && report.status !== 'failed') lines.push('dry run: pass --write to apply');
  return lines.join('\n');
}

function summary(report) {
  if (report.command === 'slice') return report.error ? `command: slice\nstatus: failed\nerror: ${report.error}` : report.text;
  if (report.command === 'patch') return patchSummary(report);
  if (report.command === 'worktree') {
    const lines = [`command: worktree ${report.subcommand ?? ''}`.trim()];
    if (report.error) lines.push(`error: ${report.error}`);
    // The check subcommand already prints a `status:` line through its audit
    // summary, so only the other subcommands carry the receipt status here.
    if (report.summary) lines.push(report.summary);
    else lines.push(`status: ${report.status}`);
    for (const entry of report.worktrees ?? []) {
      lines.push(`worktree: ${entry.path} ${entry.branch ?? '(detached)'}${entry.integrated === true ? ' [merged]' : entry.integrated === false ? ' [merge-back pending]' : ''}`);
    }
    for (const item of report.results ?? []) {
      lines.push(`${item.status}: ${item.id ?? item.path ?? ''} ${item.error ?? ''} ${(item.blockers ?? []).join('; ')}`.trim());
      for (const step of item.steps ?? []) lines.push(`  ${step.kind}${step.command ? `: ${step.command}` : step.root ? `: ${step.root} (${step.mode})` : ''}`);
    }
    return lines.join('\n');
  }
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
  else if (command === 'worktree') report = await worktreeReport(projectDir, args);
  else if (command === 'slice') report = await sliceReport(projectDir, args);
  else if (command === 'patch') report = await patchReport(projectDir, args);
  else if (command === 'help') report = { schemaVersion: SCHEMA_VERSION, command, status: 'ready', usage: 'run.mjs <env|context|changes|verify|worktree|slice|patch> --project <path> [--json]' };
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
