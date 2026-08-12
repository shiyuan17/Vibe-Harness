import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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
  assert.match(ci, /pnpm eval:replay/u);
  assert.match(ci, /windows-latest/u);
  assert.match(ci, /ubuntu-latest/u);
  assert.match(ci, /pnpm test:integration/u);
  assert.match(ci, /pnpm runtime:audit/u);
  assert.match(ci, /pnpm pack:contract/u);
  assert.match(ci, /supply-chain:/u);
  assert.match(ci, /risk-evidence:/u);
  assert.match(ci, /merge-gate:/u);
  assert.match(ci, /needs:\s*\[product, supply-chain, risk-evidence\]/u);
  assert.match(online, /schedule:/u);
  assert.match(online, /workflow_dispatch:/u);
  assert.match(online, /environment:\s*Production/u);
  assert.match(online, /pnpm eval:online/u);
  assert.match(online, /retention-days:\s*(?:3[0-9]|[4-9][0-9]|[1-9][0-9]{2,})/u);
  assert.match(online, /--limit\s+(?:1[4-9]|[2-9][0-9])/u);
  assert.match(online, /pnpm eval:compare/u);
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

test('GitHub Actions are least-privilege, commit-pinned, and receive automated updates', async () => {
  const workflowDir = path.join(rootDir, '.github/workflows');
  const workflowNames = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/u.test(name));
  const workflows = await Promise.all(workflowNames.map(async (name) => ({
    content: await readFile(path.join(workflowDir, name), 'utf8'),
    name,
  })));
  for (const workflow of workflows) {
    assert.match(workflow.content, /^permissions:/mu, workflow.name + ' must declare permissions');
    assert.doesNotMatch(workflow.content, /pull_request_target:/u, workflow.name + ' must not use pull_request_target');
    const actionReferences = [...workflow.content.matchAll(/uses:\s*([^\s#]+)/gu)].map((match) => match[1]);
    for (const reference of actionReferences) {
      assert.match(reference, /@[a-f0-9]{40}$/u, workflow.name + ' contains an unpinned action: ' + reference);
    }
  }
  const release = workflows.find((workflow) => workflow.name === 'release-please.yml').content;
  assert.match(release, /release-verify:/u);
  assert.match(release, /pnpm pack --pack-destination/u);
  assert.match(release, /attest-build-provenance@/u);
  assert.match(release, /release-evidence\.json/u);
  assert.match(release, /secrets\.RELEASE_PLEASE_TOKEN/u);
  assert.doesNotMatch(release, /npm publish|pnpm publish/u);
  assert.match(release, /release-please:\s*[\s\S]*permissions:\s*[\s\S]*contents:\s*write[\s\S]*pull-requests:\s*write/u);

  const dependabot = await readFile(path.join(rootDir, '.github/dependabot.yml'), 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u);
  assert.match(dependabot, /package-ecosystem:\s*"npm"/u);
  assert.match(dependabot, /interval:\s*"weekly"/u);
  const runtimeDir = path.join(rootDir, 'runtime/tools');
  const runtimeNames = await readdir(runtimeDir);
  for (const name of runtimeNames) {
    try {
      await readFile(path.join(runtimeDir, name, 'package-lock.json'), 'utf8');
      assert.match(dependabot, new RegExp('/runtime/tools/' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('online canary suite contains critical product scenarios', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  assert.equal(suite.cases.every((item) => item.risk === 'critical'), true);
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  for (const fragment of ['global', 'existing', '--project', 'eval-driven-development', 'Goal Brief', 'secret']) {
    assert.match(scenarios, new RegExp(fragment, 'iu'));
  }
  const demands = suite.cases.map((item) => item.reporting?.workflowDemand).filter(Boolean);
  assert.deepEqual(demands.map((item) => item.expectedOwner.kind).sort(), ['builtin', 'skill', 'skill']);
});

test('offline routing eval covers browser, rtk, and ast-grep tool routing', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  const scenarios = suite.cases.filter((item) => item.category === 'skill-routing')
    .map((item) => item.input.scenario).join('\n');
  assert.match(scenarios, /Chrome DevTools MCP/iu);
  assert.match(scenarios, /RTK/iu);
  assert.match(scenarios, /ast-grep/iu);
});

test('dedicated tool routing eval covers codebase memory, ast-grep, rg, and RTK boundaries', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-tool-routing.json'));
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  assert.match(scenarios, /cross-file callers/iu);
  assert.match(scenarios, /local AST pattern/iu);
  assert.match(scenarios, /plain-text matching/iu);
  assert.match(scenarios, /RTK.*ast-grep.*MCP runtime.*raw-evidence/iu);
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
