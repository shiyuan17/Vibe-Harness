import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { runCommand } from '../../runtime/commands/run.mjs';
import { gitFingerprint } from '../../runtime/lib/git-fingerprint.mjs';
import { deliveryProfiles, completionReceipt, isReviewRequired, resolveDelivery, validateCompletion, validateDeliveryConfig, overrideWarnings } from '../../runtime/lib/delivery.mjs';
import { verificationAcceptance, verificationReview } from '../../runtime/lib/verification-plan-support.mjs';
import { processStartIdentity, releaseServiceTeardown, serviceEndpoint, serviceOwnership, serviceSocketDirectory, startIdentityToken, teardownServices, treeGone, windowsConfirmedMembers, windowsTreeProbeCommand } from '../../runtime/lib/services.mjs';

function git(project, ...args) {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
}
async function fixture() {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-delivery-'));
  const config = { validationCommands: { test: 'node --version' }, worktree: { baseRef: 'target', root: `${project}-trees` } };
  await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
  await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\n');
  await writeFile(path.join(project, 'example.txt'), 'base\n');
  git(project, 'init', '-q', '-b', 'target');
  git(project, 'config', 'user.name', 'Fixture');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'core.hooksPath', '.git/no-hooks');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'fixture');
  return { project, config };
}
async function command(project, ...args) {
  return runCommand([...args, '--project', project, '--json']);
}
async function remove(project) {
  // A service tree retired through `taskkill` releases its directory handle
  // asynchronously on Windows, so a removal that races the exit has to retry.
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  await rm(`${project}-trees`, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Declare one HTTP service in `project` and give it a `server.mjs` to run. */
async function declareService(project, config, script) {
  config.worktree.provision = { services: [{ id: 'web', command: 'node server.mjs', cwd: '.', healthcheck: 'http://127.0.0.1:${PORT}', stopOnTeardown: true }] };
  await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
  await writeFile(path.join(project, 'server.mjs'), script);
}

const servingScript = "import http from 'node:http'; http.createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n";

/** An endpoint that is syntactically valid but has nothing listening on it. */
function unreachableEndpoint() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vibe-harness-${randomUUID()}`
    : path.join(tmpdir(), `vibe-harness-${randomUUID()}.sock`);
}

/** Kill a detached fixture process tree that a test left running. */
function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * Write one service registration directly.
 *
 * The tests below need a registration whose supervisor is unreachable, which a
 * real start cannot produce: the entry names an endpoint nothing listens on.
 */
async function writeServiceRegistry(project, entry) {
  await mkdir(path.join(project, '.vibe-harness'), { recursive: true });
  await writeFile(path.join(project, '.vibe-harness', 'processes.json'), JSON.stringify({ schemaVersion: 1, processes: [entry] }));
}

/** A long-lived detached process a stale registration can point at. */
function spawnDetachedFixture() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

test('交付配置兼容旧项目并拒绝未知模式和不安全服务', () => {
  assert.equal(resolveDelivery({}).profile, 'legacy');
  assert.equal(resolveDelivery({}, 'managed-mr').merge, 'squash');
  assert.throws(() => resolveDelivery({}, 'unknown'));
  assert.throws(() => validateDeliveryConfig({ delivery: { default: 'missing', profiles: {} } }));
  assert.throws(() => validateDeliveryConfig({ worktree: { provision: { services: [{ id: 'web', cwd: '../outside', command: 'node server.mjs', healthcheck: 'http://127.0.0.1:1', stopOnTeardown: true }] } } }));
  // The healthcheck has to probe this service's allocated port: a fixed port, or
  // a placeholder used only in the path or query, would let an unrelated server
  // that already listens there satisfy the probe.
  const service = (healthcheck) => ({ worktree: { provision: { services: [{ id: 'web', cwd: '.', command: 'node server.mjs', healthcheck, stopOnTeardown: true }] } } });
  assert.equal(validateDeliveryConfig(service('http://127.0.0.1:${PORT}/health')), undefined);
  assert.throws(() => validateDeliveryConfig(service('http://127.0.0.1:3000')), /allocated \$\{PORT\}/u);
  assert.throws(() => validateDeliveryConfig(service('http://127.0.0.1:3000/${PORT}')), /URL port/u);
  assert.throws(() => validateDeliveryConfig(service('http://127.0.0.1:3000?port=${PORT}')), /URL port/u);
  assert.equal(overrideWarnings({ projectRules: { exceptions: [{ id: 'shadow' }] } })[0].status, 'stale');
});

test('完成收据四态不将 blocked 或缺字段转换为通过', () => {
  const delivery = resolveDelivery({}, 'managed-mr');
  const receipt = completionReceipt({ status: 'blocked', selectedChecks: ['browser'], checks: { browser: { status: 'blocked', command: 'browser check' } } }, delivery);
  assert.equal(receipt.acceptance[0].status, 'blocked');
  assert.equal(validateCompletion(receipt, delivery).status, 'blocked');
  assert.equal(validateCompletion(null, resolveDelivery({})).status, 'passed');
  assert.equal(validateCompletion(null, resolveDelivery({})).warnings.length, 1);
  const owner = { pid: 1, supervisorPid: 2, cwd: '/fixture', commandFingerprint: 'hash', startedAt: 'now' };
  // An entry without the control token and the OS start identity proves no
  // ownership at all, so a reply that omits the same fields cannot authorize
  // acting on it.
  assert.equal(serviceOwnership(owner, { ...owner, status: 'running' }), false);
  assert.equal(serviceOwnership(owner, { ...owner, pid: 3, status: 'running' }), false);
  // The registry is caller-readable, so the ownership fields a local user can
  // learn from a `status` reply must not authorize a `stop` on their own: the
  // per-supervisor control token is what the caller has to have recorded.
  const owned = { ...owner, controlToken: 'token-a', processStartTime: 'linux-start:41' };
  assert.equal(serviceOwnership(owned, { ...owned, status: 'running' }), true);
  assert.equal(serviceOwnership(owned, { ...owned, controlToken: 'token-b', status: 'running' }), false);
  assert.equal(serviceOwnership(owned, { ...owned, processStartTime: 'linux-start:42', status: 'running' }), false);
  assert.equal(serviceOwnership(owned, { ...owned, status: 'stopped' }), false);
});

test('完成收据不接受自证的验收证据', () => {
  const delivery = resolveDelivery({}, 'managed-mr');
  // The provenance gate is exercised on its own below; here the receipt shapes
  // are compared on their internal consistency, so the attestation that the
  // cited verification resolves to the tool's record is supplied directly.
  const attested = { provenance: { ok: true, reason: 'recorded-verification-matched' } };
  const receipt = () => ({
    delivery: { profile: 'managed-mr', stage: 'complete' },
    status: 'passed',
    acceptance: [{ id: 'test', status: 'passed', command: 'node --version', scope: 'layer' }],
    unverified: [],
    remainingRisks: [],
    rollback: 'git revert HEAD',
    source: { head: 'head', fingerprint: 'fingerprint' },
    target: { head: 'base' },
    verification: {
      id: 'verification',
      finishedAt: new Date().toISOString(),
      snapshotComparison: 'match',
      status: 'passed',
      fingerprint: 'fingerprint',
      acceptance: { status: 'accepted', selectedCheckIds: [], finalFingerprint: 'fingerprint' },
      review: { status: 'relevant', reviewedCheckIds: [] },
    },
  });

  // A self-asserted `accepted` that names nothing and cites no review is the
  // shape a handcrafted receipt would take.
  const forged = validateCompletion(receipt(), delivery, null, attested);
  assert.equal(forged.status, 'blocked');
  assert.ok(forged.errors.some((line) => /does not name the selected checks/u.test(line)), forged.errors.join('; '));
  assert.ok(forged.errors.some((line) => /does not cite a reviewed relevant check/u.test(line)), forged.errors.join('; '));
  assert.ok(!forged.errors.some((line) => /provenance/u.test(line)), forged.errors.join('; '));

  // A mismatched final fingerprint is the same class of unproven claim.
  const tampered = receipt();
  tampered.verification.acceptance.selectedCheckIds = ['test'];
  tampered.verification.review.reviewedCheckIds = ['test'];
  tampered.verification.acceptance.finalFingerprint = 'other';
  const stale = validateCompletion(tampered, delivery, null, attested);
  assert.ok(stale.errors.some((line) => /does not match the verification fingerprint/u.test(line)), stale.errors.join('; '));

  // A review that names a check outside the selection, or an acceptance that
  // does not cover what was reviewed, is an internally inconsistent claim even
  // though every field looks plausible on its own.
  const outsideSelection = receipt();
  outsideSelection.verification.acceptance.selectedCheckIds = ['test'];
  outsideSelection.verification.acceptance.finalFingerprint = 'fingerprint';
  outsideSelection.verification.review.reviewedCheckIds = ['test', 'browser'];
  const uncovered = validateCompletion(outsideSelection, delivery, null, attested);
  assert.ok(uncovered.errors.some((line) => /reviewed checks are not part of the selected checks/u.test(line)), uncovered.errors.join('; '));
  assert.ok(uncovered.errors.some((line) => /acceptance entries do not cover the reviewed checks/u.test(line)), uncovered.errors.join('; '));

  const disagreed = receipt();
  disagreed.verification.acceptance.selectedCheckIds = ['test'];
  disagreed.verification.acceptance.finalFingerprint = 'fingerprint';
  disagreed.verification.review.selectedCheckIds = ['lint'];
  disagreed.verification.review.reviewedCheckIds = ['test'];
  assert.ok(validateCompletion(disagreed, delivery, null, attested).errors.some((line) => /disagree about the selected checks/u.test(line)));

  // An acceptance that cites only the passing selections hides a failed or
  // unverified one, so every selected check needs its own entry.
  const partial = receipt();
  partial.verification.acceptance.selectedCheckIds = ['test', 'eval'];
  partial.verification.review.reviewedCheckIds = ['test', 'eval'];
  partial.verification.review.selectedCheckIds = ['test', 'eval'];
  const omitted = validateCompletion(partial, delivery, null, attested);
  assert.ok(omitted.errors.some((line) => /selected checks are missing acceptance entries: eval/u.test(line)), omitted.errors.join('; '));

  // A repeated id inflates the selection the same way a missing entry hides it.
  const duplicated = receipt();
  duplicated.verification.acceptance.selectedCheckIds = ['test', 'test'];
  duplicated.verification.review.reviewedCheckIds = ['test'];
  duplicated.verification.review.selectedCheckIds = ['test', 'test'];
  assert.ok(validateCompletion(duplicated, delivery, null, attested).errors.some((line) => /repeats a selected check/u.test(line)));

  // The consistent shape is accepted.
  const consistent = receipt();
  consistent.verification.acceptance.selectedCheckIds = ['test'];
  consistent.verification.review.reviewedCheckIds = ['test'];
  assert.equal(validateCompletion(consistent, delivery, null, attested).status, 'passed');
});

test('reviewPolicy:none 只为 develop 免审，其他分支与伪造上下文仍被阻断', () => {
  const config = {
    delivery: {
      default: 'local-land',
      profiles: { 'local-land': { merge: 'no-ff', cleanup: 'ancestor', requireReceipt: true, reviewPolicy: 'none' } },
    },
  };
  const delivery = resolveDelivery(config);
  assert.equal(delivery.reviewPolicy, 'none');
  assert.equal(isReviewRequired({ reviewPolicy: 'none', targetBranch: 'develop' }), false);
  assert.equal(isReviewRequired({ reviewPolicy: 'none', targetBranch: 'main' }), true);
  assert.equal(isReviewRequired({ reviewPolicy: 'required', targetBranch: 'develop' }), true);

  const receipt = () => ({
    delivery: { profile: 'local-land', stage: 'complete', targetBranch: 'develop' },
    status: 'passed',
    acceptance: [{ id: 'test', status: 'passed', command: 'node --version', scope: 'layer' }],
    unverified: [],
    remainingRisks: [],
    rollback: 'git revert HEAD',
    source: { head: 'head', fingerprint: 'fingerprint' },
    target: { head: 'base' },
    verification: {
      id: 'verification',
      finishedAt: new Date().toISOString(),
      snapshotComparison: 'match',
      status: 'passed',
      fingerprint: 'fingerprint',
      acceptance: {
        status: 'accepted',
        selectedCheckIds: ['test'],
        finalFingerprint: 'fingerprint',
      },
      review: {
        status: 'not_required',
        reasonCode: 'REVIEW_NOT_REQUIRED',
        reviewPolicy: 'none',
        targetBranch: 'develop',
        selectedCheckIds: ['test'],
        reviewedCheckIds: [],
      },
    },
  });
  const attested = { provenance: { ok: true, reason: 'recorded-verification-matched' } };
  assert.equal(validateCompletion(receipt(), delivery, null, { ...attested, targetBranch: 'develop' }).status, 'passed');

  const main = receipt();
  main.delivery.targetBranch = 'main';
  const mainGate = validateCompletion(main, delivery, null, { ...attested, targetBranch: 'main' });
  assert.equal(mainGate.status, 'blocked');
  assert.ok(mainGate.errors.some((line) => /does not cite a reviewed relevant check/u.test(line)), mainGate.errors.join('; '));

  const forged = receipt();
  forged.verification.review.targetBranch = 'main';
  forged.delivery.targetBranch = 'main';
  const forgedGate = validateCompletion(forged, delivery, null, { ...attested, targetBranch: 'main' });
  assert.equal(forgedGate.status, 'blocked');

  const wrongPolicy = resolveDelivery({ delivery: { default: 'local-land', profiles: { 'local-land': { merge: 'no-ff', cleanup: 'ancestor', requireReceipt: true } } } });
  assert.equal(validateCompletion(receipt(), wrongPolicy, null, { ...attested, targetBranch: 'develop' }).status, 'blocked');
});

test('免审验证据记录 not_required 而不是伪装的 relevant', () => {
  const review = verificationReview({
    changedPaths: ['src/app.js'],
    selectedNames: ['lint', 'test'],
    checks: { lint: { status: 'passed' }, test: { status: 'passed' } },
    reviewed: [],
    reviewPolicy: 'none',
    targetBranch: 'develop',
  });
  assert.equal(review.status, 'not_required');
  assert.equal(review.reasonCode, 'REVIEW_NOT_REQUIRED');
  assert.equal(review.reviewPolicy, 'none');
  assert.equal(review.targetBranch, 'develop');
  const accepted = verificationAcceptance({
    review,
    status: 'verified',
    snapshotComparison: 'match',
    inputsStable: true,
    fingerprint: 'fingerprint',
    selectedNames: ['lint', 'test'],
    deferredCount: 0,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.reasonCode, 'ACCEPTED');

  const otherBranch = verificationReview({
    selectedNames: ['lint'], checks: { lint: { status: 'passed' } },
    reviewPolicy: 'none', targetBranch: 'main',
  });
  assert.equal(otherBranch.status, 'unreviewed');
  const blocked = verificationAcceptance({
    review: { ...review, targetBranch: 'main' },
    status: 'verified',
    snapshotComparison: 'match',
    inputsStable: true,
    fingerprint: 'fingerprint',
    selectedNames: ['lint', 'test'],
    deferredCount: 0,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reasonCode, 'REVIEW_POLICY_CONTEXT_INVALID');
});

test('完成收据必须能对上工具自己写的验证记录', () => {
  const delivery = resolveDelivery({}, 'managed-mr');
  const consistent = {
    delivery: { profile: 'managed-mr', stage: 'complete' },
    status: 'passed',
    acceptance: [{ id: 'test', status: 'passed', command: 'node --version', scope: 'layer' }],
    unverified: [],
    remainingRisks: [],
    rollback: 'git revert HEAD',
    source: { head: 'head', fingerprint: 'fingerprint' },
    target: { head: 'base' },
    verification: {
      id: 'forgeable',
      finishedAt: new Date().toISOString(),
      snapshotComparison: 'match',
      status: 'passed',
      fingerprint: 'fingerprint',
      writeFingerprint: 'write-fingerprint',
      acceptance: { status: 'accepted', selectedCheckIds: ['test'], finalFingerprint: 'fingerprint' },
      review: { status: 'relevant', reviewedCheckIds: ['test'] },
    },
  };
  // `--receipt` is caller-supplied JSON: without the attestation that its cited
  // verification id resolves to a record this tool wrote, the receipt fails
  // closed even though every field is internally consistent.
  const unproven = validateCompletion(consistent, delivery);
  assert.equal(unproven.status, 'blocked');
  assert.ok(unproven.errors.some((line) => /provenance is unverified/u.test(line)), unproven.errors.join('; '));
  assert.equal(validateCompletion(consistent, delivery, null, { provenance: { ok: true } }).status, 'passed');
  const mismatched = validateCompletion(consistent, delivery, null, { provenance: { ok: false, reason: 'recorded-verification-mismatch:write-fingerprint' } });
  assert.ok(mismatched.errors.some((line) => /write-fingerprint/u.test(line)), mismatched.errors.join('; '));
});

test('checkpoint dry-run 无写入且恢复报告 HEAD 和工作区漂移', async () => {
  const { project } = await fixture();
  try {
    await command(project, 'task', 'init', 'demo', '--title', 'Demo', '--goal', 'Resume', '--write');
    const first = await command(project, 'task', 'event', 'demo', '--reason', 'continue', '--write');
    assert.equal(first.report.checkpointed, false);
    const second = await command(project, 'task', 'event', 'demo', '--reason', 'continue', '--write');
    assert.equal(second.report.latestCheckpoint.reason, 'continue');
    const dry = await command(project, 'task', 'checkpoint', 'demo', '--reason', 'pre-compaction');
    assert.equal(dry.report.status, 'planned');
    const file = path.join(project, '.vibe-harness/tasks/demo.json');
    assert.equal(JSON.parse(await readFile(file)).latestCheckpoint.reason, 'continue');
    await command(project, 'task', 'checkpoint', 'demo', '--reason', 'pre-compaction', '--write');
    assert.equal((await command(project, 'task', 'status', 'demo')).report.recovery.status, 'passed');
    await writeFile(path.join(project, 'example.txt'), 'changed\n');
    assert.ok((await command(project, 'task', 'status', 'demo')).report.recovery.drift.includes('fingerprint'));
    const blocked = await command(project, 'task', 'check', 'demo', '--complete', '--delivery', 'managed-mr');
    assert.equal(blocked.report.status, 'blocked');
  } finally { await remove(project); }
});

test('squash 清理拒绝缺证据、漂移、脏目录和 patch 不一致后接受有效证据', async () => {
  const { project, config } = await fixture();
  const worktree = `${project}-trees/demo`;
  try {
    git(project, 'worktree', 'add', '-qb', 'feature', worktree);
    const sourceBase = git(project, 'rev-parse', 'HEAD');
    await writeFile(path.join(worktree, 'example.txt'), 'feature\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'feature');
    const sourceHead = git(worktree, 'rev-parse', 'HEAD');
    git(project, 'merge', '--squash', 'feature');
    git(project, 'commit', '-qm', 'squash');
    const targetAfter = git(project, 'rev-parse', 'HEAD');
    const diff = git(project, 'diff', '--binary', sourceBase, sourceHead);
    const patchId = spawnSync('git', ['patch-id', '--stable'], { input: diff, cwd: project, encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s/u)[0];
    const evidence = { sourceBase, sourceHead, targetRef: 'target', targetBefore: sourceBase, targetAfter, mergeMethod: 'squash', mergeCommit: targetAfter, patchId, taskId: 'demo' };
    // A completion receipt is only accepted with an explicit relevance review:
    // the selection reasons the planner emits are not review evidence.
    const unreviewed = (await command(worktree, 'verify', '--delivery', 'managed-mr')).report;
    // `verify` emits a draft: this caller never supplied the review, so nothing
    // refutes the run — the draft is `unverified` while the acceptance evidence
    // it cites is blocked and the review is unreviewed. Only `passed` completes
    // a delivery.
    assert.equal(unreviewed.completion.status, 'unverified');
    assert.equal(unreviewed.completion.verificationAcceptance.status, 'blocked');
    assert.equal(unreviewed.completion.review.status, 'unreviewed');
    assert.deepEqual(unreviewed.completion.review.reviewedCheckIds ?? [], []);
    const verification = (await command(worktree, 'verify', '--delivery', 'managed-mr', '--reviewed', 'all')).report;
    const receipt = verification.completion;
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.review.status, 'relevant');
    // The write evidence a completion receipt is validated against has to be the
    // state verification ended in, which is what `gitFingerprint` reports now.
    assert.equal(typeof receipt.verification.writeFingerprint, 'string');
    assert.equal(receipt.verification.writeFingerprint, (await gitFingerprint(worktree)).writeFingerprint);
    receipt.delivery.stage = 'complete';
    receipt.target.head = targetAfter;
    const receiptFile = path.join(project, '.vibe-harness/receipt.json');
    const evidenceFile = path.join(project, '.vibe-harness/evidence.json');
    await command(project, 'task', 'init', 'holder', '--title', 'Holder', '--goal', 'Receipt files', '--write');
    await writeFile(receiptFile, JSON.stringify(receipt));
    const options = ['worktree', 'cleanup', '--task', 'demo', '--delivery', 'managed-mr', '--receipt', receiptFile];
    assert.equal((await command(project, ...options)).report.status, 'blocked');
    await writeFile(evidenceFile, JSON.stringify({ ...evidence, patchId: 'incorrect' }));
    assert.equal((await command(project, ...options, '--merge-evidence', evidenceFile)).report.status, 'blocked');
    await writeFile(evidenceFile, JSON.stringify(evidence));
    await writeFile(path.join(worktree, 'dirty.txt'), 'dirty');
    assert.equal((await command(project, ...options, '--merge-evidence', evidenceFile)).report.status, 'blocked');
    await rm(path.join(worktree, 'dirty.txt'));
    git(project, 'commit', '--allow-empty', '-qm', 'target drift');
    assert.equal((await command(project, ...options, '--merge-evidence', evidenceFile)).report.status, 'blocked');
    git(project, 'reset', '--hard', targetAfter);
    // Creating and removing the dirty file is itself a write the receipt gate
    // can see — the worktree directory carries the timestamps of both — so the
    // accepted receipt has to be the one verification ends in, after the probe.
    const refreshed = (await command(worktree, 'verify', '--delivery', 'managed-mr', '--reviewed', 'all')).report.completion;
    refreshed.delivery.stage = 'complete';
    refreshed.target.head = targetAfter;
    await writeFile(receiptFile, JSON.stringify(refreshed));
    const result = await command(project, ...options, '--merge-evidence', evidenceFile, '--write');
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report));
    assert.equal(git(project, 'rev-parse', 'feature'), sourceHead);
    assert.equal(config.worktree.baseRef, 'target');
  } finally { await remove(project); }
});

test('服务登记启动、状态、重复启动拒绝和归属核对停止', async () => {
  const { project, config } = await fixture();
  try {
    const port = await freePort();
    await declareService(project, config, servingScript);
    const start = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(start.report.status, 'passed', JSON.stringify(start.report));
    const duplicate = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(duplicate.report.status, 'blocked');
    assert.equal((await command(project, 'runtime', 'service', 'status')).report.processes[0].status, 'running');
    assert.equal((await command(project, 'runtime', 'service', 'stop', '--write')).report.processes[0].teardownStatus, 'passed');
    assert.equal((await command(project, 'runtime', 'service', 'status')).report.processes[0].status, 'stopped');
  } finally {
    await command(project, 'runtime', 'service', 'stop', '--write').catch(() => {});
    await remove(project);
  }
});

test('inspect-only 阻止实际验证和任何受管写入', async () => {
  const { project } = await fixture();
  try {
    assert.equal((await command(project, 'verify', '--delivery', 'inspect-only')).report.status, 'blocked');
    const planned = await command(project, 'verify', '--plan', '--delivery', 'inspect-only');
    assert.equal(planned.report.status, 'planned');
    assert.equal((await command(project, 'task', 'init', 'no', '--title', 'No', '--goal', 'No writes', '--write', '--delivery', 'inspect-only')).report.status, 'blocked');
    assert.ok((await gitFingerprint(project)).fingerprint);
    assert.equal(deliveryProfiles['local-land'].merge, 'no-ff');
  } finally { await remove(project); }
});

test('tracked 符号链接改指向会改变写指纹', async (t) => {
  const { project } = await fixture();
  try {
    await writeFile(path.join(project, 'target-a.txt'), 'a\n');
    await writeFile(path.join(project, 'target-b.txt'), 'b\n');
    try {
      await symlink('target-a.txt', path.join(project, 'link.txt'));
    } catch (error) {
      t.skip(`当前环境无法创建符号链接: ${error.code}`);
      return;
    }
    git(project, 'add', 'target-a.txt', 'target-b.txt', 'link.txt');
    git(project, 'commit', '-qm', 'tracked link');
    const before = await gitFingerprint(project);
    assert.equal(typeof before.writeFingerprint, 'string');

    // Retargeting the link changes the link text while the metadata of the
    // file it resolves to stays identical, so `stat()` alone cannot see it.
    const link = path.join(project, 'link.txt');
    await rm(link, { force: true });
    await symlink('target-b.txt', link);
    assert.equal(await readlink(link), 'target-b.txt');
    const after = await gitFingerprint(project);
    assert.notEqual(after.writeFingerprint, before.writeFingerprint);
  } finally {
    await remove(project);
  }
});

test('子模块内已脏路径的再次写入会改变写指纹', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-delivery-submodule-'));
  const source = path.join(root, 'submodule-source');
  const project = path.join(root, 'main');
  try {
    await mkdir(source, { recursive: true });
    await mkdir(project, { recursive: true });
    for (const dir of [source, project]) {
      git(dir, 'init', '-q', '-b', 'target');
      git(dir, 'config', 'user.name', 'Fixture');
      git(dir, 'config', 'user.email', 'fixture@example.invalid');
    }
    await writeFile(path.join(source, 'inner.txt'), 'one\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'submodule base');
    try {
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', source.split(path.sep).join('/'), 'vendor/sub'], { cwd: project, encoding: 'utf8', windowsHide: true });
    } catch (error) {
      t.skip(`当前环境无法添加子模块: ${error.message.split('\n')[0]}`);
      return;
    }
    git(project, 'commit', '-qm', 'add submodule');
    const inner = path.join(project, 'vendor', 'sub', 'inner.txt');
    await writeFile(inner, 'two\n');
    const dirty = await gitFingerprint(project);
    assert.equal(typeof dirty.writeFingerprint, 'string');
    // HEAD and the porcelain status are unchanged by this second write, so only
    // the metadata of the paths inside the submodule can see it.
    await writeFile(inner, 'three\n');
    const rewritten = await gitFingerprint(project);
    assert.notEqual(rewritten.writeFingerprint, dirty.writeFingerprint);
  } finally {
    await remove(root);
  }
});

test('嵌套子模块内的写入会改变写指纹', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-delivery-submodule-deep-'));
  const inner = path.join(root, 'inner');
  const outer = path.join(root, 'outer');
  const project = path.join(root, 'main');
  try {
    for (const dir of [inner, outer, project]) {
      await mkdir(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'target');
      git(dir, 'config', 'user.name', 'Fixture');
      git(dir, 'config', 'user.email', 'fixture@example.invalid');
    }
    await writeFile(path.join(inner, 'inner.txt'), 'one\n');
    git(inner, 'add', '.');
    git(inner, 'commit', '-qm', 'inner base');
    await writeFile(path.join(outer, 'outer.txt'), 'outer\n');
    git(outer, 'add', '.');
    git(outer, 'commit', '-qm', 'outer base');
    try {
      const allowFileProtocol = ['-c', 'protocol.file.allow=always'];
      execFileSync('git', [...allowFileProtocol, 'submodule', 'add', inner.split(path.sep).join('/'), 'nested/sub'], { cwd: outer, encoding: 'utf8', windowsHide: true });
      git(outer, 'commit', '-qm', 'add nested submodule');
      execFileSync('git', [...allowFileProtocol, 'submodule', 'add', outer.split(path.sep).join('/'), 'vendor/outer'], { cwd: project, encoding: 'utf8', windowsHide: true });
      execFileSync('git', [...allowFileProtocol, 'submodule', 'update', '--init', '--recursive', '--checkout'], { cwd: project, encoding: 'utf8', windowsHide: true });
      git(project, 'commit', '-qm', 'add outer submodule');
    } catch (error) {
      t.skip(`当前环境无法添加嵌套子模块: ${error.message.split('\n')[0]}`);
      return;
    }
    const deepest = path.join(project, 'vendor', 'outer', 'nested', 'sub', 'inner.txt');
    await writeFile(deepest, 'two\n');
    const dirty = await gitFingerprint(project);
    assert.equal(typeof dirty.writeFingerprint, 'string');
    // Rewriting an already-dirty path below the second gitlink changes neither
    // the superproject's porcelain status nor the gitlink directory metadata, so
    // only a recursive walk of every gitlink can see it.
    await writeFile(deepest, 'three\n');
    const rewritten = await gitFingerprint(project);
    assert.notEqual(rewritten.writeFingerprint, dirty.writeFingerprint);
  } finally {
    await remove(root);
  }
});

test('删除 tracked 文件后写指纹记下删除时刻', async () => {
  const { project } = await fixture();
  try {
    await mkdir(path.join(project, 'nested'));
    await writeFile(path.join(project, 'nested', 'gone.txt'), 'x\n');
    git(project, 'add', 'nested/gone.txt');
    git(project, 'commit', '-qm', 'tracked file');
    const before = await gitFingerprint(project);
    assert.equal(typeof before.writeFingerprint, 'string');

    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(path.join(project, 'nested', 'gone.txt'));
    const after = await gitFingerprint(project);
    assert.equal(typeof after.writeFingerprint, 'string');
    assert.notEqual(after.writeFingerprint, before.writeFingerprint);
    // A deleted path has no metadata of its own, so the deletion is dated by the
    // deepest surviving ancestor. Without that evidence `latestWriteAt` would
    // stay older than the deletion and a receipt taken before it would still look
    // current.
    const parent = await stat(path.join(project, 'nested'));
    assert.ok(after.latestWriteAt >= parent.mtimeMs - 1, `${after.latestWriteAt} < ${parent.mtimeMs}`);
    assert.ok(after.latestWriteAt > before.latestWriteAt, `${after.latestWriteAt} <= ${before.latestWriteAt}`);
  } finally { await remove(project); }
});

test('指向目录的 tracked 符号链接使写指纹 fail closed', async (t) => {
  const { project } = await fixture();
  try {
    await mkdir(path.join(project, 'real-dir'));
    await writeFile(path.join(project, 'real-dir', 'inner.txt'), 'one\n');
    try {
      await symlink('real-dir', path.join(project, 'dir-link'), 'dir');
    } catch (error) {
      t.skip(`当前环境无法创建目录符号链接: ${error.code}`);
      return;
    }
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'directory link');
    const staged = git(project, 'ls-files', '-s', 'dir-link');
    if (!staged.startsWith('120000')) {
      t.skip('当前 Git 未把目录符号链接记录为链接');
      return;
    }
    const snapshot = await gitFingerprint(project);
    // Writing a child through the link changes neither the link nor the target
    // directory metadata, so there is no surface left to observe and the write
    // fingerprint has to be dropped rather than published as current.
    assert.equal(snapshot.writeFingerprint, null);
    assert.equal(snapshot.latestWriteAt, null);
    assert.equal(typeof snapshot.fingerprint, 'string');
  } finally { await remove(project); }
});

test('supervisor 崩溃后重新启动回收旧服务树而非复用登记', async () => {
  const { project, config } = await fixture();
  try {
    const port = await freePort();
    await declareService(project, config, servingScript);
    const first = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const entry = first.report.processes[0];
    // The service tree keeps running, but the endpoint that could prove it gone
    // disappears with the supervisor: the registration is now unreachable.
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/pid', String(entry.supervisorPid), '/f'], { windowsHide: true });
    else process.kill(entry.supervisorPid, 'SIGKILL');
    const restarted = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(restarted.report.status, 'passed', JSON.stringify(restarted.report));
    assert.notEqual(restarted.report.processes[0].pid, entry.pid);
  } finally {
    await command(project, 'runtime', 'service', 'stop', '--write').catch(() => {});
    await remove(project);
  }
});

test('服务自行退出后登记可被回收并重新启动', async () => {
  const { project, config } = await fixture();
  try {
    const port = await freePort();
    const transient = "import http from 'node:http'; const server = http.createServer((request, response) => response.end('ok')); server.listen(Number(process.env.PORT), '127.0.0.1', () => setTimeout(() => process.exit(0), 900));\n";
    await declareService(project, config, transient);
    const first = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const restarted = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(restarted.report.status, 'passed', JSON.stringify(restarted.report));
    assert.notEqual(restarted.report.processes[0].pid, first.report.processes[0].pid);
  } finally {
    await command(project, 'runtime', 'service', 'stop', '--write').catch(() => {});
    await remove(project);
  }
});

test('teardown 墓碑阻止同一 worktree 再次启动服务并可显式释放', async () => {
  const { project, config } = await fixture();
  try {
    const port = await freePort();
    await declareService(project, config, servingScript);
    const start = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(start.report.status, 'passed', JSON.stringify(start.report));
    const teardown = await teardownServices(project, realpathSync(project), true);
    assert.equal(teardown.status, 'passed', JSON.stringify(teardown));
    const blocked = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(blocked.report.status, 'blocked');
    assert.equal(blocked.report.reason, 'worktree-teardown-in-progress');
    assert.deepEqual(releaseServiceTeardown(project, realpathSync(project)), { released: true });
    const restarted = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(restarted.report.status, 'passed', JSON.stringify(restarted.report));
  } finally {
    await command(project, 'runtime', 'service', 'stop', '--write').catch(() => {});
    await releaseServiceTeardown(project, realpathSync(project));
    await remove(project);
  }
});

test('服务登记指向复用 PID 时不发信号并保持 blocked', async () => {
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  try {
    const realIdentity = processStartIdentity(child.pid);
    assert.equal(typeof realIdentity, 'string');
    assert.notEqual(realIdentity, 'unreadable');
    assert.notEqual(realIdentity, 'missing');
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port: 9,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint: unreachableEndpoint(),
      // The recorded start time belongs to the process the registration was
      // written for, not to whatever holds the PID now.
      processStartTime: 'a-different-process',
    });
    const stopped = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    assert.equal(stopped.report.status, 'blocked', JSON.stringify(stopped.report));
    assert.equal(stopped.report.processes[0].reason, 'service-tree-survives');
    // The unrelated process that now holds the PID was never signalled.
    assert.equal(treeGone(child.pid), false);
  } finally {
    killTree(child.pid);
    await remove(project);
  }
});

test('服务登记用同目录别名拼写时仍算作了本工作区', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('大小写与 8.3 短名这类同目录别名只存在于 Windows');
    return;
  }
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  try {
    // Windows accepts more than one spelling for one directory, and the
    // registry is caller-readable state, so a registration written for this
    // worktree can name it in a different case. It still names this worktree:
    // the identity comparison has to be made on the canonical directory, or
    // the entry is silently treated as another worktree's and a stop reports
    // `service-not-registered` for a service that is still registered here.
    const canonical = realpathSync(project);
    const alias = canonical.toUpperCase();
    assert.notEqual(alias, canonical);
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: alias, port: 9,
      commandFingerprint: 'fingerprint', cwd: alias, status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint: unreachableEndpoint(),
      // The recorded start time belongs to another process, so the entry is
      // selected while nothing may be signalled on its behalf.
      processStartTime: 'a-different-process',
    });
    const stopped = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    assert.equal(stopped.report.status, 'blocked', JSON.stringify(stopped.report));
    assert.equal(stopped.report.processes.length, 1, JSON.stringify(stopped.report));
    assert.equal(stopped.report.processes[0].serviceId, 'web');
    assert.equal(treeGone(child.pid), false);
  } finally {
    killTree(child.pid);
    await remove(project);
  }
});

test('服务登记身份一致时才回收进程树', async () => {
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  try {
    const realIdentity = processStartIdentity(child.pid);
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port: 9,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint: unreachableEndpoint(),
      processStartTime: realIdentity,
    });
    const stopped = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    assert.equal(stopped.report.status, 'passed', JSON.stringify(stopped.report));
    assert.equal(stopped.report.processes[0].teardownStatus, 'passed');
    assert.equal(treeGone(child.pid), true);
  } finally {
    killTree(child.pid);
    await remove(project);
  }
});

test('冒名端点回答 stopped 时不作为回收证据', async () => {
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  // The recorded endpoint lives in this user's socket directory: anything else
  // is rejected as un-publishable before it is ever asked, so an impostor that
  // bound one of those would exercise the rejection path instead of this one.
  const endpoint = serviceEndpoint();
  await mkdir(serviceSocketDirectory(), { recursive: true, mode: 0o700 });
  const impostor = createServer((socket) => { socket.end(`${JSON.stringify({ status: 'stopped' })}\n`); });
  try {
    await new Promise((resolve, reject) => {
      impostor.once('error', reject);
      impostor.listen(endpoint, resolve);
    });
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port: 9,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint, controlToken: 'token-a',
      processStartTime: processStartIdentity(child.pid),
    });
    const stopped = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    // The endpoint name is per user, not per supervisor: after the recorded
    // supervisor exits, another process can bind it and answer `stopped` for a
    // tree that is still serving, so the reply has to prove the recorded identity.
    assert.equal(stopped.report.status, 'blocked', JSON.stringify(stopped.report));
    assert.equal(stopped.report.processes[0].reason, 'ownership-unproven');
    assert.equal(stopped.report.processes[0].teardownStatus, 'blocked');
    const registry = JSON.parse(await readFile(path.join(project, '.vibe-harness', 'processes.json'), 'utf8'));
    assert.notEqual(registry.processes[0].status, 'stopped');
    // The unrelated process that holds the recorded PID was never signalled.
    assert.equal(treeGone(child.pid), false);
  } finally {
    impostor.close();
    killTree(child.pid);
    await remove(project);
  }
});

test('Windows 成员探针不把登记过的身份拼进脚本', () => {
  const identity = "x'; Remove-Item -Recurse -Force C:\\; '";
  const probeCommands = [];
  const probe = (command) => { probeCommands.push(command); return '4321'; };
  // The identity comes from the caller-readable registry, so the probe must not
  // carry it as PowerShell source: a tampered entry would otherwise run whatever
  // it contains as the user who starts the next service command.
  assert.deepEqual(windowsConfirmedMembers([{ pid: 4321, startIdentity: identity }], { probe }), [{ pid: 4321, startIdentity: identity }]);
  assert.equal(probeCommands.length, 1);
  assert.equal(probeCommands[0].includes(identity), false);
  const payload = probeCommands[0].match(/'([A-Za-z0-9+/=]+)'/u)?.[1] ?? '';
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), [{ pid: 4321, startIdentity: identity }]);
});

test('Windows 树探针把登记过的身份当作数据而不是脚本', () => {
  const identity = "x'; Remove-Item -Recurse -Force C:\\; '";
  const command = windowsTreeProbeCommand(4321, identity);
  // The expected root identity comes from the registry a local user can edit, so
  // it travels as the decoded request payload; the walk then refuses a root whose
  // identity does not match instead of describing the tree a recycled PID leads.
  assert.equal(command.includes(identity), false);
  const payload = command.match(/'([A-Za-z0-9+/=]+)'/u)?.[1] ?? '';
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), { root: 4321, startIdentity: identity });
  // A registry that recorded no usable token asks for the walk without the gate
  // rather than comparing a value the probe can never match.
  const withoutGate = windowsTreeProbeCommand(4321);
  const emptyPayload = withoutGate.match(/'([A-Za-z0-9+/=]+)'/u)?.[1] ?? '';
  assert.deepEqual(JSON.parse(Buffer.from(emptyPayload, 'base64').toString('utf8')), { root: 4321, startIdentity: '' });
});

test('只有真实起始身份参与比较，无效 PID 既不算存活也不算消失', () => {
  // `missing` and `unreadable` are the probes' non-token answers: they have to
  // travel in the control protocol but cannot authorize acting on a number.
  assert.equal(startIdentityToken('missing'), '');
  assert.equal(startIdentityToken('unreadable'), '');
  assert.equal(startIdentityToken(undefined), '');
  assert.equal(startIdentityToken('linux-start:41'), 'linux-start:41');
  // An entry without a usable PID describes a tree whose start was never proven
  // gone, so reading it as "gone" would authorize a shadowing start.
  assert.equal(treeGone(0), false);
  assert.equal(treeGone(-1), false);
  assert.equal(treeGone(Number.NaN), false);
});

test('Windows 缺失根进程时按端口证据判断旧服务是否仍在服务', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('缺失根进程的端口证据只替代 Windows 的祖先遍历');
    return;
  }
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  const port = await freePort();
  // The probe half-closes as soon as it sees the port answer, and a socket that
  // is reset while a reply is still in flight reports the failure here rather
  // than to the caller, so the fixture has to absorb it the way a service would.
  const holder = createServer((socket) => {
    socket.on('error', () => {});
    socket.end('ok');
  });
  try {
    // A root that exited can no longer be walked for descendants, so the
    // registration is retired only when nothing is still serving its port: a
    // service that outlived its root must not be shadowed by a replacement.
    // The registration describes a root that is already gone, so the PID has to
    // stop answering the identity probe before the test writes it.
    killTree(child.pid);
    for (let attempt = 0; attempt < 50 && processStartIdentity(child.pid) !== 'missing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(processStartIdentity(child.pid), 'missing');
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint: unreachableEndpoint(),
      processStartTime: 'a-different-process',
    });
    await new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.listen(port, '127.0.0.1', resolve);
    });
    const serving = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    assert.equal(serving.report.status, 'blocked', JSON.stringify(serving.report));
    assert.equal(serving.report.processes[0].reason, 'service-tree-survives');
    await new Promise((resolve) => holder.close(resolve));
    const retired = await command(project, 'runtime', 'service', 'stop', '--service', 'web', '--write');
    assert.equal(retired.report.status, 'passed', JSON.stringify(retired.report));
    assert.equal(retired.report.processes[0].teardownStatus, 'passed');
  } finally {
    holder.close();
    killTree(child.pid);
    await remove(project);
  }
});

test('start 不带 --write 时不回收既有登记也不改注册表', async () => {
  const { project, config } = await fixture();
  const child = spawnDetachedFixture();
  const endpoint = unreachableEndpoint();
  try {
    await declareService(project, config, servingScript);
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port: 9,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint, controlToken: 'token-a',
      processStartTime: processStartIdentity(child.pid),
    });
    const registryFile = path.join(project, '.vibe-harness', 'processes.json');
    const before = await readFile(registryFile, 'utf8');
    const planned = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', '9');
    // Reclaiming signals a process tree and rewrites the registry, so a start
    // without `--write` reports what it would reclaim instead of doing it.
    assert.equal(planned.report.status, 'planned', JSON.stringify(planned.report));
    assert.equal(planned.report.reason, 'service-reclaim-required');
    assert.equal(treeGone(child.pid), false);
    assert.equal(await readFile(registryFile, 'utf8'), before);
  } finally {
    killTree(child.pid);
    await remove(project);
  }
});

test('service stop 不带 --write 时不发信号', async () => {
  const { project } = await fixture();
  const child = spawnDetachedFixture();
  try {
    await writeServiceRegistry(project, {
      taskId: 'local', serviceId: 'web', worktree: realpathSync(project), port: 9,
      commandFingerprint: 'fingerprint', cwd: realpathSync(project), status: 'running',
      teardownStatus: 'unverified', stopOnTeardown: true, pid: child.pid, supervisorPid: 1,
      startedAt: '2026-01-01T00:00:00.000Z', endpoint: unreachableEndpoint(),
      processStartTime: processStartIdentity(child.pid),
    });
    const planned = await command(project, 'runtime', 'service', 'stop', '--service', 'web');
    assert.equal(planned.report.status, 'planned', JSON.stringify(planned.report));
    assert.equal(planned.report.processes[0].status, 'planned');
    assert.equal(treeGone(child.pid), false);
  } finally {
    killTree(child.pid);
    await remove(project);
  }
});

test('无 registry 的 teardown 仍取锁并留下启动屏障', async () => {
  const { project, config } = await fixture();
  try {
    const port = await freePort();
    await declareService(project, config, servingScript);
    // No service was ever started, so there is no registry file at all.
    const teardown = await teardownServices(project, realpathSync(project), true);
    assert.equal(teardown.status, 'passed', JSON.stringify(teardown));
    const blocked = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(blocked.report.status, 'blocked');
    assert.equal(blocked.report.reason, 'worktree-teardown-in-progress');
    assert.deepEqual(releaseServiceTeardown(project, realpathSync(project)), { released: true });
    const started = await command(project, 'runtime', 'service', 'start', '--service', 'web', '--port', String(port), '--write');
    assert.equal(started.report.status, 'passed', JSON.stringify(started.report));
  } finally {
    await command(project, 'runtime', 'service', 'stop', '--write').catch(() => {});
    await releaseServiceTeardown(project, realpathSync(project));
    await remove(project);
  }
});

test('工作区在运行中变化时完成草稿判为 blocked 而不是缺证据', () => {
  const delivery = resolveDelivery({}, 'managed-mr');
  const draft = (snapshotComparison) => completionReceipt({
    status: 'passed',
    selectedChecks: ['test'],
    checks: { test: { status: 'passed', command: 'node --test' } },
    verification: {
      snapshotComparison,
      acceptance: { status: 'blocked', reasonCode: 'FINAL_SNAPSHOT_MISMATCH' },
    },
  }, delivery);
  // A workspace that demonstrably changed under passing checks refutes the run,
  // so the draft is `blocked` and the CLI verdict has to fail with it. Only a
  // comparison the run could not make at all is absent evidence, which stays
  // `unverified`; reading every mismatch as unobservable would silently make
  // the refuting state unreachable.
  assert.equal(draft('changed').status, 'blocked');
  assert.equal(draft('unknown').status, 'unverified');
  assert.equal(draft('unavailable').status, 'unverified');
});
