import './helpers/offline-tools.js';

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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-target-conflict-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-target-installed-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/loopengine.js');
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

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'validate',
      '--project',
      target,
      '--allow-degraded',
    ]);

    const report = JSON.parse(stdout);
    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');

    assert.equal(report.ok, false);
    assert.equal(report.status, 'degraded');
    assert.equal(report.scope, 'project');
    assert.equal(taskTemplate.includes('工作流档位'), true);
    assert.equal(taskTemplate.includes('当前阶段'), true);
    assert.equal(taskTemplate.includes('完整流程控制'), true);
    assert.equal(taskTemplate.includes('父任务'), true);
    assert.equal(taskTemplate.includes('子任务'), true);
    assert.equal(taskTemplate.includes('写入范围'), true);
    assert.equal(taskTemplate.includes('禁止动作'), true);
    assert.equal(taskTemplate.includes('Write Scope'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
