import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '..');

// Parity bridge between the Chinese split-judgment rule in
// rules/governance-core.md and the English EVAL-SPLIT fixture texts in the
// online canary suite (audit P2-6). Rule-side wording locks stay owned by
// tests/execution-simplification.test.js; this file locks only the load-bearing
// threshold parity plus fixture-internal and scenario-verdict consistency.
const THRESHOLD_PAIRS = [
  { rule: /0–1 项直接执行计划/u, fixture: /0-1 signals: execute the plan directly/u },
  { rule: /2–3 项拆分为实施任务/u, fixture: /2-3 signals: split into implementation tasks/u },
  { rule: /4 项及以上必须拆分并显式声明任务依赖/u, fixture: /4 or more: must split and declare task dependencies/u },
];

// Fixture-internal concept integrity: each hard trigger and soft signal the
// fixture paraphrases must keep its English anchor (eval asset lock, not a
// rule wording lock).
const FIXTURE_CONCEPT_ANCHORS = [
  /public contract, schema, or data model change with migration or compatibility impact/u,
  /mixing refactor and behavior change/u,
  /exceed one context/u,
  /multiple independent modules/u,
  /ordering dependencies/u,
  /parallelizable work units/u,
  /independently acceptable stages/u,
  /multiple test layers/u,
];

// Decision table mirrored from the rule thresholds: any hard trigger forces a
// split regardless of soft signals; otherwise 0-1 soft signals execute the
// plan directly and 4 or more must split with declared dependencies.
function expectedVerdict({ hardTrigger, softSignals }) {
  if (hardTrigger) return 'SPLIT_HARD_TRIGGER';
  if (softSignals <= 1) return 'DIRECT_EXECUTE';
  if (softSignals >= 4) return 'SPLIT_WITH_DEPENDENCIES';
  return 'SPLIT';
}

// Per-case parity spec: the scenario must actually declare the signals that
// justify its expected verdict under the decision table above.
const SPLIT_CASE_SPECS = {
  'EVAL-SPLIT-001': {
    hardTrigger: false,
    softSignals: 0,
    scenarioKeywords: [
      'no contract or schema change',
      'no migration',
      'no refactor mixed with behavior change',
      'one module only',
      'no parallelizable units',
      'a single acceptance stage',
      'one layer of focused tests',
    ],
  },
  'EVAL-SPLIT-002': {
    hardTrigger: true,
    softSignals: 0,
    scenarioKeywords: ['public API schema', 'data migration'],
  },
  'EVAL-SPLIT-003': {
    hardTrigger: false,
    softSignals: 5,
    scenarioKeywords: [
      'three independent modules',
      'ordering dependencies',
      'worked in parallel',
      'acceptable stages',
      'unit plus integration verification',
    ],
  },
};

test('EVAL-SPLIT fixture keeps threshold parity with the governance-core rule source', async () => {
  const [rule, suite] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json')),
  ]);
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-SPLIT-'));
  assert.equal(cases.length, 3);
  const fixtureText = cases[0].input.fixture.files.find((file) => file.path === 'AGENTS.md').content;
  for (const anchor of FIXTURE_CONCEPT_ANCHORS) {
    assert.match(fixtureText, anchor, 'fixture concept anchor drifted: ' + anchor);
  }
  for (const pair of THRESHOLD_PAIRS) {
    assert.match(rule, pair.rule, 'rule threshold drifted: ' + pair.rule);
    assert.match(fixtureText, pair.fixture, 'fixture threshold drifted: ' + pair.fixture);
  }
});

test('EVAL-SPLIT expected verdicts match the rule decision table for the declared signals', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-SPLIT-'));
  for (const item of cases) {
    const spec = SPLIT_CASE_SPECS[item.id];
    assert.ok(spec, 'EVAL-SPLIT case without a parity spec: ' + item.id);
    for (const keyword of spec.scenarioKeywords) {
      assert.match(item.input.scenario, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        item.id + ' scenario no longer declares: ' + keyword);
    }
    const expected = expectedVerdict(spec);
    const required = item.oracle?.requiredOutputFragments ?? [];
    const requiredValues = required.map((fragment) => fragment.value);
    assert.ok(requiredValues.includes(expected),
      item.id + ' expects ' + expected + ' from the decision table but requires: ' + JSON.stringify(requiredValues));
  }
});
