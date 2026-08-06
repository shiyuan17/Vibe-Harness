import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { defaultProjectConfig, validateProjectConfig } from '../scripts/lib/project-config.js';
import { scanStagedDiff } from '../.agents/runtime/hooks/git-hook.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

test('project config exposes guarded safety Hook defaults', () => {
  assert.deepEqual(defaultProjectConfig.hooks, {
    allowedWriteRoots: [],
    allowedEgressHosts: [],
    mode: 'guarded',
    redZonePaths: ['.env', 'auth/', 'ci/cd/', '.github/workflows/', '.codex/hooks.json', '.cursor/hooks.json', '.cursor/mcp.json', '.mcp.json', '.qoder/settings.json', '.zcode/config.json', '.agents/hooks.json', '.agents/mcp_config.json'],
  });
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
  assert.equal(validateProjectConfig({
    ...defaultProjectConfig,
    hooks: { allowedEgressHosts: ['registry.npmjs.org', '*.github.com'] },
  }), true);
  assert.throws(
    () => validateProjectConfig({ ...defaultProjectConfig, hooks: { allowedEgressHosts: [''] } }),
    /hooks\.allowedEgressHosts/,
  );
});

test('full installs safety Hook runtime while core does not', async () => {
  const run = async (profile) => {
    const target = await mkdtemp(path.join(tmpdir(), `vibe-harness-hook-${profile}-`));
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
    '.agents/runtime/hooks/codex-hook.mjs',
    '.agents/runtime/hooks/lib/context.mjs',
    '.agents/runtime/hooks/lib/policy.mjs',
    '.githooks/pre-commit',
    '.githooks/pre-push',
  ]) assert.equal(full.includes(target), true, target);
  assert.equal(core.some((target) => target.includes('/hooks/') || target.startsWith('.githooks/')), false);
});

test('full Codex install writes only PreToolUse and PermissionRequest Hook events', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-events-'));
  try {
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full']);
    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone',
    ]);
    const hooks = JSON.parse(await readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PreToolUse']);
    // Hook commands must use relative paths, not machine-specific absolute paths.
    const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
    for (const command of commands) {
      assert.match(command, /node "\.agents\/runtime\/hooks\/codex-hook\.mjs"/u);
      assert.doesNotMatch(command, /[A-Za-z]:[\\/]/u);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor reports Git Hook activation without modifying local Git config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-doctor-'));
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

function stagedDiff(file, addedLines) {
  const header = `diff --git a/${file} b/${file}\nindex 0000000..1111111 100644\n--- /dev/null\n+++ b/${file}\n`;
  return header + addedLines.map((line) => `+${line}`).join('\n');
}

test('scanStagedDiff rejects staged secrets and forbidden paths', () => {
  assert.throws(
    () => scanStagedDiff(stagedDiff('scripts/run.js', ['const key = "sk-abcdefghijklmnopqrstuvwxyz1234";'])),
    /secret/u,
  );
  assert.throws(
    () => scanStagedDiff(stagedDiff('node_modules/pkg/index.js', ['export const x = 1;'])),
    /Forbidden/u,
  );
});

test('scanStagedDiff rejects staged red-zone paths even without secret content', () => {
  // .env without a recognizable secret pattern is still a red-zone path.
  assert.throws(
    () => scanStagedDiff(stagedDiff('config/.env', ['LOG_LEVEL=info'])),
    /Red-zone/u,
  );
  assert.throws(
    () => scanStagedDiff(stagedDiff('auth/token.json', ['{}'])),
    /Red-zone/u,
  );
  assert.throws(
    () => scanStagedDiff(stagedDiff('.github/workflows/ci.yml', ['name: ci'])),
    /Red-zone/u,
  );
  // An ordinary file is not a red-zone path.
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('src/app.js', ['export const app = 1;'])),
  );
});

test('scanStagedDiff blocks focused and skipped test markers in .test.js files', () => {
  assert.throws(
    () => scanStagedDiff(stagedDiff('tests/example.test.js', ["test.only('runs all', () => {});"])),
    /\.only/u,
  );
  assert.throws(
    () => scanStagedDiff(stagedDiff('tests/example.test.mjs', ["it.skip('not now', () => {});"])),
    /\.skip/u,
  );
  assert.throws(
    () => scanStagedDiff(stagedDiff('tests/example.test.js', ["describe.only('group', () => {});"])),
    /\.only/u,
  );
});

test('scanStagedDiff allows legitimate skip and non-test files', () => {
  // Option-object conditional skip is a sanctioned pattern in this repo.
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('tests/eval-runner.test.js', [
      "test('opt-in smoke', { skip: process.env.CI !== '1' }, async () => {});",
    ])),
  );
  // Runtime context skip inside a test body is also legitimate.
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('tests/tool-provisioning.test.js', [
      "  testContext.skip('requires a local fixture');",
    ])),
  );
  // Markers in non-test files are out of scope.
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('scripts/run.js', ['describe.only = () => {};'])),
  );
  // A clean test file diff passes.
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('tests/clean.test.js', ["test('passes', () => assert.ok(true));"])),
  );
});
