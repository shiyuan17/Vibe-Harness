import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { inspectTargetInstall } from '../scripts/lib/install-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');

test('target inspection reports missing files and red-zone status for an empty target', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-target-empty-'));
  try {
    const report = await inspectTargetInstall({ profile: 'codex-internal', rootDir, targetDir: target });

    assert.equal(report.profile, 'codex-internal');
    assert.ok(report.missing.some((item) => item.target.endsWith('AGENTS.md')));
    assert.ok(report.redZone.some((item) => item.target === '.codex/hooks.json' && item.status === 'missing'));
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('target inspection reports conflicts when existing target content differs', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-target-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'project-owned content\n', 'utf8');

    const report = await inspectTargetInstall({ profile: 'codex-minimal', rootDir, targetDir: target });

    assert.ok(report.conflicts.some((item) => item.target.endsWith('AGENTS.md')));
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI validate --target passes after a real install and reports Chinese template content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-target-installed-'));
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
    ]);

    const { stdout } = await execFileAsync(process.execPath, [
      path.join(rootDir, 'scripts/loopengine.js'),
      'validate',
      '--target',
      target,
      '--profile',
      'codex-internal',
    ]);

    const report = JSON.parse(stdout);
    const intakeTemplate = await readFile(path.join(target, 'docs/templates/task-intake.md'), 'utf8');

    assert.equal(report.ok, true);
    assert.deepEqual(report.missing, []);
    assert.equal(intakeTemplate.includes('来源'), true);
    assert.equal(intakeTemplate.includes('Source'), false);
    assert.equal(intakeTemplate.includes('任务模式'), true);
    assert.equal(intakeTemplate.includes('拆分判断'), true);
    assert.equal(intakeTemplate.includes('父任务'), true);
    assert.equal(intakeTemplate.includes('子任务'), true);
    assert.equal(intakeTemplate.includes('写入范围'), true);
    assert.equal(intakeTemplate.includes('禁止动作'), true);
    assert.equal(intakeTemplate.includes('Write Scope'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
