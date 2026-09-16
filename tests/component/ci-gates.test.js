import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

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

// Every gate the workflow exports, plus the advisory flags the merge-gate step
// computes from the change plan.
const PASSING_GATE_ENV = {
  BRANCH_POLICY_RESULT: 'success',
  CHANGE_PLAN_RESULT: 'success',
  FAST_GATE_RESULT: 'success',
  FULL_GATE_RESULT: 'skipped',
  HIGH_RISK_APPROVAL_RESULT: 'success',
  HIGH_RISK_REVIEW_RESULT: 'success',
  INTEGRATION_GATE_RESULT: 'skipped',
  PRODUCT_RESULT: 'success',
  REQUIRED_FULL_GATE_RESULT: 'false',
  REQUIRED_INTEGRATION_GATE_RESULT: 'false',
  RISK_EVIDENCE_RESULT: 'success',
  SMOKE_GATE_RESULT: 'skipped',
  REQUIRED_SMOKE_GATE_RESULT: 'false',
  SUPPLY_CHAIN_RESULT: 'skipped',
  REQUIRED_SUPPLY_CHAIN_RESULT: 'false',
};

test('merge-gate passes when every exported gate succeeds or is not required', async () => {
  const { code, report } = await runScript(MERGE_GATE, { env: PASSING_GATE_ENV });
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((check) => check.name).sort(),
    Object.keys(PASSING_GATE_ENV).filter((name) => !name.startsWith('REQUIRED_')).sort(),
  );
});

test('merge-gate treats a skipped advisory gate as a pass and a skipped required gate as a failure', async () => {
  const advisory = await runScript(MERGE_GATE, { env: { ...PASSING_GATE_ENV, BRANCH_POLICY_RESULT: 'skipped', REQUIRED_BRANCH_POLICY_RESULT: 'false' } });
  assert.equal(advisory.code, 0);
  const required = await runScript(MERGE_GATE, { env: { ...PASSING_GATE_ENV, BRANCH_POLICY_RESULT: 'skipped', REQUIRED_BRANCH_POLICY_RESULT: 'true' } });
  assert.equal(required.code, 1);
  assert.equal(required.report.ok, false);
});

test('merge-gate ignores gate names that no workflow job exports', async () => {
  const { code, report } = await runScript(MERGE_GATE, {
    env: { ...PASSING_GATE_ENV, DEVELOP_GATE_RESULT: 'failure', MAIN_RELEASE_GATE_RESULT: 'failure' },
  });
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.checks.some((check) => check.name.startsWith('DEVELOP_GATE') || check.name.startsWith('MAIN_RELEASE_GATE')), false);
});

test('merge-gate fails a real gate failure', async () => {
  const { code, report } = await runScript(MERGE_GATE, { env: { ...PASSING_GATE_ENV, PRODUCT_RESULT: 'failure' } });
  assert.equal(code, 1);
  assert.equal(report.ok, false);
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
