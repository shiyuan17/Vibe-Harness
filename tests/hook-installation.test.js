import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { defaultProjectConfig, validateProjectConfig } from '../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

test('project config exposes guarded hook defaults and validates optional hook settings', () => {
  assert.deepEqual(defaultProjectConfig.hooks, {
    completionGate: 'advisory',
    mode: 'guarded',
  });
  assert.equal(validateProjectConfig(defaultProjectConfig), true);
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { mode: 'unsafe' } }),
    /hooks\.mode/,
  );
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { completionGate: 'always' } }),
    /hooks\.completionGate/,
  );
});

test('full and internal profiles install hook runtime and inactive Git hook templates while core does not', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-hook-profile-'));
  try {
    const run = async (profile) => {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, 'install', '--target', target, '--profile', profile, '--dry-run']);
      return JSON.parse(stdout).actions.map((action) => action.relativeTarget);
    };
    const core = await run('core');
    const full = await run('full');
    const internal = await run('codex-internal');

    for (const targets of [full, internal]) {
      assert.ok(targets.includes('.codex/hooks.json'));
      assert.ok(targets.includes('.agents/loopengine/hooks/codex-hook.mjs'));
      assert.ok(targets.includes('.githooks/pre-commit'));
      assert.ok(targets.includes('.githooks/pre-push'));
    }
    assert.equal(core.some((targetPath) => targetPath.includes('/hooks/') || targetPath.startsWith('.githooks/')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor reports Git hook activation without modifying local Git config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-hook-doctor-'));
  try {
    await execFileAsync('git', ['init'], { cwd: target });
    const doctor = async () => JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--target', target, '--profile', 'codex-minimal',
    ])).stdout);

    const inactive = await doctor();
    assert.deepEqual(inactive.gitHooks, { active: false, configuredPath: null, expectedPath: '.githooks', status: 'inactive' });

    await execFileAsync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: target });
    const active = await doctor();
    assert.equal(active.gitHooks.active, true);
    assert.equal(active.gitHooks.status, 'active');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
