import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  createVerificationPreflightError,
  createProjectSnapshot,
  executeProjectVerification,
  PROJECT_VERIFICATION_ID_ENV,
  runFocusedProjectVerification,
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

async function createProject(validationCommands, verification = undefined) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-'));
  await runCli(['init', '--project', target]);
  const configPath = path.join(target, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.validationCommands = validationCommands;
  if (verification) config.verification = verification;
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
    assert.equal(report.results.lint.verificationId, report.verification.id);
    assert.doesNotMatch(JSON.stringify(report), /success-secret|alice%40corp|pass%3Aword|signature=|fragment/u);
    assert.equal(report.results.typecheck.status, 'not_configured');
    assert.equal(report.results.typecheck.verificationId, report.verification.id);
    assert.equal(report.verification.planMode, 'auto');
    assert.equal(report.verification.riskLevel, 'standard');
    assert.ok(Array.isArray(report.verification.selectedChecks));
    assert.ok(Array.isArray(report.verification.skippedChecks));
    assert.equal(report.verification.fallbackUsed, false);
    assert.equal(report.verification.before.available, false);
    assert.equal(report.verification.stable, null);
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.workspaceStability, {
      proven: false,
      reason: 'Git snapshot evidence is unavailable; command success does not prove workspace stability.',
      required: false,
      status: 'unverified',
    });
    assert.match(report.verification.id, /^[0-9a-f-]{36}$/u);
    assert.equal(Date.parse(report.verification.finishedAt) >= Date.parse(report.verification.startedAt), true);
    await assert.rejects(readFile(path.join(target, '.vibe-harness/verification.json'), 'utf8'), /ENOENT/u);

    const stabilityRequired = await runProjectVerification({
      commandStatus: {
        lint: { command: 'node verify-lint.mjs', status: 'available' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      requireStable: true,
      targetDir: target,
    });
    assert.equal(stabilityRequired.ok, false);
    assert.equal(stabilityRequired.error.code, 'PROJECT_VERIFICATION_STABILITY_UNVERIFIED');
    assert.equal(stabilityRequired.results.lint.status, 'passed');
    assert.equal(stabilityRequired.verification.evidence.commandExecution.status, 'passed');
    assert.equal(stabilityRequired.verification.evidence.workspaceStability.required, true);
    assert.equal(stabilityRequired.verification.evidence.workspaceStability.proven, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project --plan previews without executing checks and --full preserves the complete matrix', async () => {
  const target = await createProject({
    lint: 'node verify-marker.mjs',
    typecheck: null,
    test: 'node verify-marker-test.mjs',
    eval: null,
  });
  try {
    await writeFile(
      path.join(target, 'verify-marker.mjs'),
      "import { appendFile } from 'node:fs/promises'; await appendFile('marker.txt', 'ran\\n');\n",
      'utf8',
    );
    await writeFile(
      path.join(target, 'verify-marker-test.mjs'),
      "import { appendFile } from 'node:fs/promises'; await appendFile('marker.txt', 'test-ran\\n');\n",
      'utf8',
    );
    const preview = await runCli(['verify', '--project', target, '--plan']);
    assert.equal(preview.ok, true);
    assert.equal(preview.status, 'ready');
    assert.equal(preview.plan.planMode, 'auto');
    assert.ok(Array.isArray(preview.plan.selectedChecks));
    await assert.rejects(readFile(path.join(target, 'marker.txt'), 'utf8'), /ENOENT/u);

    const full = await runCli(['verify', '--project', target, '--full']);
    assert.equal(full.ok, true);
    assert.equal(full.verification.planMode, 'full');
    assert.ok(full.verification.selectedChecks.length >= 2);
    const marker = await readFile(path.join(target, 'marker.txt'), 'utf8');
    assert.equal(marker.split(/\r?\n/u).filter(Boolean).length, 2);
    assert.match(marker, /ran/u);
    assert.match(marker, /test-ran/u);
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
        assert.equal(payload.results.lint.verificationId, payload.verification.id);
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

test('verify --project terminates a hanging command and returns a structured timeout receipt', async () => {
  const target = await createProject({
    lint: 'node verify-hang.mjs',
    typecheck: null,
    test: null,
    eval: null,
  }, { timeoutMs: 1000 });
  try {
    await writeFile(
      path.join(target, 'verify-hang.mjs'),
      "console.log('started'); setInterval(() => {}, 1000);\n",
      'utf8',
    );
    const startedAt = Date.now();
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /lint timed out after 1000ms/u);
        assert.equal(payload.results.lint.status, 'failed');
        assert.equal(payload.results.lint.code, 'PROJECT_VERIFICATION_TIMEOUT');
        assert.equal(payload.results.lint.category, 'lint');
        assert.equal(payload.results.lint.timedOut, true);
        assert.equal(payload.results.lint.timeoutMs, 1000);
        assert.equal(payload.results.lint.verificationId, payload.verification.id);
        assert.equal(payload.results.lint.next.command, 'vibe-harness verify --project .');
        assert.equal(JSON.stringify(payload).includes(target), false);
        return true;
      },
    );
    assert.equal(Date.now() - startedAt < 5000, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project verification cancellation terminates the command and preserves recovery metadata', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-cancel-'));
  try {
    await writeFile(
      path.join(target, 'verify-hang.mjs'),
      "console.log('started'); setInterval(() => {}, 1000);\n",
      'utf8',
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const report = await runProjectVerification({
      commandStatus: {
        lint: { command: 'node verify-hang.mjs', status: 'available' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      signal: controller.signal,
      targetDir: target,
      timeoutMs: 5000,
    });
    clearTimeout(timer);

    assert.equal(report.ok, false);
    assert.match(report.error.message, /lint was cancelled/u);
    assert.equal(report.results.lint.code, 'PROJECT_VERIFICATION_CANCELLED');
    assert.equal(report.results.lint.category, 'lint');
    assert.equal(report.results.lint.cancelled, true);
    assert.equal(report.results.lint.timedOut, undefined);
    assert.equal(report.results.lint.verificationId, report.verification.id);
    assert.equal(report.results.lint.next.command, 'vibe-harness verify --project .');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project returns bounded installation drift diagnostics', async () => {
  const target = await createProject({ lint: null, typecheck: null, test: null, eval: null });
  try {
    const managedPath = path.join(target, 'docs', 'rules', 'governance-core.md');
    const managedContent = await readFile(managedPath, 'utf8');
    await writeFile(managedPath, managedContent + '\nlocal drift\n', 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.equal(payload.error.details.stage, 'installation');
        assert.equal(payload.error.details.summary.changedCount > 0, true);
        assert.equal(payload.error.details.samples.changed.includes('docs/rules/governance-core.md'), true);
        assert.equal(payload.error.details.samples.changed.length <= 3, true);
        assert.equal(payload.error.details.next.command, 'vibe-harness validate --project .');
        assert.equal(JSON.stringify(payload).includes(target), false);
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project verification rejects a project with no configured checks', async () => {
  const target = await createProject({ lint: null, typecheck: null, test: null, eval: null });
  try {
    const commandStatus = {
      lint: { command: null, status: 'not_configured' },
      typecheck: { command: null, status: 'not_configured' },
      test: { command: null, status: 'not_configured' },
      eval: { command: null, status: 'not_configured' },
    };
    const report = await runProjectVerification({ commandStatus, targetDir: target });
    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'PROJECT_VERIFICATION_NO_CHECKS');
    assert.equal(report.verification.evidence.commandExecution.status, 'failed');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('pack preflight diagnostics are categorized, bounded, and redacted', () => {
  const target = path.join(tmpdir(), 'vibe-harness-pack-secret-project');
  const secret = 'pack-super-secret';
  const report = {
    ok: false,
    capabilityErrors: Array.from({ length: 5 }, (_, index) =>
      target + '/schemas/item-' + index + '.json Bearer ' + secret + ' failed validation',
    ),
    documentationErrors: ['client_secret=' + secret + ' ' + target + '/docs/README.md is invalid'],
    contentQualityErrors: ['content quality is invalid'],
    instructionBudgetErrors: ['instruction budget is invalid'],
    invalidSkillDirs: ['invalid skill directory'],
    redZoneConsistencyErrors: ['red-zone map is invalid'],
    schemaErrors: ['seventh category must remain bounded'],
  };

  const error = createVerificationPreflightError({
    kind: 'pack',
    message: 'Vibe-Harness pack validation failed.',
    report,
    targetDir: target,
  });
  const serialized = JSON.stringify(error.details);

  assert.equal(error.code, 'PROJECT_VERIFICATION_FAILED');
  assert.equal(error.details.stage, 'pack');
  assert.equal(error.details.categories.length, 6);
  assert.equal(error.details.categories.some((category) => category.count === 5), true);
  assert.equal(error.details.categories.every((category) => category.samples.length <= 2), true);
  assert.equal(error.details.summary.failureCategoryCount, 7);
  assert.equal(error.details.next.command, 'pnpm check');
  assert.match(serialized, /Bearer \[REDACTED\]/u);
  assert.doesNotMatch(serialized, /pack-super-secret|vibe-harness-pack-secret-project/u);
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

test('truncated child output retains the wrapper verification id', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-correlation-'));
  try {
    await writeFile(path.join(target, 'long-output.mjs'), "console.log('x'.repeat(9000));\n", 'utf8');
    const report = await runProjectVerification({
      commandStatus: {
        lint: { command: 'node long-output.mjs', status: 'available' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      targetDir: target,
    });

    assert.equal(report.results.lint.stdout.length <= 8 * 1024, true);
    assert.equal(report.results.lint.verificationId, report.verification.id);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verification children receive the same correlation id as their receipt', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-child-correlation-'));
  try {
    await writeFile(
      path.join(target, 'correlation.mjs'),
      "console.log('verification-id=' + process.env." + PROJECT_VERIFICATION_ID_ENV
        + " + ' client_secret=child-secret');\n",
      'utf8',
    );
    const commandStatus = {
      lint: { command: 'node correlation.mjs', status: 'available' },
      typecheck: { command: 'node correlation.mjs', status: 'available' },
      test: { command: null, status: 'not_configured' },
      eval: { command: null, status: 'not_configured' },
    };
    const report = await runProjectVerification({ commandStatus, targetDir: target });

    for (const name of ['lint', 'typecheck']) {
      assert.equal(report.results[name].verificationId, report.verification.id);
      assert.match(report.results[name].stdout, new RegExp('verification-id=' + report.verification.id, 'u'));
      assert.match(report.results[name].stdout, /client_secret=\[REDACTED\]/u);
      assert.doesNotMatch(report.results[name].stdout, /child-secret/u);
    }

    const focused = await runFocusedProjectVerification({
      focused: {
        changedPaths: ['correlation.mjs'],
        commands: [{ command: 'node correlation.mjs', reason: 'correlation fixture' }],
        notes: [],
      },
      targetDir: target,
    });
    assert.equal(focused.results[0].verificationId, focused.verification.id);
    assert.match(focused.results[0].stdout, new RegExp('verification-id=' + focused.verification.id, 'u'));
    assert.match(focused.results[0].stdout, /client_secret=\[REDACTED\]/u);
    assert.doesNotMatch(focused.results[0].stdout, /child-secret/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verification commands run through package-manager shims on Windows', { skip: process.platform !== 'win32' }, async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-shim-'));
  try {
    // pnpm is guaranteed on the path for this repository's toolchain; exercising
    // the shim path proves .cmd executables spawn without EINVAL.
    const results = await executeProjectVerification({
      commandStatus: {
        lint: { command: 'pnpm --version', status: 'manual' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      allowManual: true,
      failureMode: 'report',
      targetDir: target,
    });
    assert.equal(results.lint.status, 'passed');
    assert.equal(results.lint.exitCode, 0);
    assert.match(results.lint.stdout, /\d/u);
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

test('Git verification receipt proves command success and workspace stability separately', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-stable-'));
  try {
    await initializeGitProject(target);
    const report = await runProjectVerification({
      commandStatus: {
        lint: { command: 'node -e "console.log(42)"', status: 'available' },
        typecheck: { command: null, status: 'not_configured' },
        test: { command: null, status: 'not_configured' },
        eval: { command: null, status: 'not_configured' },
      },
      requireStable: true,
      targetDir: target,
    });

    assert.equal(report.ok, true);
    assert.equal(report.verification.stable, true);
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.workspaceStability, {
      proven: true,
      reason: 'Git snapshots match before and after verification.',
      required: true,
      status: 'verified',
    });
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
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.workspaceStability, {
      proven: false,
      reason: 'Git snapshot evidence changed while verification was running.',
      required: false,
      status: 'changed',
    });
    assert.notEqual(report.verification.before.fingerprint, report.verification.after.fingerprint);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('focused verification receipt binds changed paths, suggestions, results, and stability', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-verify-focused-receipt-'));
  try {
    await initializeGitProject(target);
    await writeFile(path.join(target, 'tracked.txt'), 'changed before verification\n', 'utf8');
    const focused = {
      changedPaths: ['tracked.txt'],
      commands: [{ command: 'node -e "console.log(42)"', reason: 'focused receipt fixture' }],
      notes: ['fixture note'],
    };
    const report = await runFocusedProjectVerification({ focused, requireStable: true, targetDir: target });

    assert.equal(report.ok, true);
    assert.equal(report.results[0].status, 'passed');
    assert.equal(report.results[0].verificationId, report.verification.id);
    assert.match(report.results[0].stdout, /42/u);
    assert.deepEqual(report.verification.focused, focused);
    assert.equal(report.verification.stable, true);
    assert.equal(report.verification.evidence.commandExecution.status, 'passed');
    assert.equal(report.verification.evidence.workspaceStability.status, 'verified');
    assert.equal(report.verification.evidence.workspaceStability.required, true);
    assert.equal(report.verification.before.ignoredContentHashed, false);
    assert.ok(Array.isArray(report.verification.before.ignoredPaths));
    assert.match(report.verification.id, /^[0-9a-f-]{36}$/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
