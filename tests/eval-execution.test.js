import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson, validateJsonAgainstSchema } from '../scripts/lib/manifest.js';
import {
  validateEvalObserverCoverage,
  validateEvalSuiteSemantics,
} from '../scripts/lib/eval-contract.js';
import { runHiddenTests } from '../runtime/evals/lib/hidden-tests.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');
const suitePath = path.join(rootDir, 'evals/suites/vibe-harness-online-execution.json');

test('execution suite schema accepts the optional fixture.tests block', async () => {
  const [schema, suite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(suitePath),
  ]);
  assert.deepEqual(validateJsonAgainstSchema(suite, schema, 'execution suite'), []);
  // tests is optional and present on every case.
  assert.equal(suite.cases.every((item) => Array.isArray(item.input.fixture.tests) && item.input.fixture.tests.length > 0), true);
  // command is a non-empty argv array, expectedExitCode is a non-negative integer.
  for (const item of suite.cases) {
    assert.equal(item.input.fixture.allowedWritePaths.length, 1);
    for (const entry of item.input.fixture.tests) {
      assert.equal(Array.isArray(entry.command) && entry.command.length > 0, true);
      assert.equal(Number.isInteger(entry.expectedExitCode) && entry.expectedExitCode >= 0, true);
    }
  }
});

test('execution suite rejects unknown fixture keys and bad command types', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/eval-suite.schema.json'));
  const suite = await readJson(suitePath);
  const invalid = structuredClone(suite);
  // Unknown key inside a test entry is rejected (additionalProperties: false).
  invalid.cases[0].input.fixture.tests[0].unexpected = true;
  assert.notEqual(validateJsonAgainstSchema(invalid, schema, 'bad').length, 0);
  // Non-array command is rejected.
  const nonArray = structuredClone(suite);
  nonArray.cases[0].input.fixture.tests[0].command = 'node test.js';
  assert.notEqual(validateJsonAgainstSchema(nonArray, schema, 'bad').length, 0);
  // Non-integer expectedExitCode is rejected.
  const badCode = structuredClone(suite);
  badCode.cases[0].input.fixture.tests[0].expectedExitCode = 1.5;
  assert.notEqual(validateJsonAgainstSchema(badCode, schema, 'bad').length, 0);
  for (const invalidPath of ['/absolute.js', 'C:/absolute.js', '../escape.js', 'dir\\file.js', 'dir/../file.js']) {
    const invalidWrite = structuredClone(suite);
    invalidWrite.cases[0].input.fixture.allowedWritePaths = [invalidPath];
    assert.notEqual(validateJsonAgainstSchema(invalidWrite, schema, 'bad').length, 0, invalidPath);
  }
});

test('execution suite passes semantic validation (weight-assertion coupling, positive total weight)', async () => {
  const suite = await readJson(suitePath);
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
});

test('execution suite hidden-test events are registered observers', async () => {
  const [suite, observers] = await Promise.all([
    readJson(suitePath),
    readJson(path.join(rootDir, 'runtime/evals/observers.json')),
  ]);
  assert.deepEqual(validateEvalObserverCoverage([suite], observers), []);
  assert.equal(typeof observers.events['hidden-tests-passed'], 'object');
  assert.equal(typeof observers.events['hidden-tests-failed'], 'object');
  assert.equal(typeof observers.events['undeclared-workspace-write'], 'object');
  const incomplete = structuredClone(observers);
  delete incomplete.events['hidden-tests-failed'];
  assert.match(validateEvalObserverCoverage([suite], incomplete).join('\n'), /hidden-tests-failed/u);
});

