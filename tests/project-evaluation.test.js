import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkProjectEvaluations,
  runProjectEvaluations,
  writeProjectEvaluationReference,
} from '../scripts/lib/project-evaluation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

function baseConfig(overrides = {}) {
  return {
    projectName: 'TestProject',
    language: 'zh-CN',
    packageManager: 'pnpm',
    target: 'codex',
    profile: 'core',
    validationCommands: { lint: null, typecheck: null, test: null, eval: null },
    evaluations: {
      enabled: true,
      suites: ['evals/suites/vibe-harness-core.json'],
      reference: 'evals/references/vibe-harness-core.offline.json',
      thresholds: { criticalPassRate: 1, overallScore: 0.9, maxCapabilityRegression: 0.05 },
      onlineRunner: null,
      repetitions: 3,
    },
    ...overrides,
  };
}

async function createEvalProject() {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-pe-'));
  await cp(
    path.join(rootDir, 'evals/suites/vibe-harness-core.json'),
    path.join(target, 'evals/suites/vibe-harness-core.json'),
    { recursive: true },
  );
  await cp(
    path.join(rootDir, 'evals/references/vibe-harness-core.offline.json'),
    path.join(target, 'evals/references/vibe-harness-core.offline.json'),
    { recursive: true },
  );
  return target;
}

test('checkProjectEvaluations rejects a disabled evaluations config', async () => {
  const target = await createEvalProject();
  try {
    await assert.rejects(
      checkProjectEvaluations({ config: baseConfig({ evaluations: { ...baseConfig().evaluations, enabled: false } }), rootDir, targetDir: target }),
      /disabled/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('checkProjectEvaluations rejects a suite path that escapes the project', async () => {
  const target = await createEvalProject();
  try {
    const config = baseConfig({ evaluations: { ...baseConfig().evaluations, suites: ['../escape.json'] } });
    await assert.rejects(
      checkProjectEvaluations({ config, rootDir, targetDir: target }),
      /suite|portable|inside|escape/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runProjectEvaluations degrades when a copied reference has source-project asset hashes', async () => {
  const target = await createEvalProject();
  try {
    const result = await runProjectEvaluations({
      config: baseConfig(),
      mode: 'offline',
      rootDir,
      targetDir: target,
      suiteId: 'vibe-harness-core',
      write: false,
    });
    assert.equal(result.status, 'degraded');
    assert.equal(result.dryRun, true);
    assert.equal(result.run.status, 'passed');
    assert.equal(result.run.reference.status, 'mismatched');
    assert.equal(result.warnings.some((item) => item.includes('assets.')), true);
    assert.equal(result.written.length, 0);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runProjectEvaluations rejects an invalid mode', async () => {
  const target = await createEvalProject();
  try {
    await assert.rejects(
      runProjectEvaluations({ config: baseConfig(), mode: 'bogus', rootDir, targetDir: target, suiteId: 'vibe-harness-core' }),
      /offline or online/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runProjectEvaluations flags a degraded status when the reference is missing', async () => {
  const target = await createEvalProject();
  try {
    await rm(path.join(target, 'evals/references/vibe-harness-core.offline.json'), { force: true });
    const result = await runProjectEvaluations({
      config: baseConfig(),
      mode: 'offline',
      rootDir,
      targetDir: target,
      suiteId: 'vibe-harness-core',
    });
    assert.equal(result.status, 'degraded');
    assert.equal(result.run.reference.status, 'missing');
    assert.ok(result.warnings.some((w) => w.includes('reference is missing')));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runProjectEvaluations refuses to traverse a symlink that escapes the project', async () => {
  const target = await createEvalProject();
  const outside = await mkdtemp(path.join(tmpdir(), 'vibe-harness-pe-outside-'));
  try {
    await writeFile(path.join(outside, 'rogue.json'), '{}\n', 'utf8');
    await symlink(outside, path.join(target, 'evals', 'rogue-suites'), process.platform === 'win32' ? 'junction' : 'dir');
    const config = baseConfig({
      evaluations: { ...baseConfig().evaluations, suites: ['evals/rogue-suites/rogue.json'], reference: 'evals/references/vibe-harness-core.offline.json' },
    });
    await assert.rejects(
      runProjectEvaluations({ config, mode: 'offline', rootDir, targetDir: target }),
      /EVAL_PATH_UNSAFE|symbolic link/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});
