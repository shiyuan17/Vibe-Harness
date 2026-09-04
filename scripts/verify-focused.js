#!/usr/bin/env node
// Focused-verification selector: maps current change paths to project-owned
// verification commands. The CLI can run this route as an additional gate;
// scope must still match the completion claim in docs/rules/governance-core.md.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { assertSafeCommand } from './lib/shell-command.js';
import { readProjectConfig } from './lib/project-config.js';
import { runFocusedProjectVerification } from './lib/project-verification.js';
import { buildVerificationPlan } from './lib/verification-plan.js';

const execFileAsync = promisify(execFile);

const referenceDriftNote =
  'docs/rules or runtime content changes drift the evals/references asset fingerprints by design; '
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
    match: (p) => p.startsWith('docs/rules/')
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
      { command: 'pnpm check', reason: 'pack self-validation (includes lint, docs, and schema gates)' },
      { command: 'pnpm test:unit', reason: 'unit tests' },
      { command: 'pnpm test:integration', reason: 'installer and CLI integration tests' },
      { command: 'pnpm smoke:lifecycle', reason: 'lifecycle smoke coverage for runtime-affecting scripts' },
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

function checkStage(command) {
  if (/test:integration/iu.test(command)) return 'integration';
  if (/smoke:lifecycle/iu.test(command)) return 'smoke';
  return 'focused';
}

export function buildImpactMapping(paths, commands) {
  return paths.map((source) => ({
    source,
    focused: commands.filter((item) => checkStage(item.command) === 'focused').map((item) => item.command),
    integration: [...new Set([
      ...commands.filter((item) => checkStage(item.command) === 'integration').map((item) => item.command),
      ...( /^(?:scripts|runtime|adapters)\//u.test(source) ? ['pnpm test:integration'] : []),
    ])],
    smoke: [...new Set([
      ...commands.filter((item) => checkStage(item.command) === 'smoke').map((item) => item.command),
      ...( /^(?:scripts|runtime|adapters|\.github\/workflows)\//u.test(source) ? ['pnpm smoke:lifecycle'] : []),
    ])],
  }));
}

function normalizeGitPath(entry) {
  return entry.replaceAll('\\', '/');
}

export function parseNulPathList(output) {
  return output.split('\0').filter(Boolean).map(normalizeGitPath);
}

export function parseNulPorcelainPaths(output) {
  const entries = output.split('\0');
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const record = entries[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const entry = record.slice(3);
    if (entry) paths.push(normalizeGitPath(entry));
    if (/[RC]/u.test(status)) index++;
  }
  return paths;
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
    ? ['diff', '--name-only', '-z', '--find-renames', base]
    : ['diff', '--name-only', '-z', '--find-renames', 'HEAD'];
  const paths = new Set();
  const [diff, status] = await Promise.all([
    execFileAsync('git', diffArgs, { env: gitEnv, cwd }),
    execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env: gitEnv, cwd }),
  ]);
  for (const entry of parseNulPathList(diff.stdout)) paths.add(entry);
  for (const entry of parseNulPorcelainPaths(status.stdout)) paths.add(entry);
  return [...paths];
}

function changedLineIsComment(line) {
  const value = line.trim();
  return value.length === 0
    || /^\/\//u.test(value)
    || /^#/u.test(value)
    || /^\/\*/u.test(value)
    || /^\*/u.test(value)
    || /^\*\//u.test(value)
    || /^<!--/u.test(value)
    || /^-->/u.test(value);
}

function changedLineIsFormatting(line) {
  return changedLineIsComment(line) || /^[{}()[\];,.:]+$/u.test(line.trim());
}

function changedLinesContainPublicContract(lines) {
  return lines.some((line) => /\b(?:export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface)|module\.exports|exports\.|public\s+(?:class|interface|function)|openapi|graphql|router\.(?:get|post|put|patch|delete))\b/iu.test(line));
}

