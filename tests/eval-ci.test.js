import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';
import { runEvaluationCheck } from '../runtime/hooks/lib/context.mjs';

const rootDir = path.resolve('.');

test('CI blocks offline eval drift and scheduled workflow runs advisory online canaries', async () => {
  const [ci, online] = await Promise.all([
    readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(rootDir, '.github/workflows/evals.yml'), 'utf8'),
  ]);
  assert.match(ci, /pnpm eval:check/u);
  assert.match(ci, /pnpm eval:offline/u);
  assert.match(ci, /windows-latest/u);
  assert.match(ci, /ubuntu-latest/u);
  assert.match(ci, /pnpm test:integration/u);
  assert.match(ci, /pnpm runtime:audit/u);
  assert.match(online, /schedule:/u);
  assert.match(online, /workflow_dispatch:/u);
  assert.match(online, /pnpm eval:online/u);
  assert.match(online, /retention-days:\s*30/u);
  assert.match(online, /pnpm eval:health/u);
  assert.match(online, /vars\.COGNIS_EVAL_ENFORCE/u);
  assert.doesNotMatch(online, /LOOPENGINE_EVAL_ENFORCE/u);
  assert.doesNotMatch(online, /pull_request:/u);
});

test('GitHub Actions are commit-pinned and receive automated update PRs', async () => {
  const [ci, online, dependabot] = await Promise.all([
    readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(rootDir, '.github/workflows/evals.yml'), 'utf8'),
    readFile(path.join(rootDir, '.github/dependabot.yml'), 'utf8'),
  ]);
  for (const workflow of [ci, online]) {
    assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/u);
    assert.match(workflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/u);
    assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/u);
    assert.match(workflow, /pnpm\/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa/u);
  }
  assert.match(online, /actions\/upload-artifact@[a-f0-9]{40}/u);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u);
  assert.match(dependabot, /package-ecosystem:\s*"npm"/u);
  assert.match(dependabot, /interval:\s*"weekly"/u);
});

test('online canary suite contains critical product scenarios', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/cognis-online-canary.json'));
  assert.equal(suite.cases.every((item) => item.risk === 'critical'), true);
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  for (const fragment of ['global', 'existing', '--project', 'eval-driven-development', 'Goal Brief', 'secret']) {
    assert.match(scenarios, new RegExp(fragment, 'iu'));
  }
});

test('offline routing eval distinguishes direct execution, product ambiguity, and debugging', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/cognis-core.json'));
  const scenarios = suite.cases.filter((item) => item.capability === 'skill-routing')
    .map((item) => item.input.scenario).join('\n');
  assert.match(scenarios, /decision-complete local task proceeds without clarification/iu);
  assert.match(scenarios, /product decision changes user-visible behavior/iu);
  assert.match(scenarios, /deterministic bug with a reproduction/iu);
});

test('offline install lifecycle eval covers Cognis legacy upgrade and red-zone confirmation', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/cognis-core.json'));
  const lifecycle = suite.cases.find((item) => item.id === 'EVAL-INSTALL-004');
  assert.match(lifecycle.input.scenario, /Cognis.*install --upgrade.*--write.*--confirm-red-zone/iu);
  assert.doesNotMatch(JSON.stringify(lifecycle), /Legacy apply|legacy-install-state/u);
  assert.equal(lifecycle.input.replay.artifacts.includes('cognis-upgrade-state.json'), true);
});

test('hook evaluation check executes configured command without a shell', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-hook-eval-'));
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
