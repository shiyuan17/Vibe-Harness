import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCommand } from '../runtime/commands/run.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
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
    assert.equal(result.report.checks.lint.status, 'blocked');
    assert.equal(result.report.checks.lint.code, 'VIBE_HARNESS_UNSAFE_COMMAND');
    assert.equal(result.report.checks.test.status, 'blocked');
    assert.equal(result.report.checks.test.code, 'MANUAL_REQUIRES_ALLOW');
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
