import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { defaultProjectConfig, validateProjectConfig } from '../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

test('project config exposes guarded safety Hook defaults', () => {
  assert.deepEqual(defaultProjectConfig.hooks, { allowedWriteRoots: [], mode: 'guarded' });
  assert.equal(validateProjectConfig(defaultProjectConfig), true);
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { mode: 'strict' } }),
    /hooks\.mode/,
  );
  assert.equal(validateProjectConfig({
    ...defaultProjectConfig,
    hooks: { allowedWriteRoots: [path.resolve(rootDir, '..', 'companion-project')] },
  }), true);
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { allowedWriteRoots: ['../companion-project'] } }),
    /hooks\.allowedWriteRoots/,
  );
});

test('full installs safety Hook runtime while core does not', async () => {
  const run = async (profile) => {
    const target = await mkdtemp(path.join(tmpdir(), `cognis-hook-${profile}-`));
    try {
      await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', profile]);
      const { stdout } = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', profile, '--dry-run']);
      return JSON.parse(stdout).actions.map((action) => action.relativeTarget);
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  };
  const core = await run('core');
  const full = await run('full');

  for (const target of [
    '.codex/hooks.json',
    '.agents/cognis/hooks/codex-hook.mjs',
    '.agents/cognis/hooks/lib/context.mjs',
    '.agents/cognis/hooks/lib/policy.mjs',
    '.githooks/pre-commit',
    '.githooks/pre-push',
  ]) assert.equal(full.includes(target), true, target);
  assert.equal(core.some((target) => target.includes('/hooks/') || target.startsWith('.githooks/')), false);
});

test('full Codex install writes only PreToolUse and PermissionRequest Hook events', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-hook-events-'));
  try {
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full']);
    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone',
    ]);
    const hooks = JSON.parse(await readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PreToolUse']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor reports Git Hook activation without modifying local Git config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-hook-doctor-'));
  try {
    await execFileAsync('git', ['init'], { cwd: target });
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex']);
    await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);
    const doctor = async () => JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--profile', 'minimal',
    ])).stdout);

    const inactive = await doctor();
    assert.deepEqual(inactive.gitHooks, { active: false, configuredPath: null, expectedPath: '.githooks', status: 'inactive' });
    await execFileAsync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: target });
    assert.equal((await doctor()).gitHooks.status, 'active');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
