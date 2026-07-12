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
const rootDir = path.resolve('.');

test('dry-run install plans codex-internal files without writing them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-dry-run-'));
  try {
    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'codex-internal',
      rootDir,
      targetDir: target,
    });

    assert.equal(plan.profile, 'codex-internal');
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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'codex-minimal',
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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-dry-run-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'codex-minimal',
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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-redzone-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'codex-internal',
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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-escape-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'codex-minimal',
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

test('CLI apply mode writes files when red-zone confirmation is explicit', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-apply-'));
  try {
    await execFileAsync(process.execPath, [
      path.join(rootDir, 'scripts/loopengine.js'),
      'install',
      '--target',
      target,
      '--profile',
      'codex-internal',
      '--apply',
      '--confirm-red-zone',
      '--allow-degraded',
    ]);

    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');
    const deliveryTemplate = await readFile(path.join(target, 'docs/templates/delivery.md'), 'utf8');
    const routerSkill = await readFile(path.join(target, '.agents/skills/using-loopengine/SKILL.md'), 'utf8');

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8').then((content) => content.includes('## 启动')), true);
    assert.equal(await readFile(path.join(target, '.codex/hooks.json'), 'utf8').then((content) => content.includes('hooks')), true);
    assert.equal(taskTemplate.includes('工作流档位'), true);
    assert.equal(taskTemplate.includes('完整流程控制'), true);
    assert.equal(deliveryTemplate.includes('轻量反证'), true);
    assert.equal(routerSkill.includes('LoopEngine 路由'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
