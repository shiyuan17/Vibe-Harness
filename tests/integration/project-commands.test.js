import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCommand } from '../../runtime/commands/run.mjs';
import { attestCompletionProvenance } from '../../runtime/lib/verification-receipt.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function tempProject() {
  return mkdtemp(path.join(tmpdir(), 'vibe-harness-project-commands-'));
}

async function writeConfig(project, validationCommands) {
  await writeFile(
    path.join(project, 'vibe-harness.config.json'),
    `${JSON.stringify({ validationCommands }, null, 2)}\n`,
    'utf8',
  );
}

async function runRootCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(result.stdout);
}

/**
 * A project the CLI can verify end to end: committed, configured to require a
 * completion receipt, and installed so the preflight sees a consistent state.
 *
 * `validationCommands` defaults to one plain slot; pass `{ checks: [...] }`
 * to declare explicitly deterministic checks, which is what makes the receipt
 * store usable for `--reuse`.
 */
async function installedProject(project, { validationCommands = { test: 'node -e 0' } } = {}) {
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'core.hooksPath', '.git/no-hooks']]) {
    await execFileAsync('git', args, { cwd: project });
  }
  await execFileAsync(process.execPath, [cliPath, 'init', '--project', project, '--target', 'codex', '--profile', 'full'], { cwd: rootDir });
  const configPath = path.join(project, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.validationCommands = validationCommands;
  config.delivery = { default: 'managed-mr', profiles: { 'managed-mr': { merge: 'squash', cleanup: 'evidence-compatible', requireReceipt: true } } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  // The receipt store only works when the project ignores it.
  await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: project });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: project });
  await execFileAsync(process.execPath, [
    cliPath, 'install', '--project', project, '--target', 'codex', '--profile', 'full',
    '--write', '--confirm-red-zone', '--allow-degraded', '--output', 'json',
  ], { cwd: rootDir });
}

