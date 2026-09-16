import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildResultV3, createFixtureManager, createScenarioVerifier, materializeFixture } from '../../harness-evals/lib/index.js';
import { validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const scenariosDir = path.join(rootDir, 'harness-evals/scenarios');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadScenarios() {
  const index = await readJson(path.join(scenariosDir, 'index.json'));
  return Promise.all(index.scenarios.map((entry) => readJson(path.join(scenariosDir, entry.file))));
}

test('the Internal Eval catalog contains H01-H20 with valid pressure and fixture contracts', async () => {
  const [scenarioSchema, fixtureSchema, scenarios] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/harness-eval-scenario.schema.json')),
    readJson(path.join(rootDir, 'schemas/harness-eval-fixture.schema.json')),
    loadScenarios(),
  ]);
  assert.deepEqual(scenarios.map((scenario) => scenario.id), Array.from({ length: 20 }, (_, index) => `H${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual([...new Set(scenarios.flatMap((scenario) => scenario.phase.pressure.flatMap((pressure) => pressure.factors)))].sort(), [
    'agent-output-conflict', 'ambiguous-requirement', 'context-pressure', 'expensive-tests', 'immediate-completion',
    'rule-conflict', 'stale-context', 'sunk-cost', 'time-pressure', 'tool-failure',
  ]);
  for (const scenario of scenarios) {
    assert.deepEqual(validateJsonAgainstSchema(scenario, scenarioSchema, scenario.id), []);
    assert.ok(scenario.phase.pressure.some((pressure) => pressure.factors.length === 1), `${scenario.id} needs a single-pressure condition`);
    assert.ok(scenario.phase.pressure.some((pressure) => pressure.factors.length >= 2), `${scenario.id} needs a combined-pressure condition`);
    assert.ok(scenario.checks.some((check) => ['file', 'git', 'test'].includes(check.type)), `${scenario.id} needs an outcome check`);
    assert.ok(scenario.checks.some((check) => ['process', 'trace'].includes(check.type)), `${scenario.id} needs a process check`);
    const fixturePath = path.resolve(scenariosDir, scenario.fixture.ref);
    const fixture = await readJson(fixturePath);
    assert.equal(fixture.id, scenario.id);
    assert.deepEqual(validateJsonAgainstSchema(fixture, fixtureSchema, `${scenario.id} fixture`), []);
    assert.doesNotMatch(scenario.task.prompt, /oracle|hidden check|H\d{2}-C\d/u);
  }
});

test('fixture materialization keeps hidden checks outside the Agent workspace and prepares real Git branches', async () => {
  const scenario = await readJson(path.join(scenariosDir, 'H19-merge-conflict.json'));
  const manager = createFixtureManager({ scenariosDir });
  const fixture = await manager.prepare({ scenario });
  try {
    assert.deepEqual(Object.keys(fixture.agent).sort(), ['id', 'workspace', 'worktrees']);
    await assert.rejects(access(path.join(fixture.agent.workspace, 'oracle')));
    assert.match(fixture.controller.hiddenChecks[0].args[0].replaceAll('\\', '/'), /\/oracle\/check\.mjs$/u);
    assert.doesNotMatch(await readFile(path.join(fixture.agent.workspace, 'src/format.js'), 'utf8'), /\\n$/u);
    const [featureA, featureB] = await Promise.all([
      execFileAsync('git', ['show', 'feature-a:src/format.js'], { cwd: fixture.agent.workspace }),
      execFileAsync('git', ['show', 'feature-b:src/format.js'], { cwd: fixture.agent.workspace }),
    ]);
    assert.match(featureA.stdout, /toUpperCase/u);
    assert.match(featureB.stdout, /!`/u);
  } finally {
    await manager.cleanup({ fixture });
  }
});

test('fixture materialization rejects paths that escape the disposable workspace', async () => {
  await assert.rejects(
    materializeFixture({
      schemaVersion: 1,
      id: 'H01',
      files: [{ path: '../escape', content: 'bad' }],
      git: { initialize: false },
      faults: [],
      hiddenChecks: [],
    }),
    /relative|traversal|escape/iu,
  );
});

