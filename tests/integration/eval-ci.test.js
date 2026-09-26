import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson } from '../../scripts/lib/manifest.js';
import { createChangeEvidence } from '../../scripts/lib/review-audit.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

test('CI 阻断 offline eval 漂移且夜间 workflow 对 harness eval 失败置红', async () => {
  const [ci, online] = await Promise.all([
    readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(rootDir, '.github/workflows/evals.yml'), 'utf8'),
  ]);
  assert.match(ci, /pnpm eval:check/u);
  assert.match(ci, /pnpm eval:replay/u);
  assert.match(ci, /pnpm eval:harness check/u);
  assert.match(ci, /pnpm eval:harness plan --tier fast/u);
  assert.match(ci, /windows-latest/u);
  assert.match(ci, /ubuntu-latest/u);
  assert.match(ci, /include:\s*\n\s*- os: ubuntu-latest\s*\n\s*node-version: 22\.x\s*\n\s*- os: windows-latest\s*\n\s*node-version: 22\.x/u);
  assert.doesNotMatch(ci, /node-version:\s*\[/u);
  assert.match(ci, /pnpm test:integration/u);
  assert.match(ci, /pnpm runtime:audit/u);
  assert.match(ci, /pnpm pack:contract/u);
  assert.match(ci, /supply-chain:/u);
  assert.match(ci, /risk-evidence:/u);
  assert.match(ci, /merge-gate:/u);
  assert.match(ci, /needs:\s*\[change-plan, product, supply-chain, security, risk-evidence, branch-policy, independent-review, high-risk-approval\]/u);
  assert.match(ci, /docsOnly: \$\{\{ steps\.plan\.outputs\.docsOnly \}\}/u);
  assert.match(ci, /if: needs\.change-plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm lint:eslint/u);
  assert.match(ci, /if: needs\.change-plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm check:fast/u);
  assert.match(ci, /branch-policy:\n\s+name: branch policy\n\s+if: github\.event_name == 'pull_request'/u);
  assert.match(ci, /node scripts\/branch-policy\.js/u);
  assert.match(ci, /node scripts\/independent-review\.js/u);
  assert.match(ci, /node scripts\/check-pull-request-approval\.js/u);
  assert.match(ci, /BRANCH_POLICY_RESULT: \$\{\{ needs\.branch-policy\.result \}\}/u);
  assert.match(ci, /REQUIRED_BRANCH_POLICY_RESULT: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
  assert.match(ci, /HIGH_RISK_REVIEW_RESULT: \$\{\{ needs\.independent-review\.result \}\}/u);
  assert.match(ci, /HIGH_RISK_APPROVAL_RESULT: \$\{\{ needs\.high-risk-approval\.result \}\}/u);
  assert.match(online, /schedule:/u);
  assert.match(online, /workflow_dispatch:/u);
  assert.match(online, /environment:\s*Production/u);
  assert.match(online, /pnpm eval:online/u);
  assert.match(online, /pnpm eval:harness run --tier/u);
  assert.match(online, /Harness Eval tier/u);
  assert.match(online, /Gate on harness eval step outcome/u);
  assert.match(online, /HARNESS_EVAL_OUTCOME: \$\{\{ steps\.harness-eval\.outcome \}\}/u);
  assert.match(online, /"\$HARNESS_EVAL_OUTCOME" = "failure"[\s\S]*"\$HARNESS_EVAL_OUTCOME" = "cancelled"[\s\S]*exit 1/u);
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
  assert.match(release, /node scripts\/release-readiness\.js --sha "\$GITHUB_SHA" --require-clean --receipt release-artifacts\/release-readiness\.json/u);
  assert.match(release, /pnpm pack --pack-destination/u);
  assert.match(release, /id: plan\s*\n\s*env:\s*\n\s*BASE_SHA: \$\{\{ github\.event\.before \}\}\s*\n\s*run: pnpm verify:plan/u);
  assert.match(release, /if: steps\.plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm check\n/u);
  assert.match(release, /if: steps\.plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm eval:replay/u);
  assert.doesNotMatch(release, /docsOnly != 'true'\s*\n\s*run: pnpm docs:audit/u);
  assert.doesNotMatch(release, /docsOnly != 'true'\s*\n\s*run: pnpm runtime:audit/u);
  assert.doesNotMatch(release, /docsOnly != 'true'\s*\n\s*run: pnpm pack:contract/u);
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

test('CI runs pinned dependency and secret scanning with least privilege', async () => {
  const ci = await readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^ {2}security:$/mu);
  assert.match(ci, /actions\/dependency-review-action@[a-f0-9]{40}/u);
  assert.match(ci, /gitleaks\/gitleaks-action@[a-f0-9]{40}/u);
  assert.match(ci, /fail-on-severity:\s*high/u);
  assert.doesNotMatch(ci, /actions\/dependency-review-action@(?:v\d+|main|master)\b/u);
});

test('online canary suite contains critical product scenarios', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const criticalCount = suite.cases.filter((item) => item.risk === 'critical').length;
  assert.equal(suite.cases.every((item) => item.risk === 'critical' || item.risk === 'high'), true);
  assert.ok(criticalCount / suite.cases.length >= 0.8, 'critical cases must stay at least 80% of the canary suite');
  const scenarios = suite.cases.map((item) => item.input.scenario).join('\n');
  for (const fragment of ['global', 'existing', '--project', 'eval-driven-development', 'Goal Brief', 'secret']) {
    assert.match(scenarios, new RegExp(fragment, 'iu'));
  }
  const demands = suite.cases.map((item) => item.reporting?.workflowDemand).filter(Boolean);
  assert.deepEqual(demands.map((item) => item.expectedOwner.kind).sort(), ['builtin', 'builtin', 'skill', 'skill', 'skill', 'skill', 'skill']);
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

// The CI review job is a shadow observer unless the repository explicitly
// pins required mode: it must surface a v2 contract violation (a high-risk
// receipt without the second independent reviewer) in the step summary and the
// machine-readable report while leaving the merge decision to merge-gate.
test('CI 独立复审保持 shadow 观测并消费 v2 双复审契约', async () => {
  const ci = await readFile(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /VIBE_HARNESS_INDEPENDENT_REVIEW_MODE/u);
  assert.match(ci, /node scripts\/independent-review\.js/u);
  assert.match(ci, /HIGH_RISK_REVIEW_RESULT: \$\{\{ needs\.independent-review\.result \}\}/u);

  const fixture = await mkdtemp(path.join(os.tmpdir(), 'vibe-harness-independent-review-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: fixture });
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: fixture });
    await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: fixture });
    await mkdir(path.join(fixture, 'runtime'), { recursive: true });
    await writeFile(path.join(fixture, 'runtime', 'baseline.js'), 'export const baseline = 0;\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: fixture });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'base'], { cwd: fixture });
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture })).stdout.trim();
    // runtime/** is a high-risk path, so the receipt is mandatory here.
    await writeFile(path.join(fixture, 'runtime', 'baseline.js'), 'export const baseline = 1;\n', 'utf8');
    const change = await createChangeEvidence(fixture, base);
    assert.ok(change.changedPaths.includes('runtime/baseline.js'));

    const receipt = {
      schemaVersion: 2,
      id: 'review-1',
      createdAt: '2026-09-24T00:00:00.000Z',
      baseSha: change.baseSha,
      headSha: change.headSha,
      changeFingerprint: change.fingerprint,
      highRiskPaths: change.changedPaths,
      reviewer: { type: 'human', identity: 'reviewer', contextId: 'review-context' },
      implementer: { identity: 'implementer', contextId: 'implement-context' },
      readOnly: true,
      verification: { id: 'verify-1', finishedAt: '2026-09-24T00:00:00.000Z', headSha: change.headSha, stable: true, status: 'passed' },
      findings: [],
      decision: 'approved',
    };
    const body = ['## Independent Review Receipt', '', '```json', JSON.stringify(receipt, null, 2), '```', ''].join('\n');
    const eventPath = path.join(fixture, 'event.json');
    await writeFile(eventPath, `${JSON.stringify({ pull_request: { base: { sha: change.baseSha }, body } }, null, 2)}\n`, 'utf8');

    const shadow = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/independent-review.js')], {
      cwd: fixture,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: '' },
    });
    const shadowReport = JSON.parse(shadow.stdout);
    assert.equal(shadowReport.mode, 'shadow');
    assert.equal(shadowReport.ok, true, 'shadow mode must not block the merge');
    assert.equal(shadowReport.status, 'degraded');
    const evidence = shadowReport.evidence.map((item) => item.code);
    assert.match(evidence.join(','), /REVIEW_SECOND_REVIEW_MISSING|REVIEW_RECEIPT_SCHEMA/u);

    const required = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/independent-review.js')], {
      cwd: fixture,
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: '', VIBE_HARNESS_INDEPENDENT_REVIEW_MODE: 'required' },
    }).then((result) => ({ exitCode: 0, stdout: result.stdout }), (error) => ({ exitCode: 1, stdout: error.stdout }));
    assert.equal(required.exitCode, 1, 'required mode must block a v2 receipt without two reviewers');
    assert.equal(JSON.parse(required.stdout).status, 'degraded');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
