import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCommand } from '../../runtime/commands/run.mjs';
import { acquireCheckResources } from '../../runtime/lib/check-resources.mjs';
import { buildDeliveryVerificationPlan } from '../../runtime/lib/verification-risk.mjs';
import { buildVerificationPlan } from '../../scripts/lib/verification-plan.js';
import { verifyProject } from '../../runtime/lib/verification-command.mjs';
import { createPushVerification, inspectPushVerification, preparePushAttempt } from '../../runtime/lib/push-verification.mjs';
import { readCandidateResources, saveCandidateResources } from '../../runtime/lib/candidate-resources.mjs';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { taskParentBatchEvidence } from '../../runtime/lib/task-command.mjs';
import { parentBatchContract } from '../../runtime/lib/parent-batch.mjs';
import { checkTaskDagNode, validateTaskDag } from '../../scripts/lib/task-dag.js';

const exec = promisify(execFile);
const hook = fileURLToPath(new URL('../../runtime/hooks/git-hook.mjs', import.meta.url)).replaceAll('\\', '/');
const git = async (cwd, args) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
async function fixture(options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vh-collaboration-')));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'remote.git');
  const counter = path.join(root, 'checks');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(repo, ['init', '-q', '-b', 'develop']);
  await git(repo, ['config', 'user.name', 'Fixture']);
  await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repo, '.gitignore'), '.vibe-harness/\nnode_modules/\n');
  await writeFile(path.join(repo, 'check.mjs'), `import {appendFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
appendFileSync(${JSON.stringify(counter)},head+'\\n');\n`);
  const config = {
    worktree: { root: '../worktrees', baseRef: 'develop', dependencyRoots: [], ...options.worktree },
    validationCommands: { test: 'node check.mjs', tiers: { quick: ['node check.mjs'], standard: ['node check.mjs'], deep: [] },
      checks: [{ id: 'test', command: 'node check.mjs', deterministic: true }] },
  };
  if (options.validationCommands) config.validationCommands = options.validationCommands;
  await writeFile(path.join(repo, 'vibe-harness.config.json'), JSON.stringify(config));
  for (const [name, contents] of Object.entries(options.files ?? {})) await writeFile(path.join(repo, name), contents);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'fixture']);
  await git(root, ['init', '--bare', '-q', origin]);
  await git(repo, ['remote', 'add', 'origin', origin]);
  await git(repo, ['push', '-q', 'origin', 'develop']);
  const run = async (...args) => (await runCommand(['worktree', ...args, '--project', repo, '--json'], { cwd: repo })).report;
  const source = async (id) => {
    const result = await run('bootstrap', '--task', `${id}:feat/${id}`, '--write');
    assert.equal(result.status, 'passed', JSON.stringify(result));
    const directory = path.join(root, 'worktrees', id);
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(path.join(directory, `src/${id}.txt`), id);
    await git(directory, ['add', '.']);
    await git(directory, ['commit', '-qm', 'feat: task']);
    return directory;
  };
  const stage = async (id) => {
    const result = await run('stage', '--task', id, '--write');
    assert.equal(result.status, 'passed', JSON.stringify(result));
    return result;
  };
  const installHook = async () => {
    await writeFile(path.join(repo, '.git/hooks/pre-push'), `#!/bin/sh\nexec node "${hook}" pre-push "$@"\n`);
    await chmod(path.join(repo, '.git/hooks/pre-push'), 0o755);
  };
  const state = async (id) => JSON.parse(await readFile(path.join(repo, '.git', `vibe-harness-land-batch-${id}.json`), 'utf8'));
  return { root, repo, origin, config, counter, run, source, stage, state, installHook };
}

async function parentFixture() {
  const f = await fixture({ files: { '.gitignore': '.vibe-harness/\nnode_modules/\ndocs/plans/\n' } });
  const boot = await f.run('bootstrap', '--task', 'ENG-P:feat/ENG-P', '--write');
  assert.equal(boot.status, 'passed', JSON.stringify(boot));
  const source = path.join(f.root, 'worktrees', 'ENG-P');
  await mkdir(path.join(source, 'src'), { recursive: true });
  const base = await git(source, ['rev-parse', 'HEAD']);
  const units = ['A', 'B', 'C'].map((letter, index, all) => ({
    id: `ENG-${letter}`, kind: 'write', files: [`src/${letter}.txt`], acceptance: [`A-00${index + 1}`],
    dependsOn: index ? [`ENG-${all[index - 1]}`] : [],
  }));
  const executionBatch = { parentId: 'ENG-P', members: units.map((unit) => unit.id),
    worktree: source, branch: 'feat/ENG-P', targetRef: 'refs/heads/develop', baseSha: base };
  const planPath = path.join(source, 'docs/plans/parent.md');
  const plan = (batch = executionBatch, nextUnits = units) => [
    '# Parent batch', '## Goal', 'Deliver required children.', '## Non-goals', 'Do not publish partial work.',
    '## Plan of Work', 'One writer in native dependency order.', '## Validation and Acceptance',
    '| ID | Criterion |', '|---|---|', ...nextUnits.map((unit, index) => `| A-00${index + 1} | ${unit.id} content is correct |`),
    '```plan-units', JSON.stringify({ allowedScope: ['src/**'], units: nextUnits, executionBatch: batch }), '```',
  ].join('\n');
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, plan());
  const task = async (...args) => (await runCommand(['task', ...args, '--json'], { cwd: source })).report;
  const init = await task('init', 'ENG-P', '--title', 'Parent', '--goal', 'Deliver children',
    '--plan-file', 'docs/plans/parent.md', '--write');
  assert.equal(init.status, 'passed', JSON.stringify(init));
  const complete = async (letter, { record = true, message = `feat(ENG-${letter}): deliver ${letter}` } = {}) => {
    await writeFile(path.join(source, `src/${letter}.txt`), `${letter}\n`);
    await git(source, ['add', `src/${letter}.txt`]);
    const verified = (await runCommand(['verify', '--task', 'ENG-P', '--unit', `ENG-${letter}`, '--json'], { cwd: source })).report;
    assert.equal(verified.status, 'passed', JSON.stringify(verified));
    await git(source, ['commit', '-qm', message]);
    const head = await git(source, ['rev-parse', 'HEAD']);
    if (record) {
      const saved = await task('update', 'ENG-P', '--unit', `ENG-${letter}`, '--unit-status', `ENG-${letter}:done`,
        '--verification', JSON.stringify(verified), '--write');
      assert.equal(saved.status, 'passed', JSON.stringify(saved));
    }
    return { head, verified };
  };
  const finish = async () => {
    const heads = [];
    for (const letter of ['A', 'B', 'C']) heads.push((await complete(letter)).head);
    return heads;
  };
  return { ...f, source, task, complete, finish, units, executionBatch, planPath, plan };
}

