import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { consumeVerificationQueue } from '../../scripts/verification-queue.js';

import {
  createVerificationPreflightError,
  createProjectSnapshot,
  executeProjectVerification,
  PROJECT_VERIFICATION_ID_ENV,
  runFocusedProjectVerification,
  runProjectVerification,
} from '../../scripts/lib/project-verification.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
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
    // The single configured command seeds the fast layer, so the default run
    // executes that layer instead of the old four-command batch.
    assert.equal(report.verification.planMode, 'tier:quick');
    assert.equal(report.verification.executionTier, 'quick');
    assert.equal(report.verification.scopeStatus, 'complete');
    assert.equal(report.verification.riskLevel, 'standard');
    assert.ok(Array.isArray(report.verification.selectedChecks));
    assert.ok(Array.isArray(report.verification.skippedChecks));
    assert.equal(report.verification.fallbackUsed, false);
    assert.equal(report.verification.before.available, false);
    assert.equal(report.verification.snapshotComparison, 'unavailable');
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.snapshotComparison, {
      value: 'unavailable',
      reason: 'Git snapshot evidence is unavailable; command success does not prove workspace stability.',
      required: false,
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
    assert.equal(stabilityRequired.verification.evidence.snapshotComparison.required, true);
    assert.equal(stabilityRequired.verification.evidence.snapshotComparison.value, 'unavailable');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

// The raised tests below drive real CLI verify subprocesses (1-4 invocations
// each); on slow filesystems every invocation carries a multi-second I/O floor,
// so they legitimately exceed the default 120s test budget.
// 2026-09-19 calibration (solo, slow box): install --write 35s, validate 68s,
// doctor 73s per invocation; RTK round-trip measured >300s solo, so 600s is a
// hang guard, not a performance claim.
test('verify --project --plan 预览快速层且不执行检查，--full 保留完整矩阵', { timeout: 600000 }, async () => {
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
    // The configured lint/test commands seed the fast layer, so an unnamed run
    // previews exactly that layer instead of the old four-command default.
    assert.equal(preview.plan.planMode, 'tier:quick');
    assert.equal(preview.plan.executionTier, 'quick');
    assert.deepEqual(
      preview.plan.selectedChecks.map((item) => item.command),
      ['node verify-marker.mjs', 'node verify-marker-test.mjs'],
    );
    await assert.rejects(readFile(path.join(target, 'marker.txt'), 'utf8'), /ENOENT/u);

    const full = await runCli(['verify', '--project', target, '--full']);
    assert.equal(full.ok, true);
    assert.equal(full.verification.planMode, 'full');
    assert.equal(full.verification.executionTier, 'deep');
    assert.deepEqual(full.verification.deferredChecks, []);
    assert.ok(full.verification.selectedChecks.length >= 2);
    const marker = await readFile(path.join(target, 'marker.txt'), 'utf8');
    assert.equal(marker.split(/\r?\n/u).filter(Boolean).length, 2);
    assert.match(marker, /ran/u);
    assert.match(marker, /test-ran/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project blocks missing and manual commands by default', { timeout: 600000 }, async () => {
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

test('verify --project terminates a hanging command and returns a structured timeout receipt', { timeout: 600000 }, async () => {
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
    // TD-2026-09-15-8: 结构化超时收据已由上方断言覆盖；这里的墙钟判据只要求
    // 「不早于声明的 timeoutMs 结束，且在进程树回收的合理预算内结束」，
    // 不再绑定与机器负载强相关的固定上界。预算还需覆盖 CLI 进程启动与
    // 安装漂移预检的文件 I/O（慢盘下单次 verify 调用可达数十秒，2026-09-19
    // 实测整测 84.7s，单跑 111.4s），故从 30s 放宽至 240s；精确的 1s 终止语义由收据字段断言。
    const declaredTimeoutMs = 1000;
    const reclamationBudgetMs = 240_000;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs >= declaredTimeoutMs, true);
    assert.equal(elapsedMs < declaredTimeoutMs + reclamationBudgetMs, true);
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
    assert.equal(report.verification.snapshotComparison, 'match');
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.snapshotComparison, {
      value: 'match',
      reason: 'Git snapshots match before and after verification.',
      required: true,
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
    assert.equal(report.verification.snapshotComparison, 'changed');
    assert.deepEqual(report.verification.evidence.commandExecution, { status: 'passed' });
    assert.deepEqual(report.verification.evidence.snapshotComparison, {
      value: 'changed',
      reason: 'Git snapshot evidence changed while verification was running.',
      required: false,
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
    assert.equal(report.verification.snapshotComparison, 'match');
    assert.equal(report.verification.evidence.commandExecution.status, 'passed');
    assert.equal(report.verification.evidence.snapshotComparison.value, 'match');
    assert.equal(report.verification.evidence.snapshotComparison.required, true);
    assert.equal(report.verification.before.ignoredContentHashed, false);
    assert.ok(Array.isArray(report.verification.before.ignoredPaths));
    assert.match(report.verification.id, /^[0-9a-f-]{36}$/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

// The tiered surface is upgrade-only: a command missing from
// `validationCommands.tiers` is deferred, not silently dropped, and a fast pass
// never reports the change boundary as verified.
const tierTiers = {
  quick: ['node verify-quick.mjs'],
  standard: ['node verify-standard.mjs'],
  deep: ['node verify-deep.mjs'],
};

async function writeTierFixtures(target) {
  for (const name of ['quick', 'standard', 'deep']) {
    await writeFile(
      path.join(target, `verify-${name}.mjs`),
      `import { appendFile } from 'node:fs/promises';\nawait appendFile('tier-marker.txt', '${name}\\n');\n`,
      'utf8',
    );
  }
}

async function tierMarker(target) {
  try {
    return (await readFile(path.join(target, 'tier-marker.txt'), 'utf8')).split(/\r?\n/u).filter(Boolean);
  } catch {
    return [];
  }
}

test('不带 --tier 的 verify 默认只跑快速层并标注部分范围', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: tierTiers,
  });
  try {
    await writeTierFixtures(target);
    const report = await runCli(['verify', '--project', target]);

    assert.equal(report.ok, true);
    assert.equal(report.status, 'ready');
    assert.equal(report.executionTier, 'quick');
    assert.equal(report.nextTier, 'standard');
    assert.equal(report.scopeStatus, 'partial');
    assert.equal(report.verification.planMode, 'tier:quick');
    assert.equal(report.verification.executionTier, 'quick');
    assert.equal(report.verification.nextTier, 'standard');
    assert.equal(report.verification.tierSource, 'explicit');
    assert.equal(report.verification.scopeStatus, 'partial');
    assert.equal(report.verification.tierFallback, null);
    assert.equal(report.verification.changeBoundary.status, 'unverified');
    assert.deepEqual(report.verification.deferredChecks.map((item) => item.costTier), ['standard', 'deep']);
    assert.deepEqual(await tierMarker(target), ['quick']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('快速层未声明命令时默认调用回退到最便宜的非空层', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: { quick: [], standard: ['node verify-standard.mjs'], deep: [] },
  });
  try {
    await writeTierFixtures(target);
    const report = await runCli(['verify', '--project', target]);

    assert.equal(report.ok, true);
    assert.equal(report.verification.executionTier, 'standard');
    assert.equal(report.verification.nextTier, null);
    assert.equal(report.verification.scopeStatus, 'complete');
    assert.deepEqual(report.verification.tierFallback, {
      from: 'quick',
      reason: 'quick 层未声明命令，回退到最便宜的非空层',
      to: 'standard',
    });
    assert.deepEqual(await tierMarker(target), ['standard']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('显式 --tier 指向空层时保持 blocked 而不回退', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: { quick: [], standard: ['node verify-standard.mjs'], deep: [] },
  });
  try {
    await writeTierFixtures(target);
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target, '--tier', 'quick']),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_NO_CHECKS');
        assert.equal(payload.verification.executionTier, 'quick');
        assert.equal(payload.verification.tierFallback, null);
        return true;
      },
    );
    assert.deepEqual(await tierMarker(target), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --tier quick 通过、延迟更深层且不宣称完成', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: tierTiers,
  });
  try {
    await writeTierFixtures(target);
    const report = await runCli(['verify', '--project', target, '--tier', 'quick']);

    assert.equal(report.ok, true);
    assert.equal(report.status, 'ready');
    assert.equal(report.scopeStatus, 'partial');
    assert.equal(report.executionTier, 'quick');
    assert.equal(report.tierSource, 'explicit');
    assert.deepEqual(report.verification.executionTier, 'quick');
    assert.equal(report.verification.planMode, 'tier:quick');
    assert.equal(report.verification.scopeStatus, 'partial');
    assert.equal(report.verification.tierSource, 'explicit');
    assert.equal(report.verification.changeBoundary.status, 'unverified');
    assert.deepEqual(
      report.verification.deferredChecks.map((item) => [item.id, item.costTier]),
      [['verify-standard-mjs', 'standard'], ['verify-deep-mjs', 'deep']],
    );
    assert.equal(report.verification.nextTier, 'standard');
    assert.match(report.verification.recovery.hint, /--tier standard/u);
    assert.deepEqual(await tierMarker(target), ['quick']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --tier standard 只运行快速层与中等层', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: tierTiers,
  });
  try {
    await writeTierFixtures(target);
    const report = await runCli(['verify', '--project', target, '--tier', 'standard']);

    assert.equal(report.ok, true);
    assert.equal(report.verification.scopeStatus, 'partial');
    assert.deepEqual(report.verification.deferredChecks.map((item) => item.costTier), ['deep']);
    assert.deepEqual(await tierMarker(target), ['quick', 'standard']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --tier deep 运行全部层并完成范围，all 别名已移除', { timeout: 600000 }, async () => {
  for (const tier of ['deep']) {
    const target = await createProject({
      lint: null,
      typecheck: null,
      test: null,
      eval: null,
      tiers: tierTiers,
    });
    try {
      await writeTierFixtures(target);
      const report = await runCli(['verify', '--project', target, '--tier', tier]);

      assert.equal(report.ok, true);
      assert.equal(report.verification.schemaVersion, 2);
      assert.equal(report.verification.engine, 'vibe-harness-cli');
      assert.equal(report.executionTier, 'deep');
      assert.equal(report.nextTier, null);
      assert.equal(report.scopeStatus, 'complete');
      assert.deepEqual(report.verification.deferredChecks, []);
      assert.deepEqual(await tierMarker(target), ['quick', 'standard', 'deep']);
      // `all` was a silent alias for `deep`; it now fails loudly so callers
      // notice the difference between "every declared layer" and "full matrix".
      await assert.rejects(
        runCli(['verify', '--project', target, '--tier', 'all']),
        /--tier must be one of quick, standard, deep/u,
      );
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  }
});

test('verify --plan 结合分层只预览不执行', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: tierTiers,
  });
  try {
    await writeTierFixtures(target);
    const preview = await runCli(['verify', '--project', target, '--tier', 'quick', '--plan']);

    assert.equal(preview.ok, true);
    assert.equal(preview.plan.planMode, 'tier:quick');
    assert.equal(preview.plan.executionTier, 'quick');
    assert.equal(preview.plan.tierSource, 'explicit');
    assert.deepEqual(preview.plan.selectedChecks.map((item) => item.costTier), ['quick']);
    assert.deepEqual(preview.plan.deferredChecks.map((item) => item.costTier), ['standard', 'deep']);
    assert.equal(preview.plan.selectedChecks[0].blockingScope, 'quick 失败阻塞当前实施单元');
    assert.equal(preview.plan.deferredChecks[1].blockingScope, 'deep 失败阻塞集成、发布或依赖该证据的完成声明');
    assert.deepEqual(await tierMarker(target), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --tier 拒绝未知取值与 --full 组合', { timeout: 600000 }, async () => {
  const target = await createProject({ lint: null, typecheck: null, test: null, eval: null, tiers: tierTiers });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target, '--tier', 'nightly']),
      /--tier must be one of/u,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target, '--tier', 'quick', '--full']),
      /Use --tier or --full, not both/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --tier deep 暴露失败的深度命令以便回流修复', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
    tiers: { quick: ['node verify-quick.mjs'], standard: [], deep: ['node verify-fail.mjs'] },
  });
  try {
    await writeTierFixtures(target);
    await writeFile(path.join(target, 'verify-fail.mjs'), 'process.exitCode = 9;\n', 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target, '--tier', 'deep']),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /failed with exit 9/u);
        assert.equal(payload.verification.executionTier, 'deep');
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('异步验证使用一致的内容指纹，变化使排队和通过收据失效', async () => {
  const target = await createProject({
    lint: null,
    typecheck: null,
    test: 'node verify-check.mjs',
    eval: null,
    tiers: { quick: [], standard: [], deep: ['node verify-check.mjs'] },
  });
  try {
    await writeFile(path.join(target, '.gitignore'), '.vibe-harness/\n', 'utf8');
    await writeFile(path.join(target, 'verify-check.mjs'), 'process.exit(0);\n', 'utf8');
    await initializeGitProject(target);
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write', '--force']);
    const first = await runCli(['verify', '--project', target, '--tier', 'deep', '--async']);
    assert.equal(first.status, 'queued');
    assert.ok(first.queue.commitSha);
    assert.ok(first.queue.worktreeFingerprint);
    assert.equal((await consumeVerificationQueue(target))[0].status, 'passed');
    assert.equal((await consumeVerificationQueue(target))[0].status, 'passed');
    const second = await runCli(['verify', '--project', target, '--tier', 'deep', '--async']);
    assert.equal(second.status, 'queued');
    await writeFile(path.join(target, 'verify-check.mjs'), 'throw new Error("must not execute stale work");\n', 'utf8');
    const invalidated = await consumeVerificationQueue(target);
    assert.deepEqual(invalidated.map((receipt) => receipt.status), ['stale', 'stale']);
    assert.ok(invalidated.every((receipt) => /identity/iu.test(receipt.staleReason)));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
