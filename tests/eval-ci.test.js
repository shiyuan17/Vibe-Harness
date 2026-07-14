import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';
import { evaluateGovernanceEvalChanges } from '../scripts/eval-change-check.js';
import { runEvaluationCheck } from '../runtime/hooks/lib/context.mjs';

const rootDir = path.resolve('.');

test('CI blocks offline eval drift and scheduled workflow runs advisory online canaries', async () => {
  const [ci, online] = await Promise.all([
    readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(rootDir, '.github/workflows/evals.yml'), 'utf8'),
  ]);
  assert.match(ci, /pnpm eval:check/u);
  assert.match(ci, /pnpm eval:offline/u);
  assert.match(ci, /pnpm eval:changes/u);
  assert.match(online, /schedule:/u);
  assert.match(online, /workflow_dispatch:/u);
  assert.match(online, /pnpm eval:online/u);
  assert.match(online, /retention-days:\s*30/u);
  assert.doesNotMatch(online, /pull_request:/u);
});

test('governance diffs require a newly added Eval-ID while unrelated diffs do not', () => {
  assert.equal(evaluateGovernanceEvalChanges({
    addedEvalCases: [],
    changedFiles: ['rules/agent-skill-routing.md'],
    coverageKeys: ['capability:skill-routing'],
  }).ok, false);
  assert.equal(evaluateGovernanceEvalChanges({
    addedEvalCases: [{ id: 'EVAL-ROUTE-999', suite: 'evals/suites/core.json' }],
    changedFiles: ['rules/agent-skill-routing.md', 'evals/suites/core.json'],
    coverageKeys: ['capability:skill-routing'],
  }).ok, true);
  assert.equal(evaluateGovernanceEvalChanges({
    addedEvalCases: [],
    changedFiles: ['docs/evals.md'],
  }).ok, true);
});

test('online canary suite contains exactly six critical governance scenarios', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/loopengine-online-canary.json'));
  assert.equal(suite.cases.length, 6);
  assert.equal(suite.cases.every((item) => item.risk === 'critical'), true);
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  for (const fragment of ['global', 'existing', '--project', 'evidence', 'eval-driven-development', 'secret']) {
    assert.match(scenarios, new RegExp(fragment, 'iu'));
  }
});

test('hook evaluation check executes configured command without a shell', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-hook-eval-'));
  try {
    await writeFile(path.join(target, 'pass.mjs'), 'process.exitCode = 0;\n', 'utf8');
    await writeFile(path.join(target, 'fail.mjs'), 'process.exitCode = 7;\n', 'utf8');
    assert.deepEqual(await runEvaluationCheck(target, null), { ok: true, skipped: true });
    assert.deepEqual(await runEvaluationCheck(target, 'node pass.mjs'), { ok: true });
    assert.deepEqual(await runEvaluationCheck(target, 'node fail.mjs'), { ok: false });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('EDD documentation distinguishes baseline from reference and documents calibration gates', async () => {
  const [docs, architecture, readme, readmeZh] = await Promise.all([
    readFile(path.join(rootDir, 'docs/evals.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/architecture.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  for (const content of [docs, architecture, readme, readmeZh]) assert.match(content, /reference/u);
  assert.match(docs, /20/u);
  assert.match(docs, /3\/3/u);
  assert.match(docs, /0\.90/u);
  assert.match(docs, /0\.05/u);
  assert.match(docs, /degraded/u);
  assert.match(docs, /baseline/u);
});