test('Parent 三个 Issue 共用一个任务树逐项提交，完成前远端不变，整批一次交付保留 SHA', async () => {
  const f = await parentFixture();
  try {
    const initial = await git(f.origin, ['rev-parse', 'develop']);
    const a = await f.complete('A');
    const premature = await f.run('stage', '--task', 'ENG-P', '--write');
    assert.equal(premature.integrationStatus, 'not_integrated');
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), initial);
    const bypass = await f.run('stage', '--task', 'ENG-A:feat/ENG-P', '--write');
    assert.equal(bypass.integrationStatus, 'not_integrated', '子 Issue 不能绕过 Parent 发布边界');
    const b = await f.complete('B');
    const dispatch = await f.task('check', 'ENG-P', '--unit', 'ENG-C', '--dispatch');
    assert.equal(dispatch.status, 'passed', JSON.stringify(dispatch));
    const c = await f.complete('C');
    const worktrees = await git(f.repo, ['worktree', 'list', '--porcelain']);
    assert.equal(worktrees.split('\n').filter((line) => line.startsWith('worktree ')).length, 2);
    for (const [letter, head] of [['A', a.head], ['B', b.head], ['C', c.head]]) {
      assert.equal(await git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]), `src/${letter}.txt`);
      assert.match(await git(f.repo, ['show', '-s', '--format=%s', head]), new RegExp(`ENG-${letter}`));
    }
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), initial);
    const staged = await f.run('stage', '--task', 'ENG-P', '--write');
    assert.equal(staged.status, 'passed', JSON.stringify(staged));
    assert.equal(staged.integrationStatus, 'local_staged');
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), initial);
    const localOnly = await f.task('check', 'ENG-P', '--complete');
    assert.equal(localOnly.deliveryStatus, 'not_published');
    const state = await f.state(staged.batchId);
    assert.equal(state.sources.length, 1);
    assert.equal(state.sources[0].id, 'ENG-P');
    assert.deepEqual(state.sources[0].executionBatch.members.map((unit) => unit.id), ['ENG-A', 'ENG-B', 'ENG-C']);
    assert.deepEqual(state.sources[0].executionBatch.members.map((unit) => unit.verificationId),
      [a, b, c].map((unit) => unit.verified.verification.id));
    const stageChecks = (await readFile(f.counter, 'utf8')).trim().split('\n').length;
    const reusedStage = await f.run('stage', '--resume', staged.batchId, '--write');
    assert.equal(reusedStage.status, 'passed', JSON.stringify(reusedStage));
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').length, stageChecks,
      '同一有效 stage 收据无需重复验证');
    const published = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.equal(published.integrationStatus, 'integrated_cleanup_pending', JSON.stringify(published));
    assert.equal(existsSync(f.source), true, 'Linear 回写完成前保留共享任务锚点和工作区');
    assert.equal((await f.task('check', 'ENG-P', '--complete')).deliveryStatus, 'remote_confirmed');
    const remote = await git(f.origin, ['rev-parse', 'develop']);
    for (const head of [a.head, b.head, c.head]) await git(f.repo, ['merge-base', '--is-ancestor', head, remote]);
    const checks = (await readFile(f.counter, 'utf8')).trim().split('\n');
    assert.ok(checks.includes(staged.candidateHead), '最终候选也必须取得验证');
    const count = checks.length;
    const retry = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.equal(retry.pushed, false);
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').length, count);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), remote);
    assert.equal(existsSync(f.source), true, '状态回写失败后重试 publish 也不得清理任务工作区');
    const cleaned = await f.run('cleanup', '--batch', staged.batchId, '--write');
    assert.equal(cleaned.integrationStatus, 'integrated', JSON.stringify(cleaned));
    assert.equal(existsSync(f.source), false);
    const cleanupRetry = await f.run('cleanup', '--batch', staged.batchId, '--write');
    assert.equal(cleanupRetry.pushed, false);
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').length, count);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 的任务检查与真实 DAG 检查一致放行批内前驱，批外及 Parent 不提前成功', async () => {
  const f = await parentFixture();
  try {
    await f.complete('A');
    const evidence = await taskParentBatchEvidence(f.source, 'ENG-P');
    const nodes = f.units.map((unit) => ({ id: unit.id, kind: unit.kind, output: unit.id,
      dependsOn: unit.dependsOn, writeScope: unit.files, resourceLocks: [], verification: ['node check.mjs'],
      result: unit.id === 'ENG-A' ? 'unverified' : 'pending' }));
    nodes.push({ id: 'OUTSIDE', kind: 'read', output: 'outside', dependsOn: ['ENG-A'], writeScope: [], result: 'pending' });
    nodes.push({ id: 'ENG-P', kind: 'aggregate', output: 'fan-in', dependsOn: ['ENG-A', 'ENG-B', 'ENG-C'], writeScope: [], result: 'pending' });
    const dag = { executionBatch: { parentId: 'ENG-P', worktree: f.source }, nodes };
    const analysis = validateTaskDag(dag, { batchEvidence: evidence });
    assert.equal(checkTaskDagNode(analysis, 'ENG-B').ready, true, JSON.stringify(analysis));
    assert.equal(checkTaskDagNode(analysis, 'OUTSIDE').ready, false);
    assert.equal(checkTaskDagNode(analysis, 'ENG-P').ready, false);
    assert.equal(analysis.nodes.find((node) => node.id === 'ENG-A').result, 'unverified');
    const forged = validateTaskDag({ ...dag, batchEvidence: evidence });
    assert.equal(checkTaskDagNode(forged, 'ENG-B').ready, false, 'JSON 自报证据不能放行');
    const file = path.join(f.source, '.vibe-harness/dag.json');
    await writeFile(file, JSON.stringify(dag));
    const { stdout } = await exec(process.execPath, [path.join(import.meta.dirname, '../../scripts/task-dag.js'),
      'check', '--file', file, '--node', 'ENG-B', '--json'], { cwd: f.source, windowsHide: true });
    assert.equal(JSON.parse(stdout).dispatch.ready, true);
    nodes[1].dependsOn = [];
    const drifted = validateTaskDag(dag, { batchEvidence: evidence });
    assert.equal(drifted.structureValid, false);
    nodes[1].dependsOn = ['ENG-A'];
    const missingProof = { ...evidence, localCompleted: [] };
    nodes[0].result = 'succeeded';
    assert.equal(checkTaskDagNode(validateTaskDag(dag, { batchEvidence: missingProof }), 'ENG-B').ready, false,
      'DAG 自报 succeeded 不能替代批内提交证据');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 无依赖成员按稳定顺序串行且不新增依赖，追加修复保留旧提交证据', async () => {
  const f = await parentFixture();
  try {
    const independent = f.units.map((unit) => ({ ...unit, dependsOn: [] }));
    await writeFile(f.planPath, f.plan(f.executionBatch, independent));
    await f.task('plan-sync', 'ENG-P', '--reason', 'User confirmed independent members', '--write');
    const nodes = independent.map((unit) => ({ id: unit.id, kind: 'write', output: unit.id,
      writeScope: unit.files, resourceLocks: [], dependsOn: [], verification: ['node check.mjs'], result: 'pending' }));
    const dag = { executionBatch: { parentId: 'ENG-P', worktree: f.source }, nodes };
    const ready = () => f.task('check', 'ENG-P', '--unit', 'ENG-B', '--dispatch');
    assert.equal((await ready()).code, 'VIBE_HARNESS_PARENT_BATCH_SINGLE_WRITER');
    let evidence = await taskParentBatchEvidence(f.source, 'ENG-P');
    assert.deepEqual(validateTaskDag(dag, { batchEvidence: evidence }).ready, ['ENG-A']);
    const first = await f.complete('A', { message: 'feat: deliver A\n\nRefs ENG-A' });
    assert.equal((await ready()).status, 'passed');
    await f.task('update', 'ENG-P', '--unit-status', 'ENG-B:in_progress', '--write');
    assert.equal((await f.task('check', 'ENG-P', '--unit', 'ENG-C', '--dispatch')).status, 'failed');
    const overlap = await f.task('update', 'ENG-P', '--unit-status', 'ENG-C:in_progress', '--write');
    assert.equal(overlap.code, 'VIBE_HARNESS_PARENT_BATCH_SINGLE_WRITER');
    await f.complete('B');
    await writeFile(path.join(f.source, 'src/A.txt'), 'A fix\n');
    await git(f.source, ['add', 'src/A.txt']);
    const verification = (await runCommand(['verify', '--task', 'ENG-P', '--unit', 'ENG-A', '--json'], { cwd: f.source })).report;
    await git(f.source, ['commit', '-qm', 'fix(ENG-A): follow-up correction']);
    assert.equal((await f.task('update', 'ENG-P', '--unit', 'ENG-A', '--verification',
      JSON.stringify(verification), '--write')).status, 'passed');
    evidence = await taskParentBatchEvidence(f.source, 'ENG-P');
    assert.deepEqual(evidence.localCompleted, ['ENG-A', 'ENG-B']);
    assert.deepEqual(evidence.dependencies, { 'ENG-A': [], 'ENG-B': [], 'ENG-C': [] });
    assert.deepEqual(evidence.unmappedCommits, []);
    assert.deepEqual(validateTaskDag(dag, { batchEvidence: evidence }).ready, ['ENG-C']);
    await git(f.source, ['merge-base', '--is-ancestor', first.head, 'HEAD']);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), f.executionBatch.baseSha);
  } finally { await removeTemporaryDirectory(f.root); }
});

