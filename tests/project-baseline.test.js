import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson, validateJsonAgainstSchema } from '../scripts/lib/manifest.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return JSON.parse(result.stdout);
}

async function runCliFailure(args) {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], { maxBuffer: 1024 * 1024 * 8 });
  } catch (error) {
    return {
      payload: JSON.parse(error.stdout || error.stderr),
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
  assert.fail(`Expected command to fail: ${args.join(' ')}`);
}

async function initMinimalProject(target, validationCommands = { governance: null, lint: null, typecheck: null, eval: null }) {
  await runCli(['init', '--project', target]);
  const configPath = path.join(target, 'loopengine.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await writeFile(configPath, `${JSON.stringify({
    ...config,
    governance: { mode: 'off' },
    profile: 'minimal',
    validationCommands,
  }, null, 2)}\n`, 'utf8');
}

test('baseline previews then writes a managed project snapshot', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-baseline-'));
  try {
    await initMinimalProject(target);
    const injectedConfigPath = path.join(target, 'loopengine.config.json');
    const injectedConfig = JSON.parse(await readFile(injectedConfigPath, 'utf8'));
    injectedConfig.projectName = 'Example\n# injected instruction';
    await writeFile(injectedConfigPath, `${JSON.stringify(injectedConfig, null, 2)}\n`, 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);

    const preview = await runCli(['baseline', '--project', target]);

    assert.equal(preview.dryRun, true);
    assert.equal(preview.baseline.schemaVersion, 1);
    assert.equal(preview.baseline.project.name, 'Example # injected instruction');
    assert.equal(preview.baseline.drift.status, 'initial');
    assert.deepEqual(preview.artifacts.map((item) => item.target), [
      '.loopengine/baseline.json',
      'docs/loopengine/PROJECT_BASELINE.md',
    ]);
    await assert.rejects(readFile(path.join(target, '.loopengine/baseline.json'), 'utf8'), /ENOENT/u);

    const written = await runCli(['baseline', '--project', target, '--write']);
    const baseline = JSON.parse(await readFile(path.join(target, '.loopengine/baseline.json'), 'utf8'));
    const report = await readFile(path.join(target, 'docs/loopengine/PROJECT_BASELINE.md'), 'utf8');
    const state = JSON.parse(await readFile(path.join(target, '.loopengine/install-state.json'), 'utf8'));

    assert.equal(written.dryRun, false);
    assert.equal(baseline.schemaVersion, 1);
    assert.equal(baseline.installation.profile, 'minimal');
    assert.equal(baseline.verification.commands.eval.status, 'not_configured');
    const schema = await readJson(path.join(rootDir, 'schemas/project-baseline.schema.json'));
    assert.deepEqual(validateJsonAgainstSchema(baseline, schema, 'baseline'), []);
    assert.match(report, /项目基线/u);
    assert.doesNotMatch(report, /^# injected instruction$/mu);
    assert.deepEqual(state.generatedFiles.map((item) => item.target).sort(), [
      '.loopengine/baseline.json',
      'docs/loopengine/PROJECT_BASELINE.md',
    ]);

    const unchanged = await runCli(['baseline', '--project', target]);
    assert.equal(unchanged.baseline.drift.status, 'unchanged');
    assert.equal(unchanged.baseline.drift.changes.length, 0);

    await writeFile(path.join(target, 'package.json'), `${JSON.stringify({
      packageManager: 'pnpm@10.33.0',
      dependencies: { react: '^19.0.0' },
    }, null, 2)}\n`, 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write', '--force']);
    const changed = await runCli(['baseline', '--project', target]);

    assert.equal(changed.baseline.drift.status, 'changed');
    assert.equal(changed.baseline.drift.changes.some((item) => item.path === 'project.stackSummary'), true);
    assert.deepEqual(changed.artifacts.map((item) => item.action), ['update', 'update']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('baseline requires an installed MVP project', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-baseline-invalid-'));
  try {
    const missingConfig = await runCliFailure(['baseline', '--project', target]);
    assert.equal(missingConfig.payload.error.code, 'BASELINE_INSTALL_INVALID');

    await initMinimalProject(target);
    const configPath = path.join(target, 'loopengine.config.json');
    const validConfigText = await readFile(configPath, 'utf8');
    const invalidConfig = JSON.parse(validConfigText);
    invalidConfig.profile = 'unknown';
    await writeFile(configPath, `${JSON.stringify(invalidConfig, null, 2)}\n`, 'utf8');
    const invalidConfiguration = await runCliFailure(['baseline', '--project', target]);
    assert.equal(invalidConfiguration.payload.error.code, 'BASELINE_INSTALL_INVALID');

    await writeFile(configPath, validConfigText, 'utf8');
    const missingInstall = await runCliFailure(['baseline', '--project', target]);
    assert.equal(missingInstall.payload.error.code, 'BASELINE_INSTALL_INVALID');

    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);
    const statePath = path.join(target, '.loopengine/install-state.json');
    const mismatchedState = JSON.parse(await readFile(statePath, 'utf8'));
    mismatchedState.profile = 'full';
    await writeFile(statePath, `${JSON.stringify(mismatchedState, null, 2)}\n`, 'utf8');
    const mismatchedProfile = await runCliFailure(['baseline', '--project', target]);
    assert.equal(mismatchedProfile.payload.error.code, 'BASELINE_INSTALL_INVALID');

    await writeFile(statePath, '{ invalid json\n', 'utf8');
    const invalidState = await runCliFailure(['baseline', '--project', target]);
    assert.equal(invalidState.payload.error.code, 'BASELINE_INSTALL_INVALID');

    const invalidTarget = await runCliFailure(['baseline', '--target', target]);
    assert.equal(invalidTarget.payload.error.code, 'BASELINE_PROJECT_REQUIRED');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('baseline protects conflicting artifacts, backs up forced writes, and rolls back managed files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-baseline-conflict-'));
  try {
    await initMinimalProject(target);
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);
    const reportPath = path.join(target, 'docs/loopengine/PROJECT_BASELINE.md');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, 'local baseline\n', 'utf8');

    const conflict = await runCliFailure(['baseline', '--project', target, '--write']);
    assert.equal(conflict.payload.error.code, 'BASELINE_ARTIFACT_CONFLICT');
    assert.equal(await readFile(reportPath, 'utf8'), 'local baseline\n');

    const forced = await runCli(['baseline', '--project', target, '--write', '--force']);
    assert.equal(forced.backups.length, 1);
    assert.match(forced.backups[0].backup, /^\.loopengine\/backups\//u);
    assert.match(await readFile(reportPath, 'utf8'), /项目基线/u);

    const baselinePath = path.join(target, '.loopengine/baseline.json');
    const poisoned = JSON.parse(await readFile(baselinePath, 'utf8'));
    poisoned.project.stackSummary = 'SECRET C:\\private\\source';
    await writeFile(baselinePath, `${JSON.stringify(poisoned, null, 2)}\n`, 'utf8');
    await runCli(['baseline', '--project', target, '--write', '--force']);
    assert.doesNotMatch(await readFile(baselinePath, 'utf8'), /SECRET|private/u);

    await writeFile(reportPath, 'user modified\n', 'utf8');
    const modified = await runCliFailure(['baseline', '--project', target, '--write']);
    assert.equal(modified.payload.error.code, 'BASELINE_ARTIFACT_CONFLICT');
    await runCli(['baseline', '--project', target, '--write', '--force']);

    const rollback = await runCli(['rollback', '--project', target, '--write']);
    assert.equal(rollback.applied.includes('.loopengine/baseline.json'), true);
    assert.equal(rollback.applied.includes('docs/loopengine/PROJECT_BASELINE.md'), true);
    await assert.rejects(readFile(path.join(target, '.loopengine/baseline.json'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(reportPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('baseline verify persists sanitized failure diagnostics', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-baseline-verify-'));
  try {
    const failureFile = path.join(target, 'token=top-secret.mjs');
    const absoluteFailureCommand = `node ${failureFile}`;
    await initMinimalProject(target, {
      governance: null,
      lint: absoluteFailureCommand,
      typecheck: 'node -e "console.log(42)"',
    });
    await writeFile(failureFile, "console.error('secret-output'); process.exitCode = 7;\n", 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);

    const failure = await runCliFailure(['baseline', '--project', target, '--verify', '--write']);
    const baselineText = await readFile(path.join(target, '.loopengine/baseline.json'), 'utf8');
    const baseline = JSON.parse(baselineText);

    assert.equal(failure.payload.ok, false);
    assert.equal(baseline.verification.status, 'failed');
    assert.equal(baseline.verification.commands.lint.exitCode, 7);
    assert.equal(baseline.verification.commands.lint.command, 'node <project>/token=[REDACTED]');
    assert.equal(baseline.verification.commands.typecheck.status, 'blocked');
    assert.doesNotMatch(baselineText, /secret-output/u);
    assert.doesNotMatch(baselineText, /top-secret/u);
    assert.doesNotMatch(baselineText, new RegExp(target.replaceAll('\\', '\\\\'), 'u'));
    assert.equal(Object.hasOwn(baseline.verification.commands.lint, 'stdout'), false);
    assert.equal(Object.hasOwn(baseline.verification.commands.lint, 'stderr'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('baseline recommends static missing commands as P1 and verified blockers as P0', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-baseline-priority-'));
  try {
    await initMinimalProject(target, { governance: null, lint: 'pnpm missing-script', typecheck: null });
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);

    const preview = await runCli(['baseline', '--project', target]);
    const staticRecommendation = preview.baseline.recommendations.find((item) => item.code === 'VERIFY_LINT_MISSING');
    assert.equal(staticRecommendation.priority, 'P1');

    const verified = await runCliFailure(['baseline', '--project', target, '--verify']);
    const blockedRecommendation = verified.payload.baseline.recommendations.find((item) => item.code === 'VERIFY_LINT_BLOCKED');
    assert.equal(blockedRecommendation.priority, 'P0');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
