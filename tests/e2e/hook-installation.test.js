import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { defaultProjectConfig, defaultRedZonePaths, validateProjectConfig } from '../../scripts/lib/project-config.js';
import { hashManagedBlock } from '../../scripts/lib/managed-block.js';
import { managedJsonPayload } from '../../scripts/lib/managed-json-config.js';
import { DEFAULT_RED_ZONE_PATHS } from '../../runtime/hooks/lib/context.mjs';
import { scanStagedDiff } from '../../.agents/runtime/hooks/git-hook.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

// Host Hook trust is recorded in the host config, not in the project, so this
// suite points CODEX_HOME at an empty directory: the Hook trust state is then
// deterministically "unknown" (config missing) instead of whatever the machine
// running the suite happens to have trusted. Tests that need the three real
// states live in tests/runtime-diagnostics.test.js.
let isolatedCodexHome = null;
test.before(async () => {
  isolatedCodexHome = await mkdtemp(path.join(tmpdir(), 'vibe-harness-codex-home-'));
  process.env.CODEX_HOME = isolatedCodexHome;
});
test.after(async () => {
  if (isolatedCodexHome) await rm(isolatedCodexHome, { force: true, recursive: true });
});

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
    allowedEgressHosts: [],
    redZonePaths: defaultRedZonePaths,
  });
  for (const runtimePath of DEFAULT_RED_ZONE_PATHS) {
    assert.equal(defaultRedZonePaths.some((configuredPath) => configuredPath.endsWith('/')
      ? runtimePath.startsWith(configuredPath)
      : runtimePath === configuredPath), true, runtimePath);
  }
  assert.equal(validateProjectConfig(defaultProjectConfig), true);
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
    '.agents/runtime/hooks/lib/execution-envelope.mjs',
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
    assert.equal(installed.runtimeHooks.supported, true);
    assert.equal(installed.runtimeHooks.activated, null);
    assert.equal(installed.runtimeHooks.enforced, false);
    assert.equal(installed.runtimeHooks.coverageLimitations.length, 3);
    assert.equal(installed.runtimeHooks.activation.status, 'unknown');
    assert.equal(installed.warnings.some((warning) => warning.code === 'HOOK_ACTIVATION_UNVERIFIED'), true);
    const hooks = JSON.parse(await readFile(path.join(target, '.codex/hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse']);
    const safetyCommands = ['PreToolUse'].flatMap((event) =>
      hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command)));
    for (const command of safetyCommands) {
      // The root is resolved by walking up to `.git`, so the installed command
      // no longer depends on a Git binary being on PATH.
      assert.doesNotMatch(command, /rev-parse/u);
      assert.match(command, /\.git/u);
      assert.match(command, /process\.execPath/u);
      assert.match(command, /codex-hook\.mjs/u);
      assert.doesNotMatch(command, /[A-Za-z]:[\\/]/u);
      assert.doesNotMatch(command, /\$\(|`/u);
    }
    // A missing project root or runtime must reach the host as a decision, not
    // as a non-zero exit that the host records as a failed Hook run.
    const orphanDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-orphan-'));
    try {
      const denials = {
        PreToolUse: (decision) => decision.hookSpecificOutput.permissionDecision,
      };
      for (const [event, readDecision] of Object.entries(denials)) {
        const command = hooks[event][0].hooks[0].command;
        const orphaned = await execFileAsync(command, { cwd: orphanDir, shell: true, windowsHide: true });
        const decision = JSON.parse(orphaned.stdout);
        assert.equal(readDecision(decision), 'deny', event);
        assert.match(JSON.stringify(decision), /BOOTSTRAP_UNAVAILABLE/u, event);
      }
    } finally {
      await rm(orphanDir, { force: true, recursive: true });
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
    assert.equal(doctor.runtimeHooks.enforced, false);
    assert.equal(doctor.warnings.some((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED'), true);
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
    assert.equal(inactive.gitHooks.active, false);
    assert.equal(inactive.gitHooks.configuredPath, null);
    assert.equal(inactive.gitHooks.status, 'inactive');
    assert.equal(inactive.gitHooks.entries.preCommit.status, 'inactive');
    assert.equal(inactive.runtimeHooks.configured, false);
    assert.equal(inactive.runtimeHooks.activation.status, 'unknown');
    assert.match(inactive.runtimeHooks.activation.verification, /\/hooks/u);
    await mkdir(path.join(target, '.githooks'), { recursive: true });
    await writeFile(path.join(target, '.githooks', 'pre-commit'), 'node .agents/runtime/hooks/git-hook.mjs pre-commit\n', 'utf8');
    await writeFile(path.join(target, '.githooks', 'pre-push'), 'node .agents/runtime/hooks/git-hook.mjs pre-push\n', 'utf8');
    await execFileAsync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: target });
    const githooksDoctor = await doctor();
    assert.equal(githooksDoctor.gitHooks.status, 'active');
    assert.equal(githooksDoctor.gitHooks.entries.prePush.activated, true);

    await mkdir(path.join(target, '.husky', '_'), { recursive: true });
    await writeFile(path.join(target, '.husky', 'pre-commit'), 'node .agents/runtime/hooks/git-hook.mjs pre-commit\n', 'utf8');
    await writeFile(path.join(target, '.husky', 'pre-push'), 'node .agents/runtime/hooks/git-hook.mjs pre-push\n', 'utf8');
    await execFileAsync('git', ['config', '--local', 'core.hooksPath', '.husky/_'], { cwd: target });
    const huskyDoctor = await doctor();
    assert.equal(huskyDoctor.gitHooks.status, 'active');
    assert.equal(huskyDoctor.gitHooks.entries.preCommit.path, '.husky/pre-commit');
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

test('upgrade retires the managed Codex PermissionRequest projection', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-projection-retire-'));
  try {
    await execFileAsync(process.execPath, [
      cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'full',
    ]);
    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone',
    ]);
    const hooksPath = path.join(target, '.codex/hooks.json');
    const statePath = path.join(target, '.vibe-harness/install-state.json');
    const configured = JSON.parse(await readFile(hooksPath, 'utf8'));
    const managedLegacy = {
      hooks: [{
        command: 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PermissionRequest',
        statusMessage: 'Vibe-Harness safety policy',
        timeout: 10,
        type: 'command',
      }],
    };
    configured.hooks.PermissionRequest = [managedLegacy];
    const legacyContent = `${JSON.stringify(configured, null, 2)}\n`;
    await writeFile(hooksPath, legacyContent, 'utf8');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const entry = state.files.find((file) => file.target === '.codex/hooks.json');
    entry.managedBlockHash = hashManagedBlock(managedJsonPayload(legacyContent, {
      hookMarker: 'Vibe-Harness safety policy',
      hooksPath: ['hooks'],
      mcpPath: null,
      serverPrefix: 'vibe-harness-',
    }));
    entry.targetHash = sha256(legacyContent);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const upgraded = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--upgrade', '--write', '--confirm-red-zone',
    ])).stdout);
    assert.equal(upgraded.status, 'ready', JSON.stringify(upgraded));
    const rewritten = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.deepEqual(Object.keys(rewritten.hooks).sort(), ['PreToolUse']);
    assert.equal(rewritten.hooks.PreToolUse.length, 1);
    assert.equal(Object.hasOwn(rewritten.hooks, 'PermissionRequest'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

function stagedDiff(file, addedLines) {
  const header = `diff --git a/${file} b/${file}\nindex 0000000..1111111 100644\n--- /dev/null\n+++ b/${file}\n`;
  return header + addedLines.map((line) => `+${line}`).join('\n');
}

async function commitFixture(run) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-commit-repair-'));
  const git = (...args) => execFileAsync('git', args, { cwd: target, windowsHide: true });
  try {
    await git('init', '-q');
    await git('config', 'user.name', 'Commit Fixture');
    await git('config', 'user.email', 'commit@example.invalid');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(path.join(target, 'baseline.txt'), 'baseline\n');
    await git('add', 'baseline.txt');
    await git('commit', '-qm', 'chore(fixture): baseline');
    const hook = `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${rootDir.replaceAll('\\', '/')}/runtime/hooks/git-hook.mjs" pre-commit\n`;
    await writeFile(path.join(target, '.git/hooks/pre-commit'), hook, { mode: 0o755 });
    await git('config', 'core.hooksPath', '.git/hooks');
    await run({ target, git, hook });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

test('提交先拒绝 EOF 空行并定位文件，修复重新暂存后保留排除项正常提交', async () => {
  await commitFixture(async ({ target, git, hook }) => {
    const baseline = (await git('rev-parse', 'HEAD')).stdout;
    await writeFile(path.join(target, 'app.cjs'), 'module.exports = 1;\n\n');
    await writeFile(path.join(target, 'private-note.txt'), 'excluded\n');
    await git('add', 'app.cjs');
    const rejectWithLocation = (error) => {
      assert.match(error.stderr, /app\.cjs:2: new blank line at EOF/u);
      return true;
    };
    await assert.rejects(git('commit', '-m', 'feat(app): add value'), rejectWithLocation);
    assert.equal((await git('rev-parse', 'HEAD')).stdout, baseline);
    await writeFile(path.join(target, 'app.cjs'), 'module.exports = 1;\n');
    await assert.rejects(git('commit', '-m', 'feat(app): add value'), rejectWithLocation,
      '修复工作树但未重新暂存不能解除拒绝');
    await git('add', 'app.cjs');
    await git('diff', '--cached', '--check');
    await git('commit', '-m', 'feat(app): add value');
    assert.equal((await git('rev-list', '--count', 'HEAD')).stdout.trim(), '2');
    assert.equal((await git('show', 'HEAD:app.cjs')).stdout, 'module.exports = 1;\n');
    assert.equal((await git('status', '--porcelain')).stdout.trim(), '?? private-note.txt');
    assert.equal(await readFile(path.join(target, '.git/hooks/pre-commit'), 'utf8'), hook);
  });
});

test('提交诊断只显示空白位置不泄露代码，密钥拒绝仍保留暂存内容和 HEAD', async () => {
  await commitFixture(async ({ target, git }) => {
    const baseline = (await git('rev-parse', 'HEAD')).stdout;
    const privateText = 'fixture-private-message';
    await writeFile(path.join(target, 'file with spaces.cjs'), `// ${privateText}  \n`);
    await git('add', 'file with spaces.cjs');
    await assert.rejects(git('commit', '-m', 'feat(app): add note'), (error) => {
      assert.match(error.stderr, /file with spaces\.cjs:1: trailing whitespace/u);
      assert.equal(error.stderr.includes(privateText), false);
      return true;
    });
    const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz1234'].join('-');
    await writeFile(path.join(target, 'file with spaces.cjs'), `module.exports = "${secret}";\n`);
    await git('add', 'file with spaces.cjs');
    const stagedTree = (await git('write-tree')).stdout;
    await assert.rejects(git('commit', '-m', 'feat(app): add note'), (error) => {
      assert.match(error.stderr, /Possible secret found/u);
      assert.equal(error.stderr.includes(secret), false);
      return true;
    });
    assert.equal((await git('write-tree')).stdout, stagedTree);
    assert.equal((await git('rev-parse', 'HEAD')).stdout, baseline);
  });
});

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
  assert.doesNotThrow(() =>
    scanStagedDiff(stagedDiff('.github/workflows/ci.yml', ['name: ci']), { redZoneConfirmed: true }),
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
