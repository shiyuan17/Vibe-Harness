import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { defaultProjectConfig, validateProjectConfig } from '../scripts/lib/project-config.js';
import { scanStagedDiff } from '../.agents/runtime/hooks/git-hook.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function seedTrackedAutoCommitRuntime(target, { modified = false } = {}) {
  const relative = '.agents/runtime/hooks/auto-commit.mjs';
  const content = 'legacy managed auto-commit runtime\n';
  const runtimePath = path.join(target, relative);
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, modified ? content + 'user modification\n' : content, 'utf8');
  const statePath = path.join(target, '.vibe-harness/install-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const base = state.files.find((file) => file.target === '.agents/runtime/hooks/codex-hook.mjs');
  state.files.push({
    ...base,
    source: 'runtime/hooks/auto-commit.mjs',
    sourceHash: sha256(content),
    target: relative,
    targetHash: sha256(content),
  });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return runtimePath;
}

test('project config exposes guarded safety Hook defaults', () => {
  assert.deepEqual(defaultProjectConfig.hooks, {
    allowedWriteRoots: [],
    allowedEgressHosts: [],
    mode: 'guarded',
    redZonePaths: ['.env', 'auth/', 'ci/cd/', '.github/workflows/', '.codex/hooks.json', '.cursor/hooks.json', '.cursor/mcp.json', '.mcp.json', '.qoder/settings.json', '.zcode/config.json', 'opencode.json', 'opencode.jsonc', '.agents/hooks.json', '.agents/mcp_config.json', '.claude/settings.json'],
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

test('full Codex install writes only safety Hook events through the Git-root bootstrap', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-events-'));
  try {
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full']);
    const installed = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone',
    ])).stdout);
    assert.equal(installed.runtimeHooks.configured, true);
    assert.equal(installed.runtimeHooks.activation.status, 'unknown');
    assert.equal(installed.warnings.some((warning) => warning.code === 'HOOK_ACTIVATION_UNVERIFIED'), true);
    const hooks = JSON.parse(await readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PreToolUse']);
    const safetyCommands = ['PreToolUse', 'PermissionRequest'].flatMap((event) =>
      hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command)));
    for (const command of safetyCommands) {
      assert.match(command, /git.*rev-parse.*--show-toplevel/u);
      assert.match(command, /process\.execPath/u);
      assert.match(command, /codex-hook\.mjs/u);
      assert.doesNotMatch(command, /[A-Za-z]:[\\/]/u);
      assert.doesNotMatch(command, /\$\(|`/u);
    }
    const validation = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'validate', '--project', target,
    ])).stdout);
    assert.equal(validation.runtimeHooks.activation.status, 'unknown');
    assert.equal(validation.warnings.some((warning) => warning.code === 'HOOK_ACTIVATION_UNVERIFIED'), true);
    const doctor = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target,
    ])).stdout);
    assert.deepEqual(doctor.runtimeHooks.selfCheck, {
      code: 'HOOK_SELF_CHECK_PASSED',
      status: 'pass',
    });
    await assert.rejects(
      () => readFile(path.resolve(target, '..', '.vibe-harness-hook-self-check'), 'utf8'),
      /ENOENT/u,
    );
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
    assert.equal(inactive.runtimeHooks.configured, false);
    assert.equal(inactive.runtimeHooks.activation.status, 'unknown');
    assert.match(inactive.runtimeHooks.activation.verification, /\/hooks/u);
    await execFileAsync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: target });
    assert.equal((await doctor()).gitHooks.status, 'active');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('upgrade retires an unmodified auto-commit runtime and preserves a modified copy', async () => {
  for (const modified of [false, true]) {
    const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-auto-commit-retire-'));
    try {
      await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--profile', 'full']);
      await execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
        '--write', '--confirm-red-zone',
      ]);
      const runtimePath = await seedTrackedAutoCommitRuntime(target, { modified });
      const result = JSON.parse((await execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
        '--upgrade', '--write', '--confirm-red-zone',
      ])).stdout);
      if (modified) {
        assert.equal(result.skipped.some((item) => item.target === '.agents/runtime/hooks/auto-commit.mjs' && item.reason === 'target-modified'), true);
        assert.match(await readFile(runtimePath, 'utf8'), /user modification/u);
      } else {
        assert.equal(result.retired.includes('.agents/runtime/hooks/auto-commit.mjs'), true);
        await assert.rejects(() => readFile(runtimePath, 'utf8'), /ENOENT/u);
      }
    } finally {
      await rm(target, { force: true, recursive: true });
    }
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
