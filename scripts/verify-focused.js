#!/usr/bin/env node
// Focused-verification selector: maps the current change paths to the project's
// suggested verification commands. This is a suggestion generator, not a gate:
// it is not wired into hooks or completion judgment; whether and how to scale
// verification stays governed by rules/governance-core.md (scope must match the
// completion claim).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assertSafeCommand } from './lib/shell-command.js';

const execFileAsync = promisify(execFile);

const referenceDriftNote =
  'rules/runtime content changes drift the evals/references asset fingerprints by design; '
  + 'if eval:replay fails, follow the reference update checklist in CONTRIBUTING.md and '
  + 'confirm the update explicitly instead of treating it as a regression.';

// Ordered rules; the first matching rule wins for each path, then per-path
// command buckets merge into an ordered, de-duplicated suggestion list.
const FOCUSED_CHECK_RULES = [
  {
    match: (p) => p.startsWith('.github/workflows/'),
    commands: [{ command: 'pnpm test:eval', reason: 'eval-ci tests assert CI workflow content' }],
  },
  {
    match: (p) => p.startsWith('evals/'),
    commands: [
      { command: 'pnpm eval:check', reason: 'eval suite contract and reference validation' },
      { command: 'pnpm test:eval', reason: 'eval infrastructure tests' },
    ],
  },
  {
    match: (p) => p.startsWith('skills/') || p.startsWith('.agents/skills/'),
    commands: [
      { command: 'pnpm skills:audit', reason: 'skill metadata quality audit' },
      { command: 'pnpm eval:check', reason: 'eval suite contract and reference validation' },
      { command: 'pnpm test:eval', reason: 'eval infrastructure tests' },
    ],
  },
  {
    match: (p) => p.startsWith('rules/')
      || p.startsWith('docs/rules/')
      || p.startsWith('runtime/')
      || p.startsWith('.agents/runtime/'),
    commands: [
      { command: 'pnpm test:unit', reason: 'unit and behavior-lock tests' },
      { command: 'pnpm eval:check', reason: 'eval suite contract and reference validation' },
    ],
    notes: [referenceDriftNote],
  },
  {
    match: (p) => p.startsWith('scripts/'),
    commands: [
      { command: 'pnpm test:unit', reason: 'unit tests' },
      { command: 'pnpm test:integration', reason: 'installer and CLI integration tests' },
    ],
  },
  {
    match: (p) => p.startsWith('tests/'),
    commands: [{ command: 'pnpm test:unit', reason: 'unit tests' }],
  },
  {
    match: (p) => p.startsWith('adapters/'),
    commands: [
      { command: 'pnpm check', reason: 'pack self-validation (includes documentation audit)' },
      { command: 'pnpm test:integration', reason: 'cross-platform adapter integration tests' },
    ],
  },
  {
    match: (p) => p.startsWith('manifests/')
      || p.startsWith('schemas/')
      || p.startsWith('templates/')
      || p.startsWith('docs/')
      || p === 'AGENTS.md'
      || p === 'CONTRIBUTING.md'
      || p === 'README.md',
    commands: [{ command: 'pnpm check', reason: 'pack self-validation (includes documentation audit)' }],
  },
];

const FALLBACK_COMMANDS = [{ command: 'pnpm check', reason: 'default baseline validation' }];

/**
 * Select suggested verification commands for a list of changed paths.
 *
 * @param {string[]} paths - Changed file paths (repo-relative, forward slashes).
 * @returns {{commands: Array<{command: string, reason: string}>, notes: string[]}}
 *   Ordered, de-duplicated commands plus accumulated advisory notes.
 */
export function selectFocusedChecks(paths) {
  const commands = [];
  const notes = [];
  const seenCommands = new Set();
  for (const changedPath of paths) {
    const rule = FOCUSED_CHECK_RULES.find((item) => item.match(changedPath));
    const bucket = rule ?? { commands: FALLBACK_COMMANDS, notes: [] };
    for (const item of bucket.commands) {
      if (!seenCommands.has(item.command)) {
        seenCommands.add(item.command);
        commands.push({ ...item });
      }
    }
    for (const note of bucket.notes ?? []) {
      if (!notes.includes(note)) notes.push(note);
    }
  }
  return { commands, notes };
}