for (const invalid of ['dirty', 'hook-tree', 'forged-receipt', 'check-definition', 'rewritten-history']) {
  test(`Parent 本地证据在 ${invalid} 时阻断且保留现场`, async () => {
    const f = await parentFixture();
    try {
      const a = await f.complete('A');
      if (invalid === 'dirty') await writeFile(path.join(f.source, 'unexpected.txt'), 'preserve');
      if (invalid === 'hook-tree') {
        await writeFile(path.join(f.source, 'src/A.txt'), 'hook changed content\n');
        await git(f.source, ['add', 'src/A.txt']);
        await git(f.source, ['commit', '-qm', 'fix(ENG-A): Hook changed tree']);
        const rebound = await f.task('update', 'ENG-P', '--unit', 'ENG-A', '--verification', JSON.stringify(a.verified), '--write');
        assert.equal(rebound.code, 'VIBE_HARNESS_LOCAL_COMPLETION_INVALID');
        return;
      }
      if (invalid === 'forged-receipt') {
        const fake = structuredClone(a.verified);
        fake.verification.id = 'invented-verification';
        const rejected = await f.task('update', 'ENG-P', '--unit', 'ENG-A', '--verification', JSON.stringify(fake), '--write');
        assert.equal(rejected.code, 'VIBE_HARNESS_LOCAL_COMPLETION_INVALID');
        return;
      }
      if (invalid === 'check-definition') {
        f.config.validationCommands.test = 'node --version';
        f.config.validationCommands.tiers.quick = ['node --version'];
        await writeFile(path.join(f.source, 'vibe-harness.config.json'), JSON.stringify(f.config));
        await git(f.source, ['add', 'vibe-harness.config.json']);
        await git(f.source, ['commit', '-qm', 'chore: change validation']);
      }
      if (invalid === 'rewritten-history') await git(f.source, ['commit', '--amend', '-qm', 'feat(ENG-A): replaced history']);
      const ready = await f.task('check', 'ENG-P', '--unit', 'ENG-B', '--dispatch');
      assert.equal(ready.status, 'failed');
      assert.equal(await git(f.origin, ['rev-parse', 'develop']), f.executionBatch.baseSha);
      if (invalid === 'dirty') assert.equal(await readFile(path.join(f.source, 'unexpected.txt'), 'utf8'), 'preserve');
    } finally { await removeTemporaryDirectory(f.root); }
  });
}

