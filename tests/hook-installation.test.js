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
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

test('project config exposes guarded hook defaults and validates optional hook settings', () => {
  assert.deepEqual(defaultProjectConfig.hooks, {
    allowedWriteRoots: [],
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
  assert.equal(validateProjectConfig({
    ...defaultProjectConfig,
    hooks: { allowedWriteRoots: [path.resolve(rootDir, '..', 'companion-project')] },
  }), true);
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { allowedWriteRoots: ['../companion-project'] } }),
    /hooks\.allowedWriteRoots/,
  );
});

test('full installs hook runtime and inactive Git hook templates while core does not', async () => {
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

    for (const targets of [full]) {
      assert.ok(targets.includes('.codex/hooks.json'));
      assert.ok(targets.includes('.agents/cognis/hooks/codex-hook.mjs'));
      assert.ok(targets.includes('.agents/cognis/hooks/lib/delivery-validation.mjs'));
      assert.ok(targets.includes('.githooks/pre-commit'));
      assert.ok(targets.includes('.githooks/pre-push'));
      assert.ok(targets.includes('.codex/agents/cognis_tester.toml'));
      assert.ok(targets.includes('.codex/agents/cognis_reviewer.toml'));
      assert.ok(targets.includes('.agents/cognis/hooks/lib/subagent-receipts.mjs'));
    }
    assert.equal(core.some((targetPath) => targetPath.startsWith('.codex/agents/')), false);
    assert.equal(core.some((targetPath) => targetPath.includes('/hooks/') || targetPath.startsWith('.githooks/')), false);
});

test('full Codex install selects adaptive hooks for new projects and strict hooks when requested', async () => {
  const run = async (workflow) => {
    const target = await mkdtemp(path.join(tmpdir(), `cognis-hook-workflow-${workflow}-`));
    try {
      await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full', '--workflow', workflow]);
      await execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
        '--write', '--confirm-red-zone',
      ]);
      return Object.keys(JSON.parse(await readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks);
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  };

  assert.deepEqual(await run('adaptive'), [
    'SessionStart', 'PostCompact', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'Stop',
  ]);
  assert.deepEqual(await run('strict'), [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
  ]);
});

test('doctor reports Git hook activation without modifying local Git config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-hook-doctor-'));
  try {
    await execFileAsync('git', ['init'], { cwd: target });
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex']);
    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write',
    ]);
    const doctor = async () => JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--profile', 'minimal',
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
