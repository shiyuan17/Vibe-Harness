import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildResultV3, createFixtureManager, createScenarioVerifier, materializeFixture } from '../../harness-evals/lib/index.js';
import { validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';
import { finalChangeValidationSummary, transcript } from '../../runtime/evals/codex-runner.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const scenariosDir = path.join(rootDir, 'harness-evals/scenarios');

const codexMessage = (text) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadScenarios() {
  const index = await readJson(path.join(scenariosDir, 'index.json'));
  return Promise.all(index.scenarios.map((entry) => readJson(path.join(scenariosDir, entry.file))));
}

const reworkSolutions = {
  H24: "export function report(rows){return {total:rows.reduce((a,b)=>a+b,0),count:rows.length}}\n",
  H25: "export function format(value,prefix=''){return prefix+String(value)}\n",
  H26: "export function range(start,end){return Array.from({length:Math.max(0,end-start+1)},(_,i)=>start+i)}\n",
  H27: "export function decode(value){const parsed=JSON.parse(value);return typeof parsed==='number'?parsed:parsed.amount}\n",
  H28: "export function score(value){const n=Number(value);return Number.isNaN(n)?0:n}\n",
  H29: "export function sum(a,b){return a+b}\n",
};

async function checkReworkControls(id) {
  const scenario = (await loadScenarios()).find((item) => item.id === id);
  const manager = createFixtureManager({ scenariosDir });
  const fixture = await manager.prepare({ scenario });
  const verifier = createScenarioVerifier({ semanticJudge: () => ({ passed: true }) });
  const expected = scenario.checks.find((check) => check.type === 'trace').expected;
  const lines = [];
  let sequence = 0;
  async function command(target) {
    const callId = `run-${++sequence}`;
    lines.push(JSON.stringify({ type: 'item.started', item: { id: callId, type: 'command_execution', command: `node ${target}` } }));
    let exitCode = 0;
    try {
      await execFileAsync(process.execPath, [target], { cwd: fixture.agent.workspace });
    } catch (error) {
      exitCode = error.code;
    }
    assert.ok(Number.isInteger(exitCode), 'infrastructure failure is not a valid red test');
    lines.push(JSON.stringify({ type: 'item.completed', item: {
      id: callId, type: 'command_execution', command: `node ${target}`, status: 'completed', exit_code: exitCode,
    } }));
    return exitCode;
  }
  const changed = () => lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } }));
  const context = () => ({ scenario, fixture, observation: { exitCode: 0, metrics: {} }, events: transcript(lines.join('\n')).traceEvents });
  try {
    const broken = await verifier.verify(context());
    assert.equal(broken.checks.find((check) => check.id === `${id}-C1`).status, 'failed');
    if (expected.beforeChange) {
      assert.equal(await command(expected.beforeChange.target), expected.beforeChange.exitCode);
    }
    await writeFile(path.join(fixture.agent.workspace, scenario.task.allowedWritePaths[0]), reworkSolutions[id]);
    changed();
    for (const target of expected.finalChecks) assert.equal(await command(target), 0);
    const good = context();
    assert.equal((await verifier.verify(good)).status, 'passed');

    const noProcess = await verifier.verify({ ...good, events: [] });
    assert.equal(noProcess.checks.find((check) => check.id === `${id}-C3`).status, 'unverified');
    const forged = await verifier.verify({
      ...good, events: good.events.map((event) => ({ ...event, evidenceSource: 'agent-claim' })),
      observation: { exitCode: 0, metrics: { finalChangeValidation: { status: 'verified' } } },
    });
    assert.equal(forged.checks.find((check) => check.id === `${id}-C3`).status, 'unverified');
    changed();
    const stale = await verifier.verify(context());
    assert.equal(stale.checks.find((check) => check.id === `${id}-C3`).status, 'unverified');
    if (expected.beforeChange) {
      const noEarlyFeedback = await verifier.verify({
        ...good, events: good.events.slice(good.events.findIndex((event) => event.type === 'change')),
      });
      assert.equal(noEarlyFeedback.checks.find((check) => check.id === `${id}-C3`).code, 'REWORK_EARLY_FEEDBACK_MISSING');
    }
    if (id === 'H24') {
      await writeFile(path.join(fixture.agent.workspace, scenario.task.allowedWritePaths[0]),
        "export function report(rows){return {total:rows.reduce((a,b)=>a+b,0)}}\n");
      assert.equal(await command('test/check.test.mjs'), 0);
      const omitted = await verifier.verify(context());
      assert.equal(omitted.checks.find((check) => check.id === 'H24-C1').status, 'failed');
    }
    if (id === 'H29') {
      const unnecessary = await verifier.verify({ ...good, events: [...good.events,
        { type: 'tool-call', evidenceSource: 'tool-call', name: 'request_user_input', arguments: {} }] });
      assert.equal(unnecessary.checks.find((check) => check.id === 'H29-C3').code, 'REWORK_UNNECESSARY_PROCESS');
      const extraRuns = (target) => [
        { type: 'tool-call', evidenceSource: 'tool-call', callId: 'extra-check', arguments: { command: `node ${target}` } },
        { type: 'tool-result', evidenceSource: 'tool-result', callId: 'extra-check', exitCode: 0 },
      ];
      for (const target of ['test/check.test.mjs', 'test/deep.test.mjs']) {
        const excessive = await verifier.verify({ ...good, events: [...good.events, ...extraRuns(target)] });
        assert.equal(excessive.checks.find((check) => check.id === 'H29-C3').code, 'REWORK_EXCESSIVE_VERIFICATION');
      }
    }
    if (id === 'H27') {
      lines.length = 0;
      changed();
      assert.equal(await command('test/probe.test.mjs'), 0);
      assert.equal(await command('test/acceptance.test.mjs'), 0);
      assert.equal((await verifier.verify(context())).status, 'passed', 'first-slice feedback is a legitimate alternative');
    }
  } finally {
    await manager.cleanup({ fixture });
  }
}

