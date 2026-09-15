#!/usr/bin/env node
// Worktree isolation audit CLI.
//
// `list` reads the machine-parsable `git worktree list --porcelain -z` output
// docs/rules/git-rules.md names as the authoritative listing. `check` audits
// that listing against the registered tasks (one isolation unit = one named
// branch, an outside-repository path and the `<type>/<ISSUE-ID>-<slug>` branch
// convention) and reports the merge-back facts. `plan` prints the `git worktree
// add` commands a caller would run; every subcommand is read-only and this tool
// never removes a worktree, prunes, or deletes a branch.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultWorktreePath,
  isTaskBranch,
  parseWorktreeList,
  pathKey,
  summarizeWorktreeAudit,
  validateWorktrees,
} from './lib/worktree-audit.js';

const TASK_OPTIONS = new Set(['--branch-prefix', '--repo', '--task', '--base-ref', '--base-sha']);

function printUsage() {
  console.log('Usage: node scripts/worktree.js list --repo <path> [--json]');
  console.log('       node scripts/worktree.js check --repo <path> [--task <ISSUE-ID>[:<branch>[:<path>]]]... [options]');
  console.log('       node scripts/worktree.js plan --repo <path> --task <ISSUE-ID>:<branch>[:<path>] [options]');
  console.log();
  console.log('list   Print the `git worktree list --porcelain -z` entries (read-only).');
  console.log('check  Audit the listing against the registered tasks and report merge-back facts.');
  console.log('       Errors fail closed: a worktree inside the repository or nested in another worktree,');
  console.log('       a detached non-primary worktree, two worktrees on one branch, a task without a');
  console.log('       branch, a branch outside <type>/<ISSUE-ID>-<slug>, an assigned path bound to');
  console.log('       another branch, and a merge-base drift from the frozen base SHA.');
  console.log('       Warnings report a not-yet-created task worktree, an unmanaged worktree, a pending');
  console.log('       merge-back and uncommitted changes; `--strict` turns them into a failure.');
  console.log('plan   Print the `git worktree add` command per task. Never executed here.');
  console.log();
  console.log('  --repo <path>            repository or worktree to inspect; default the current directory');
  console.log('  --task <ISSUE-ID>[:<branch>[:<path>]]   registered task, repeatable');
  console.log(`  --branch-prefix <prefix> restrict branches to <prefix><ISSUE-ID>-<slug>`);
  console.log('  --base-ref <ref>         target ref for merge-back facts; default origin/develop');
  console.log('  --base-sha <sha>         frozen base SHA that each merge-base must match');
  console.log('  --deep                   also read `git status --porcelain` per worktree');
  console.log('  --strict                 exit non-zero on warnings as well as errors');
  console.log('  --json                   print the complete audit');
  console.log();
  console.log('This command never runs `git worktree remove`, `git worktree prune` or a branch delete.');
  console.log();
  console.log('Development-side audit only: worktrees are created, linked and removed through the');
  console.log('project-side runner `node .agents/runtime/commands/run.mjs worktree <bootstrap|cleanup>');
  console.log('--project <path> --json` (dry-run until `--write`), not by this tool.');
}

function usageError(message) {
  console.error(`worktree: ${message}`);
  printUsage();
  process.exit(1);
}

function takeValue(argv, index, token) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) usageError(`${token} requires a value`);
  return value;
}

/** Parse `--task <ISSUE-ID>[:<branch>[:<path>]]`; paths may contain a Windows drive colon. */
export function parseTask(value) {
  if (typeof value !== 'string' || value.trim() === '') usageError('--task expects <ISSUE-ID>[:<branch>[:<path>]]');
  const [id, branch, ...rest] = value.split(':');
  const task = { branch: branch === undefined || branch === '' ? null : branch, id, path: rest.length > 0 ? rest.join(':') : null };
  if (task.id.trim() === '') usageError(`--task ${value} has no ISSUE-ID`);
  return task;
}

