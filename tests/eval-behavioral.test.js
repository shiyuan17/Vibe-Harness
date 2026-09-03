import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CONTROLS, runBehavioralEvaluation } from '../scripts/lib/eval-behavioral.js';

const rootDir = path.resolve(import.meta.dirname, '..');

const EXPECTED_MUTATIONS_PER_CONTROL = {
  'BEHAVIOR-RULE-001': 5,
  'BEHAVIOR-SKILL-001': 2,
  'BEHAVIOR-HOOK-001': 3,
  'BEHAVIOR-CONFIG-001': 3,
};

async function writeBehavioralFixture(root, overrides = new Map()) {
  const files = new Map(CONTROLS.map((control) => [control.relative, control.required.join('\n')]));
  for (const [relative, content] of overrides) files.set(relative, content);
  for (const [relative, content] of files) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, 'utf8');
  }
}

test('behavioral evaluation mutates every required fragment of every control', async () => {
  const report = await runBehavioralEvaluation(rootDir);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.proof, 'stub-behavioral');
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.length, 4);
  assert.equal(report.cases.every((item) => item.passed), true);
  const expectedTotal = Object.values(EXPECTED_MUTATIONS_PER_CONTROL).reduce((sum, count) => sum + count, 0);
  assert.equal(report.mutations.length, expectedTotal);
  assert.equal(new Set(report.mutations.map((item) => item.id)).size, report.mutations.length);
  assert.equal(report.mutations.every((item) => typeof item.fragment === 'string' && item.fragment.length > 0), true);
  for (const control of CONTROLS) {
    const mutations = report.mutations.filter((item) => item.id.startsWith(`${control.id}-MUTATION-`));
    assert.equal(mutations.length, EXPECTED_MUTATIONS_PER_CONTROL[control.id], `${control.id} mutation count`);
    assert.equal(mutations.every((item) => item.detected), true, `${control.id} mutations detected`);
  }
});

test('fixture containing every fragment passes with one mutation per fragment', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'eval-behavioral-'));
  try {
    await writeBehavioralFixture(sandbox);
    const report = await runBehavioralEvaluation(sandbox);
    assert.equal(report.status, 'passed');
    assert.equal(report.mutations.length, CONTROLS.reduce((sum, control) => sum + control.required.length, 0));
    assert.equal(report.mutations.every((item) => item.detected), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('missing non-first fragment fails the case and voids that control mutation proof', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'eval-behavioral-'));
  try {
    const ruleControl = CONTROLS.find((control) => control.id === 'BEHAVIOR-RULE-001');
    await writeBehavioralFixture(sandbox, new Map([[ruleControl.relative, ruleControl.required[0]]]));
    const report = await runBehavioralEvaluation(sandbox);
    assert.equal(report.status, 'failed');
    const ruleCase = report.cases.find((item) => item.id === 'BEHAVIOR-RULE-001');
    assert.equal(ruleCase.passed, false);
    assert.deepEqual(ruleCase.missing, ruleControl.required.slice(1));
    const ruleMutations = report.mutations.filter((item) => item.id.startsWith('BEHAVIOR-RULE-001-MUTATION-'));
    assert.equal(ruleMutations.length, ruleControl.required.length);
    assert.equal(ruleMutations.every((item) => item.detected), false);
    const otherMutations = report.mutations.filter((item) => !item.id.startsWith('BEHAVIOR-RULE-001-MUTATION-'));
    assert.equal(otherMutations.every((item) => item.detected), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