test('CLI verify 只承认显式 --reviewed 作为完成审阅证据', async () => {
  const project = await tempProject();
  try {
    await installedProject(project);
    // Without the declaration the checked commands are not review evidence, so
    // the receipt the CLI reports stays incomplete instead of self-attesting.
    // The caller never supplied the evidence, so the draft records it as
    // unverified rather than blocked: nothing contradicts the completion, and
    // only `passed` completes a delivery.
    const unreviewed = await runRootCli(['verify', '--project', project, '--allow-manual', '--output', 'json']);
    assert.equal(unreviewed.completion.status, 'unverified', JSON.stringify(unreviewed.completion));
    assert.equal(unreviewed.completion.verificationAcceptance.status, 'blocked');

    const reviewed = await runRootCli(['verify', '--project', project, '--allow-manual', '--output', 'json', '--reviewed', 'all']);
    assert.equal(reviewed.completion.verificationAcceptance.status, 'accepted', JSON.stringify(reviewed.completion));
    assert.equal(reviewed.completion.status, 'passed');
    assert.ok(reviewed.completion.review.reviewedCheckIds.length > 0);
    // The receipt a receipt-required delivery accepts has to resolve to the
    // record this run wrote, so the gate can be satisfied after the fact.
    const attestation = await attestCompletionProvenance(project, reviewed.completion);
    assert.equal(attestation.ok, true, JSON.stringify(attestation));
    // The record store is inside the project, so a caller can rewrite it: only a
    // record whose authentication still matches counts as tool-written evidence.
    const directory = path.join(project, '.vibe-harness/verification/receipts');
    const [file] = await readdir(directory);
    const recordPath = path.join(directory, file);
    const stored = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...stored, writeFingerprint: 'forged' }), 'utf8');
    const forged = await attestCompletionProvenance(project, reviewed.completion);
    assert.equal(forged.ok, false, JSON.stringify(forged));
    // A receipt may not relabel a recorded check as a manual criterion: the
    // command is the evidence, and a criterion cannot stand in for it.
    const relabelled = structuredClone(reviewed.completion);
    relabelled.acceptance = relabelled.acceptance.map((item, index) => (index === 0
      ? { id: item.id, status: 'passed', criterion: 'reviewed by hand', scope: item.scope }
      : item));
    const criterion = await attestCompletionProvenance(project, relabelled);
    assert.equal(criterion.ok, false, JSON.stringify(criterion));
    // Neither may it cite a stronger command than the one this run reported.
    const replaced = structuredClone(reviewed.completion);
    replaced.acceptance = replaced.acceptance.map((item, index) => (index === 0
      ? { ...item, command: 'pnpm verify:all' }
      : item));
    const command = await attestCompletionProvenance(project, replaced);
    assert.equal(command.ok, false, JSON.stringify(command));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('CLI verify 在需要完成收据时仍可复用，但审查只认本次声明', async () => {
  const project = await tempProject();
  try {
    await installedProject(project, { validationCommands: { checks: [{ id: 'test', command: 'node -e 0', deterministic: true }] } });
    // A cache hit never replays the stored review verdict: this invocation's
    // `--reviewed` declaration is applied to the reused check set again.
    const first = await runRootCli(['verify', '--project', project, '--allow-manual', '--output', 'json', '--reviewed', 'all', '--reuse']);
    assert.equal(first.completion.verificationAcceptance.status, 'accepted', JSON.stringify(first.completion));
    const rerun = await runRootCli(['verify', '--project', project, '--allow-manual', '--output', 'json', '--reviewed', 'all', '--reuse']);
    assert.equal(rerun.verification.cache.status, 'hit', JSON.stringify(rerun.verification.cache));
    assert.equal(rerun.completion.verificationAcceptance.status, 'accepted', JSON.stringify(rerun.completion.verificationAcceptance));

    // A stored review the current plan does not select is not evidence for this
    // run, so a reuse attempt without this caller's declaration stays blocked.
    const receiptDirectory = path.join(project, '.vibe-harness/verification/receipts');
    const [receiptFile] = await readdir(receiptDirectory);
    const receiptPath = path.join(receiptDirectory, receiptFile);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    await writeFile(receiptPath, JSON.stringify({
      ...receipt,
      review: { ...receipt.review, reviewedCheckIds: ['browser'], status: 'relevant' },
    }), 'utf8');
    const undeclared = await runRootCli(['verify', '--project', project, '--allow-manual', '--output', 'json', '--reuse']);
    // The tampered record fails authentication, so the run executes again and
    // still has no review declaration from this caller.
    assert.equal(undeclared.verification.cache.status, 'miss');
    assert.equal(undeclared.completion.verificationAcceptance.status, 'blocked', JSON.stringify(undeclared.completion.verificationAcceptance));
    assert.equal(undeclared.completion.status, 'unverified');
    // The run itself passed and reported the missing evidence, so the ordinary
    // report status stays valid for the layer that ran instead of claiming the
    // delivery failed.
    assert.equal(undeclared.ok, true);
    assert.equal(undeclared.status, 'ready');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('project command context and environment report facts without executing project checks', async () => {
  const project = await tempProject();
  try {
    await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@10.0.0' }));
    const context = await runCommand(['context', '--project', '.', '--json'], { cwd: project });
    assert.equal(context.exitCode, 0);
    assert.equal(context.report.package.name, 'fixture');
    assert.equal(context.report.package.packageManager, 'npm');

    const env = await runCommand(['env', '--project', '.', '--json'], { cwd: project });
    assert.equal(env.exitCode, 0);
    assert.equal(typeof env.report.executables.node, 'boolean');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify plan never executes configured commands', async () => {
  const project = await tempProject();
  const marker = path.join(project, 'executed.txt');
  try {
    await writeConfig(project, { test: `node -e "require('node:fs').writeFileSync('${marker}', 'unexpected')"` });
    const result = await runCommand(['verify', '--project', '.', '--plan', '--json'], { cwd: project });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'planned');
    assert.equal(result.report.checks.test.status, 'planned');
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify executes safe commands and reports failures', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(3)"' });
    const result = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.checks.lint.status, 'passed');
    assert.equal(result.report.checks.test.status, 'failed');
    assert.equal(result.report.checks.test.exitCode, 3);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify blocks shell metacharacters and manual commands by default', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, {
      lint: 'node -e "process.exit(0)"; touch escaped.txt',
      test: 'manual:node -e "process.exit(0)"',
    });
    const result = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(result.exitCode, 1);
    // `blocked` stays a distinct terminal status: no evidence was produced,
    // which is a different statement than a check that ran and failed.
    assert.equal(result.report.schemaVersion, 2);
    assert.equal(result.report.engine, 'vibe-harness-runtime');
    assert.equal(result.report.status, 'blocked');
    assert.equal(result.report.verification.status, 'checks_blocked');
    assert.equal(result.report.checks.lint.status, 'blocked');
    assert.equal(result.report.checks.lint.code, 'VIBE_HARNESS_UNSAFE_COMMAND');
    assert.equal(result.report.checks.test.status, 'blocked');
    assert.equal(result.report.checks.test.code, 'MANUAL_REQUIRES_ALLOW');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify 在 failed 与 blocked 并存时保持 failed 优先于 blocked', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, {
      lint: 'node -e "process.exit(0)"; touch escaped.txt',
      test: 'node -e "process.exit(3)"',
    });
    const result = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.verification.status, 'checks_failed');
    assert.equal(result.report.checks.lint.status, 'blocked');
    assert.equal(result.report.checks.test.status, 'failed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify 默认延迟深层插槽并支持 --tier deep 显式升级', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { lint: 'node -e "process.exit(0)"', eval: 'node -e "process.exitCode=0"' });
    const quick = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(quick.exitCode, 0);
    assert.equal(quick.report.status, 'passed');
    assert.equal(quick.report.tier, 'quick');
    assert.equal(quick.report.checks.lint.status, 'passed');
    assert.equal(quick.report.checks.eval.status, 'deferred');
    assert.deepEqual(quick.report.deferredChecks, [{
      name: 'eval',
      tier: 'deep',
      command: 'node -e "process.exitCode=0"',
      selectionReasons: ['deep 层检查覆盖 项目根目录；请求执行层为 quick'],
    }]);
    assert.equal(quick.report.nextTier, 'deep');

    const deep = await runCommand(['verify', '--project', '.', '--tier', 'deep', '--json'], { cwd: project });
    assert.equal(deep.exitCode, 0);
    assert.equal(deep.report.status, 'passed');
    assert.equal(deep.report.tier, 'deep');
    assert.equal(deep.report.checks.eval.status, 'passed');
    assert.deepEqual(deep.report.deferredChecks, []);
    assert.equal(deep.report.nextTier, null);

    const invalid = await runCommand(['verify', '--project', '.', '--tier', 'all', '--json'], { cwd: project });
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.report.status, 'failed');
    assert.match(invalid.report.error, /--tier must be one of quick, standard, deep/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify 按声明的 validationCommands.tiers 解析插槽层级', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, {
      test: 'node -e "process.exit(0)"',
      tiers: { quick: [], standard: [], deep: ['node -e "process.exit(0)"'] },
    });
    const quick = await runCommand(['verify', '--project', '.', '--tier', 'quick', '--json'], { cwd: project });
    assert.equal(quick.report.status, 'unverified');
    assert.equal(quick.report.checks.test.status, 'deferred');
    assert.deepEqual(quick.report.deferredChecks, [{
      name: 'test',
      tier: 'deep',
      command: 'node -e "process.exit(0)"',
      selectionReasons: ['deep 层检查覆盖 项目根目录；请求执行层为 quick'],
    }]);
    // `--only` is an explicit per-check selection and wins over tier deferral.
    const explicit = await runCommand(['verify', '--project', '.', '--only', 'test', '--json'], { cwd: project });
    assert.equal(explicit.report.status, 'passed');
    assert.equal(explicit.report.checks.test.status, 'passed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('changes reports git status without invoking a shell', async () => {
  const project = await tempProject();
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: project });
    await writeFile(path.join(project, 'new file.txt'), 'fixture\n');
    const result = await runCommand(['changes', '--project', '.', '--json'], { cwd: project });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'ready');
    assert.equal(result.report.changes.some((item) => item.path === 'new file.txt'), true);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('help 覆盖含 worktree、slice、patch 与 task 在内的全部项目命令', async () => {
  const result = await runCommand(['help', '--json'], { cwd: rootDir });
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.report.usage,
    'run.mjs <env|context|changes|verify|worktree|slice|patch|task> [--project <path>] [--json]（--project 缺省为当前目录）',
  );
  assert.equal(result.report.codebaseMemory, undefined);
  assert.match(result.report.worktree, /worktree <list\|check\|bootstrap\|land\|cleanup\|recover>/u);
  assert.match(result.report.worktree, /dry-run until --write/u);
  assert.match(result.report.worktree, /land serializes writes through a shared Git common-dir lock/u);
  assert.match(result.report.worktree, /merges the attributed worktree in an isolated candidate \(--no-ff\)/u);
  assert.match(result.report.task, /task <init\|update\|status\|list\|plan-check\|plan-sync\|check\|freeze-tests\|rebaseline-tests>/u);
  assert.match(result.report.reuse, /--reuse/u);
});

