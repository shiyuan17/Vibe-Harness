import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { runCommand } from '../../runtime/commands/run.mjs';
import { gitFingerprint } from '../../runtime/lib/git-fingerprint.mjs';
import { deliveryProfiles, completionReceipt, resolveDelivery, validateCompletion, validateDeliveryConfig, overrideWarnings } from '../../runtime/lib/delivery.mjs';
import { processStartIdentity, releaseServiceTeardown, serviceOwnership, teardownServices, treeGone } from '../../runtime/lib/services.mjs';

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
  assert.equal(serviceOwnership(owner, { ...owner, status: 'running' }), true);
  assert.equal(serviceOwnership(owner, { ...owner, pid: 3, status: 'running' }), false);
});

test('完成收据不接受自证的验收证据', () => {
  const delivery = resolveDelivery({}, 'managed-mr');
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
  const forged = validateCompletion(receipt(), delivery);
  assert.equal(forged.status, 'blocked');
  assert.ok(forged.errors.some((line) => /does not name the selected checks/u.test(line)), forged.errors.join('; '));
  assert.ok(forged.errors.some((line) => /does not cite a reviewed relevant check/u.test(line)), forged.errors.join('; '));

  // A mismatched final fingerprint is the same class of unproven claim.
  const tampered = receipt();
  tampered.verification.acceptance.selectedCheckIds = ['test'];
  tampered.verification.review.reviewedCheckIds = ['test'];
  tampered.verification.acceptance.finalFingerprint = 'other';
  const stale = validateCompletion(tampered, delivery);
  assert.ok(stale.errors.some((line) => /does not match the verification fingerprint/u.test(line)), stale.errors.join('; '));

  // A review that names a check outside the selection, or an acceptance that
  // does not cover what was reviewed, is an internally inconsistent claim even
  // though every field looks plausible on its own.
  const outsideSelection = receipt();
  outsideSelection.verification.acceptance.selectedCheckIds = ['test'];
  outsideSelection.verification.acceptance.finalFingerprint = 'fingerprint';
  outsideSelection.verification.review.reviewedCheckIds = ['test', 'browser'];
  const uncovered = validateCompletion(outsideSelection, delivery);
  assert.ok(uncovered.errors.some((line) => /reviewed checks are not part of the selected checks/u.test(line)), uncovered.errors.join('; '));
  assert.ok(uncovered.errors.some((line) => /acceptance entries do not cover the reviewed checks/u.test(line)), uncovered.errors.join('; '));

  const disagreed = receipt();
  disagreed.verification.acceptance.selectedCheckIds = ['test'];
  disagreed.verification.acceptance.finalFingerprint = 'fingerprint';
  disagreed.verification.review.selectedCheckIds = ['lint'];
  disagreed.verification.review.reviewedCheckIds = ['test'];
  assert.ok(validateCompletion(disagreed, delivery).errors.some((line) => /disagree about the selected checks/u.test(line)));

  // The consistent shape is accepted.
  const consistent = receipt();
  consistent.verification.acceptance.selectedCheckIds = ['test'];
  consistent.verification.review.reviewedCheckIds = ['test'];
  assert.equal(validateCompletion(consistent, delivery).status, 'passed');
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
    assert.equal(unreviewed.completion.status, 'blocked');
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
