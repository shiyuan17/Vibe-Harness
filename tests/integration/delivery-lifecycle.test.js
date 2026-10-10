import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { runCommand } from '../../runtime/commands/run.mjs';
import { gitFingerprint } from '../../runtime/lib/git-fingerprint.mjs';
import { deliveryProfiles, completionReceipt, resolveDelivery, validateCompletion, validateDeliveryConfig, overrideWarnings } from '../../runtime/lib/delivery.mjs';
import { serviceOwnership } from '../../runtime/lib/services.mjs';

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
  await rm(project, { recursive: true, force: true });
  await rm(`${project}-trees`, { recursive: true, force: true });
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
    const verification = (await command(worktree, 'verify', '--delivery', 'managed-mr')).report;
    const receipt = verification.completion;
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
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    config.worktree.provision = { services: [{ id: 'web', command: 'node server.mjs', cwd: '.', healthcheck: 'http://127.0.0.1:${PORT}', stopOnTeardown: true }] };
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    await writeFile(path.join(project, 'server.mjs'), "import http from 'node:http'; http.createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n");
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