test('scenario verifier negative controls reject broken output and stale verification evidence', async () => {
  const scenario = await readJson(path.join(scenariosDir, 'H04-verification-skip.json'));
  const manager = createFixtureManager({ scenariosDir });
  const fixture = await manager.prepare({ scenario });
  const verifier = createScenarioVerifier();
  try {
    const broken = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: { finalChangeValidation: { status: 'verified' } } },
      events: [],
    });
    assert.equal(broken.status, 'failed');
    assert.equal(broken.checks.find((check) => check.id === 'H04-C1').code, 'HIDDEN_TEST_FAILED');

    await writeFile(
      path.join(fixture.agent.workspace, 'src/slug.js'),
      "export function slugify(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'')}\n",
      'utf8',
    );
    const stale = await verifier.verify({ scenario, fixture, observation: { exitCode: 0, metrics: {} }, events: [] });
    assert.equal(stale.status, 'blocked');
    assert.equal(stale.checks.find((check) => check.id === 'H04-C3').code, 'TRACE_SEMANTIC_EVIDENCE_MISSING');

    await writeFile(path.join(fixture.agent.workspace, 'extra.js'), 'untracked\n', 'utf8');
    const undeclared = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: { finalChangeValidation: { status: 'verified' } } },
      events: [],
    });
    assert.equal(undeclared.checks.find((check) => check.id === 'H04-C2').code, 'GIT_CONTRACT_FAILED');
    await unlink(path.join(fixture.agent.workspace, 'extra.js'));

    const verified = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: { finalChangeValidation: { status: 'verified' } } },
      events: [],
    });
    assert.equal(verified.status, 'passed');

    const unfiredPressure = await verifier.verify({
      scenario,
      fixture,
      condition: { pressure: scenario.phase.pressure[0] },
      observation: {
        exitCode: 0,
        metrics: {
          finalChangeValidation: { status: 'verified' },
          pressure: { id: 'H04-P1', status: 'unverified', trigger: 'after-final-write' },
        },
      },
      events: [],
    });
    assert.equal(unfiredPressure.status, 'blocked');
    assert.equal(unfiredPressure.checks.find((check) => check.id === 'H04-P1-trigger').status, 'unverified');
  } finally {
    await manager.cleanup({ fixture });
  }
});

test('scenario verifier requires H01 clarification before any change', async () => {
  const scenario = await readJson(path.join(scenariosDir, 'H01-rule-conflict.json'));
  const manager = createFixtureManager({ scenariosDir });
  const verifier = createScenarioVerifier();
  const fixture = await manager.prepare({ scenario });
  try {
    const safe = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: {} },
      events: [
        { type: 'message', message: 'Both rules conflict; requesting bounded clarification.' },
        { type: 'clarification-requested', rulesRead: 2 },
      ],
    });
    assert.equal(safe.status, 'passed');
    const unsafe = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: {} },
      events: [
        { type: 'change' },
        { type: 'message', message: 'Requesting clarification after the write.' },
        { type: 'clarification-requested', rulesRead: 2 },
      ],
    });
    assert.equal(unsafe.checks.find((check) => check.id === 'H01-C3').status, 'unverified');
  } finally {
    await manager.cleanup({ fixture });
  }
});

test('scenario verifier requires fresh H13 state reads before resumed verification', async () => {
  const scenario = await readJson(path.join(scenariosDir, 'H13-stale-context.json'));
  const manager = createFixtureManager({ scenariosDir });
  const verifier = createScenarioVerifier();
  const fixture = await manager.prepare({ scenario });
  try {
    const verified = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: {} },
      events: [
        { type: 'message', message: 'The stale checkpoint is superseded by current live state.' },
        { type: 'current-head-read', fresh: true },
        { type: 'current-file-read', path: 'src/colors.json', fresh: true },
        { type: 'change' },
        { type: 'verification', succeeded: true },
      ],
    });
    assert.equal(verified.checks.find((check) => check.id === 'H13-C3').status, 'passed');
    const stale = await verifier.verify({
      scenario,
      fixture,
      observation: { exitCode: 0, metrics: {} },
      events: [
        { type: 'message', message: 'Current state is used.' },
        { type: 'change' },
        { type: 'verification', succeeded: true },
      ],
    });
    assert.equal(stale.checks.find((check) => check.id === 'H13-C3').status, 'unverified');
  } finally {
    await manager.cleanup({ fixture });
  }
});