test('Parent 成员变化在 stage 后继续阻断 publish，确认 plan-sync 不自动完成新成员', async () => {
  const f = await parentFixture();
  try {
    await f.finish();
    const staged = await f.run('stage', '--task', 'ENG-P', '--write');
    assert.equal(staged.status, 'passed', JSON.stringify(staged));
    const nextUnits = [...f.units, { id: 'ENG-D', files: ['src/D.txt'], acceptance: ['A-004'], dependsOn: ['ENG-C'] }];
    await writeFile(f.planPath, f.plan({ ...f.executionBatch, members: [...f.executionBatch.members, 'ENG-D'] }, nextUnits));
    assert.equal((await f.task('plan-check', 'ENG-P')).code, 'VIBE_HARNESS_PLAN_DRIFT');
    const refused = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.notEqual(refused.integrationStatus, 'integrated');
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), f.executionBatch.baseSha);
    const sync = await f.task('plan-sync', 'ENG-P', '--reason', 'User confirmed adding ENG-D', '--write');
    assert.equal(sync.status, 'passed');
    const added = sync.anchor?.units?.find((unit) => unit.id === 'ENG-D');
    const anchor = added ? sync.anchor : JSON.parse(await readFile(path.join(f.source, '.vibe-harness/tasks/ENG-P.json')));
    assert.equal(anchor.units.find((unit) => unit.id === 'ENG-D').status, 'pending');
    assert.equal((await f.run('stage', '--task', 'ENG-P', '--write')).integrationStatus, 'not_integrated');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 拒绝外部交付循环、未知依赖和多目标，外部前驱未交付不放行', async () => {
  const f = await parentFixture();
  try {
    const cycleUnits = f.units.map((unit) => ({ ...unit, dependsOn: unit.id === 'ENG-B' ? ['OUTSIDE'] : unit.dependsOn }));
    const contract = parentBatchContract({ ...f.executionBatch,
      externalDependencies: [{ id: 'OUTSIDE', dependsOn: ['ENG-A'], result: 'pending' }] }, cycleUnits);
    assert.match(contract.errors.join('\n'), /delivery cycle/u);
    assert.ok(parentBatchContract({ ...f.executionBatch, targetRef: 'refs/heads/main' }, f.units).errors.length);
    assert.ok(parentBatchContract(f.executionBatch, [{ ...f.units[0], dependsOn: ['MISSING'] }, ...f.units.slice(1)]).errors.length);
    await writeFile(f.planPath, f.plan({ ...f.executionBatch,
      externalDependencies: [{ id: 'OUTSIDE', dependsOn: [], result: 'pending' }] },
    f.units.map((unit) => ({ ...unit, dependsOn: unit.id === 'ENG-A' ? ['OUTSIDE'] : unit.dependsOn }))));
    await f.task('plan-sync', 'ENG-P', '--reason', 'User confirmed external relation', '--write');
    assert.equal((await f.task('check', 'ENG-P', '--unit', 'ENG-A', '--dispatch')).status, 'failed');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 计划修订可在最终树重验旧提交，只读任务不制造空提交', async () => {
  const f = await parentFixture();
  try {
    const a = await f.complete('A');
    const revised = f.units.map((unit) => unit.id === 'ENG-B' ? { ...unit, kind: 'read', files: [] } : unit);
    await writeFile(f.planPath, f.plan(f.executionBatch, revised));
    assert.equal((await f.task('plan-sync', 'ENG-P', '--reason', 'User confirmed B as read-only', '--write')).status, 'passed');
    const before = await git(f.source, ['rev-parse', 'HEAD']);
    for (const id of ['ENG-A', 'ENG-B']) {
      const verification = (await runCommand(['verify', '--task', 'ENG-P', '--unit', id, '--json'], { cwd: f.source })).report;
      const saved = await f.task('update', 'ENG-P', '--unit', id, '--unit-status', `${id}:done`,
        '--verification', JSON.stringify(verification), '--write');
      assert.equal(saved.status, 'passed', JSON.stringify(saved));
    }
    assert.equal(await git(f.source, ['rev-parse', 'HEAD']), before, '重验与读取任务都不应制造提交');
    assert.equal((await f.task('check', 'ENG-P', '--unit', 'ENG-C', '--dispatch')).status, 'passed');
    await f.complete('C');
    const state = await taskParentBatchEvidence(f.source, 'ENG-P');
    assert.deepEqual(state.localCompleted, ['ENG-A', 'ENG-B', 'ENG-C']);
    assert.deepEqual(state.unmappedCommits, []);
    await git(f.source, ['merge-base', '--is-ancestor', a.head, 'HEAD']);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 子任务失败保留已提交前驱和失败现场，不发布部分结果', async () => {
  const f = await parentFixture();
  try {
    const a = await f.complete('A');
    await writeFile(path.join(f.source, 'src/B.txt'), 'failed implementation\n');
    await f.task('update', 'ENG-P', '--unit-status', 'ENG-B:failed', '--failure', 'focused verification failed', '--write');
    assert.equal((await f.task('check', 'ENG-P', '--unit', 'ENG-C', '--dispatch')).status, 'failed');
    assert.equal((await f.run('stage', '--task', 'ENG-P', '--write')).integrationStatus, 'not_integrated');
    assert.equal(await git(f.source, ['rev-parse', 'HEAD']), a.head);
    assert.equal(await readFile(path.join(f.source, 'src/B.txt'), 'utf8'), 'failed implementation\n');
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), f.executionBatch.baseSha);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('Parent 复用冻结基线中已交付任务的提交，不制造空提交且不提前宣布整批完成', async () => {
  const f = await parentFixture();
  try {
    await writeFile(path.join(f.source, 'src/A.txt'), 'previously delivered A\n');
    await git(f.source, ['add', 'src/A.txt']);
    await git(f.source, ['commit', '-qm', 'feat: deliver existing task\n\nRefs ENG-A']);
    const delivered = await git(f.source, ['rev-parse', 'HEAD']);
    // This is fixture setup: A was delivered before the new batch baseline.
    await git(f.source, ['push', '-q', 'origin', 'HEAD:refs/heads/develop']);
    const units = f.units.map((unit) => unit.id === 'ENG-A' ? { ...unit, deliveredCommit: delivered } : unit);
    await writeFile(f.planPath, f.plan({ ...f.executionBatch, baseSha: delivered }, units));
    assert.equal((await f.task('plan-sync', 'ENG-P', '--reason', 'User confirmed prior delivery as baseline', '--write')).status, 'passed');
    const verification = (await runCommand(['verify', '--task', 'ENG-P', '--unit', 'ENG-A', '--json'], { cwd: f.source })).report;
    const saved = await f.task('update', 'ENG-P', '--unit', 'ENG-A', '--unit-status', 'ENG-A:done',
      '--verification', JSON.stringify(verification), '--write');
    assert.equal(saved.status, 'passed', JSON.stringify(saved));
    assert.equal(await git(f.source, ['rev-parse', 'HEAD']), delivered);
    assert.equal((await f.task('check', 'ENG-P', '--unit', 'ENG-B', '--dispatch')).status, 'passed');
    assert.equal((await f.task('check', 'ENG-P', '--complete')).deliveryStatus, 'not_published');
    const state = await taskParentBatchEvidence(f.source, 'ENG-P');
    assert.deepEqual(state.localCompleted, ['ENG-A']);
    assert.deepEqual(state.unmappedCommits, []);
  } finally { await removeTemporaryDirectory(f.root); }
});

for (const mode of ['advance', 'conflict', 'protected', 'multi-push', 'hook']) {
  test(`Parent 统一发布在 ${mode} 时复用远端同步与拒绝边界`, async () => {
    const f = await parentFixture();
    try {
      const heads = await f.finish();
      const staged = await f.run('stage', '--task', 'ENG-P', '--write');
      assert.equal(staged.status, 'passed', JSON.stringify(staged));
      let remoteBefore = f.executionBatch.baseSha;
      if (['advance', 'conflict'].includes(mode)) {
        const other = path.join(f.root, 'other-clone');
        await git(f.root, ['clone', '-q', '-b', 'develop', f.origin, other]);
        await git(other, ['config', 'user.name', 'Other']);
        await git(other, ['config', 'user.email', 'other@example.invalid']);
        await mkdir(path.join(other, 'src'), { recursive: true });
        await writeFile(path.join(other, mode === 'conflict' ? 'src/A.txt' : 'remote.txt'), 'remote change\n');
        await git(other, ['add', '.']);
        await git(other, ['commit', '-qm', 'feat(remote): advance develop']);
        await git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/develop']);
        remoteBefore = await git(f.origin, ['rev-parse', 'develop']);
      }
      if (mode === 'protected') {
        const receiver = path.join(f.origin, 'hooks/pre-receive');
        await writeFile(receiver, '#!/bin/sh\necho "protected branch: direct updates rejected" >&2\nexit 1\n');
        await chmod(receiver, 0o755);
      }
      if (mode === 'multi-push') {
        await git(f.repo, ['config', '--add', 'remote.origin.pushurl', f.origin]);
        await git(f.repo, ['config', '--add', 'remote.origin.pushurl', path.join(f.root, 'another.git')]);
      }
      if (mode === 'hook') {
        const prePush = path.join(f.repo, '.git/hooks/pre-push');
        await writeFile(prePush, '#!/bin/sh\nexit 1\n');
        await chmod(prePush, 0o755);
      }
      const result = await f.run('publish', '--batch', staged.batchId, '--write');
      if (mode === 'advance') {
        assert.equal(result.integrationStatus, 'integrated_cleanup_pending', JSON.stringify(result));
        const final = await git(f.origin, ['rev-parse', 'develop']);
        await git(f.repo, ['merge-base', '--is-ancestor', remoteBefore, final]);
        for (const head of heads) await git(f.repo, ['merge-base', '--is-ancestor', head, final]);
        assert.ok((await readFile(f.counter, 'utf8')).trim().split('\n').includes(final), '新基线候选必须重验');
      } else {
        assert.notEqual(result.integrationStatus, 'integrated', JSON.stringify(result));
        assert.equal(await git(f.origin, ['rev-parse', 'develop']), remoteBefore);
        for (const head of heads) await git(f.repo, ['cat-file', '-e', `${head}^{commit}`]);
        assert.equal(await git(f.source, ['rev-parse', 'HEAD']), heads.at(-1));
      }
    } finally { await removeTemporaryDirectory(f.root); }
  });
}

test('delivery policy is identical for CLI/runtime and never omits required high-risk checks for quick', async () => {
  const f = await fixture();
  try {
    f.config.validationCommands.tiers.standard = ['node --version'];
    f.config.validationCommands.tiers.deep = ['node --no-warnings --version'];
    await writeFile(path.join(f.repo, 'vibe-harness.config.json'), JSON.stringify(f.config));
    for (const changedPath of ['runtime/lib/change.mjs', '.agents/runtime/lib/change.mjs', 'docs/schemas/test.json', 'apps/a/pnpm-lock.yaml', 'unknown.xyz']) {
      const shared = buildDeliveryVerificationPlan({ changedPaths: [changedPath], config: f.config, projectDir: f.repo, tier: 'quick' });
      const cli = await buildVerificationPlan({ changedPaths: [changedPath], config: f.config, targetDir: f.repo, tier: 'quick', delivery: true });
      const runtime = await verifyProject(f.repo, { deliveryEvidence: true, paths: [changedPath], tier: 'quick' }, { planOnly: true });
      assert.equal(shared.riskLevel, 'high', changedPath);
      assert.deepEqual(cli.selectedNames, shared.selectedNames);
      assert.deepEqual(runtime.selectedChecks, shared.selectedNames);
      assert.ok(shared.selectedChecks.some((check) => check.command === 'node --version'));
    }
    const unknown = buildDeliveryVerificationPlan({ changedPaths: ['src/a.js'], config: f.config, projectDir: f.repo, scopeConfidence: 'lower-bound' });
    assert.ok(unknown.selectedChecks.some((check) => check.costTier === 'deep'));
  } finally { await removeTemporaryDirectory(f.root); }
});

test('candidate identities and ports differ; named resources block only the matching checks', async () => {
  const f = await fixture();
  try {
    await f.source('A'); await f.source('B');
    const [a, b] = await Promise.all([f.stage('A'), f.stage('B')]);
    const ca = await readCandidateResources(f.repo, a.candidatePath);
    const cb = await readCandidateResources(f.repo, b.candidatePath);
    assert.notEqual(ca.id, cb.id);
    assert.notEqual(ca.namespace, cb.namespace);
    assert.notDeepEqual(ca.ports, cb.ports);
    const lock = await acquireCheckResources(a.candidatePath, ['db/shared']);
    assert.equal(lock.ok, true);
    try {
      const blocked = await acquireCheckResources(b.candidatePath, ['db/shared'], { timeoutMs: 80 });
      assert.equal(blocked.code, 'CHECK_RESOURCE_BUSY');
      const unrelated = await acquireCheckResources(b.candidatePath, ['db/other'], { timeoutMs: 80 });
      assert.equal(unrelated.ok, true);
      unrelated.release();
    } finally { lock.release(); }
  } finally { await removeTemporaryDirectory(f.root); }
});

test('native managed push consumes exact proof once; cleanup retry does not rerun checks or push', async () => {
  const f = await fixture();
  try {
    await f.source('A');
    const staged = await f.stage('A');
    await f.installHook();
    await writeFile(path.join(f.repo, 'dirty-user.txt'), 'preserve');
    const published = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.equal(published.integrationStatus, 'integrated', JSON.stringify(published));
    assert.equal((await readFile(f.counter, 'utf8')).trim(), staged.candidateHead);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), staged.candidateHead);
    const dry = await f.run('cleanup', '--batch', staged.batchId);
    assert.equal(dry.status, 'planned');
    const retry = await f.run('cleanup', '--batch', staged.batchId, '--write');
    assert.equal(retry.alreadyCleaned, true);
    assert.equal(retry.pushed, false);
    assert.equal((await readFile(f.counter, 'utf8')).trim(), staged.candidateHead);
    assert.equal(await readFile(path.join(f.repo, 'dirty-user.txt'), 'utf8'), 'preserve');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('proof rejects changed ref, dependency bytes, environment and tampering; attempts are single-use', async () => {
  const f = await fixture();
  const previous = process.env.VH_PROOF_TEST;
  try {
    await f.source('A');
    const staged = await f.stage('A');
    const state = await f.state(staged.batchId);
    assert.equal((await inspectPushVerification(f.repo, state.pushProof)).ok, true);
    const endpoint = { url: f.origin, ref: 'refs/heads/develop' };
    const attempt = await preparePushAttempt(f.repo, state.pushProof, endpoint);
    assert.equal(attempt.ok, true);
    assert.equal((await inspectPushVerification(f.repo, attempt.id,
      { ...endpoint, sha: staged.candidateHead, ref: 'refs/heads/other' })).ok, false);
    assert.equal((await inspectPushVerification(f.repo, attempt.id, { ...endpoint, sha: staged.candidateHead })).ok, true);
    assert.equal((await inspectPushVerification(f.repo, attempt.id, { ...endpoint, sha: staged.candidateHead })).ok, false);
    process.env.VH_PROOF_TEST = randomUUID();
    assert.equal((await inspectPushVerification(f.repo, state.pushProof)).code, 'PUSH_PROOF_STALE');
    if (previous === undefined) delete process.env.VH_PROOF_TEST; else process.env.VH_PROOF_TEST = previous;
    await mkdir(path.join(staged.candidatePath, 'node_modules'), { recursive: true });
    await writeFile(path.join(staged.candidatePath, 'node_modules/input'), 'changed');
    assert.equal((await inspectPushVerification(f.repo, state.pushProof)).code, 'PUSH_PROOF_STALE');
    const proofFile = path.join(f.repo, '.git/vibe-harness-push-proofs', `${state.pushProof}.json`);
    const proof = JSON.parse(await readFile(proofFile, 'utf8'));
    proof.head = 'a'.repeat(40);
    await writeFile(proofFile, JSON.stringify(proof));
    assert.equal((await inspectPushVerification(f.repo, state.pushProof)).ok, false);
  } finally {
    if (previous === undefined) delete process.env.VH_PROOF_TEST; else process.env.VH_PROOF_TEST = previous;
    await removeTemporaryDirectory(f.root);
  }
});

test('ordinary multi-ref push checks pushed SHA once despite dirty primary and ignores deleted refs', async () => {
  const f = await fixture();
  try {
    const source = await f.source('A');
    const head = await git(source, ['rev-parse', 'HEAD']);
    await f.installHook();
    await writeFile(path.join(f.repo, 'check.mjs'), 'throw new Error("dirty checkout must not execute");\n');
    await git(f.repo, ['push', 'origin', `${head}:refs/heads/one`, `${head}:refs/heads/two`]);
    assert.equal((await readFile(f.counter, 'utf8')).trim(), head);
    await git(f.repo, ['push', 'origin', ':refs/heads/one']);
    assert.equal((await readFile(f.counter, 'utf8')).trim(), head);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('isolated native push candidate preserves pnpm package dependency adjacency', async () => {
  const f = await fixture({
    worktree: { dependencyMode: 'isolated' },
    validationCommands: {
      test: 'node package-check.cjs',
      tiers: { quick: ['node package-check.cjs'], standard: ['node package-check.cjs'], deep: [] },
      checks: [{ id: 'test', command: 'node package-check.cjs', deterministic: true }],
    },
    files: { 'package-check.cjs': "if (require('fixture-package') !== 'ok') process.exit(1);\n" },
  });
  try {
    const packageRoot = path.join(f.repo, 'node_modules/.pnpm/fixture-package@1.0.0/node_modules/fixture-package');
    const optionalRoot = path.join(f.repo, 'node_modules/.pnpm/fixture-package@1.0.0/node_modules/fixture-optional');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(optionalRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'index.js'), "module.exports = require('fixture-optional');\n");
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-package', version: '1.0.0', main: 'index.js' }));
    await writeFile(path.join(optionalRoot, 'index.js'), "module.exports = 'ok';\n");
    await writeFile(path.join(optionalRoot, 'package.json'), JSON.stringify({ name: 'fixture-optional', version: '1.0.0', main: 'index.js' }));
    await symlink(packageRoot, path.join(f.repo, 'node_modules/fixture-package'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const source = await f.source('A');
    const head = await git(source, ['rev-parse', 'HEAD']);
    await f.installHook();
    await git(f.repo, ['push', 'origin', `${head}:refs/heads/native-deps`]);
    assert.equal(await git(f.origin, ['rev-parse', 'native-deps']), head);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('proof creation rejects inputs changed after verification instead of signing stale evidence', async () => {
  const f = await fixture();
  const previous = process.env.VH_PROOF_CREATION_TEST;
  try {
    await mkdir(path.join(f.repo, 'node_modules'), { recursive: true });
    const dependency = path.join(f.repo, 'node_modules/input');
    await writeFile(dependency, 'before');
    const verification = await verifyProject(f.repo, {});
    assert.equal(verification.status, 'passed', JSON.stringify(verification));
    const state = { candidate: f.repo, id: randomUUID() };
    assert.ok(await createPushVerification(f.repo, state, verification));
    process.env.VH_PROOF_CREATION_TEST = randomUUID();
    assert.equal(await createPushVerification(f.repo, state, verification), null,
      'changed environment must invalidate the evidence before signing');
    if (previous === undefined) delete process.env.VH_PROOF_CREATION_TEST;
    else process.env.VH_PROOF_CREATION_TEST = previous;
    await writeFile(dependency, 'after!');
    assert.equal(await createPushVerification(f.repo, state, verification), null,
      'ignored dependency bytes must match the original verification');
  } finally {
    if (previous === undefined) delete process.env.VH_PROOF_CREATION_TEST;
    else process.env.VH_PROOF_CREATION_TEST = previous;
    await removeTemporaryDirectory(f.root);
  }
});

test('externally integrated dirty source is retained, then batch cleanup finishes without merging or pushing', async () => {
  const f = await fixture();
  try {
    const source = await f.source('A');
    const staged = await f.stage('A');
    await git(f.repo, ['push', 'origin', `${staged.sourceHead}:refs/heads/develop`]);
    await writeFile(path.join(source, 'dirty.txt'), 'preserve');
    const integrated = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.equal(integrated.integrationStatus, 'integrated_cleanup_pending', JSON.stringify(integrated));
    assert.equal(existsSync(source), true);
    // Restore only this fixture's deliberately added file.
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(source, 'dirty.txt'));
    const retry = await f.run('cleanup', '--batch', staged.batchId, '--write');
    assert.equal(retry.integrationStatus, 'integrated', JSON.stringify(retry));
    assert.equal(retry.pushed, false);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), staged.sourceHead);
    assert.equal((await readFile(f.counter, 'utf8')).trim(), staged.candidateHead);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('candidate journal retains stopped ownership after directory removal and rejects foreign identity', async () => {
  const f = await fixture();
  try {
    await f.source('A');
    const staged = await f.stage('A');
    const context = await readCandidateResources(f.repo, staged.candidatePath);
    await assert.rejects(saveCandidateResources(f.repo, staged.candidatePath, { ...context, id: 'foreign' }), /ownership/);
    await saveCandidateResources(f.repo, staged.candidatePath, { ...context, phase: 'stopped' });
    await git(f.repo, ['worktree', 'remove', staged.candidatePath]);
    assert.equal((await readCandidateResources(f.repo, staged.candidatePath)).phase, 'stopped');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('partial setup resumes only the unfinished step and failed teardown retains resource ownership', async () => {
  const f = await fixture({
    worktree: { provision: {
      candidateSetupCommands: ['node setup.mjs first', 'node setup.mjs second'],
      candidateTeardownCommands: ['node setup.mjs stop'],
    } },
    files: { 'setup.mjs': `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
const step=process.argv[2];
if (!process.env.VIBE_HARNESS_RESOURCE_STEP || !process.env.VIBE_HARNESS_WORKSPACE_ID) process.exit(9);
if (step==='second' && !existsSync('.vibe-harness/retried')) {
  writeFileSync('.vibe-harness/retried','1'); process.exit(2);
}
if (step==='stop' && !existsSync('.vibe-harness/stop-ready')) process.exit(3);
appendFileSync('.vibe-harness/steps',step+'\\n');
` },
  });
  try {
    await f.source('A');
    const failed = await f.run('stage', '--task', 'A', '--write');
    assert.equal(failed.code, 'LAND_VERIFY_ENVIRONMENT_FAILED', JSON.stringify(failed));
    const state = await f.state(failed.batchId);
    const context = await readCandidateResources(f.repo, state.candidate);
    assert.equal(context.setupNext, 1);
    assert.equal(context.pendingStep, 'setup:1');
    assert.equal(context.dependencyMode, 'isolated');
    const resumed = await f.run('stage', '--resume', failed.batchId, '--write');
    assert.equal(resumed.status, 'passed', JSON.stringify(resumed));
    assert.equal(await readFile(path.join(state.candidate, '.vibe-harness/steps'), 'utf8'), 'first\nsecond\n');
    const published = await f.run('publish', '--batch', failed.batchId, '--write');
    assert.equal(published.integrationStatus, 'integrated_cleanup_pending', JSON.stringify(published));
    assert.equal((await readCandidateResources(f.repo, state.candidate)).pendingStep, 'teardown:0');
    await writeFile(path.join(state.candidate, '.vibe-harness/stop-ready'), '1');
    const cleanup = await f.run('cleanup', '--batch', failed.batchId, '--write');
    assert.equal(cleanup.integrationStatus, 'integrated', JSON.stringify(cleanup));
    assert.equal((await readCandidateResources(f.repo, state.candidate)).phase, 'cleaned');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('dependency-writing candidate owns copies and cannot change primary dependency bytes', async () => {
  const f = await fixture({ worktree: { dependencyMode: 'isolated' } });
  try {
    await mkdir(path.join(f.repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(f.repo, 'node_modules/input'), 'original');
    await f.source('A');
    const staged = await f.stage('A');
    await writeFile(path.join(staged.candidatePath, 'node_modules/input'), 'changed');
    assert.equal(await readFile(path.join(f.repo, 'node_modules/input'), 'utf8'), 'original');
    const state = await f.state(staged.batchId);
    assert.equal((await inspectPushVerification(f.repo, state.pushProof)).code, 'PUSH_PROOF_STALE');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('remote high-risk changes rebuild the required plan and failed integration never reaches the remote', async () => {
  const f = await fixture({
    validationCommands: { test: 'node check.mjs',
      tiers: { quick: ['node check.mjs'], standard: ['node integration.mjs'], deep: [] },
      checks: [{ id: 'test', command: 'node check.mjs', deterministic: true }] },
    files: { 'integration.mjs': 'process.exit(3);\n' },
  });
  try {
    await f.source('A');
    const staged = await f.stage('A');
    await mkdir(path.join(f.repo, 'schemas'));
    await writeFile(path.join(f.repo, 'schemas/remote.json'), '{}');
    await git(f.repo, ['add', '.']);
    await git(f.repo, ['commit', '-qm', 'feat: remote contract']);
    await git(f.repo, ['push', 'origin', 'develop']);
    const remote = await git(f.origin, ['rev-parse', 'develop']);
    const failed = await f.run('publish', '--batch', staged.batchId, '--write');
    assert.equal(failed.code, 'LAND_VERIFY_FAILED', JSON.stringify(failed));
    assert.ok(Object.values(failed.verification.checks).some((check) =>
      check.command === 'node integration.mjs' && check.status === 'failed'));
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), remote);
    const state = await f.state(staged.batchId);
    assert.equal(state.risk.riskLevel, 'high');
  } finally { await removeTemporaryDirectory(f.root); }
});
