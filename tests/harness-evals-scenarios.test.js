import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildResultV3, createFixtureManager, createScenarioVerifier, materializeFixture } from '../harness-evals/lib/index.js';
import { validateJsonAgainstSchema } from '../scripts/lib/manifest.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
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
    assert.match(fixture.controller.hiddenChecks[0].args[0], /\/oracle\/check\.mjs$/u);
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
  } finally {
    await manager.cleanup({ fixture });
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
