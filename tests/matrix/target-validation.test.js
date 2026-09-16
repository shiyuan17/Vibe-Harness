import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { inspectTargetInstall } from '../../scripts/lib/install-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');

test('target inspection reports missing files and red-zone status for an empty target', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-empty-'));
  try {
    const report = await inspectTargetInstall({ profile: 'full', rootDir, targetDir: target });

    assert.equal(report.profile, 'full');
    assert.ok(report.missing.some((item) => item.target.endsWith('AGENTS.md')));
    assert.ok(report.redZone.some((item) => item.target === '.codex/hooks.json' && item.status === 'missing'));
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('target inspection reports conflicts when existing target content differs', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'project-owned content\n', 'utf8');

    const report = await inspectTargetInstall({ profile: 'minimal', rootDir, targetDir: target });

    assert.ok(report.conflicts.some((item) => item.target.endsWith('AGENTS.md')));
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI validate --project passes after a real install and reports Chinese template content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-installed-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'full']);
    await execFileAsync(process.execPath, [
      cliPath,
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'full',
      '--write',
      '--confirm-red-zone',
    ]);

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'validate',
      '--project',
      target,
    ]);

    const report = JSON.parse(stdout);
    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');

    assert.equal(report.ok, true);
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.warnings.map((warning) => warning.code), [
      'HOOK_ACTIVATION_UNVERIFIED',
      'HOOK_ENFORCEMENT_UNVERIFIED',
    ]);
    assert.deepEqual(report.tools, {});
    assert.equal(report.scope, 'project');
    assert.equal(taskTemplate.includes('可选的人读记录'), true);
    assert.equal(taskTemplate.includes('档位'), true);
    assert.equal(taskTemplate.includes('状态'), true);
    assert.equal(taskTemplate.includes('验收'), true);
    assert.equal(taskTemplate.includes('下一步'), true);
    assert.equal(taskTemplate.includes('验证'), true);
    assert.equal(taskTemplate.includes('风险'), true);
    assert.equal(taskTemplate.includes('Write Scope'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Linear plugin install validates the dedicated DAG and execution receipt templates', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-linear-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'core']);
    await execFileAsync(process.execPath, [
      cliPath,
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--plugin',
      'linear-mcp',
      '--write',
      '--confirm-red-zone',
    ]);
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]);
    assert.equal(JSON.parse(stdout).ok, true);
    const [parent, receipt] = await Promise.all([
      readFile(path.join(target, 'docs/templates/linear/dag-parent.md'), 'utf8'),
      readFile(path.join(target, 'docs/templates/linear/execution-receipt.md'), 'utf8'),
    ]);
    assert.match(parent, /Fan-in Verification/u);
    assert.match(parent, /Completion Policy/u);
    assert.match(receipt, /vibe-harness\.linear-execution\/v1/u);
    assert.match(receipt, /runtimeInstanceId/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('init --targets writes every requested adapter and rejects invalid lists', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-list-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--targets', 'codex,bogus']),
      /Unknown target: bogus/u,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--targets', 'codex,codex']),
      /duplicate adapters/u,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--targets', 'codex,zcode', '--target', 'codex']),
      /not both/u,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--targets', 'codex,']),
      /comma-separated adapter list/u,
    );

    await execFileAsync(process.execPath, [
      cliPath, 'init', '--project', target, '--targets', 'codex,zcode,opencode', '--preset', 'everything',
    ]);
    const config = JSON.parse(await readFile(path.join(target, 'vibe-harness.config.json'), 'utf8'));
    assert.equal(config.preset, 'everything');
    assert.equal(config.profile, 'full');
    assert.deepEqual(config.targets, ['codex', 'zcode', 'opencode']);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target, '--preset', 'everything']),
      /only accepted by init and install/u,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--preset', 'unknown', '--dry-run']),
      /Unknown preset: unknown/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('everything preset plans the full surface for every target before writing', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-preset-plan-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [
      cliPath, 'init', '--project', target, '--targets', 'codex,zcode,opencode', '--preset', 'everything',
    ]);
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--dry-run',
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.preset, 'everything');
    assert.equal(report.profile, 'full');
    assert.deepEqual(report.targets, ['codex', 'zcode', 'opencode']);
    assert.equal(report.requestedPlugins.includes('linear'), true);
    assert.equal(report.requestedPlugins.length, 7);
    assert.equal(report.requestedModules.includes('memory'), true);
    assert.deepEqual(report.provisioning, { executed: false, requested: true, source: 'preset' });
    assert.equal(report.requiresRedZoneConfirmation, true);
    assert.equal(report.configUpdate, null);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('everything preset writes three host projections and replays them in validate and doctor', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-preset-write-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [
      cliPath, 'init', '--project', target, '--targets', 'codex,zcode,opencode', '--preset', 'everything',
    ]);
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--write', '--confirm-red-zone', '--allow-degraded',
    ], { timeout: 180_000 });
    const report = JSON.parse(stdout);
    assert.equal(report.preset, 'everything');
    assert.deepEqual(report.targets, ['codex', 'zcode', 'opencode']);
    assert.equal(report.provisioning.executed, true);
    assert.equal(report.provisioning.source, 'preset');

    const config = JSON.parse(await readFile(path.join(target, 'vibe-harness.config.json'), 'utf8'));
    assert.equal(config.preset, 'everything');
    assert.equal(config.profile, 'full');
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.deepEqual(state.targets, ['codex', 'zcode', 'opencode']);
    assert.equal(state.requestedPlugins.includes('linear'), true);
    assert.equal(state.requestedModules.includes('memory'), true);

    const validation = await execFileAsync(process.execPath, [
      cliPath, 'validate', '--project', target, '--allow-degraded',
    ]);
    assert.equal(JSON.parse(validation.stdout).preset, 'everything');
    const doctor = await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--allow-degraded',
    ]);
    assert.equal(JSON.parse(doctor.stdout).preset, 'everything');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install --preset persists the preset into an existing project config under red-zone confirmation', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-preset-persist-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full']);
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--preset', 'everything', '--write', '--allow-degraded',
      ], { timeout: 180_000 }),
      /red-zone confirmation/u,
    );

    const preview = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--preset', 'everything', '--dry-run',
    ]);
    assert.deepEqual(JSON.parse(preview.stdout).configUpdate, {
      preset: 'everything',
      profile: 'full',
      relativeTarget: 'vibe-harness.config.json',
    });

    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--preset', 'everything', '--write', '--confirm-red-zone', '--allow-degraded',
    ], { timeout: 180_000 });
    const config = JSON.parse(await readFile(path.join(target, 'vibe-harness.config.json'), 'utf8'));
    assert.equal(config.preset, 'everything');
    assert.equal(config.profile, 'full');
    assert.deepEqual(config.targets, ['codex']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