/** Parse a subcommand argument vector. */
export function parseWorktreeArgs(argv) {
  const options = {
    baseRef: 'origin/develop',
    baseSha: null,
    branchPrefix: null,
    deep: false,
    json: false,
    repo: process.cwd(),
    strict: false,
    tasks: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') { options.json = true; continue; }
    if (token === '--deep') { options.deep = true; continue; }
    if (token === '--strict') { options.strict = true; continue; }
    if (token === '--help' || token === '-h') { printUsage(); process.exit(0); }
    if (!TASK_OPTIONS.has(token)) usageError(`unknown argument: ${token}`);
    const value = takeValue(argv, index, token);
    index += 1;
    if (token === '--repo') options.repo = value;
    else if (token === '--task') options.tasks.push(parseTask(value));
    else if (token === '--branch-prefix') options.branchPrefix = value;
    else if (token === '--base-ref') options.baseRef = value;
    else if (token === '--base-sha') options.baseSha = value;
  }
  return options;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function gitSucceeds(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function resolveRepositoryRoot(repo) {
  try {
    return path.resolve(git(['rev-parse', '--show-toplevel'], repo));
  } catch (error) {
    usageError(`--repo ${repo} is not a Git worktree: ${error.message}`);
    return null;
  }
}

function readWorktreeList(repo) {
  return execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function readDirty(repositoryRoot, entries) {
  const dirty = new Map();
  for (const entry of entries) {
    if (!entry.path || !existsSync(entry.path)) continue;
    try {
      dirty.set(pathKey(entry.path), git(['status', '--porcelain'], entry.path) !== '');
    } catch {
      dirty.set(pathKey(entry.path), false);
    }
  }
  return dirty;
}

function resolveIntegration(repo, baseRef, tasks) {
  const map = new Map();
  let baseRefResolved = false;
  if (baseRef) baseRefResolved = gitSucceeds(['rev-parse', '--verify', '--quiet', baseRef], repo);
  if (!baseRefResolved) return { baseRefResolved, map };
  for (const task of tasks) {
    if (typeof task.branch !== 'string' || task.branch === '') continue;
    if (!gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/heads/${task.branch}`], repo)) continue;
    const head = git(['rev-parse', `refs/heads/${task.branch}`], repo);
    const mergeBaseSha = git(['merge-base', task.branch, baseRef], repo);
    const integrated = gitSucceeds(['merge-base', '--is-ancestor', head, baseRef], repo);
    let baseDrift = false;
    if (typeof task.baseSha === 'string' && task.baseSha !== '' && mergeBaseSha.toLowerCase() !== task.baseSha.toLowerCase()) {
      // A merge-base that is a verified descendant of the frozen base SHA is
      // still an acceptable baseline; anything else is drift.
      baseDrift = !gitSucceeds(['merge-base', '--is-ancestor', task.baseSha, mergeBaseSha], repo);
    }
    map.set(task.branch, { baseDrift, integrated, mergeBaseSha, targetRef: baseRef });
  }
  return { baseRefResolved, map };
}

function buildAudit(options) {
  const baseRef = options.baseRef;
  const baseSha = options.baseSha;
  const repositoryRoot = resolveRepositoryRoot(options.repo);
  const listing = readWorktreeList(options.repo);
  const entries = parseWorktreeList(listing);
  const tasks = options.tasks.map((task) => ({
    ...task,
    baseSha: task.baseSha ?? baseSha ?? null,
    branch: task.branch,
    path: task.path ?? (typeof task.branch === 'string' && task.branch !== '' ? defaultWorktreePath(repositoryRoot, task.id) : null),
  }));
  const { baseRefResolved, map } = resolveIntegration(options.repo, baseRef, tasks);
  const audit = validateWorktrees(listing, {
    baseRef,
    branchPrefix: options.branchPrefix ?? undefined,
    dirty: options.deep ? readDirty(repositoryRoot, entries) : new Map(),
    integration: map,
    repositoryRoot,
    tasks,
  });
  return { audit, baseRefResolved, repositoryRoot };
}

function runList(argv) {
  const options = parseWorktreeArgs(argv);
  resolveRepositoryRoot(options.repo);
  const entries = parseWorktreeList(readWorktreeList(options.repo));
  if (options.json) console.log(JSON.stringify(entries, null, 2));
  else {
    for (const entry of entries) {
      console.log(`${entry.primary ? '* ' : '  '}${entry.path} ${entry.branch ?? '(detached)'}${entry.head ? ` @${entry.head.slice(0, 12)}` : ''}`);
    }
  }
}

function runCheck(argv) {
  const options = parseWorktreeArgs(argv);
  const { audit, baseRefResolved, repositoryRoot } = buildAudit(options);
  if (!baseRefResolved) {
    audit.problems.push({
      code: 'WORKTREE_BASE_REF_UNRESOLVED',
      message: `--base-ref ${options.baseRef} does not resolve in ${repositoryRoot}; merge-back facts were skipped`,
      severity: 'warning',
    });
    audit.warningCount += 1;
  }
  if (options.json) console.log(JSON.stringify(audit, null, 2));
  else console.log(summarizeWorktreeAudit(audit));
  if (!audit.ok || (options.strict && audit.warningCount > 0)) process.exitCode = 1;
}

function runPlan(argv) {
  const options = parseWorktreeArgs(argv);
  if (options.tasks.length === 0) usageError('plan needs at least one --task');
  const repositoryRoot = resolveRepositoryRoot(options.repo);
  const taskOptions = { branchPrefix: options.branchPrefix ?? undefined };
  const steps = [];
  for (const task of options.tasks) {
    const branch = task.branch;
    if (branch === null) {
      console.error(`worktree: task ${task.id} declares no branch; nothing to plan`);
      process.exitCode = 1;
      continue;
    }
    const worktreePath = task.path ?? defaultWorktreePath(repositoryRoot, task.id);
    const base = options.baseSha ?? options.baseRef;
    steps.push({
      branch,
      command: `git -C ${quotePath(repositoryRoot)} worktree add ${quotePath(worktreePath)} -b ${branch} ${base}`,
      id: task.id,
      path: worktreePath,
      valid: isTaskBranch(branch, task.id, taskOptions),
    });
  }
  if (options.json) console.log(JSON.stringify({ repositoryRoot, steps }, null, 2));
  else {
    for (const step of steps) {
      console.log(`# ${step.id}${step.valid ? '' : ' (branch does not match <type>/<ISSUE-ID>-<slug>)'}`);
      console.log(step.command);
    }
    if (steps.length > 0) console.log('# read-only plan; this command never runs `git worktree add`');
  }
  if (steps.some((step) => !step.valid)) process.exitCode = 1;
}

// Git accepts forward slashes on every platform, so the printed command stays
// copy-pasteable instead of carrying Windows backslash escapes.
function quotePath(value) {
  const slashed = String(value).replaceAll('\\', '/');
  return /\s/u.test(slashed) ? `"${slashed}"` : slashed;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') { printUsage(); return; }
  if (subcommand === 'list') return runList(rest);
  if (subcommand === 'check') return runCheck(rest);
  if (subcommand === 'plan') return runPlan(rest);
  usageError(`unknown subcommand: ${subcommand}`);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
