import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  createProjectSnapshot,
  executeProjectVerification,
  runProjectVerification,
} from '../scripts/lib/project-verification.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { maxBuffer: 1024 * 1024 * 8 });
  return JSON.parse(result.stdout);
}

async function initializeGitProject(target) {
  await execFileAsync('git', ['init'], { cwd: target });
  await execFileAsync('git', ['config', 'user.email', 'verification@example.test'], { cwd: target });
  await execFileAsync('git', ['config', 'user.name', 'Verification Fixture'], { cwd: target });
  await writeFile(path.join(target, 'tracked.txt'), 'initial\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: target });
  await execFileAsync('git', ['commit', '-m', 'test: initialize verification fixture'], { cwd: target });
}

async function createProject(validationCommands) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-'));
  await runCli(['init', '--project', target]);
  const configPath = path.join(target, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.validationCommands = validationCommands;
  config.profile = 'core';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);
  return target;
}

test('verify --project executes configured available commands', async () => {
  const target = await createProject({
    lint: 'node verify-lint.mjs',
    typecheck: null,
    test: null,
    eval: null,
  });
  try {
    await writeFile(
      path.join(target, 'verify-lint.mjs'),
      "console.log('lint-ok Bearer success-secret client_secret=success-secret https://alice%40corp:pass%3Aword@example.test/path?signature=success-secret#fragment');\n",
      'utf8',
    );
    const report = await runCli(['verify', '--project', target]);

    assert.equal(report.ok, true);
    assert.equal(report.results.lint.exitCode, 0);
    assert.match(report.results.lint.stdout, /lint-ok/u);
    assert.match(report.results.lint.stdout, /Bearer \[REDACTED\]/u);
    assert.match(report.results.lint.stdout, /client_secret=\[REDACTED\]/u);
    assert.doesNotMatch(JSON.stringify(report), /success-secret|alice%40corp|pass%3Aword|signature=|fragment/u);
    assert.equal(report.results.typecheck.status, 'not_configured');
    assert.equal(report.verification.before.available, false);
    assert.equal(report.verification.stable, null);
    assert.match(report.verification.id, /^[0-9a-f-]{36}$/u);
    assert.equal(Date.parse(report.verification.finishedAt) >= Date.parse(report.verification.startedAt), true);
    await assert.rejects(readFile(path.join(target, '.vibe-harness/verification.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project blocks missing and manual commands by default', async () => {
  const target = await createProject({
    lint: 'pnpm missing-script',
    typecheck: 'node -e "console.log(42)"',
    test: null,
    eval: null,
  });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /lint is missing/u);
        return true;
      },
    );

    const manualOnlyConfigPath = path.join(target, 'vibe-harness.config.json');
    const manualOnlyConfig = JSON.parse(await readFile(manualOnlyConfigPath, 'utf8'));
    manualOnlyConfig.validationCommands.lint = null;
    await writeFile(manualOnlyConfigPath, `${JSON.stringify(manualOnlyConfig, null, 2)}\n`, 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write', '--force']);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      /typecheck is manual; pass --allow-manual/u,
    );
    const report = await runCli(['verify', '--project', target, '--allow-manual']);
    assert.equal(report.results.typecheck.exitCode, 0);
    assert.match(report.results.typecheck.stdout, /42/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project propagates command failures', async () => {
  const target = await createProject({
    lint: 'node verify-fail.mjs',
    typecheck: null,
    test: null,
    eval: null,
  });
  try {
    await writeFile(
      path.join(target, 'verify-fail.mjs'),
      "console.error('lint-failed Bearer cli-secret https://user:password@example.test/path?token=cli-secret#fragment'); process.exitCode = 7;\n",
      'utf8',
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /lint failed with exit 7/u);
        assert.equal(payload.results.lint.status, 'failed');
        assert.match(payload.results.lint.stderr, /Bearer \[REDACTED\]/u);
        assert.doesNotMatch(JSON.stringify(payload), /cli-secret|user:password|token=|fragment/u);
        assert.equal(payload.error.message.length <= 8 * 1024, true);
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project verification report mode preserves failed and blocked diagnostics', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-report-'));
  try {
    await writeFile(
      path.join(target, 'fail.mjs'),
      "console.error('Bearer verification-secret https://alice:password@example.test/private?signature=verification-secret#fragment token=verification-secret'); process.exitCode = 7;\n",
      'utf8',
    );

    const results = await executeProjectVerification({
      commandStatus: {
        lint: { command: 'node fail.mjs', status: 'available' },
        typecheck: { command: 'node -e "console.log(42)"', status: 'manual' },
        test: { command: 'pnpm missing-script', status: 'missing' },
        eval: { command: null, status: 'not_configured' },
      },
      failureMode: 'report',
      targetDir: target,
    });

    assert.equal(results.lint.status, 'failed');
    assert.equal(results.lint.exitCode, 7);
    assert.match(results.lint.stderr, /Bearer \[REDACTED\]/u);
    assert.match(results.lint.stderr, /https:\/\/example\.test\/private/u);
    assert.doesNotMatch(results.lint.stderr, /verification-secret|alice|password|signature|fragment/u);
    assert.deepEqual(results.typecheck, { command: 'node -e "console.log(42)"', status: 'blocked' });
    assert.deepEqual(results.test, { command: 'pnpm missing-script', status: 'blocked' });
    assert.deepEqual(results.eval, { command: null, status: 'not_configured' });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Git verification snapshots change when project content changes', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-snapshot-'));
  try {
    await initializeGitProject(target);
    const before = await createProjectSnapshot(target);
    await writeFile(path.join(target, 'tracked.txt'), 'changed\n', 'utf8');
    const after = await createProjectSnapshot(target);

    assert.equal(before.available, true);
    assert.equal(after.available, true);
    assert.equal(before.head, after.head);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(after.changedFiles, 1);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verification receipts reject a project that changes during checks', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-stale-'));
  try {
    await initializeGitProject(target);
    await writeFile(
      path.join(target, 'mutate.mjs'),
      "import { writeFile } from 'node:fs/promises'; await writeFile('tracked.txt', 'mutated during verification\\n');\n",
      'utf8',
    );
    const report = await runProjectVerification({
      commandStatus: {
        lint: { command: 'node mutate.mjs', status: 'available' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      targetDir: target,
    });

    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'PROJECT_VERIFICATION_STALE');
    assert.equal(report.results.lint.status, 'passed');
    assert.equal(report.verification.stable, false);
    assert.notEqual(report.verification.before.fingerprint, report.verification.after.fingerprint);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
