import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { GATE_SCOPES } from '../../scripts/lib/merge-gate-scopes.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const MERGE_GATE = path.join(repositoryRoot, 'scripts', 'merge-gate.js');
const PR_APPROVAL = path.join(repositoryRoot, 'scripts', 'check-pull-request-approval.js');

async function runScript(scriptPath, { env = {}, ...options } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], { env: { ...process.env, ...env }, windowsHide: true, ...options });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, report: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

// Each merge-gate invocation declares its scope; the scope lists are asserted
// against the workflow env maps below.
const AGGREGATE_GATE_ENV = {
  MERGE_GATE_SCOPE: 'aggregate',
  BRANCH_POLICY_RESULT: 'success',
  CHANGE_PLAN_RESULT: 'success',
  HIGH_RISK_APPROVAL_RESULT: 'success',
  HIGH_RISK_REVIEW_RESULT: 'success',
  PRODUCT_RESULT: 'success',
  RISK_EVIDENCE_RESULT: 'success',
  SECURITY_RESULT: 'success',
  SUPPLY_CHAIN_RESULT: 'skipped',
  REQUIRED_SUPPLY_CHAIN_RESULT: 'false',
};
const PRODUCT_GATE_ENV = {
  MERGE_GATE_SCOPE: 'product',
  CHANGE_PLAN_RESULT: 'success',
  FAST_GATE_RESULT: 'success',
  FULL_GATE_RESULT: 'skipped',
  REQUIRED_FULL_GATE_RESULT: 'false',
  INTEGRATION_GATE_RESULT: 'skipped',
  REQUIRED_INTEGRATION_GATE_RESULT: 'false',
  SMOKE_GATE_RESULT: 'skipped',
  REQUIRED_SMOKE_GATE_RESULT: 'false',
};

test('merge-gate passes when every exported gate in its scope succeeds or is not required', async () => {
  for (const env of [AGGREGATE_GATE_ENV, PRODUCT_GATE_ENV]) {
    const { code, report } = await runScript(MERGE_GATE, { env });
    assert.equal(code, 0, env.MERGE_GATE_SCOPE);
    assert.equal(report.ok, true, env.MERGE_GATE_SCOPE);
    assert.deepEqual(report.drift, [], env.MERGE_GATE_SCOPE);
    assert.deepEqual(
      report.checks.map((check) => check.name).sort(),
      GATE_SCOPES[env.MERGE_GATE_SCOPE].slice().sort(),
    );
  }
});

test('merge-gate treats a skipped advisory gate as a pass and a skipped required gate as a failure', async () => {
  const advisory = await runScript(MERGE_GATE, { env: { ...AGGREGATE_GATE_ENV, BRANCH_POLICY_RESULT: 'skipped', REQUIRED_BRANCH_POLICY_RESULT: 'false' } });
  assert.equal(advisory.code, 0);
  const required = await runScript(MERGE_GATE, { env: { ...AGGREGATE_GATE_ENV, BRANCH_POLICY_RESULT: 'skipped', REQUIRED_BRANCH_POLICY_RESULT: 'true' } });
  assert.equal(required.code, 1);
  assert.equal(required.report.ok, false);
});

test('merge-gate fails closed when a scoped gate result is not exported', async () => {
  for (const name of Object.keys(AGGREGATE_GATE_ENV).filter((key) => key.endsWith('_RESULT') && !key.startsWith('REQUIRED_'))) {
    const env = { ...AGGREGATE_GATE_ENV };
    delete env[name];
    delete env[`REQUIRED_${name}`];
    const { code, report } = await runScript(MERGE_GATE, { env });
    assert.equal(code, 1, `${name} missing must fail the gate`);
    assert.equal(report.ok, false, `${name} missing must fail the gate`);
    assert.equal(
      report.drift.some((item) => item.code === 'MERGE_GATE_EXPORT_MISSING' && item.name === name),
      true,
    );
  }
});