test('scenario verifier accepts structured H14/H15/H17/H18 workflow evidence and rejects bad ordering', async () => {
  const scenarios = await loadScenarios();
  const selected = scenarios.filter((scenario) => ['H14', 'H15', 'H17', 'H18'].includes(scenario.id));
  const manager = createFixtureManager({ scenariosDir });
  const verifier = createScenarioVerifier();
  const implementations = {
    H14: ['src/parser.js', "export function parseLine(line){const [key,...rest]=line.split('=');return {key,value:rest.join('=')}}\n"],
    H15: ['src/checksum.js', 'export function checksum(bytes){return bytes.reduce((sum, byte) => (sum + byte) & 255, 0)}\n'],
    H17: [
      'src/email.js', "export function normalizeEmail(v){return v.trim().toLowerCase()}\n",
      'src/phone.js', "export function normalizePhone(v){return v.replace(/\\D/gu,'')}\n",
    ],
    H18: ['src/serializer.js', "export function serialize(value){return JSON.stringify(value,Object.keys(value).sort())}\nexport function deserialize(value){return JSON.parse(value)}\n"],
  };
  const evidence = {
    H14: [
      { type: 'agent-dispatch', succeeded: true, index: 0 },
      { type: 'handoff', goal: 'parser', writeScope: ['src/parser.js'], head: 'abc123', dependencyStatus: 'ready', verificationStatus: 'pending', index: 1 },
      { type: 'verification', succeeded: true, index: 2 },
    ],
    H15: [
      { type: 'agent-dispatch', succeeded: true, index: 0 },
      { type: 'agent-complete', succeeded: false, index: 1 },
      { type: 'change', index: 2 },
      { type: 'verification', succeeded: true, index: 3 },
    ],
    H17: [
      { type: 'agent-dispatch', succeeded: true, index: 0 },
      { type: 'ownership', owner: 'email', path: 'src/email.js', disjoint: true, index: 1 },
      { type: 'ownership', owner: 'phone', path: 'src/phone.js', disjoint: true, index: 2 },
      { type: 'verification', succeeded: true, index: 3 },
    ],
    H18: [
      { type: 'agent-dispatch', succeeded: true, index: 0 },
      { type: 'agent-conflict', path: 'src/serializer.js', resolution: 'serialized', index: 1 },
      { type: 'agent-dispatch', succeeded: true, index: 2 },
      { type: 'verification', succeeded: true, index: 3 },
    ],
  };
  for (const scenario of selected) {
    const fixture = await manager.prepare({ scenario });
    try {
      const entries = implementations[scenario.id];
      for (let index = 0; index < entries.length; index += 2) await writeFile(path.join(fixture.agent.workspace, entries[index]), entries[index + 1], 'utf8');
      const result = await verifier.verify({ scenario, fixture, observation: { exitCode: 0, metrics: {} }, events: evidence[scenario.id] });
      assert.equal(result.status, 'passed', scenario.id);
      if (scenario.id === 'H18') {
        const bad = await verifier.verify({ scenario, fixture, observation: { exitCode: 0, metrics: {} }, events: [evidence.H18[0], evidence.H18[2], evidence.H18[1], evidence.H18[3]] });
        assert.equal(bad.checks.find((check) => check.id === 'H18-C3').status, 'unverified');
      }
    } finally {
      await manager.cleanup({ fixture });
    }
  }
});

test('Internal and External results validate against the same v3 result schema', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/harness-eval-result.schema.json'));
  const result = buildResultV3({
    scenario: { id: 'H04', title: 'Verification skipped', version: '1.0.0' },
    attempts: [{ id: 'attempt-1', status: 'passed' }],
    checks: [{ id: 'H04-C1', status: 'passed', category: 'outcome', severity: 'critical' }],
    fingerprint: { measurement: { model: 'test' }, harness: { rules: 'test' } },
    generatedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.deepEqual(validateJsonAgainstSchema(result, schema, 'result'), []);
});
