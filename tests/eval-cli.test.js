import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  defaultProjectConfig,
  validateProjectConfig,
} from '../scripts/lib/project-config.js';
import { executeProjectVerification } from '../scripts/lib/project-verification.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: rootDir,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, payload: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      payload: JSON.parse(error.stdout || error.stderr),
      stderr: error.stderr,
    };
  }
}

async function createEvalProject() {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-eval-cli-'));
  await mkdir(path.join(target, 'evals/suites'), { recursive: true });
  await mkdir(path.join(target, 'evals/references'), { recursive: true });
  await cp(
    path.join(rootDir, 'evals/suites/loopengine-core.json'),
    path.join(target, 'evals/suites/core.json'),
  );
  await cp(
    path.join(rootDir, 'evals/references/loopengine-core.offline.json'),
    path.join(target, 'evals/references/core.json'),
  );
  const init = await run(['init', '--project', target]);
  assert.equal(init.code, 0);
  const configPath = path.join(target, 'loopengine.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.evaluations = {
    enabled: true,
    suites: ['evals/suites/core.json'],
    reference: 'evals/references/core.json',
    thresholds: {
      criticalPassRate: 1,
      overallScore: 0.9,
      maxCapabilityRegression: 0.05,
    },
    onlineRunner: null,
    repetitions: 3,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

test('project config exposes disabled evaluation defaults and validates safe paths', () => {
  assert.deepEqual(defaultProjectConfig.evaluations, {
    enabled: false,
    suites: [],
    reference: 'evals/references/project.json',
    thresholds: {
      criticalPassRate: 1,
      overallScore: 0.9,
      maxCapabilityRegression: 0.05,
    },
    onlineRunner: null,
    repetitions: 3,
  });
  assert.equal(defaultProjectConfig.validationCommands.eval, null);
  assert.equal(validateProjectConfig(defaultProjectConfig), true);
  assert.throws(
    () => validateProjectConfig({
      ...defaultProjectConfig,
      evaluations: { ...defaultProjectConfig.evaluations, suites: ['../escape.json'] },
    }),
    /evaluations\.suites/u,
  );
  assert.throws(
    () => validateProjectConfig({
      ...defaultProjectConfig,
      evaluations: { ...defaultProjectConfig.evaluations, repetitions: 4 },
    }),
    /evaluations\.repetitions/u,
  );
  assert.throws(
    () => validateProjectConfig({
      ...defaultProjectConfig,
      evaluations: { ...defaultProjectConfig.evaluations, reference: '.agents/evals/references/managed.json' },
    }),
    /project-owned/u,
  );
});

test('project verification executes eval after governance, lint, and typecheck', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-eval-order-'));
  const orderFile = path.join(target, 'order.txt');
  try {
    for (const name of ['governance', 'lint', 'typecheck', 'eval']) {
      await writeFile(
        path.join(target, `${name}.mjs`),
        `import { appendFile } from 'node:fs/promises'; await appendFile(${JSON.stringify(orderFile)}, ${JSON.stringify(`${name}\n`)});\n`,
        'utf8',
      );
    }
    const commandStatus = Object.fromEntries(['governance', 'lint', 'typecheck', 'eval'].map((name) => [
      name,
      { command: `node ${name}.mjs`, status: 'available' },
    ]));
    const results = await executeProjectVerification({ commandStatus, targetDir: target });
    assert.equal(results.eval.status, 'passed');
    assert.equal(await readFile(orderFile, 'utf8'), 'governance\nlint\ntypecheck\neval\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('eval check and offline run are read-only until write is explicit', async () => {
  const target = await createEvalProject();
  try {
    const checked = await run(['eval', 'check', '--project', target]);
    assert.equal(checked.code, 0);
    assert.equal(checked.payload.status, 'ready');
    assert.equal(checked.payload.suites[0].id, 'loopengine-core');

    const preview = await run(['eval', 'run', '--project', target, '--mode', 'offline']);
    assert.equal(preview.code, 0);
    assert.equal(preview.payload.dryRun, true);
    assert.equal(preview.payload.run.status, 'passed');
    await assert.rejects(readFile(path.join(target, '.loopengine/evals/runs'), 'utf8'), /ENOENT|EISDIR/u);

    const written = await run(['eval', 'run', '--project', target, '--mode', 'offline', '--write']);
    assert.equal(written.code, 0);
    assert.equal(written.payload.dryRun, false);
    assert.match(written.payload.written[0], /^\.loopengine\/evals\/runs\/.+\.json$/u);
    const persisted = JSON.parse(await readFile(path.join(target, written.payload.written[0]), 'utf8'));
    assert.equal(persisted.status, 'passed');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('eval rejects removed lifecycle flags and unsafe suite selection', async () => {
  const target = await createEvalProject();
  try {
    const invalidTarget = await run(['eval', 'check', '--target', target]);
    assert.equal(invalidTarget.code, 1);
    assert.match(invalidTarget.payload.error.message, /--project/u);
    const apply = await run(['eval', 'run', '--project', target, '--mode', 'offline', '--apply']);
    assert.equal(apply.code, 1);
    assert.match(apply.payload.error.message, /--apply/u);
    const unknownSuite = await run(['eval', 'check', '--project', target, '--suite', '../escape']);
    assert.equal(unknownSuite.code, 1);
    assert.match(unknownSuite.payload.error.message, /suite/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('eval paths reject project-internal links that escape the project', async () => {
  const target = await createEvalProject();
  const outside = await mkdtemp(path.join(tmpdir(), 'loopengine-eval-outside-'));
  try {
    await writeFile(path.join(outside, 'run.json'), '{}\n', 'utf8');
    await symlink(outside, path.join(target, 'linked-runs'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await run(['eval', 'reference', '--project', target, '--from', 'linked-runs/run.json']);
    assert.equal(escaped.code, 1);
    assert.match(escaped.payload.error.message, /symbolic link/u);
  } finally {
    await Promise.all([target, outside].map((root) => rm(root, { force: true, recursive: true })));
  }
});

test('reference update requires confirmation and force protects existing files', async () => {
  const target = await createEvalProject();
  try {
    const written = await run(['eval', 'run', '--project', target, '--mode', 'offline', '--write']);
    const runPath = written.payload.written[0];
    const unconfirmed = await run(['eval', 'reference', '--project', target, '--from', runPath, '--write']);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.payload.error.message, /confirm-reference-update/u);

    const conflict = await run([
      'eval', 'reference', '--project', target, '--from', runPath, '--write', '--confirm-reference-update',
    ]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.payload.error.message, /--force/u);

    const forced = await run([
      'eval', 'reference', '--project', target, '--from', runPath, '--write', '--confirm-reference-update', '--force',
    ]);
    assert.equal(forced.code, 0);
    assert.equal(forced.payload.backups.length, 1);
    const reference = JSON.parse(await readFile(path.join(target, 'evals/references/core.json'), 'utf8'));
    assert.equal(reference.suite.id, 'loopengine-core');
    assert.equal(Object.hasOwn(reference, 'cases'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('threshold failures stay invalid without a reference and cannot be promoted', async () => {
  const target = await createEvalProject();
  try {
    const suitePath = path.join(target, 'evals/suites/core.json');
    const suite = JSON.parse(await readFile(suitePath, 'utf8'));
    suite.id = 'low-score';
    suite.cases = [suite.cases[0]];
    suite.cases[0].oracle.requiredOutputFragments.push(...Array.from({ length: 10 }, (_, index) => ({
      critical: false,
      dimension: 'correctness',
      value: `missing-${index}`,
    })));
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.evaluations.reference = 'evals/references/low-score.json';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const candidate = await run(['eval', 'run', '--project', target, '--mode', 'offline', '--write', '--allow-degraded']);
    assert.equal(candidate.code, 1);
    assert.equal(candidate.payload.status, 'invalid');
    assert.equal(candidate.payload.run.status, 'failed');
    const promotion = await run([
      'eval', 'reference', '--project', target, '--from', candidate.payload.written[0],
      '--write', '--confirm-reference-update',
    ]);
    assert.equal(promotion.code, 1);
    assert.match(promotion.payload.error.message, /absolute thresholds/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('online eval uses the runner contract, degrades without reference, then passes approved reference', async () => {
  const target = await createEvalProject();
  const runnerRoot = await mkdtemp(path.join(tmpdir(), 'loopengine-online-runner-'));
  try {
    const suitePath = path.join(target, 'evals/suites/core.json');
    const suite = JSON.parse(await readFile(suitePath, 'utf8'));
    suite.id = 'online-smoke';
    suite.cases = suite.cases.slice(0, 2);
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.evaluations.reference = 'evals/references/online.json';
    config.evaluations.repetitions = 1;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const runnerPath = path.join(runnerRoot, 'runner.mjs');
    await writeFile(runnerPath, `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      const replay = request.case.input.replay;
      process.stdout.write(JSON.stringify({
        schemaVersion: 1, caseId: request.case.id, runner: 'fake-online@1', model: 'fixture',
        agentVersion: 'fake-agent@1', governanceHash: request.governanceHash,
        events: replay.events, output: replay.output, artifacts: replay.artifacts,
        exitCode: replay.exitCode, diagnostics: []
      }));
    `, 'utf8');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)}`;
    const first = await run([
      'eval', 'run', '--project', target, '--suite', 'online-smoke', '--mode', 'online',
      '--runner', command, '--write', '--allow-degraded',
    ]);
    assert.equal(first.code, 0);
    assert.equal(first.payload.status, 'degraded');
    const approved = await run([
      'eval', 'reference', '--project', target, '--from', first.payload.written[0],
      '--write', '--confirm-reference-update',
    ]);
    assert.equal(approved.code, 0);
    const second = await run([
      'eval', 'run', '--project', target, '--suite', 'online-smoke', '--mode', 'online', '--runner', command,
    ]);
    assert.equal(second.code, 0);
    assert.equal(second.payload.status, 'ready');
  } finally {
    await Promise.all([target, runnerRoot].map((root) => rm(root, { force: true, recursive: true })));
  }
});

test('online runner degradation writes a diagnostic artifact and stops immediately', async () => {
  const target = await createEvalProject();
  const runnerRoot = await mkdtemp(path.join(tmpdir(), 'loopengine-degraded-runner-'));
  try {
    const runnerPath = path.join(runnerRoot, 'runner.mjs');
    await writeFile(runnerPath, "process.stdout.write('invalid-json')\n", 'utf8');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)}`;
    const result = await run([
      'eval', 'run', '--project', target, '--mode', 'online', '--runner', command,
      '--write', '--allow-degraded',
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.payload.status, 'degraded');
    assert.equal(result.payload.written.length, 1);
    const diagnostic = JSON.parse(await readFile(path.join(target, result.payload.written[0]), 'utf8'));
    assert.equal(diagnostic.status, 'degraded');
    assert.equal(diagnostic.diagnostics.length, 1);
  } finally {
    await Promise.all([target, runnerRoot].map((root) => rm(root, { force: true, recursive: true })));
  }
});
