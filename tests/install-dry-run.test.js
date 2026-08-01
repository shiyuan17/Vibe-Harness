import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { applyInstallPlan, createInstallPlan } from '../scripts/lib/install-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');

test('dry-run install plans full files without writing them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-dry-run-'));
  try {
    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'full',
      rootDir,
      targetDir: target,
    });

    assert.equal(plan.profile, 'full');
    assert.equal(plan.dryRun, true);
    assert.ok(plan.actions.some((action) => action.target.endsWith('AGENTS.md')));
    assert.ok(plan.actions.some((action) => action.target.endsWith(path.join('docs', 'rules', 'governance-core.md'))));
    assert.ok(plan.actions.some((action) => action.redZone === true));

    const result = await applyInstallPlan(plan);
    assert.equal(result.written.length, 0);

    await assert.rejects(readFile(path.join(target, 'AGENTS.md'), 'utf8'), /ENOENT/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install refuses to overwrite existing files unless force is used', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });

    const conflict = plan.actions.find((action) => action.target.endsWith('AGENTS.md'));
    assert.equal(conflict.kind, 'conflict');
    await assert.rejects(applyInstallPlan(plan), /Refusing to overwrite/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('dry-run reports conflicts without failing or writing files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-dry-run-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });
    const result = await applyInstallPlan(plan);

    assert.equal(plan.actions.find((action) => action.relativeTarget === 'AGENTS.md').kind, 'conflict');
    assert.deepEqual(result.written, []);
    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'user-owned content\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('actual install blocks red-zone files without explicit confirmation', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-redzone-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'full',
      rootDir,
      targetDir: target,
    });

    assert.ok(plan.actions.some((action) => action.redZone === true));
    await assert.rejects(applyInstallPlan(plan), /red-zone/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('actual install refuses to write outside the target directory', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-escape-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });
    const agents = plan.actions.find((action) => action.relativeTarget === 'AGENTS.md');
    agents.relativeTarget = '../escape.md';
    agents.target = path.resolve(target, '../escape.md');

    await assert.rejects(applyInstallPlan(plan), /outside target directory|portable relative path/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('failed install rolls back every file before install state is committed', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-transaction-failure-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');
    const plan = await createInstallPlan({
      dryRun: false,
      force: true,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });

    await assert.rejects(
      applyInstallPlan(plan, {
        afterFileWrite() {
          throw new Error('injected install failure');
        },
      }),
      /injected install failure/,
    );

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'user-owned content\n');
    await assert.rejects(readFile(path.join(target, 'docs/rules/governance-core.md'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI write mode writes files when red-zone confirmation is explicit', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-apply-'));
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
      '--allow-degraded',
    ]);

    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');
    const deliveryTemplate = await readFile(path.join(target, 'docs/templates/delivery.md'), 'utf8');
    const clarifySkill = await readFile(path.join(target, '.agents/skills/clarify-requirements/SKILL.md'), 'utf8');

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8').then((content) => content.includes('## 启动')), true);
    assert.equal(await readFile(path.join(target, '.codex/hooks.json'), 'utf8').then((content) => content.includes('hooks')), true);
    assert.equal(taskTemplate.includes('档位：'), true);
    assert.equal(deliveryTemplate.includes('实际变更'), true);
    assert.equal(deliveryTemplate.includes('本轮验证'), true);
    assert.equal(clarifySkill.includes('澄清关键需求'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI write mode installs localized en-US templates when language is en-US', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-enus-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'full']);
    // init defaults to zh-CN; switch to en-US before installing so the
    // sourceForEntry localization picks the .en-US.md template sources.
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.language = 'en-US';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
      '--allow-degraded',
    ]);

    const deliveryTemplate = await readFile(path.join(target, 'docs/templates/delivery.md'), 'utf8');
    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');
    assert.equal(deliveryTemplate.includes('Actual changes'), true);
    assert.equal(deliveryTemplate.includes('Verification performed this run'), true);
    assert.equal(taskTemplate.includes('档位：'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