/**
 * Collect changed paths from git: committed and working-tree changes relative
 * to HEAD (or the given base ref), plus untracked paths from status.
 *
 * @param {{base?: string|null, cwd?: string}} [options]
 * @returns {Promise<string[]>} Repo-relative forward-slash paths.
 */
export async function collectChangedPaths({ base = null, cwd = process.cwd() } = {}) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const diffArgs = base
    ? ['diff', '--name-only', base]
    : ['diff', '--name-only', 'HEAD'];
  const paths = new Set();
  const [diff, status] = await Promise.all([
    execFileAsync('git', diffArgs, { env: gitEnv, cwd }),
    execFileAsync('git', ['status', '--porcelain'], { env: gitEnv, cwd }),
  ]);
  // Diff output is bare paths; porcelain output prefixes three status columns.
  for (const line of diff.stdout.split('\n')) {
    const entry = line.trim();
    if (entry) paths.add(entry.replaceAll('\\', '/'));
  }
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue;
    // Porcelain lines are "XY <path>" (or "XY <orig> -> <path>" for renames);
    // the status columns occupy exactly three characters.
    let entry = line.slice(3);
    const arrow = entry.indexOf(' -> ');
    if (arrow >= 0) entry = entry.slice(arrow + 4);
    if (entry) paths.add(entry.replaceAll('\\', '/'));
  }
  return [...paths];
}

function executableFor(command) {
  const tokens = assertSafeCommand(command);
  const [program, ...rest] = tokens;
  // Windows npm/pnpm/yarn are .cmd shims that cannot be spawned directly
  // (EINVAL on Node >= 18.20/20.12), so route them through cmd.exe like
  // project-verification.js does.
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) {
    return { file: 'cmd.exe', args: ['/c', `${program}.cmd`, ...rest] };
  }
  return { file: program, args: rest };
}

async function runCommand(command) {
  const { file, args } = executableFor(command);
  await execFileAsync(file, args, { stdio: 'inherit', env: process.env });
}

function printUsage() {
  console.log('Usage: node scripts/verify-focused.js [--base <ref>] [--run]');
  console.log();
  console.log('Prints suggested focused verification commands for the current changes.');
  console.log('  --base <ref>  Diff against <ref> instead of HEAD (covers committed changes).');
  console.log('  --run         Execute the suggested commands in order, stopping on first failure.');
}

function usageError(message) {
  console.error(`verify-focused: ${message}`);
  printUsage();
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let run = false;
  let base = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') {
      run = true;
    } else if (args[index] === '--base') {
      base = args[++index];
      if (!base) usageError('--base requires a git ref argument.');
    } else if (args[index] === '--help' || args[index] === '-h') {
      printUsage();
      return;
    } else {
      usageError(`unknown argument: ${args[index]}`);
    }
  }

  const paths = await collectChangedPaths({ base });
  if (paths.length === 0) {
    console.log('No changed paths detected; no focused verification needed.');
    return;
  }

  const { commands, notes } = selectFocusedChecks(paths);
  console.log(`Focused verification suggestions (${paths.length} changed path(s), ${commands.length} command(s)):`);
  for (const item of commands) console.log(`  ${item.command.padEnd(24)}# ${item.reason}`);
  for (const note of notes) console.log(`Note: ${note}`);
  console.log('These are suggestions, not a gate; scope must still match the completion claim (governance-core).');
  console.log('Use --run to execute the commands in order.');

  if (!run) return;

  for (const item of commands) {
    console.log(`\n$ ${item.command}`);
    try {
      await runCommand(item.command);
    } catch (error) {
      console.error(`\nFocused verification failed at: ${item.command}`);
      process.exit(typeof error.code === 'number' ? error.code : 1);
    }
  }
  console.log('\nFocused verification passed.');
}

await main();
