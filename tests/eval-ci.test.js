import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '..');

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
  assert.match(online, /environment:\s*Production/u);
  assert.match(online, /pnpm eval:online/u);
  assert.match(online, /retention-days:\s*30/u);
  assert.match(online, /pnpm eval:health/u);
  assert.match(online, /vars\.VIBE_HARNESS_EVAL_ENFORCE/u);
  assert.match(online, /vars\.OPENAI_BASE_URL/u);
  assert.match(online, /vars\.VIBE_HARNESS_EVAL_PROVIDER_NAME/u);
  assert.match(online, /vars\.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API/u);
  assert.match(online, /secrets\.OPENAI_API_KEY/u);
  assert.match(online, /VIBE_HARNESS_EVAL_RUNTIME_SOURCE:\s*env/u);
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
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  assert.equal(suite.cases.every((item) => item.risk === 'critical'), true);
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  for (const fragment of ['global', 'existing', '--project', 'eval-driven-development', 'Goal Brief', 'secret']) {
    assert.match(scenarios, new RegExp(fragment, 'iu'));
  }
});

test('offline routing eval covers browser, rtk, and ast-grep tool routing', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  const scenarios = suite.cases.filter((item) => item.category === 'skill-routing')
    .map((item) => item.input.scenario).join('\n');
  assert.match(scenarios, /Chrome DevTools MCP/iu);
  assert.match(scenarios, /RTK/iu);
  assert.match(scenarios, /ast-grep/iu);
});

test('offline install lifecycle eval covers Vibe-Harness legacy upgrade and red-zone confirmation', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  const lifecycle = suite.cases.find((item) => item.id === 'EVAL-INSTALL-004');
  assert.match(lifecycle.input.scenario, /Vibe-Harness.*install --upgrade.*--write.*--confirm-red-zone/iu);
  assert.doesNotMatch(JSON.stringify(lifecycle), /Legacy apply|legacy-install-state/u);
  assert.equal(lifecycle.input.replay.artifacts.includes('vibe-harness-upgrade-state.json'), true);
});

test('EDD documentation documents reference baselines and offline/online lifecycle', async () => {
  const docs = await readFile(path.join(rootDir, 'docs/evals.md'), 'utf8');
  assert.match(docs, /reference/u);
  assert.match(docs, /offline/u);
  assert.match(docs, /online/u);
  assert.match(docs, /suite/u);
  assert.match(docs, /eval check/u);
});