test('execution suite contains five task-delivery-governance cases graded by hidden tests', async () => {
  const suite = await readJson(suitePath);
  assert.equal(suite.cases.length, 5);
  assert.equal(new Set(suite.cases.map((item) => item.id)).size, 5);
  assert.equal(suite.cases.every((item) => item.category === 'task-delivery-governance'), true);
  for (const item of suite.cases) {
    assert.equal(item.oracle.requiredEvents.some((entry) => entry.value === 'hidden-tests-passed' && entry.dimension === 'correctness' && entry.critical), true);
    assert.equal(item.oracle.forbiddenEvents.some((entry) => entry.value === 'hidden-tests-failed' && entry.dimension === 'correctness' && entry.critical), true);
    assert.equal(item.oracle.forbiddenEvents.some((entry) => entry.value === 'undeclared-workspace-write' && entry.dimension === 'safety' && entry.critical), true);
    assert.ok(item.weights.correctness > 0, 'correctness must carry positive weight');
  }
  const visibleTests = suite.cases.filter((item) => item.input.fixture.files.some((file) => file.path === 'test.js'));
  assert.deepEqual(visibleTests, []);
  for (const item of suite.cases.filter((entry) => entry.id !== 'EVAL-EXEC-004')) {
    assert.deepEqual(item.input.fixture.tests[1].command.slice(0, 2), ['node', '-e']);
  }
  assert.deepEqual(suite.cases.find((item) => item.id === 'EVAL-EXEC-004').input.fixture.tests[1].command, ['node', 'test.js']);
  assert.equal(suite.cases.every((item) => item.input.fixture.tests.map((testCase) => testCase.kind).join(',') === 'api-contract,behavior'), true);
  assert.equal(suite.cases.every((item) => item.input.fixture.tests.map((testCase) => testCase.diagnosticCategory).join(',') === 'api-existence,behavior'), true);
  assert.equal(suite.cases.every((item) => item.reporting.toolMetricMode === 'execute'), true);
  const refactor = suite.cases.find((item) => item.id === 'EVAL-EXEC-003');
  assert.match(refactor.input.scenario, /Hello, Ada![\s\S]*Hello, Ada, Alan![\s\S]*Hello, !/u);
});

test('runHiddenTests returns an empty summary when no tests are declared', async () => {
  const request = { case: { input: { fixture: { tests: [] } } }, workspace: '' };
  const empty = { events: [], summary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 0, total: 0 } };
  assert.deepEqual(await runHiddenTests(request, {}), empty);
  const noFixture = { case: { input: {} }, workspace: '' };
  assert.deepEqual(await runHiddenTests(noFixture, {}), empty);
});

test('runHiddenTests reports passed when the command exits with the expected code', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-pass-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "console.log('ok');\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual(await runHiddenTests(request, {}), {
      events: ['hidden-tests-passed'],
      summary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 1, total: 1 },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed when the command exits with an unexpected code (fail-closed)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-fail-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "process.exit(1);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed on timeout (fail-closed)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-timeout-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "setTimeout(() => process.exit(0), 10000);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0, timeoutMs: 1000 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    // On Windows the SIGKILLed child can briefly hold file handles; retry removal.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(workspace, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }
});

test('runHiddenTests reports failed when any one of several commands fails (all-must-pass)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-mixed-'));
  try {
    await writeFile(path.join(workspace, 'pass.js'), "console.log('ok');\n", 'utf8');
    await writeFile(path.join(workspace, 'fail.js'), "process.exit(1);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [
        { command: [process.execPath, 'pass.js'], expectedExitCode: 0, kind: 'behavior' },
        { command: [process.execPath, 'fail.js'], expectedExitCode: 0, kind: 'api-contract', diagnosticCategory: 'api-existence' },
      ] } } },
      workspace,
    };
    assert.deepEqual(await runHiddenTests(request, {}), {
      events: ['hidden-tests-failed'],
      summary: { apiContractFailures: 1, apiExistenceFailures: 1, failed: 1, passed: 1, total: 2 },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed when a fixture test command cannot spawn', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-spawn-'));
  try {
    const request = {
      case: { input: { fixture: { tests: [{ command: ['this-binary-does-not-exist-xyz'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