test('H24 遗漏要求不能被部分检查通过掩盖', () => checkReworkControls('H24'));
test('H25 新行为与旧调用方均需当前执行证据', () => checkReworkControls('H25'));
test('H26 普通修复必须观察有效红灯后再改实现', () => checkReworkControls('H26'));
test('H27 早期反馈必须早于扩大实现', () => checkReworkControls('H27'));
test('H28 重复失败先取得区分实验的工具证据', () => checkReworkControls('H28'));
test('H29 已知根因不新增不必要的提问和委派', () => checkReworkControls('H29'));

test('Internal Eval 目录 H01-H29 具备有效压力与 fixture 契约', async () => {
  const [scenarioSchema, fixtureSchema, scenarios] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/harness-eval-scenario.schema.json')),
    readJson(path.join(rootDir, 'schemas/harness-eval-fixture.schema.json')),
    loadScenarios(),
  ]);
  assert.deepEqual(scenarios.map((scenario) => scenario.id), Array.from({ length: 29 }, (_, index) => `H${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(scenarios.filter((scenario) => scenario.manualOnly).map((scenario) => scenario.id), ['H24', 'H25', 'H26', 'H27', 'H28', 'H29']);
  assert.ok(validateJsonAgainstSchema({ ...scenarios.at(-1), manualOnly: 'true' }, scenarioSchema, 'pilot').length > 0);
  assert.ok(validateJsonAgainstSchema({ ...scenarios.at(-1), id: 'H30' }, scenarioSchema, 'unsupported').length > 0);
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

test('H16 仅接受前驱完成后派发依赖并在子任务完成后验证的轨迹', async () => {
  const scenario = await readJson(path.join(scenariosDir, 'H16-multi-agent-dependency.json'));
  const manager = createFixtureManager({ scenariosDir });
  const fixture = await manager.prepare({ scenario });
  const verifier = createScenarioVerifier();
  const traceStatus = async (events) => {
    const report = await verifier.verify({ scenario, fixture, observation: { exitCode: 0, metrics: {} }, events });
    return report.checks.find((check) => check.id === 'H16-C3').status;
  };
  const ordered = [
    { type: 'agent-dispatch', unit: 'schema', succeeded: true },
    { type: 'agent-dispatch', unit: 'encoder', succeeded: true },
    { type: 'agent-complete', unit: 'schema', succeeded: true },
    { type: 'agent-dispatch', unit: 'decoder', succeeded: true },
    { type: 'agent-complete', unit: 'encoder', succeeded: true },
    { type: 'agent-complete', unit: 'decoder', succeeded: true },
    { type: 'verification', succeeded: true },
  ];
  try {
    assert.equal(await traceStatus(ordered), 'passed');
    assert.equal(await traceStatus([{ type: 'change' }, { type: 'verification', succeeded: true }]), 'unverified');
    assert.equal(await traceStatus([ordered[0], ordered[1], ordered[3], ordered[2], ...ordered.slice(4)]), 'unverified');
  } finally {
    await manager.cleanup({ fixture });
  }
});

test('H04 轨迹检查只接受工具支撑的最终验证证据', async () => {
  const full = await readJson(path.join(scenariosDir, 'H04-verification-skip.json'));
  const scenario = { ...full, checks: full.checks.filter((check) => check.type === 'trace') };
  const verifier = createScenarioVerifier();
  const statusOf = async (stdout) => {
    const parsed = transcript(stdout);
    const report = await verifier.verify({
      events: parsed.traceEvents,
      observation: { metrics: { finalChangeValidation: finalChangeValidationSummary(parsed.workflowEvents) } },
      scenario,
    });
    return { status: report.checks[0].status, toolCalls: parsed.toolCalls };
  };

  const claimed = await statusOf(codexMessage('[VIBE_HARNESS_EVENT:change:{"path":"src/slug.js"}]\n[VIBE_HARNESS_EVENT:verification:{"succeeded":true}]'));
  assert.equal(claimed.toolCalls, 0);
  assert.equal(claimed.status, 'unverified');

  const failedRun = await statusOf([
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'node --test', status: 'completed', exit_code: 1 } }),
    codexMessage('[VIBE_HARNESS_EVENT:verification:{"succeeded":true}]'),
  ].join('\n'));
  assert.equal(failedRun.status, 'unverified');

  const verified = await statusOf([
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'node --test', status: 'completed', exit_code: 0 } }),
  ].join('\n'));
  assert.equal(verified.status, 'passed');
});

test('H21-H23 require their reasoning evidence before accepting the repair trace', async () => {
  const scenarios = await loadScenarios();
  const selected = scenarios.filter((scenario) => ['H21', 'H22', 'H23'].includes(scenario.id));
  const manager = createFixtureManager({ scenariosDir });
  const verifier = createScenarioVerifier();
  const evidence = {
    H21: [
      { type: 'hypothesis', id: 'h1', statement: 'parsing is wrong', falsifier: 'numeric input still fails after isolated parse check' },
      { type: 'hypothesis', id: 'h2', statement: 'offset is wrong', falsifier: 'corrected offset does not change numeric result' },
      { type: 'experiment', hypothesisIds: ['h1', 'h2'], changedVariable: 'parse-only probe', result: 'parse succeeds; offset is causal' },
      { type: 'change', path: 'src/score.js' },
      { type: 'verification', succeeded: true },
    ],
    H22: [
      { type: 'unknown', id: 'u1', decisionImpact: 'whether consumers require stable serialized keys' },
      { type: 'experiment-proposed', unknownId: 'u1', cost: 'low', successCriteria: 'find a consumer comparing serialized records', stopCondition: 'stop after the first authoritative consumer is found' },
      { type: 'experiment-completed', unknownId: 'u1', outcome: 'consumer comparison found', decision: 'stable key order required' },
      { type: 'change', path: 'src/serializer.js' },
      { type: 'verification', succeeded: true },
    ],
    H23: [
      { type: 'state-model', states: ['draft', 'review', 'published', 'revision'], events: ['submit', 'approve', 'edit', 'reject'] },
      { type: 'invariant', name: 'published items never return directly to draft', check: 'published edit must enter revision' },
      { type: 'transition-check', from: 'published', event: 'edit', to: 'draft', valid: false },
      { type: 'change', path: 'src/workflow.js' },
      { type: 'verification', succeeded: true },
    ],
  };
  for (const scenario of selected) {
    const fixture = await manager.prepare({ scenario });
    try {
      const passed = await verifier.verify({
        scenario,
        fixture,
        observation: { exitCode: 0, metrics: {} },
        events: evidence[scenario.id],
      });
      assert.equal(passed.checks.find((check) => check.id === `${scenario.id}-C3`).status, 'passed');

      const missing = await verifier.verify({
        scenario,
        fixture,
        observation: { exitCode: 0, metrics: {} },
        events: evidence[scenario.id].filter((event) => event.type !== 'experiment' && event.type !== 'experiment-proposed' && event.type !== 'invariant'),
      });
      assert.equal(missing.checks.find((check) => check.id === `${scenario.id}-C3`).status, 'unverified');
    } finally {
      await manager.cleanup({ fixture });
    }
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
