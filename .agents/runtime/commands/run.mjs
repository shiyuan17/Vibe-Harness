#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parseWorktreeList, pathKey, resolveWorktreeRoot, summarizeWorktreeAudit, validateWorktrees } from '../lib/worktree-audit.mjs';
import {
  allocatePortBlock,
  collectWorktreePortEvidence,
  DEFAULT_PORT_BLOCK_SIZE,
  DEFAULT_PORT_ENV_FILE,
  inferPortPlan,
  isPortVariable,
  PORT_LOCK_RELATIVE_PATH,
  PORT_REGISTRY_RELATIVE_PATH,
  portsForBlock,
  readPortRegistry,
  renderWorktreeEnv,
  validatePortRegistry,
} from '../lib/worktree-ports.mjs';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
// Verify receipts are their own contract: v2 keeps `blocked` a distinct
// terminal status instead of folding it into `failed`, adds the cost-tier
// surface (tier, deferredChecks, nextTier) and stamps the producing engine so
// the CLI engine receipt (scripts/vibe-harness.js verify, schemaVersion 2,
// engine 'vibe-harness-cli') can be told apart from this one.
const VERIFY_SCHEMA_VERSION = 2;
const VERIFY_ENGINE = 'vibe-harness-runtime';
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 8 * 1024;
const CHECK_ORDER = ['lint', 'typecheck', 'test', 'eval'];
const VERIFY_TIERS = ['quick', 'standard', 'deep'];
const DEFAULT_VERIFY_TIER = 'quick';
// Slot cost tiers when the project declares no validationCommands.tiers: the
// eval slot replays the offline reference suite, which governance-core.md
// places in the deep layer, so it is deferred rather than run by default.
const DEFAULT_SLOT_TIERS = { lint: 'quick', typecheck: 'quick', test: 'quick', eval: 'deep' };
// Report statuses that map to wrapper exit code 0.
const PASS_STATUSES = ['passed', 'ready', 'planned', 'reused'];
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
  const args = { _: [], json: false, plan: false, allowManual: false, only: null, task: [], acceptance: [], decision: [], blocker: [], failure: [], unitStatus: [] };
  const aliases = new Map([
    ['allow-manual', 'allowManual'],
    ['no-numbers', 'numbers'],
  ]);
  const booleanFlags = new Set(['json', 'plan', 'allow-manual', 'no-numbers', 'strict', 'write', 'help', 'confirm-red-zone', 'reuse']);
  const valueFlags = new Set(['project', 'base', 'only', 'timeout', 'output', 'tier', 'task', 'base-ref', 'branch-prefix', 'file', 'from', 'to', 'spec', 'root', 'title', 'goal', 'risk-level', 'stage', 'unit', 'unit-status', 'acceptance', 'decision', 'blocker', 'failure', 'next-action', 'verification']);
  // Repeatable flags collect into arrays so one invocation can carry several
  // values (task ids, acceptance items, decisions, blockers, failures, unit updates).
  const arrayFlags = new Map([
    ['task', args.task],
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
    if (equals === -1 && booleanFlags.has(key)) {
      // `--no-numbers` turns numbering off; every other flag turns its key on.
      args[aliases.get(key) ?? (key === 'confirm-red-zone' ? 'confirmRedZone' : key)] = key === 'no-numbers' ? false : true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    if (arrayFlags.has(key)) arrayFlags.get(key).push(value);
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
    else if (key === 'tier') args.tier = value;
    else if (key === 'risk-level') args.riskLevel = value;
    else if (key === 'next-action') args.nextAction = value;
    else if (key === 'title' || key === 'goal' || key === 'stage' || key === 'unit' || key === 'verification') args[key] = value;
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

function parseVerifyTier(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (token === '') return DEFAULT_VERIFY_TIER;
  if (VERIFY_TIERS.includes(token)) return token;
  throw new Error(`--tier must be one of ${VERIFY_TIERS.join(', ')}; received ${JSON.stringify(value)}.`);
}

function activeTierNames(tier) {
  return VERIFY_TIERS.slice(0, VERIFY_TIERS.indexOf(tier) + 1);
}

// Slot cost tiers come from the project's declared validationCommands.tiers
// arrays (exact command-string match) with DEFAULT_SLOT_TIERS as the fallback
// for slots the declaration does not cover. `--only` is an explicit
// per-check selection and wins over tier deferral.
function resolveVerifyTierPlan({ commands, tiers, tier, only, projectDir }) {
  const declared = tiers && typeof tiers === 'object' && !Array.isArray(tiers) ? tiers : null;
  const slotTiers = {};
  for (const name of CHECK_ORDER) {
    if (typeof commands[name] !== 'string') continue;
    slotTiers[name] = DEFAULT_SLOT_TIERS[name] ?? 'quick';
    if (!declared) continue;
    for (const tierName of VERIFY_TIERS) {
      const list = declared[tierName];
      if (Array.isArray(list) && list.some((item) => typeof item === 'string' && item.trim() === commands[name])) {
        slotTiers[name] = tierName;
        break;
      }
    }
  }
  const active = new Set(activeTierNames(tier));
  const selectedNames = [];
  const deferredChecks = [];
  for (const name of CHECK_ORDER) {
    if (typeof commands[name] !== 'string') continue;
    if (only && !only.includes(name)) continue;
    if (!only && !active.has(slotTiers[name])) {
      deferredChecks.push({ name, tier: slotTiers[name], command: displayCommand(commands[name], projectDir) });
      continue;
    }
    selectedNames.push(name);
  }
  const nextTier = VERIFY_TIERS.slice(VERIFY_TIERS.indexOf(tier) + 1)
    .find((name) => deferredChecks.some((item) => item.tier === name)) ?? null;
  return { tier, slotTiers, selectedNames, deferredChecks, nextTier };
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
  let tier;
  try {
    tier = parseVerifyTier(args.tier);
  } catch (error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: error.message, checks: {} };
  }
  if (configured.error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: configured.error, checks: {} };
  }
  if (unknownOnly.length > 0) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: `Unknown checks: ${unknownOnly.join(', ')}`, checks: {} };
  }
  if (only && only.length === 0) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: '--only requires at least one check.', checks: {} };
  }
  const tierPlan = resolveVerifyTierPlan({
    commands: configured.commands,
    tiers: config?.validationCommands?.tiers,
    tier,
    only,
    projectDir,
  });
  const selectedNames = tierPlan.selectedNames;
  const deferredNames = new Set(tierPlan.deferredChecks.map((item) => item.name));
  const before = planOnly ? null : await gitFingerprint(projectDir);
  // `--reuse` replays the anchor's most recent passed receipt instead of
  // re-executing the commands when neither the working-tree fingerprint nor
  // the command set changed; any mismatch falls through to a normal run.
  if (!planOnly && args.reuse) {
    let reusable;
    try {
      reusable = await findReusableVerification(projectDir, args.task[0] ?? null, {
        fingerprint: before.fingerprint,
        commandSet: verificationCommandSet(configured.commands, selectedNames, projectDir),
      });
    } catch (error) {
      return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', code: error.code ?? 'TASK_ANCHOR_INVALID', error: boundedOutput(error.message, projectDir), checks: {} };
    }
    if (reusable) {
      const reusedChecks = {};
      for (const name of CHECK_ORDER) {
        const command = configured.commands[name];
        if (!command) {
          reusedChecks[name] = { status: 'not_configured' };
          continue;
        }
        if (!selectedNames.includes(name)) {
          reusedChecks[name] = deferredNames.has(name)
            ? { status: 'deferred', tier: tierPlan.slotTiers[name], command: displayCommand(command, projectDir) }
            : { status: 'not_selected', command: displayCommand(command, projectDir) };
          continue;
        }
        reusedChecks[name] = { status: 'reused', command: displayCommand(command, projectDir) };
      }
      const receipt = reusable.verification;
      return {
        schemaVersion: VERIFY_SCHEMA_VERSION,
        engine: VERIFY_ENGINE,
        command: 'verify',
        tier: tierPlan.tier,
        deferredChecks: tierPlan.deferredChecks,
        nextTier: tierPlan.nextTier,
        status: 'reused',
        reused: {
          taskId: reusable.taskId,
          unitId: reusable.unitId,
          ...(typeof receipt.id === 'string' ? { id: receipt.id } : {}),
          ...(typeof receipt.finishedAt === 'string' ? { finishedAt: receipt.finishedAt } : {}),
          ...(typeof receipt.beforeHead === 'string' ? { beforeHead: receipt.beforeHead } : {}),
          ...(typeof receipt.afterHead === 'string' ? { afterHead: receipt.afterHead } : {}),
          fingerprint: typeof receipt.fingerprint === 'string' ? receipt.fingerprint : null,
          command: typeof receipt.command === 'string' ? receipt.command : null,
          at: typeof receipt.at === 'string' ? receipt.at : null,
        },
        checks: reusedChecks,
      };
    }
  }
  let selectedCount = 0;
  for (const name of CHECK_ORDER) {
    const command = configured.commands[name];
    if (!command) {
      checks[name] = { status: 'not_configured' };
      continue;
    }
    if (!selectedNames.includes(name)) {
      checks[name] = deferredNames.has(name)
        ? { status: 'deferred', tier: tierPlan.slotTiers[name], command: displayCommand(command, projectDir) }
        : { status: 'not_selected', command: displayCommand(command, projectDir) };
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
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', tier: tierPlan.tier, deferredChecks: tierPlan.deferredChecks, nextTier: tierPlan.nextTier, status: 'unverified', checks, error: 'No configured checks selected.' };
  }
  if (planOnly) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', tier: tierPlan.tier, deferredChecks: tierPlan.deferredChecks, nextTier: tierPlan.nextTier, status: 'planned', timeoutMs, checks };
  }
  const after = await gitFingerprint(projectDir);
  const stable = before.fingerprint !== null && after.fingerprint !== null
    ? before.fingerprint === after.fingerprint
    : null;
  // `blocked` (unsafe/manual/missing executable) is a distinct terminal
  // status: it means the check never produced evidence, which is a different
  // statement than a check that ran and failed.
  const failed = Object.values(checks).some((item) => item.status === 'failed');
  const blocked = Object.values(checks).some((item) => item.status === 'blocked');
  return {
    schemaVersion: VERIFY_SCHEMA_VERSION,
    engine: VERIFY_ENGINE,
    command: 'verify',
    tier: tierPlan.tier,
    deferredChecks: tierPlan.deferredChecks,
    nextTier: tierPlan.nextTier,
    status: failed || stable === false ? 'failed' : blocked ? 'blocked' : 'passed',
    timeoutMs,
    checks,
    verification: {
      before: before.snapshot,
      after: after.snapshot,
      stable,
      status: stable === false ? 'workspace_changed' : failed ? 'checks_failed' : blocked ? 'checks_blocked' : 'verified',
      // Receipt identity: governance-core.md references these fields when a
      // delivery cites `vibe-harness verify --project`.
      id: randomUUID(),
      finishedAt: new Date().toISOString(),
      fingerprint: after.fingerprint,
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
  // `ports` and `provision` are fail-closed: a declared but malformed block
  // stops the plan instead of silently falling back to an inferred default,
  // because a wrong block silently hands two worktrees the same dev-server port.
  if (raw.ports !== undefined) {
    if (!raw.ports || typeof raw.ports !== 'object' || Array.isArray(raw.ports)) {
      return { value: {}, error: 'worktree.ports must be an object.' };
    }
    const ports = {};
    if (raw.ports.base !== undefined) {
      if (!Number.isInteger(raw.ports.base) || raw.ports.base < 1 || raw.ports.base > 65_535) {
        return { value: {}, error: 'worktree.ports.base must be an integer between 1 and 65535.' };
      }
      ports.base = raw.ports.base;
    }
    if (raw.ports.blockSize !== undefined) {
      if (!Number.isInteger(raw.ports.blockSize) || raw.ports.blockSize < 1 || raw.ports.blockSize > 1_000) {
        return { value: {}, error: 'worktree.ports.blockSize must be an integer between 1 and 1000.' };
      }
      ports.blockSize = raw.ports.blockSize;
    }
    if (raw.ports.variables !== undefined) {
      if (!Array.isArray(raw.ports.variables)
        || raw.ports.variables.some((item) => typeof item !== 'string' || !isPortVariable(item.trim()))) {
        return { value: {}, error: 'worktree.ports.variables must be an array of port variable names such as PORT or WEB_PORT.' };
      }
      ports.variables = raw.ports.variables.map((item) => item.trim());
    }
    if (raw.ports.envFile !== undefined) {
      if (typeof raw.ports.envFile !== 'string' || raw.ports.envFile.trim() === '' || path.isAbsolute(raw.ports.envFile)) {
        return { value: {}, error: 'worktree.ports.envFile must be a non-empty project-relative path.' };
      }
      ports.envFile = normalizeSlashes(raw.ports.envFile.trim());
    }
    value.ports = ports;
  }
  if (raw.provision !== undefined) {
    if (!raw.provision || typeof raw.provision !== 'object' || Array.isArray(raw.provision)) {
      return { value: {}, error: 'worktree.provision must be an object.' };
    }
    const provision = {};
    if (raw.provision.setupCommands !== undefined) {
      if (!Array.isArray(raw.provision.setupCommands)
        || raw.provision.setupCommands.some((item) => typeof item !== 'string' || item.trim() === '')) {
        return { value: {}, error: 'worktree.provision.setupCommands must be an array of non-empty command strings.' };
      }
      provision.setupCommands = raw.provision.setupCommands.map((item) => item.trim());
    }
    if (raw.provision.envFiles !== undefined) {
      if (!Array.isArray(raw.provision.envFiles)
        || raw.provision.envFiles.some((item) => typeof item !== 'string' || item.trim() === '' || path.isAbsolute(item))) {
        return { value: {}, error: 'worktree.provision.envFiles must be an array of project-relative paths.' };
      }
      provision.envFiles = raw.provision.envFiles.map((item) => normalizeSlashes(item.trim()));
    }
    value.provision = provision;
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
  const ports = configured.ports ?? {};
  const provision = configured.provision ?? {};
  const portPlan = inferPortPlan(projectDir, {
    configuredBase: ports.base ?? null,
    declaredVariables: ports.variables ?? [],
    provisionEnvFiles: provision.envFiles ?? [],
  });
  return {
    baseRef: args.baseRef ?? configured.baseRef ?? 'origin/develop',
    configuredRoot: args.root ?? configured.root ?? null,
    dependencyRoots,
    localPackages,
    ports: {
      base: portPlan.base,
      blockSize: ports.blockSize ?? DEFAULT_PORT_BLOCK_SIZE,
      envFile: ports.envFile ?? DEFAULT_PORT_ENV_FILE,
      files: portPlan.files,
      variables: portPlan.variables,
    },
    provision: {
      envFiles: provision.envFiles ?? [],
      setupCommands: provision.setupCommands ?? [],
    },
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

const PORT_LOCK_TIMEOUT_MS = 5_000;
const PORT_LOCK_RETRY_MS = 50;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Red-zone membership for a project-relative path.
 *
 * docs/rules/governance-core.md makes red-zone writes an explicit confirmation,
 * and `hooks.redZonePaths` is the only declaration that decides membership.
 */
function isRedZonePath(relativePath, patterns) {
  const candidate = normalizeSlashes(relativePath).replace(/^\.\//u, '').toLowerCase();
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const directory = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const body = directory.replace(/\/+$/u, '').toLowerCase().replace(/^\.\//u, '');
    if (body === '') continue;
    if (candidate === body || candidate.startsWith(`${body}/`)) return true;
    if (!body.includes('/') && path.basename(candidate) === body) return true;
  }
  return false;
}

/** Exclusive lock file around every registry read/modify/write. */
async function withPortRegistryLock(projectDir, action, { timeoutMs = PORT_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = path.join(projectDir, PORT_LOCK_RELATIVE_PATH);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
      closeSync(handle);
      held = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') return { error: `cannot create ${PORT_LOCK_RELATIVE_PATH}: ${error.code ?? error.message}` };
      if (Date.now() >= deadline) {
        return {
          code: 'WORKTREE_PORT_LOCK_TIMEOUT',
          error: `${PORT_LOCK_RELATIVE_PATH} is held by another process after ${timeoutMs}ms; the lock is never removed automatically`,
        };
      }
      await delay(PORT_LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    if (held) {
      try {
        rmSync(lockPath, { force: true });
      } catch { /* the lock is advisory; a failed unlink is reported by the next bootstrap */ }
    }
  }
}

function writePortRegistry(projectDir, registry) {
  const file = path.join(projectDir, PORT_REGISTRY_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const entries = [...registry.entries].sort((left, right) => left.block - right.block || left.id.localeCompare(right.id));
  writeFileSync(file, `${JSON.stringify({ ...registry, entries }, null, 2)}\n`, 'utf8');
}

/**
 * Allocate or reuse the worktree's port block from the main checkout registry.
 *
 * The registry is the fact source: a conflict between two entries fails closed
 * instead of silently handing the second worktree a used port.
 */
function planPortAssignment(projectDir, settings, { branch, id, path: worktreePath }) {
  const info = readPortRegistry(projectDir);
  if (info.error) {
    return { code: info.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${info.error}` };
  }
  const registry = info.registry ?? {
    schemaVersion: 1,
    base: settings.ports.base,
    blockSize: settings.ports.blockSize,
    entries: [],
    variables: settings.ports.variables,
  };
  const validated = validatePortRegistry(registry);
  if (!validated.ok) {
    return { code: validated.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${validated.error}` };
  }
  const block = allocatePortBlock(registry, { id });
  const ports = portsForBlock(registry.base, registry.blockSize, block, registry.variables);
  const existing = registry.entries.find((entry) => entry.id === id);
  return {
    block,
    envFile: settings.ports.envFile,
    ports,
    registry: {
      ...registry,
      entries: [
        ...registry.entries.filter((entry) => entry.id !== id),
        { block, branch, id, path: normalizeSlashes(worktreePath), ports, updatedAt: new Date().toISOString() },
      ],
    },
    registryDiffers: !existing
      ? registry.base !== settings.ports.base || registry.blockSize !== settings.ports.blockSize
      : false,
    reused: Boolean(existing),
  };
}

function releasePortRegistryEntry(projectDir, id) {
  return withPortRegistryLock(projectDir, async () => {
    const info = readPortRegistry(projectDir);
    if (!info.registry) return { released: false, reason: info.error ?? 'no registry' };
    const entries = info.registry.entries.filter((entry) => entry.id !== id);
    if (entries.length === info.registry.entries.length) return { released: false, reason: 'no entry' };
    writePortRegistry(projectDir, { ...info.registry, entries });
    return { released: true };
  });
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
  const collected = collectWorktreePortEvidence({
    entries,
    projectDir,
    registryInfo: readPortRegistry(projectDir),
    settings: {
      dependencyRoots: settings.dependencyRoots,
      envFile: settings.ports.envFile,
      envFiles: settings.provision.envFiles,
    },
  });
  // The audit counts severity in one place, so the caller flattens the
  // per-worktree facts into the same problem list the other codes use.
  const portFacts = {
    flat: [...collected.registryProblems, ...[...collected.evidence.values()].flat()],
    summary: collected.summary,
  };
  const audit = validateWorktrees(entries, {
    baseRef: settings.baseRef,
    branchPrefix: args.branchPrefix ?? null,
    configuredRoot: settings.root,
    dependencyEvidence: worktreeDependencyEvidence(projectDir, entries, settings),
    dirty,
    integration: map,
    integrationAll: true,
    portProblems: portFacts.flat,
    portSummary: portFacts.summary,
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
    portRegistry: {
      base: settings.ports.base,
      blockSize: settings.ports.blockSize,
      envFile: settings.ports.envFile,
      exists: readPortRegistry(projectDir).exists,
      path: PORT_REGISTRY_RELATIVE_PATH,
      variables: settings.ports.variables,
    },
    summary: summarizeWorktreeAudit(audit),
    unknownLocalPackages: settings.unknownLocalPackages,
  };
}

/**
 * Six-step bootstrap plan: worktree add, dependency links, port allocation plus
 * env file, declared env files, declared setup commands, toolchain probe.
 *
 * The plan is produced without touching the disk so `--dry-run` and `--write`
 * describe the same steps; only the apply path performs them.
 */
function worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, { confirmRedZone = false, existingEntry = null } = {}) {
  const worktreePath = task.path ?? path.join(settings.root, task.id);
  const branch = task.branch ?? `feat/${task.id}-worktree`;
  const redZonePatterns = readWorktreeRedZone(projectDir);
  const missingRoots = settings.dependencyRoots
    .filter((root) => !existsSync(path.join(projectDir, root, 'node_modules')));
  const setupCommands = settings.provision.setupCommands;
  const writeTargets = [settings.ports.envFile, ...settings.provision.envFiles];
  const redZoneTargets = writeTargets.filter((file) => isRedZonePath(file, redZonePatterns));
  const blocked = [];
  if (missingRoots.length > 0 && setupCommands.length === 0) {
    blocked.push({
      code: 'WORKTREE_MAIN_DEPENDENCIES_MISSING',
      message: `${missingRoots.map((root) => `${root === '.' ? '' : `${root}/`}node_modules`).join(', ')} is absent in the main checkout; run the project's install command there first (or declare worktree.provision.setupCommands so the worktree installs its own dependencies)`,
    });
  }
  if (redZoneTargets.length > 0 && !confirmRedZone) {
    blocked.push({
      code: 'WORKTREE_RED_ZONE_CONFIRMATION_REQUIRED',
      message: `${redZoneTargets.join(', ')} is a red-zone path (hooks.redZonePaths); pass --confirm-red-zone to write it`,
    });
  }
  const steps = [{
    branch,
    command: `git -C ${normalizeSlashes(repositoryRoot)} worktree add ${normalizeSlashes(worktreePath)} -b ${branch} ${settings.baseRef}`,
    kind: existingEntry ? 'reuse-worktree' : 'git-worktree-add',
    path: normalizeSlashes(worktreePath),
  }];
  // A worktree that installs its own dependencies must do that before the links
  // overlay the main checkout, otherwise the setup command deletes the links.
  if (missingRoots.length > 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  for (const root of settings.dependencyRoots) {
    const localPackages = packagesForRoot(settings, root);
    steps.push({
      kind: 'link-dependencies',
      localPackages: localPackages.map((item) => item.name),
      mode: localPackages.length > 0 ? 'overlay' : 'directory',
      root,
    });
  }
  const assignment = planPortAssignment(projectDir, settings, { branch, id: task.id, path: worktreePath });
  if (assignment.error) {
    blocked.push({ code: assignment.code, message: assignment.error });
  } else {
    steps.push({
      block: assignment.block,
      envFile: assignment.envFile,
      kind: 'allocate-ports',
      ports: assignment.ports,
      registry: PORT_REGISTRY_RELATIVE_PATH,
      reused: assignment.reused,
    });
  }
  steps.push({
    files: settings.provision.envFiles,
    kind: 'materialize-env-files',
    redZone: redZoneTargets,
  });
  if (missingRoots.length === 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  steps.push({
    kind: 'probe-toolchain',
    programs: [...new Set(['git', 'node', projectPackageManager(projectDir) ?? 'pnpm'])],
  });
  return {
    blocked,
    branch,
    missingDependencyRoots: missingRoots,
    ports: assignment.error ? null : assignment.ports,
    steps,
    worktreePath,
  };
}

function readWorktreeRedZone(projectDir) {
  try {
    const config = JSON.parse(readFileSync(path.join(projectDir, CONFIG_FILE), 'utf8'));
    return Array.isArray(config?.hooks?.redZonePaths) ? config.hooks.redZonePaths : [];
  } catch {
    return [];
  }
}

function projectPackageManager(projectDir) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    return packageManager(packageJson, projectDir);
  } catch {
    return null;
  }
}

/** Run the declared setup commands inside the new worktree. */
async function runSetupCommands(commands, worktreePath, projectDir, timeoutMs) {
  const results = [];
  for (const command of commands) {
    let tokens;
    try {
      tokens = assertSafeCommand(command);
    } catch (error) {
      return { error: `${command}: ${error.message}`, results, step: { command, kind: 'setup-command', status: 'blocked' } };
    }
    // `--write` is the explicit authorization for this command list; credentials
    // never travel with it, and the receipt carries a redacted tail only.
    const result = await executeCommand(command, worktreePath, timeoutMs);
    results.push({ command, exitCode: result.exitCode, status: result.status, ...(result.code ? { code: result.code } : {}) });
    if (result.status !== 'passed') {
      return {
        error: `${command} ${result.code ?? 'failed'}${result.stderr ? `: ${result.stderr}` : ''}`,
        results,
        step: { command, code: result.code ?? 'COMMAND_FAILED', kind: 'setup-command', status: 'failed' },
      };
    }
  }
  return { error: null, results, step: null };
}

async function worktreeBootstrapReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: 'bootstrap needs at least one --task <name>[:<branch>[:<path>]]' };
  }
  const { entries, repositoryRoot, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'unavailable', error: reason };
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const existing = entries.find((entry) => !entry.primary
      && entry.path
      && pathKey(entry.path) === pathKey(task.path ?? path.join(settings.root, task.id)));
    const plan = worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, {
      confirmRedZone: Boolean(args.confirmRedZone),
      existingEntry: existing ?? null,
    });
    if (args.write && isInsidePath(plan.worktreePath, repositoryRoot)) {
      results.push({ ...plan, error: `${normalizeSlashes(plan.worktreePath)} is inside the repository; use worktree.root outside the project`, status: 'failed' });
      continue;
    }
    const blockedError = plan.blocked[0];
    if (blockedError) {
      results.push({ ...plan, code: blockedError.code, error: blockedError.message, status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ ...plan, ports: plan.ports, status: 'planned' });
      continue;
    }
    if (!existing) {
      const added = await runGit(['worktree', 'add', plan.worktreePath, '-b', plan.branch, settings.baseRef], projectDir);
      if (!added.ok) {
        results.push({ ...plan, error: boundedOutput(added.stderr || added.error?.message || 'git worktree add failed', projectDir), status: 'failed' });
        continue;
      }
    }
    try {
      // A worktree that has to install its own dependencies runs the declared
      // setup commands before the links are overlaid on top of them.
      const setupFirst = plan.missingDependencyRoots.length > 0;
      let setup = { error: null, results: [], step: null };
      if (setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }
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

      // The registry entry is written inside the lock so two concurrent
      // bootstraps can never pick the same block.
      const allocation = await withPortRegistryLock(projectDir, async () => {
        const assignment = planPortAssignment(projectDir, settings, { branch: plan.branch, id: task.id, path: plan.worktreePath });
        if (assignment.error) return { error: assignment.error, code: assignment.code };
        writePortRegistry(projectDir, assignment.registry);
        const envPath = path.join(plan.worktreePath, assignment.envFile);
        mkdirSync(path.dirname(envPath), { recursive: true });
        writeFileSync(envPath, renderWorktreeEnv({ block: assignment.block, id: task.id, ports: assignment.ports }), 'utf8');
        return { block: assignment.block, envFile: assignment.envFile, ports: assignment.ports, reused: assignment.reused };
      });
      if (allocation.error) throw Object.assign(new Error(allocation.error), { code: allocation.code });

      const envFiles = [];
      for (const file of settings.provision.envFiles) {
        const source = path.join(projectDir, file);
        const target = path.join(plan.worktreePath, file);
        if (existsSync(target)) {
          envFiles.push({ file, status: 'present' });
          continue;
        }
        if (!existsSync(source)) {
          envFiles.push({ file, reason: 'absent in the main checkout', status: 'skipped' });
          continue;
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
        envFiles.push({ file, status: 'materialized' });
      }

      if (!setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }

      const toolchain = {};
      for (const program of plan.steps.find((step) => step.kind === 'probe-toolchain').programs) {
        toolchain[program] = await probeExecutable(program, plan.worktreePath);
      }
      results.push({
        ...plan,
        allocation,
        envFiles,
        links,
        setupCommands: setup.results,
        status: 'passed',
        toolchain,
      });
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
      const released = await releasePortRegistryEntry(projectDir, task.id);
      results.push({
        ...plan,
        branchDeleted,
        code: error.code ?? 'BOOTSTRAP_FAILED',
        error: boundedOutput(error.message, projectDir),
        released: released.released === true,
        status: 'failed',
        rolledBack: true,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'bootstrap',
    status: results.every((item) => !['failed', 'blocked'].includes(item.status)) ? (args.write ? 'passed' : 'planned') : 'failed',
    ports: settings.ports,
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
    // The block is released inside the same lock that hands it out; the branch
    // itself is still never deleted here.
    const released = await releasePortRegistryEntry(projectDir, task.id);
    results.push({
      branch: entry.branch,
      id: task.id,
      path: normalizeSlashes(entry.path),
      portBlockReleased: released.released === true,
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

/**
 * Crash recovery for worktree provisioning (docs/rules/git-rules.md §Worktree).
 *
 * A hard kill bypasses the in-process rollback a failed bootstrap runs, so the
 * repository can be left with prunable worktree residue (directory gone, Git
 * metadata and branch binding left), worktrees whose provisioning stopped
 * before the locked registry/env write, zero-commit branches only that residue
 * still references, and registry entries whose worktree no longer exists.
 * Every category is detected from evidence (git listings, the port registry,
 * the filesystem) and nothing is touched without `--write`; a branch is only
 * ever deleted after being proven to sit at the base ref with a clean tree,
 * so no work can be lost.
 */
async function worktreeRecoverReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed', error: settings.error };
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'unavailable', error: reason };
  const registry = readPortRegistry(projectDir).registry ?? null;
  const registryEntryFor = (worktree) => (registry?.entries ?? []).find((item) => item.id === path.basename(worktree.path)
    || (item.path && pathKey(item.path) === pathKey(worktree.path))
    || (item.branch && item.branch === worktree.branch)) ?? null;
  const baseHead = await runGit(['rev-parse', '--verify', '--quiet', settings.baseRef], projectDir);
  const baseSha = baseHead.ok ? baseHead.stdout.trim() : null;
  // Without a resolvable base ref nothing can be proven untouched, so the two
  // categories that delete branches stay empty; `worktree check` is the command
  // that reports WORKTREE_BASE_REF_UNRESOLVED.
  const branchUntouched = async (branch) => {
    if (baseSha === null) return false;
    const head = await runGit(['rev-parse', `refs/heads/${branch}`], projectDir);
    return head.ok && head.stdout.trim() === baseSha;
  };

  const prunable = entries.filter((entry) => !entry.primary && entry.prunable);
  const liveEntries = entries.filter((entry) => !entry.prunable);

  // Incomplete worktrees: a bootstrap that died between `git worktree add` and
  // the locked registry/env write leaves a worktree that is clean, still at the
  // base ref, and missing the registry entry or the port env file (a successful
  // bootstrap always writes both). Attribution requires the worktree to sit
  // under the configured root or carry a registry entry, so foreign worktrees
  // are never touched.
  const incomplete = [];
  for (const entry of entries) {
    if (entry.primary || entry.prunable || entry.detached || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const registryEntry = registryEntryFor(entry);
    if (!isInsidePath(entry.path, settings.root) && !registryEntry) continue;
    const envFilePresent = existsSync(path.join(entry.path, settings.ports.envFile));
    if (envFilePresent && registryEntry) continue;
    if (!await branchUntouched(entry.branch)) continue;
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    if (!dirty.ok || dirty.stdout.trim() !== '') continue;
    incomplete.push({
      branch: entry.branch,
      envFilePresent,
      id: registryEntry?.id ?? path.basename(entry.path),
      path: entry.path,
      registryEntryId: registryEntry?.id ?? null,
    });
  }

  // Zero-commit branches nothing checks out, referenced only by residue. The
  // prunable listing is the attribution evidence that the bootstrap created the
  // branch, so this must be detected before prune removes that listing;
  // unreferenced branches are user placeholders and are never deleted. Bindings
  // that only a prunable listing still holds are freed by the prune below, so
  // those branches are cleanup candidates here; every other binding (primary,
  // live or incomplete worktree) keeps its branch out of cleanup.
  const checkedOut = new Set(entries
    .filter((entry) => !entry.prunable && typeof entry.branch === 'string' && entry.branch !== '')
    .map((entry) => entry.branch));
  const branchListing = await runGit(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], projectDir);
  const orphanedBranches = [];
  if (branchListing.ok) {
    for (const branch of branchListing.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      if (checkedOut.has(branch) || branch === settings.baseRef) continue;
      if (!await branchUntouched(branch)) continue;
      const evidence = (registry?.entries ?? []).some((item) => item.branch === branch) ? 'registry'
        : prunable.some((item) => item.branch === branch) ? 'prunable'
        : null;
      if (evidence === null) continue;
      orphanedBranches.push({ branch, evidence });
    }
  }

  // Registry entries no surviving worktree claims. A prunable worktree is
  // already gone from the filesystem, so its entry only leaks the port block;
  // an entry matched by an incomplete worktree is released by that worktree's
  // own rollback instead.
  const orphanedRegistry = [];
  for (const item of registry?.entries ?? []) {
    const claimed = liveEntries.some((entry) => !entry.primary && (
      item.id === path.basename(entry.path)
      || (item.path && pathKey(item.path) === pathKey(entry.path))
      || (item.branch && item.branch === entry.branch)
    ));
    if (!claimed) orphanedRegistry.push({ id: item.id, path: item.path ?? null });
  }

  // Apply: incomplete worktrees first (each removal is its own rollback), then
  // one prune for the residue, then branch deletes (prune is what frees the
  // bindings the prunable listing held), then registry releases.
  const results = [];
  for (const item of incomplete) {
    if (!args.write) {
      results.push({ ...item, status: 'planned' });
      continue;
    }
    const removedLinks = removeDependencyLinks(item.path, settings);
    const removed = await runGit(['worktree', 'remove', '--force', item.path], projectDir);
    if (!removed.ok) {
      results.push({
        ...item,
        code: 'WORKTREE_RECOVER_REMOVE_FAILED',
        error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir),
        removedLinks,
        status: 'failed',
      });
      continue;
    }
    const branchDeleted = (await runGit(['branch', '--delete', '--force', item.branch], projectDir)).ok;
    const released = item.registryEntryId !== null
      ? await releasePortRegistryEntry(projectDir, item.registryEntryId)
      : { released: false };
    const errors = [];
    if (!branchDeleted) errors.push(`branch ${item.branch} could not be deleted`);
    if (item.registryEntryId !== null && released.released !== true) errors.push(`registry entry ${item.registryEntryId} not released`);
    results.push({
      ...item,
      ...(errors.length > 0 ? { code: 'WORKTREE_RECOVER_PARTIAL', error: errors.join('; ') } : {}),
      branchDeleted,
      portBlockReleased: released.released === true,
      removedLinks,
      status: errors.length === 0 ? 'passed' : 'failed',
    });
  }

  let pruned = null;
  if (args.write && (prunable.length > 0 || incomplete.length > 0)) {
    pruned = (await runGit(['worktree', 'prune'], projectDir)).ok;
  }

  const branchResults = [];
  for (const item of orphanedBranches) {
    if (!args.write) {
      branchResults.push({ ...item, status: 'planned' });
      continue;
    }
    const deleted = await runGit(['branch', '--delete', '--force', item.branch], projectDir);
    branchResults.push(deleted.ok
      ? { ...item, status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_BRANCH_FAILED',
        error: boundedOutput(deleted.stderr || deleted.error?.message || 'git branch --delete failed', projectDir),
        status: 'failed',
      });
  }

  const registryResults = [];
  for (const item of orphanedRegistry) {
    if (!args.write) {
      registryResults.push({ ...item, status: 'planned' });
      continue;
    }
    const released = await releasePortRegistryEntry(projectDir, item.id);
    registryResults.push(released.released === true
      ? { ...item, status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_RELEASE_FAILED',
        error: released.reason ?? released.error ?? 'registry entry not released',
        status: 'failed',
      });
  }

  const failed = [...results, ...branchResults, ...registryResults].some((item) => item.status === 'failed')
    || (args.write && prunable.length > 0 && pruned !== true);
  const summary = [
    `status: ${failed ? 'failed' : args.write ? 'passed' : 'planned'} (write: ${Boolean(args.write)})`,
    `prunable residue: ${prunable.length}${prunable.length > 0 ? ` (${prunable.map((item) => item.path).join(', ')})` : ''}`,
    ...results.map((item) => `incomplete: ${item.path} branch ${item.branch} ${item.status}`),
    ...branchResults.map((item) => `branch: ${item.branch} ${item.status}${item.evidence ? ` [${item.evidence}]` : ''}${item.error ? ` (${item.error})` : ''}`),
    ...registryResults.map((item) => `registry entry: ${item.id} ${item.status}`),
  ].join('\n');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'recover',
    status: failed ? 'failed' : args.write ? 'passed' : 'planned',
    baseRef: settings.baseRef,
    orphanedBranches: branchResults,
    orphanedRegistry: registryResults,
    prunable: prunable.map((item) => ({
      branch: item.branch,
      path: item.path,
      reason: typeof item.prunable === 'string' ? item.prunable : 'worktree directory missing',
    })),
    pruned: args.write ? pruned : null,
    results,
    summary,
    write: Boolean(args.write),
  };
}

async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  if (subcommand === 'recover') return worktreeRecoverReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand} (expected list, check, bootstrap, cleanup or recover)`);
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

// --- task anchors ------------------------------------------------------------
//
// `task` persists one JSON anchor per long-running task under
// `.vibe-harness/tasks/` so a compacted or resumed session can recover from
// the anchor plus the current diff without re-reading rule bodies or the full
// report. init and update stay read-only until --write; status and list never
// write. A damaged anchor is rejected, never silently rebuilt.

const TASK_SCHEMA_VERSION = 1;
const TASKS_RELATIVE_DIR = '.vibe-harness/tasks';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const TASK_STAGES = ['review', 'plan', 'implement', 'verify'];
const TASK_UNIT_STATUSES = ['pending', 'in_progress', 'done', 'blocked'];
const TASK_RISK_LEVELS = ['quick', 'light', 'full'];
const DEFAULT_TASK_RISK_LEVEL = 'light';
const INITIAL_TASK_STAGE = 'plan';

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || WINDOWS_RESERVED_NAMES.test(taskId)) {
    throw Object.assign(
      new Error(`Invalid task id ${JSON.stringify(String(taskId))}: expected 1-64 characters from [A-Za-z0-9._-], starting alphanumeric, and not a reserved device name`),
      { code: 'VIBE_HARNESS_INVALID_TASK_ID' },
    );
  }
  return taskId;
}

function taskAnchorPath(projectDir, taskId) {
  return path.join(projectDir, TASKS_RELATIVE_DIR, `${taskId}.json`);
}

function taskAnchorRelativePath(taskId) {
  return `${TASKS_RELATIVE_DIR}/${taskId}.json`;
}

async function readTaskAnchor(projectDir, taskId) {
  validateTaskId(taskId);
  const filePath = taskAnchorPath(projectDir, taskId);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, anchor: null, filePath };
    throw Object.assign(
      new Error(`cannot read ${taskAnchorRelativePath(taskId)}: ${error.code ?? error.message}`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_UNREADABLE' },
    );
  }
  let anchor;
  try {
    anchor = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(
      new Error(`${taskAnchorRelativePath(taskId)} is not valid JSON: ${error.message}`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_INVALID' },
    );
  }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
    || typeof anchor.taskId !== 'string' || anchor.taskId !== taskId
    || !Number.isInteger(anchor.schemaVersion)) {
    throw Object.assign(
      new Error(`${taskAnchorRelativePath(taskId)} is not a task anchor (expected taskId ${JSON.stringify(taskId)} and an integer schemaVersion)`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_INVALID' },
    );
  }
  return { exists: true, anchor, filePath };
}

function writeTaskAnchor(filePath, anchor) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Idempotency probe: updatedAt and sessions grow with every real write, so
// they are excluded when deciding whether an update changed anything.
function anchorSignature(anchor) {
  const clone = { ...(anchor ?? {}) };
  delete clone.updatedAt;
  delete clone.sessions;
  return stableStringify(clone);
}

function taskFailure(subcommand, message, code) {
  return { schemaVersion: SCHEMA_VERSION, command: 'task', subcommand, status: 'failed', ...(code ? { code } : {}), error: message };
}

function upsertTaskUnit(units, unitId) {
  let unit = units.find((item) => item && item.id === unitId);
  if (!unit) {
    unit = { id: unitId, title: unitId, files: [], status: 'pending', verification: null };
    units.push(unit);
  }
  return unit;
}

function parseVerificationReceipt(value, projectDir) {
  let raw = String(value).trim();
  if (!raw.startsWith('{')) {
    const filePath = path.resolve(projectDir, raw);
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw Object.assign(
        new Error(`cannot read verification receipt ${normalizePath(value)}: ${error.code ?? error.message}`),
        { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_UNREADABLE' },
      );
    }
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(
      new Error(`verification receipt is not valid JSON: ${error.message}`),
      { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID' },
    );
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.command !== 'verify' || !receipt.verification || typeof receipt.verification !== 'object') {
    throw Object.assign(
      new Error('verification receipt must be a verify report (JSON output of run.mjs verify)'),
      { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID' },
    );
  }
  return receipt;
}

// A unit's verification.command records the command SET that produced the
// receipt (`name=command` lines in CHECK_ORDER) so `verify --reuse` can compare
// it against the currently configured selection.
function taskVerificationFromReceipt(receipt) {
  const verification = receipt.verification ?? {};
  const checks = receipt.checks && typeof receipt.checks === 'object' && !Array.isArray(receipt.checks) ? receipt.checks : {};
  const command = CHECK_ORDER
    .filter((name) => checks[name] && typeof checks[name] === 'object' && checks[name].status === 'passed' && typeof checks[name].command === 'string')
    .map((name) => `${name}=${checks[name].command}`)
    .join('\n');
  return {
    command,
    status: typeof receipt.status === 'string' ? receipt.status : null,
    exitCode: typeof receipt.status === 'string' && PASS_STATUSES.includes(receipt.status) ? 0 : 1,
    fingerprint: typeof verification.fingerprint === 'string' ? verification.fingerprint : null,
    at: typeof verification.finishedAt === 'string' ? verification.finishedAt : null,
    ...(typeof verification.id === 'string' ? { id: verification.id } : {}),
    ...(typeof verification.finishedAt === 'string' ? { finishedAt: verification.finishedAt } : {}),
    ...(typeof verification.before?.head === 'string' ? { beforeHead: verification.before.head } : {}),
    ...(typeof verification.after?.head === 'string' ? { afterHead: verification.after.head } : {}),
  };
}

function verificationCommandSet(commands, selectedNames, projectDir) {
  return CHECK_ORDER
    .filter((name) => selectedNames.includes(name) && typeof commands[name] === 'string')
    .map((name) => `${name}=${displayCommand(commands[name], projectDir)}`)
    .join('\n');
}

async function findReusableVerification(projectDir, taskId, { fingerprint, commandSet }) {
  if (typeof fingerprint !== 'string') return null;
  const taskIds = [];
  if (taskId) {
    taskIds.push(taskId);
  } else {
    let entries = [];
    try {
      entries = await readdir(path.join(projectDir, TASKS_RELATIVE_DIR), { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const candidate = entry.name.slice(0, -'.json'.length);
      // Files this CLI could not have written are not anchors; skip them
      // instead of failing an otherwise verifiable tree.
      if (!TASK_ID_PATTERN.test(candidate) || WINDOWS_RESERVED_NAMES.test(candidate)) continue;
      taskIds.push(candidate);
    }
    taskIds.sort((left, right) => left.localeCompare(right));
  }
  let best = null;
  for (const id of taskIds) {
    const read = await readTaskAnchor(projectDir, id);
    if (!read.exists) continue;
    const units = Array.isArray(read.anchor.units) ? read.anchor.units : [];
    for (const unit of units) {
      const verification = unit && typeof unit === 'object' && unit.verification && typeof unit.verification === 'object' ? unit.verification : null;
      if (!verification || verification.status !== 'passed' || verification.fingerprint !== fingerprint) continue;
      if (typeof verification.command !== 'string' || verification.command !== commandSet) continue;
      const at = typeof verification.at === 'string' ? verification.at : '';
      if (!best || at > best.at) best = { taskId: id, unitId: unit.id, verification, at };
    }
  }
  return best;
}

async function taskInitReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('init', 'task init needs a task id: task init <task-id> --title <t> --goal <g>');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('init', error.message, error.code);
  }
  if (args.title === undefined || args.title.trim() === '') return taskFailure('init', 'task init needs --title <text>');
  if (args.goal === undefined || args.goal.trim() === '') return taskFailure('init', 'task init needs --goal <text>');
  const riskLevel = args.riskLevel ?? DEFAULT_TASK_RISK_LEVEL;
  if (!TASK_RISK_LEVELS.includes(riskLevel)) {
    return taskFailure('init', `--risk-level must be one of ${TASK_RISK_LEVELS.join(', ')}`);
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (read.exists) {
    return taskFailure('init', `anchor for task ${taskId} already exists at ${taskAnchorRelativePath(taskId)}; use "task update ${taskId}" to change it`);
  }
  const now = new Date().toISOString();
  const anchor = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId,
    title: args.title,
    stage: INITIAL_TASK_STAGE,
    riskLevel,
    goal: args.goal,
    acceptance: args.acceptance.filter((item) => item.trim() !== ''),
    units: [],
    decisions: [],
    blockers: [],
    failures: [],
    nextAction: null,
    sessions: [{ at: now, action: 'init' }],
    updatedAt: now,
  };
  if (args.write) writeTaskAnchor(read.filePath, anchor);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'init',
    taskId,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    write: Boolean(args.write),
    written: Boolean(args.write),
    path: taskAnchorRelativePath(taskId),
    anchor,
  };
}

async function taskUpdateReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('update', 'task update needs a task id: task update <task-id> [--stage <s>] [--unit-status <unitId>:<status>] [--failure <text>] [--verification <receipt> --unit <unitId>]');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('update', error.message, error.code);
  }
  if (args.verification !== undefined && args.unit === undefined) {
    return taskFailure('update', '--verification requires --unit <unitId>');
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) {
    return taskFailure('update', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  }
  const current = read.anchor;
  const currentSignature = anchorSignature(current);
  // Deep-clone before mutating: the raw anchor stays the baseline for the
  // idempotency probe, so in-place edits must never leak into it.
  const next = JSON.parse(JSON.stringify(current));
  const changes = [];
  if (!Array.isArray(next.units)) next.units = [];
  if (!Array.isArray(next.decisions)) next.decisions = [];
  if (!Array.isArray(next.blockers)) next.blockers = [];
  if (!Array.isArray(next.failures)) next.failures = [];
  if (!Array.isArray(next.sessions)) next.sessions = [];
  if (args.stage !== undefined) {
    if (!TASK_STAGES.includes(args.stage)) {
      return taskFailure('update', `--stage must be one of ${TASK_STAGES.join(', ')}`);
    }
    if (next.stage !== args.stage) {
      next.stage = args.stage;
      changes.push('stage');
    }
  }
  for (const entry of args.unitStatus) {
    const separator = entry.lastIndexOf(':');
    const unitId = separator > 0 ? entry.slice(0, separator) : null;
    const status = separator > 0 ? entry.slice(separator + 1) : null;
    if (!unitId || !TASK_UNIT_STATUSES.includes(status)) {
      return taskFailure('update', `--unit-status ${JSON.stringify(entry)} must be <unitId>:<status> with status from ${TASK_UNIT_STATUSES.join(', ')}`);
    }
    try {
      validateTaskId(unitId);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    const existed = next.units.some((item) => item && item.id === unitId);
    const unit = upsertTaskUnit(next.units, unitId);
    if (!existed || unit.status !== status) {
      unit.status = status;
      changes.push(`unit-status:${unitId}`);
    }
  }
  for (const [flag, field] of [['decision', 'decisions'], ['blocker', 'blockers']]) {
    for (const value of args[flag]) {
      if (value.trim() === '') continue;
      if (!next[field].includes(value)) {
        next[field].push(value);
        changes.push(flag);
      }
    }
  }
  // Failures are deduped by text so re-reporting the same failure (for example
  // after a compaction-driven resume) does not grow the anchor.
  for (const value of args.failure) {
    if (value.trim() === '') continue;
    if (!next.failures.some((item) => item && item.text === value)) {
      next.failures.push({ at: new Date().toISOString(), text: value });
      changes.push('failure');
    }
  }
  if (args.nextAction !== undefined && next.nextAction !== args.nextAction) {
    next.nextAction = args.nextAction;
    changes.push('nextAction');
  }
  if (args.verification !== undefined) {
    try {
      validateTaskId(args.unit);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    let receipt;
    try {
      receipt = parseVerificationReceipt(args.verification, projectDir);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    const existed = next.units.some((item) => item && item.id === args.unit);
    const unit = upsertTaskUnit(next.units, args.unit);
    const entry = taskVerificationFromReceipt(receipt);
    if (!existed || stableStringify(unit.verification ?? null) !== stableStringify(entry)) {
      unit.verification = entry;
      changes.push(`verification:${args.unit}`);
    }
  }
  const changed = anchorSignature(next) !== currentSignature;
  let anchor = next;
  if (changed) {
    const now = new Date().toISOString();
    anchor = { ...next, updatedAt: now, sessions: [...next.sessions, { at: now, action: 'update' }] };
    if (args.write) {
      try {
        writeTaskAnchor(read.filePath, anchor);
      } catch (error) {
        return taskFailure('update', `cannot write ${taskAnchorRelativePath(taskId)}: ${error.code ?? error.message}`);
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'update',
    taskId,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    write: Boolean(args.write),
    written: changed && Boolean(args.write),
    changed,
    changes,
    path: taskAnchorRelativePath(taskId),
    anchor,
  };
}

function taskResumeHint(taskId, anchor, pendingUnits) {
  const parts = [
    `read ${taskAnchorRelativePath(taskId)} and the current diff (git status --porcelain plus git diff) first`,
    'do not re-read rule bodies or the full report',
    `stage: ${typeof anchor.stage === 'string' ? anchor.stage : 'unknown'}`,
  ];
  if (pendingUnits.length > 0) parts.push(`pending units: ${pendingUnits.join(', ')}`);
  const failures = Array.isArray(anchor.failures)
    ? anchor.failures.filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
    : [];
  if (failures.length > 0) parts.push(`recent failure: ${failures[failures.length - 1].text}`);
  if (typeof anchor.nextAction === 'string' && anchor.nextAction !== '') parts.push(`next action: ${anchor.nextAction}`);
  return `${parts.join('; ')}.`;
}

async function taskStatusReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('status', 'task status needs a task id: task status <task-id>');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('status', error.message, error.code);
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) {
    return taskFailure('status', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  }
  const anchor = read.anchor;
  const units = Array.isArray(anchor.units) ? anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
  const pendingUnits = units.filter((unit) => unit.status !== 'done').map((unit) => unit.id);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'status',
    taskId,
    status: 'ready',
    path: taskAnchorRelativePath(taskId),
    title: typeof anchor.title === 'string' ? anchor.title : null,
    stage: typeof anchor.stage === 'string' ? anchor.stage : null,
    riskLevel: typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null,
    goal: typeof anchor.goal === 'string' ? anchor.goal : null,
    acceptance: Array.isArray(anchor.acceptance) ? anchor.acceptance : [],
    units,
    pendingUnits,
    decisions: Array.isArray(anchor.decisions) ? anchor.decisions : [],
    blockers: Array.isArray(anchor.blockers) ? anchor.blockers : [],
    failures: Array.isArray(anchor.failures) ? anchor.failures : [],
    nextAction: typeof anchor.nextAction === 'string' ? anchor.nextAction : null,
    sessions: Array.isArray(anchor.sessions) ? anchor.sessions : [],
    updatedAt: typeof anchor.updatedAt === 'string' ? anchor.updatedAt : null,
    resumeHint: taskResumeHint(taskId, anchor, pendingUnits),
  };
}

async function taskListReport(projectDir) {
  let entries = [];
  try {
    entries = await readdir(path.join(projectDir, TASKS_RELATIVE_DIR), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return taskFailure('list', `cannot read ${TASKS_RELATIVE_DIR}: ${error.code ?? error.message}`);
    }
  }
  const tasks = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const taskId = entry.name.slice(0, -'.json'.length);
    if (!TASK_ID_PATTERN.test(taskId) || WINDOWS_RESERVED_NAMES.test(taskId)) {
      tasks.push({ taskId, status: 'invalid', error: 'filename is not a valid task id' });
      continue;
    }
    let read;
    try {
      read = await readTaskAnchor(projectDir, taskId);
    } catch (error) {
      tasks.push({ taskId, status: 'invalid', error: error.message });
      continue;
    }
    if (!read.exists) continue;
    const anchor = read.anchor;
    const units = Array.isArray(anchor.units) ? anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
    tasks.push({
      taskId,
      status: 'ready',
      title: typeof anchor.title === 'string' ? anchor.title : null,
      stage: typeof anchor.stage === 'string' ? anchor.stage : null,
      riskLevel: typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null,
      unitCount: units.length,
      doneUnits: units.filter((unit) => unit.status === 'done').length,
      pendingUnits: units.filter((unit) => unit.status !== 'done').map((unit) => unit.id),
      blockerCount: Array.isArray(anchor.blockers) ? anchor.blockers.length : 0,
      updatedAt: typeof anchor.updatedAt === 'string' ? anchor.updatedAt : null,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'list',
    status: 'ready',
    directory: TASKS_RELATIVE_DIR,
    count: tasks.length,
    invalidCount: tasks.filter((item) => item.status === 'invalid').length,
    tasks,
  };
}

async function taskReport(projectDir, args) {
  const subcommand = args._[1] ?? null;
  try {
    if (subcommand === null) {
      return taskFailure(null, 'task needs a subcommand: task <init|update|status|list> [task-id]');
    }
    if (subcommand === 'init') return await taskInitReport(projectDir, args);
    if (subcommand === 'update') return await taskUpdateReport(projectDir, args);
    if (subcommand === 'status') return await taskStatusReport(projectDir, args);
    if (subcommand === 'list') return await taskListReport(projectDir);
    return taskFailure(subcommand, `Unknown task subcommand: ${JSON.stringify(String(subcommand))} (expected init, update, status or list)`);
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand,
      status: 'failed',
      ...(error.code ? { code: error.code } : {}),
      error: boundedOutput(error.message, projectDir),
    };
  }
}

function taskSummary(report) {
  const lines = [`command: task ${report.subcommand ?? ''}`.trim(), `status: ${report.status}`];
  if (report.error) {
    lines.push(`error: ${report.error}`);
    return lines.join('\n');
  }
  if (report.path) lines.push(`path: ${report.path}`);
  if (report.taskId) lines.push(`taskId: ${report.taskId}`);
  if (report.subcommand === 'init' || report.subcommand === 'update') {
    const anchor = report.anchor ?? {};
    lines.push(`title: ${anchor.title ?? ''}`);
    lines.push(`stage: ${anchor.stage ?? ''}`);
    lines.push(`riskLevel: ${anchor.riskLevel ?? ''}`);
    if (report.subcommand === 'update') {
      lines.push(`changed: ${report.changed ? 'yes' : 'no'}`);
      if ((report.changes ?? []).length > 0) lines.push(`changes: ${report.changes.join(', ')}`);
    }
    lines.push(`units: ${Array.isArray(anchor.units) ? anchor.units.length : 0}`);
    lines.push(`decisions: ${Array.isArray(anchor.decisions) ? anchor.decisions.length : 0}`);
    lines.push(`blockers: ${Array.isArray(anchor.blockers) ? anchor.blockers.length : 0}`);
    if (anchor.nextAction) lines.push(`nextAction: ${anchor.nextAction}`);
    if (report.written === false && report.status !== 'failed') lines.push('dry run: pass --write to apply');
    return lines.join('\n');
  }
  if (report.subcommand === 'status') {
    lines.push(`stage: ${report.stage ?? ''}`);
    lines.push(`goal: ${report.goal ?? ''}`);
    for (const unit of report.units ?? []) {
      lines.push(`unit ${unit.id}: ${unit.status ?? 'unknown'}${unit.verification ? ' (verified)' : ''}`);
    }
    if ((report.pendingUnits ?? []).length > 0) lines.push(`pendingUnits: ${report.pendingUnits.join(', ')}`);
    if (report.nextAction) lines.push(`nextAction: ${report.nextAction}`);
    lines.push(`resumeHint: ${report.resumeHint}`);
    return lines.join('\n');
  }
  if (report.subcommand === 'list') {
    lines.push(`count: ${report.count}`);
    for (const item of report.tasks ?? []) {
      if (item.status === 'invalid') {
        lines.push(`task ${item.taskId}: invalid (${item.error})`);
        continue;
      }
      lines.push(`task ${item.taskId}: ${item.stage ?? 'unknown'} (${item.unitCount} units, ${item.doneUnits} done, ${item.blockerCount} blockers)`);
    }
    return lines.join('\n');
  }
  return lines.join('\n');
}

/**
 * Shared codebase-memory helpers shipped with the tool runtime. They are the
 * same modules the wrapper, the managed MCP block and the provisioning phases
 * resolve their paths through, so this command cannot report a cache or a
 * state file the tool never uses. The lookup is lazy because the runtime only
 * exists when the plugin (or an equivalent project copy) was installed.
 *
 * @returns {Promise<{cachePath: any, indexState: any, projectRoot: any} | null>}
 */
let codebaseMemoryHelperModules;
async function codebaseMemoryHelpers() {
  codebaseMemoryHelperModules ??= (async () => {
    const base = new URL('../tools/codebase-memory-mcp/', import.meta.url);
    try {
      const [cachePath, indexState, projectRoot] = await Promise.all([
        import(new URL('cache-path.mjs', base).href),
        import(new URL('index-state.mjs', base).href),
        import(new URL('project-root.mjs', base).href),
      ]);
      return { cachePath, indexState, projectRoot };
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
      throw error;
    }
  })();
  return codebaseMemoryHelperModules;
}

function codebaseMemoryWrapperPath(projectDir) {
  return path.join(projectDir, '.agents/runtime/tools/codebase-memory-mcp/run.mjs');
}

async function codebaseMemoryRuntimeInstalled(projectDir) {
  try {
    await access(codebaseMemoryWrapperPath(projectDir));
    return true;
  } catch {
    return false;
  }
}

function codebaseMemoryEnvironment(indexRoot, helpers) {
  return {
    ...process.env,
    CBM_ALLOWED_ROOT: indexRoot,
    CBM_CACHE_DIR: helpers.cachePath.codebaseMemoryCacheDir(indexRoot),
    CBM_MEM_BUDGET_MB: '2048',
    CBM_WORKERS: '2',
  };
}

/**
 * The freshness stamp is the only durable answer to "is this graph current?".
 * `index_status` reports the live HEAD, and the pinned runtime keeps
 * auto_index/auto_watch off, so a graph nobody rebuilt after a commit must
 * report stale instead of ready.
 */
async function codebaseMemoryStatus(projectDir, helpers) {
  const facts = helpers.projectRoot.resolveGitFacts(projectDir);
  const sourceRoot = facts?.root ?? path.resolve(projectDir);
  const indexRoot = facts?.mainRoot ?? path.resolve(projectDir);
  const worktreeMapped = Boolean(facts?.isWorktree);
  const state = await helpers.indexState.readIndexState(helpers.cachePath.codebaseMemoryIndexStatePath(indexRoot));
  const freshness = helpers.indexState.evaluateIndexFreshness(state, { headSha: facts?.headSha ?? null });
  const report = {
    branch: facts?.branch ?? null,
    cacheDir: state?.cacheDir ?? helpers.cachePath.codebaseMemoryCacheDir(indexRoot),
    edges: state?.edges ?? null,
    headSha: facts?.headSha ?? null,
    indexedAt: state?.indexedAt ?? null,
    indexedHeadSha: state?.headSha ?? null,
    indexStatePath: helpers.indexState.indexStateRelativePath(indexRoot),
    mode: state?.mode ?? null,
    nodes: state?.nodes ?? null,
    project: state?.project ?? null,
    reason: freshness.reason,
    rootPath: indexRoot,
    runtimeInstalled: await codebaseMemoryRuntimeInstalled(projectDir),
    runtimeVersion: state?.runtimeVersion ?? null,
    sourceRoot,
    status: freshness.state,
    worktreeMapped,
  };
  if (worktreeMapped) {
    report.worktreeNote = '索引映射到主检出；worktree 未提交的新文件与新符号不在图中，需用 rg 补充核验。';
  }
  if (freshness.state === 'fresh') return report;
  report.guidance = freshness.state === 'missing'
    ? ['尚未记录索引状态；运行 `node .agents/runtime/commands/run.mjs codebase-memory refresh --project . --write` 建立索引并写入状态戳。']
    : ['HEAD 已变化，索引图早于当前提交；重新运行 `... codebase-memory refresh --project . --write`，或仅用 rg 补充核验后再决定是否重建。'];
  if (freshness.state === 'missing' && report.runtimeInstalled) {
    report.probe = await codebaseMemoryProbe(projectDir, indexRoot, helpers);
    if (report.probe.matched) {
      // A graph exists for this project but nothing recorded which HEAD it
      // covers; report stale instead of claiming the project was never indexed.
      report.status = 'stale';
      report.reason = 'index-without-state-stamp';
    }
  }
  return report;
}

/**
 * Ask the runtime whether it already holds a graph for the project root. The
 * probe is deliberately shallow: it only matches the reported `root_path`, so
 * a missing stamp stays distinguishable from a genuinely absent index.
 */
async function codebaseMemoryProbe(projectDir, indexRoot, helpers) {
  const wrapper = codebaseMemoryWrapperPath(projectDir);
  const expected = indexRoot.replaceAll('\\', '/').replace(/\/+$/u, '');
  try {
    const { stdout } = await execFileAsync(process.execPath, [wrapper, 'cli', 'list_projects', '--json'], {
      cwd: indexRoot,
      env: codebaseMemoryEnvironment(indexRoot, helpers),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
    const haystack = process.platform === 'win32' ? stdout.toLowerCase() : stdout;
    const needle = process.platform === 'win32' ? expected.toLowerCase() : expected;
    return { matched: haystack.includes(needle), probe: 'list_projects' };
  } catch (error) {
    return {
      matched: false,
      probe: 'list_projects',
      probeError: boundedOutput(String(error?.message ?? error), projectDir),
    };
  }
}

async function runCodebaseMemoryWrapper(wrapper, args, cwd, env, timeoutMs) {
  try {
    const { stderr, stdout } = await execFileAsync(process.execPath, [wrapper, ...args], {
      cwd,
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { status: 'passed', stderr: boundedOutput(stderr, cwd), stdout: boundedOutput(stdout, cwd) };
  } catch (error) {
    return {
      code: error?.killed ? 'TIMEOUT' : 'COMMAND_FAILED',
      exitCode: typeof error?.code === 'number' ? error.code : null,
      status: 'failed',
      stderr: boundedOutput(String(error?.stderr ?? error?.message ?? error), cwd),
      stdout: boundedOutput(String(error?.stdout ?? ''), cwd),
    };
  }
}

async function codebaseMemoryRefresh(projectDir, args, helpers) {
  const current = await codebaseMemoryStatus(projectDir, helpers);
  if (!current.runtimeInstalled) {
    return {
      action: 'refresh',
      command: 'codebase-memory',
      guidance: ['codebase-memory runtime 未安装；先运行 `vibe-harness provision --project <path> --write`。'],
      reason: 'runtime-not-installed',
      rootPath: current.rootPath,
      sourceRoot: current.sourceRoot,
      status: 'unavailable',
      worktreeMapped: current.worktreeMapped,
    };
  }
  const steps = [
    'cli index_repository --repo-path . --mode moderate --persistence false --json',
    'cli index_status --project <project> --json',
  ];
  if (!args.write) {
    return {
      action: 'refresh',
      command: 'codebase-memory',
      current,
      dryRun: true,
      rootPath: current.rootPath,
      sourceRoot: current.sourceRoot,
      status: 'planned',
      steps,
      worktreeMapped: current.worktreeMapped,
    };
  }
  const wrapper = codebaseMemoryWrapperPath(projectDir);
  const env = codebaseMemoryEnvironment(current.rootPath, helpers);
  const indexRun = await runCodebaseMemoryWrapper(
    wrapper,
    ['cli', 'index_repository', '--repo-path', '.', '--mode', 'moderate', '--persistence', 'false', '--json'],
    current.rootPath,
    env,
    900_000,
  );
  const refreshed = await codebaseMemoryStatus(projectDir, helpers);
  const verify = refreshed.runtimeInstalled && indexRun.status === 'passed'
    ? await runCodebaseMemoryWrapper(
      wrapper,
      ['cli', 'index_status', '--project', refreshed.project ?? path.basename(current.rootPath), '--json'],
      current.rootPath,
      env,
      120_000,
    )
    : null;
  return {
    ...refreshed,
    action: 'refresh',
    refresh: {
      indexRepository: { ...indexRun, stdout: undefined },
      verify: verify ? { ...verify, stdout: undefined } : null,
    },
  };
}

async function codebaseMemoryReport(projectDir, args) {
  const action = args._[1] ?? 'status';
  if (!['status', 'refresh'].includes(action)) throw new Error(`Unknown codebase-memory subcommand: ${action}`);
  const helpers = await codebaseMemoryHelpers();
  const defaults = { action, command: 'codebase-memory', schemaVersion: SCHEMA_VERSION };
  if (!helpers) {
    return {
      ...defaults,
      guidance: ['codebase-memory runtime 未安装；先运行 `vibe-harness provision --project <path> --write`。'],
      reason: 'runtime-not-installed',
      status: 'unavailable',
    };
  }
  const report = action === 'refresh'
    ? await codebaseMemoryRefresh(projectDir, args, helpers)
    : await codebaseMemoryStatus(projectDir, helpers);
  return { ...defaults, ...report };
}

function summary(report) {
  if (report.command === 'slice') return report.error ? `command: slice\nstatus: failed\nerror: ${report.error}` : report.text;
  if (report.command === 'patch') return patchSummary(report);
  if (report.command === 'task') return taskSummary(report);
  if (report.command === 'codebase-memory') {
    const lines = [`command: codebase-memory ${report.action ?? 'status'}`.trim(), `status: ${report.status}`];
    if (report.reason) lines.push(`reason: ${report.reason}`);
    if (report.rootPath) lines.push(`root: ${report.rootPath}`);
    if (report.sourceRoot && report.sourceRoot !== report.rootPath) lines.push(`sourceRoot: ${report.sourceRoot}`);
    if (report.headSha) lines.push(`head: ${report.headSha}`);
    if (report.indexedHeadSha) lines.push(`indexedHead: ${report.indexedHeadSha}`);
    if (report.indexedAt) lines.push(`indexedAt: ${report.indexedAt}`);
    if (Number.isInteger(report.nodes)) lines.push(`graph: ${report.nodes} nodes / ${report.edges} edges`);
    if (report.cacheDir) lines.push(`cache: ${report.cacheDir}`);
    if (report.dryRun) for (const step of report.steps ?? []) lines.push(`step: ${step}`);
    if (report.refresh) for (const [name, item] of Object.entries(report.refresh)) {
      if (item) lines.push(`${name}: ${item.status}${item.code ? ` (${item.code})` : ''}`);
    }
    for (const item of report.guidance ?? []) lines.push(`next: ${item}`);
    if (report.worktreeNote) lines.push(report.worktreeNote);
    if (report.error) lines.push(`error: ${report.error}`);
    return lines.join('\n');
  }
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
      if (item.code) lines.push(`  code: ${item.code}`);
      if (item.allocation) {
        const ports = Object.entries(item.allocation.ports ?? {}).map(([name, port]) => `${name}=${port}`).join(' ');
        lines.push(`  ports: ${item.allocation.envFile} block ${item.allocation.block}${ports ? ` (${ports})` : ''}`);
      } else if (item.ports) {
        const ports = Object.entries(item.ports).map(([name, port]) => `${name}=${port}`).join(' ');
        lines.push(`  ports: block${ports ? ` (${ports})` : ''}`);
      }
      for (const step of item.steps ?? []) lines.push(`  ${step.kind}${step.command ? `: ${step.command}` : step.root ? `: ${step.root} (${step.mode})` : ''}`);
      for (const file of item.envFiles ?? []) lines.push(`  env-file ${file.file}: ${file.status}${file.reason ? ` (${file.reason})` : ''}`);
      for (const command of item.setupCommands ?? []) lines.push(`  setup ${command.command}: ${command.status}`);
    }
    return lines.join('\n');
  }
  const lines = [`command: ${report.command}`, `status: ${report.status}`];
  // The help receipt carries the usage contract; without this block it only
  // surfaced under --json, so the summary path answered --help with nothing.
  if (report.command === 'help') {
    lines.push(report.usage);
    if (report.codebaseMemory) lines.push(report.codebaseMemory);
    if (report.worktree) lines.push(report.worktree);
    if (report.task) lines.push(report.task);
    if (report.reuse) lines.push(report.reuse);
    if (report.verify) lines.push(report.verify);
  }
  if (report.command === 'verify') {
    if (report.tier) lines.push(`tier: ${report.tier}`);
    for (const [name, item] of Object.entries(report.checks ?? {})) lines.push(`${name}: ${item.status}`);
    if (report.nextTier) lines.push(`nextTier: ${report.nextTier}`);
    if (report.reused) lines.push(`reused: ${report.reused.taskId}/${report.reused.unitId}${report.reused.id ? ` receipt ${report.reused.id}` : ''}`);
  }
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}

export async function runCommand(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const command = args.help ? 'help' : (args._[0] ?? 'help');
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
  else if (command === 'task') report = await taskReport(projectDir, args);
  else if (command === 'codebase-memory') report = await codebaseMemoryReport(projectDir, args);
  else if (command === 'help') report = {
    schemaVersion: SCHEMA_VERSION,
    command,
    status: 'ready',
    usage: 'run.mjs <env|context|changes|verify|worktree|slice|patch|task|codebase-memory> [--project <path>] [--json]（--project 缺省为当前目录）',
    codebaseMemory: 'run.mjs codebase-memory <status|refresh> --project <path>: status reports fresh|stale|missing from the index state stamp written by the runtime wrapper after a successful index_repository and never writes; refresh stays dry-run until --write and then rebuilds the semantic graph through the pinned project runtime',
    worktree: 'run.mjs worktree <list|check|bootstrap|cleanup|recover> --project <path>: bootstrap, cleanup and recover stay dry-run until --write; bootstrap allocates the next port block from .vibe-harness/worktree-ports.json, materializes worktree.provision.envFiles and runs worktree.provision.setupCommands (a red-zone target also needs --confirm-red-zone); cleanup refuses branches not merged into worktree.baseRef; recover reclaims crash residue (prunable worktrees, bootstrap worktrees still clean at the base ref, zero-commit branches only residue references, leaked registry entries) and never deletes a branch that moved past the base ref',
    task: 'run.mjs task <init|update|status|list> [task-id] --project <path>: anchors live in .vibe-harness/tasks/<task-id>.json; init and update stay dry-run until --write while status and list never write; update accepts --stage, --unit-status <unitId>:<status>, --decision, --blocker, --failure (repeatable, deduped by text, {at,text} entries), --next-action, and --unit <unitId> --verification <verify receipt> to record a verify receipt on a unit',
    reuse: 'run.mjs verify --project <path> [--task <task-id>] --reuse: returns status "reused" without executing commands when the working-tree fingerprint and command set match the most recent passed receipt in the anchor; otherwise the checks run normally',
    verify: 'run.mjs verify --project <path> [--tier quick|standard|deep] [--only lint,typecheck,test,eval] [--plan]: quick is the default cost layer and slots outside it are reported as deferred with nextTier; --only selects explicit checks and bypasses tier deferral; blocked checks (unsafe, manual without --allow-manual, missing executable) end the receipt with status "blocked" instead of "failed"',
  };
  else throw new Error(`Unknown command: ${command}`);
  // A freshness verdict is the answer to a question, not a failed command:
  // `stale` and `missing` still exit 0 so callers can read the receipt, while
  // an unavailable runtime or an execution failure keeps the failure exit.
  const exitCode = command === 'codebase-memory'
    ? (['failed', 'unavailable'].includes(report.status) ? 1 : 0)
    : (PASS_STATUSES.includes(report.status) ? 0 : 1);
  return { args, report, exitCode };
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