function changedLinesContainDynamicDependency(lines) {
  return lines.some((line) => /\b(?:dynamic\s+import|require\(|child_process|process\.env|fetch\(|axios\.)/iu.test(line));
}

/**
 * Collect conservative content signals used by the risk classifier. A missing
 * diff (for example an untracked binary) intentionally yields no signal and
 * therefore remains fail-safe at the path-based risk level.
 */
export async function collectChangedDetails({ base = null, cwd = process.cwd() } = {}) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const diffArgs = base
    ? ['diff', '--no-ext-diff', '--unified=0', '--find-renames', base]
    : ['diff', '--no-ext-diff', '--unified=0', '--find-renames', 'HEAD'];
  const { stdout } = await execFileAsync('git', diffArgs, { env: gitEnv, cwd });
  const details = new Map();
  let currentPath = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/u);
    if (header) {
      currentPath = header[1];
      details.set(currentPath, []);
      continue;
    }
    if (!currentPath || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+') || line.startsWith('-')) details.get(currentPath).push(line.slice(1));
  }
  return [...details.entries()].map(([changedPath, lines]) => ({
    changedPath,
    commentsOnly: lines.length > 0 && lines.every(changedLineIsComment),
    formatOnly: lines.length > 0 && lines.every(changedLineIsFormatting),
    publicContract: changedLinesContainPublicContract(lines),
    dynamicDependency: changedLinesContainDynamicDependency(lines),
  }));
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

function printUsage() {
  console.log('Usage: node scripts/verify-focused.js [--base <ref>] [--run] [--json]');
  console.log();
  console.log('Prints suggested focused verification commands for the current changes.');
  console.log('  --base <ref>  Diff against <ref> instead of HEAD (covers committed changes).');
  console.log('  --run         Execute the suggested commands in order, stopping on first failure.');
  console.log('  --json        Emit suggestions or the complete focused-verification receipt as JSON.');
}

function usageError(message) {
  console.error(`verify-focused: ${message}`);
  printUsage();
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let run = false;
  let json = false;
  let base = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') {
      run = true;
    } else if (args[index] === '--json') {
      json = true;
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
  let changedDetails = [];
  try {
    changedDetails = await collectChangedDetails({ base });
  } catch {
    // collectChangedPaths already provides the actionable failure for a bad
    // repository; the selector can still produce a path-only safe plan.
  }
  const config = await readProjectConfig(process.cwd());
  const plan = await buildVerificationPlan({
    changedPaths: paths,
    commandStatus: {},
    config,
    changedDetails,
    targetDir: process.cwd(),
  });
  const commands = plan.selectedChecks;
  const notes = plan.selectionReasons;
  const impactMapping = buildImpactMapping(paths, commands);
  if (!run && json) {
    console.log(JSON.stringify({ ...plan, impactMapping, notes }, null, 2));
    return;
  }
  let report = null;
  if (run) {
    report = await runFocusedProjectVerification({
      focused: { changedPaths: paths, commands, notes, impactMapping },
      targetDir: process.cwd(),
      timeoutMs: config.verification?.timeoutMs,
    });
    report.verification = {
      ...report.verification,
      riskLevel: plan.riskLevel,
      planMode: plan.planMode,
      impactGroups: [...plan.impactGroups],
      selectedChecks: plan.selectedChecks.map((item) => ({ ...item })),
      skippedChecks: plan.skippedChecks.map((item) => ({ ...item })),
      fallbackUsed: plan.fallbackUsed,
      selectionReasons: [...plan.selectionReasons],
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    if (json) return;
  }
  if (paths.length === 0) {
    console.log('No changed paths detected; no focused verification needed.');
    return;
  }
  console.log(`Focused verification suggestions (${paths.length} changed path(s), ${commands.length} command(s)):`);
  for (const item of commands) console.log(`  ${item.command.padEnd(24)}# ${item.reason}`);
  for (const note of notes) console.log(`Note: ${note}`);
  console.log('Use --run to execute the commands in order and emit a receipt.');

  if (!run) return;

  for (const item of commands) {
    console.log(`\n$ ${item.command}`);
    try {
      const result = report.results.find((entry) => entry.command === item.command);
      if (result.stdout) process.stdout.write(result.stdout + (result.stdout.endsWith('\n') ? '' : '\n'));
      if (result.stderr) process.stderr.write(result.stderr + (result.stderr.endsWith('\n') ? '' : '\n'));
      if (result.status !== 'passed') throw result;
    } catch (error) {
      console.error(`\nFocused verification failed at: ${item.command}`);
      console.error('Recovery: ' + (error.next?.command ?? 'pnpm verify:focused --run'));
      process.exit(typeof error.exitCode === 'number' ? error.exitCode : 1);
    }
  }
  console.log('\nFocused verification passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