test('merge-gate reports an unrecognized or unexpected gate wiring instead of ignoring it', async () => {
  const unexpected = await runScript(MERGE_GATE, {
    env: { ...AGGREGATE_GATE_ENV, DEVELOP_GATE_RESULT: 'failure', MAIN_RELEASE_GATE_RESULT: 'failure' },
  });
  assert.equal(unexpected.code, 1);
  assert.equal(unexpected.report.ok, false);
  assert.deepEqual(
    unexpected.report.drift.map((item) => item.code),
    ['MERGE_GATE_EXPORT_UNEXPECTED', 'MERGE_GATE_EXPORT_UNEXPECTED'],
  );
  const unknownScope = await runScript(MERGE_GATE, { env: { ...AGGREGATE_GATE_ENV, MERGE_GATE_SCOPE: 'release' } });
  assert.equal(unknownScope.code, 1);
  assert.deepEqual(unknownScope.report.drift.map((item) => item.code), ['MERGE_GATE_SCOPE_UNKNOWN']);
});

test('merge-gate fails a real gate failure', async () => {
  for (const name of Object.keys(AGGREGATE_GATE_ENV).filter((key) => key.endsWith('_RESULT') && !key.startsWith('REQUIRED_'))) {
    for (const status of ['failure', 'cancelled']) {
      const { code, report } = await runScript(MERGE_GATE, { env: { ...AGGREGATE_GATE_ENV, [name]: status } });
      assert.equal(code, 1, `${name}=${status}`);
      assert.equal(report.ok, false, `${name}=${status}`);
    }
  }
});

// The gate lists above only mean something while they still mirror the workflow,
// so drift between ci.yml and merge-gate-scopes.js is itself a failing test.
async function mergeGateJobs() {
  const content = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = [];
  let current = null;
  let inEnv = false;
  for (const line of content.split(/\r?\n/u)) {
    const jobMatch = /^ {2}([\w-]+):\s*$/u.exec(line);
    if (jobMatch) {
      current = { env: {}, name: jobMatch[1], runsMergeGate: false };
      jobs.push(current);
      inEnv = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}env:\s*$/u.test(line)) {
      inEnv = true;
      continue;
    }
    if (/^ {4}\S/u.test(line)) inEnv = false;
    const envMatch = /^ {6}([A-Z_]+):/u.exec(line);
    if (inEnv && envMatch) current.env[envMatch[1]] = line.slice(envMatch[0].length).trim();
    if (/node scripts\/merge-gate\.js/u.test(line)) current.runsMergeGate = true;
  }
  return jobs.filter((job) => job.runsMergeGate);
}

test('every workflow merge-gate invocation matches its declared scope', async () => {
  const jobs = await mergeGateJobs();
  assert.equal(jobs.length, 2, 'expected the product and aggregate merge-gate invocations');
  const usedScopes = new Set();
  for (const job of jobs) {
    const scope = job.env.MERGE_GATE_SCOPE;
    assert.equal(typeof scope, 'string', `${job.name} must set MERGE_GATE_SCOPE`);
    assert.ok(GATE_SCOPES[scope], `${job.name} declares unknown scope ${scope}`);
    usedScopes.add(scope);
    const exported = Object.keys(job.env)
      .filter((name) => name.endsWith('_RESULT') && !name.startsWith('REQUIRED_'))
      .sort();
    assert.deepEqual(exported, GATE_SCOPES[scope].slice().sort(), `${job.name} env must match the ${scope} scope`);
  }
  assert.deepEqual([...usedScopes].sort(), Object.keys(GATE_SCOPES).sort());
});

async function runApprovalCheck({ event, env = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-pr-approval-'));
  const eventPath = path.join(root, 'event.json');
  await writeFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
  try {
    return await runScript(PR_APPROVAL, {
      env: { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'invalid-token', ...env },
    });
  } finally {
    await removeTemporaryDirectory(root);
  }
}

test('high-risk approval is advisory in shadow mode and fails closed in required mode', async () => {
  const event = { pull_request: { number: 7, user: { login: 'author' } } };
  const shadow = await runApprovalCheck({ event });
  assert.equal(shadow.code, 0);
  assert.equal(shadow.report.ok, true);
  assert.equal(shadow.report.mode, 'shadow');

  const required = await runApprovalCheck({ env: { VIBE_HARNESS_PR_APPROVAL_MODE: 'required' }, event });
  assert.equal(required.code, 1);
  assert.equal(required.report.ok, false);
  assert.equal(required.report.mode, 'required');
});

test('high-risk approval reports a non-pull-request event instead of failing', async () => {
  const { code, report } = await runApprovalCheck({ event: { ref: 'refs/heads/main' } });
  assert.equal(code, 0);
  assert.equal(report.code, 'NOT_A_PULL_REQUEST');
});
