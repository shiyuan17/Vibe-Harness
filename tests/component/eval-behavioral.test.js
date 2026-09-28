import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson, validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';
import { validateEvalSuiteSemantics } from '../../scripts/lib/eval-contract.js';
import { BEHAVIORAL_RESULT_PATH, buildBehavioralRun, syncBehavioralRunArtifact } from '../../scripts/lib/eval-behavioral.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

async function loadBehavioralSuite() {
  const [suite, suiteSchema, runSchema] = await Promise.all([
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-behavioral.json')),
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
  ]);
  return { runSchema, suite, suiteSchema };
}

test('行为套件通过 schema 与语义校验且包含六个离线用例', async () => {
  const { suite, suiteSchema } = await loadBehavioralSuite();
  assert.deepEqual(validateJsonAgainstSchema(suite, suiteSchema, 'behavioral suite'), []);
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  assert.equal(suite.cases.length, 6);
  assert.equal(new Set(suite.cases.map((item) => item.id)).size, 6);
  assert.equal(suite.cases.every((item) => item.input.behavioral), true);
  assert.equal(suite.cases.every((item) => (item.oracle.llmRubrics ?? []).length === 0), true);
});

test('行为运行执行真实运行时且确定性通过', async () => {
  const { runSchema, suite } = await loadBehavioralSuite();
  // An empty asset root keeps this test on the runtime path without paying the
  // full-repo asset fingerprint; repo coupling is the checked-in-artifact test.
  const assetRoot = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-assets-'));
  try {
    const [first, second] = await Promise.all([
      buildBehavioralRun(suite, { assetRoot }),
      buildBehavioralRun(suite, { assetRoot }),
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(validateJsonAgainstSchema(first, runSchema, 'behavioral run'), []);
    assert.equal(first.proof, 'stub-behavioral');
    assert.equal(first.mode, 'offline');
    assert.equal(first.status, 'passed');
    assert.equal(first.overallScore, 1);
    assert.equal(first.criticalPassRate, 1);
    assert.deepEqual(first.cases.map((item) => item.id), suite.cases.map((item) => item.id));
    assert.equal(first.cases.every((item) => item.passed && item.criticalFailures === 0), true);
  } finally {
    await rm(assetRoot, { force: true, recursive: true });
  }
});

test('已入库行为产物与再生成运行一致且无需写入', async () => {
  const { suite } = await loadBehavioralSuite();
  const report = await syncBehavioralRunArtifact({ rootDir, suite, write: false });
  assert.equal(report.status, 'current');
  assert.equal(report.changed, false);
  assert.deepEqual(report.written, []);
  assert.deepEqual(report.backups, []);
  const checkedIn = await readJson(path.join(rootDir, BEHAVIORAL_RESULT_PATH));
  assert.deepEqual(checkedIn, report.run);
});

test('反转红区 oracle 使拒绝用例失败，套件无法同义反复地通过', async () => {
  const { suite } = await loadBehavioralSuite();
  const inverted = structuredClone(suite);
  inverted.cases = [inverted.cases[0]];
  inverted.cases[0].oracle = {
    requiredEvents: [{ value: 'hook:allow', dimension: 'safety', critical: true }],
    forbiddenEvents: [{ value: 'hook:deny', dimension: 'safety', critical: true }],
    requiredOutputFragments: [{ value: '"verdict":"allow"', dimension: 'correctness', critical: true }],
    forbiddenOutputFragments: [],
    requiredArtifacts: [{ value: '.env', dimension: 'evidenceQuality', critical: true }],
    forbiddenArtifacts: [],
    exitCode: { value: 0, dimension: 'correctness', critical: true },
  };
  const assetRoot = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-inverted-'));
  try {
    const run = await buildBehavioralRun(inverted, { assetRoot });
    assert.equal(run.status, 'failed');
    assert.equal(run.cases[0].passed, false);
    assert.ok(run.cases[0].criticalFailures >= 3);
    const failedKinds = run.cases[0].assertions.filter((item) => !item.passed).map((item) => item.kind).sort();
    assert.deepEqual(failedKinds, [
      'exit-code',
      'forbidden-event',
      'required-artifact',
      'required-event',
      'required-output-fragment',
    ]);
  } finally {
    await rm(assetRoot, { force: true, recursive: true });
  }
});

test('blocked 与 failed 的聚焦验证通过命令码保持区分', async () => {
  const { suite } = await loadBehavioralSuite();
  const mutated = structuredClone(suite);
  mutated.cases = mutated.cases.filter((item) => item.id === 'EVAL-BEH-VERIFY-002');
  mutated.cases[0].oracle.requiredOutputFragments
    .find((item) => item.value === '"commandCodes":["PROJECT_VERIFICATION_COMMAND_FAILED"]').value = '"commandCodes":[null]';
  const assetRoot = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-codes-'));
  try {
    const [run, swapped] = await Promise.all([
      buildBehavioralRun(suite, { assetRoot }),
      buildBehavioralRun(mutated, { assetRoot }),
    ]);
    const byId = new Map(run.cases.map((item) => [item.id, item]));
    const blocked = byId.get('EVAL-BEH-VERIFY-001');
    const failed = byId.get('EVAL-BEH-VERIFY-002');
    assert.equal(blocked.passed, true);
    assert.equal(failed.passed, true);
    for (const [definition, expected] of [
      [blocked, '"commandCodes":[null]'],
      [failed, '"commandCodes":["PROJECT_VERIFICATION_COMMAND_FAILED"]'],
    ]) {
      const fragment = definition.assertions.find((item) => item.kind === 'required-output-fragment' && item.expected === expected);
      assert.equal(fragment?.passed, true, `${expected} must be observed and passing`);
    }

    // Swapping the command-code expectation must fail: blocked and failed are
    // not interchangeable receipts.
    const failedFragment = swapped.cases[0].assertions.find((item) => item.expected === '"commandCodes":[null]');
    assert.equal(failedFragment.passed, false);
  } finally {
    await rm(assetRoot, { force: true, recursive: true });
  }
});

test('行为产物再生成显式执行、先备份并报告漂移字段', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-artifact-'));
  try {
    const { suite } = await loadBehavioralSuite();
    const single = structuredClone(suite);
    single.cases = [single.cases[0]];
    const artifactPath = path.join(targetDir, BEHAVIORAL_RESULT_PATH);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const stale = structuredClone(await buildBehavioralRun(single, { assetRoot: targetDir }));
    stale.fingerprint.assets.aggregateHash = '0'.repeat(64);
    stale.fingerprint.assets.groups.hooks.hash = '1'.repeat(64);
    await writeFile(artifactPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    const dryRun = await syncBehavioralRunArtifact({ rootDir: targetDir, suite: single });
    assert.equal(dryRun.status, 'drifted');
    assert.equal(dryRun.changed, true);
    assert.deepEqual(dryRun.written, []);
    assert.deepEqual(dryRun.backups, []);
    assert.deepEqual(dryRun.changes.map((item) => item.field), [
      'fingerprint.assets.aggregateHash',
      'fingerprint.assets.groups.hooks.hash',
    ]);
    assert.equal(JSON.parse(await readFile(artifactPath, 'utf8')).fingerprint.assets.aggregateHash, '0'.repeat(64));

    const written = await syncBehavioralRunArtifact({
      now: new Date('2026-09-18T00:00:00.000Z'),
      rootDir: targetDir,
      suite: single,
      write: true,
    });
    assert.equal(written.status, 'updated');
    assert.deepEqual(written.written, [BEHAVIORAL_RESULT_PATH]);
    assert.equal(written.backups.length, 1);
    assert.equal(written.backups[0].target, BEHAVIORAL_RESULT_PATH);
    const backup = JSON.parse(await readFile(path.join(targetDir, written.backups[0].backup), 'utf8'));
    assert.equal(backup.fingerprint.assets.aggregateHash, '0'.repeat(64));
    assert.deepEqual(JSON.parse(await readFile(artifactPath, 'utf8')), written.run);

    const current = await syncBehavioralRunArtifact({ rootDir: targetDir, suite: single });
    assert.equal(current.status, 'current');
    assert.equal(current.changed, false);
    assert.deepEqual(current.changes, []);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('行为产物再生成在缺失时直接创建且不产生备份', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-missing-'));
  try {
    const { suite } = await loadBehavioralSuite();
    const single = structuredClone(suite);
    single.cases = [single.cases[0]];
    const report = await syncBehavioralRunArtifact({ rootDir: targetDir, suite: single, write: true });
    assert.equal(report.status, 'updated');
    assert.deepEqual(report.written, [BEHAVIORAL_RESULT_PATH]);
    assert.deepEqual(report.backups, []);
    assert.deepEqual(report.changes.map((item) => item.field), ['fingerprint']);
    const saved = JSON.parse(await readFile(path.join(targetDir, BEHAVIORAL_RESULT_PATH), 'utf8'));
    assert.deepEqual(saved.fingerprint, report.run.fingerprint);
    assert.equal(saved.mode, 'offline');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('行为 CLI 默认只读、暴露包脚本并拒绝未知参数', async () => {
  const packageJson = await readJson(path.join(rootDir, 'package.json'));
  assert.equal(packageJson.scripts['eval:behavioral'], 'node ./scripts/eval-behavioral.js');
  const report = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-behavioral.js'), '--json']);
  const payload = JSON.parse(report.stdout);
  assert.deepEqual(payload, {
    backups: [],
    cases: (await loadBehavioralSuite()).suite.cases.map((item) => ({ id: item.id, passed: true })),
    changes: [],
    criticalPassRate: 1,
    ok: true,
    overallScore: 1,
    path: BEHAVIORAL_RESULT_PATH,
    status: 'current',
    suite: 'vibe-harness-behavioral',
    written: [],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-behavioral.js'), '--bogus']),
    (error) => error.code === 1 && /unknown argument/u.test(error.stderr),
  );
});
