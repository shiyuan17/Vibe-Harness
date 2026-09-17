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
import {
  DEFAULT_VALIDATION_TIER,
  VALIDATION_TIERS,
  cumulativeTierNames,
  normalizeTierOption,
} from './lib/validation-tiers.js';
import { buildVerificationPlan } from './lib/verification-plan.js';

const execFileAsync = promisify(execFile);

function checkStage(command) {
  if (/test:matrix/iu.test(command)) return 'matrix';
  if (/test:e2e/iu.test(command)) return 'e2e';
  if (/test:integration/iu.test(command)) return 'integration';
  if (/smoke:lifecycle/iu.test(command)) return 'smoke';
  if (/test:component/iu.test(command)) return 'component';
  return 'focused';
}

export function buildImpactMapping(paths, commands) {
  const stage = (name) => [...new Set(commands.filter((item) => checkStage(item.command) === name).map((item) => item.command))];
  return paths.map((source) => ({
    source,
    focused: [
      ...stage('focused'),
      ...stage('component'),
    ],
    integration: [...new Set([
      ...stage('integration'),
      ...( /^(?:scripts|runtime|adapters)\//u.test(source) ? ['pnpm test:integration'] : []),
    ])],
    e2e: [...new Set([
      ...stage('e2e'),
      ...( /^(?:scripts|runtime|adapters|\.github\/workflows)\//u.test(source) ? ['pnpm test:e2e'] : []),
    ])],
    matrix: stage('matrix'),
    smoke: [...new Set([
      ...stage('smoke'),
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
  console.log('Usage: node scripts/verify-focused.js [--base <ref>] [--run] [--tier quick|standard|deep|all] [--json]');
  console.log();
  console.log('Prints suggested focused verification commands for the current changes.');
  console.log('  --base <ref>  Diff against <ref> instead of HEAD (covers committed changes).');
  console.log('  --run         Execute the selected commands in order, stopping on first failure.');
  console.log('  --tier <t>    Cost layer to execute: quick (default), standard, deep, or all.');
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
  let tier = DEFAULT_VALIDATION_TIER;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') {
      run = true;
    } else if (args[index] === '--json') {
      json = true;
    } else if (args[index] === '--tier') {
      const value = args[++index];
      if (value === undefined) usageError('--tier requires a layer argument (quick, standard, deep, all).');
      try {
        tier = normalizeTierOption(value);
      } catch (error) {
        usageError(error.message);
      }
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
  // The risk plan answers "what does this change affect"; the cost layer
  // answers "which of that evidence do I pay for now". The fast layer is the
  // default, and the deferred checks stay visible instead of disappearing.
  const activeTiers = new Set(cumulativeTierNames(tier));
  const tierOf = (item) => item.costTier ?? 'standard';
  const commands = plan.selectedChecks.filter((item) => activeTiers.has(tierOf(item)));
  const deferredChecks = plan.selectedChecks
    .filter((item) => !activeTiers.has(tierOf(item)))
    .map((item) => ({ ...item }));
  const nextTier = VALIDATION_TIERS.find((name) => deferredChecks.some((item) => tierOf(item) === name)) ?? null;
  const scopeStatus = deferredChecks.length > 0 ? 'partial' : 'complete';
  const notes = plan.selectionReasons;
  const impactMapping = buildImpactMapping(paths, plan.selectedChecks);
  if (!run && json) {
    console.log(JSON.stringify({
      ...plan,
      deferredChecks,
      executionTier: tier,
      impactMapping,
      nextTier,
      notes,
      scopeStatus,
      selectedChecks: commands,
    }, null, 2));
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
      deferredChecks,
      executionTier: tier,
      riskLevel: plan.riskLevel,
      planMode: plan.planMode,
      impactGroups: [...plan.impactGroups],
      nextTier,
      scopeStatus,
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
  for (const item of deferredChecks) {
    console.log(`  ${item.command.padEnd(24)}# deferred (${item.costTier}): ${item.blockingScope}`);
  }
  for (const note of notes) console.log(`Note: ${note}`);
  if (deferredChecks.length > 0) {
    console.log(`Deferred layers are not run by default; escalate with --tier ${nextTier ?? 'deep'} when the completion claim needs them.`);
  }
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