test('the --help flag routes to the help receipt from any command position', async () => {
  const result = await runCommand(['worktree', '--help'], { cwd: rootDir });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.command, 'help');
  assert.equal(result.report.status, 'ready');
});

test('core installation provides a standalone project command runner', async () => {
  const project = await tempProject();
  try {
    await runRootCli(['init', '--project', project]);
    const install = await runRootCli([
      'install', '--project', project, '--target', 'codex', '--profile', 'core', '--write',
    ]);
    assert.equal(install.ok, true);
    const runner = path.join(project, '.agents/runtime/commands/run.mjs');
    const result = await execFileAsync(process.execPath, [runner, 'context', '--project', '.', '--json'], { cwd: project });
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, 'context');
    assert.equal(report.status, 'ready');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify detects a content change to an already-dirty file', async () => {
  const project = await tempProject();
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: project });
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: project });
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: project });
    await writeFile(path.join(project, 'data.txt'), 'one\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: project });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'init'], { cwd: project });
    // The file is already dirty before verification starts, so the porcelain
    // status line is identical before and after the check rewrites it.
    await writeFile(path.join(project, 'data.txt'), 'two\n', 'utf8');
    await writeFile(
      path.join(project, 'mutate.cjs'),
      'require("node:fs").appendFileSync("data.txt", "three\\n");\n',
      'utf8',
    );
    await writeConfig(project, { test: 'node mutate.cjs' });

    const result = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });

    assert.equal(result.report.checks.test.status, 'passed');
    assert.equal(result.report.verification.stable, false);
    assert.equal(result.report.verification.status, 'workspace_changed');
    assert.equal(result.exitCode, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
