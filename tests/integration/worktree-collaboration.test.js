import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCommand } from '../../runtime/commands/run.mjs';
import { acquireCheckResources } from '../../runtime/lib/check-resources.mjs';
import { buildDeliveryVerificationPlan } from '../../runtime/lib/verification-risk.mjs';
import { buildVerificationPlan } from '../../scripts/lib/verification-plan.js';
import { verifyProject } from '../../runtime/lib/verification-command.mjs';
import { executeCommand } from '../../runtime/lib/verification-plan-support.mjs';
import { processStartIdentity } from '../../runtime/lib/services.mjs';
import { createPushVerification, resolvePushBaseline } from '../../runtime/lib/push-verification.mjs';
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
    '# Parent batch', '## Goal', 'Deliver required children.', '## Non-goals', 'Do not integrate partial work.',
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

test('Parent local integration preserves all member commits and supports completion after automatic cleanup', async () => {
  const f = await parentFixture();
  try {
    const initial = await git(f.origin, ['rev-parse', 'develop']);
    await f.complete('A');
    assert.equal((await f.run('stage', '--task', 'ENG-P', '--write')).integrationStatus, 'not_integrated');
    assert.equal((await f.run('stage', '--task', 'ENG-A:feat/ENG-P', '--write')).integrationStatus, 'not_integrated');
    await f.complete('B');
    await f.complete('C');
    const checks = await readFile(f.counter, 'utf8');
    const staged = await f.run('stage', '--task', 'ENG-P', '--write');
    assert.equal(staged.integrationStatus, 'local_integrated', JSON.stringify(staged));
    assert.equal(existsSync(f.source), false);
    assert.equal(await readFile(f.counter, 'utf8'), checks);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), initial);
    const complete = (await runCommand(['task', 'check', 'ENG-P', '--complete', '--project', f.repo, '--json'], { cwd: f.repo })).report;
    assert.equal(complete.deliveryStatus, 'local_integrated', JSON.stringify(complete));
    assert.equal(complete.publication.localMergeCommit, staged.localMergeCommit);
    for (const member of complete.publication.members) {
      await git(f.repo, ['merge-base', '--is-ancestor', member.commit, 'develop']);
      const child = (await runCommand(['task', 'check', 'ENG-P', '--unit', member.id,
        '--complete', '--project', f.repo, '--json'], { cwd: f.repo })).report;
      assert.equal(child.deliveryStatus, 'local_integrated');
    }
    await writeFile(path.join(f.repo, 'later.txt'), 'later\n');
    await git(f.repo, ['add', '.']);
    await git(f.repo, ['commit', '-qm', 'feat: later local change']);
    const later = (await runCommand(['task', 'check', 'ENG-P', '--complete', '--project', f.repo, '--json'], { cwd: f.repo })).report;
    assert.equal(later.deliveryStatus, 'local_integrated', JSON.stringify(later));
    const state = await f.state(staged.batchId);
    state.sources[0].executionBatch.members[0].commit = '0'.repeat(40);
    await writeFile(path.join(f.repo, '.git', `vibe-harness-land-batch-${staged.batchId}.json`), JSON.stringify(state));
    const invalid = (await runCommand(['task', 'check', 'ENG-P', '--complete', '--project', f.repo, '--json'], { cwd: f.repo })).report;
    assert.notEqual(invalid.status, 'passed');
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
    assert.equal((await f.task('check', 'ENG-P', '--complete')).deliveryStatus, 'not_integrated');
    const state = await taskParentBatchEvidence(f.source, 'ENG-P');
    assert.deepEqual(state.localCompleted, ['ENG-A']);
    assert.deepEqual(state.unmappedCommits, []);
  } finally { await removeTemporaryDirectory(f.root); }
});

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

test('delivery preflight refuses unavailable inputs and mismatched candidates before product checks', async () => {
  const f = await fixture();
  try {
    const wrong = await verifyProject(f.repo, { expectedHead: 'a'.repeat(40) });
    assert.equal(wrong.code, 'VERIFICATION_CANDIDATE_MISMATCH');
    f.config.worktree.dependencyRoots = ['../invalid'];
    await writeFile(path.join(f.repo, 'vibe-harness.config.json'), JSON.stringify(f.config));
    const unavailable = await verifyProject(f.repo, { deliveryEvidence: true });
    assert.equal(unavailable.code, 'VERIFICATION_INPUTS_UNAVAILABLE');
    assert.equal(existsSync(f.counter), false);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('resource waiters run FIFO for overlapping resources without blocking disjoint checks', async () => {
  const f = await fixture();
  let holder, first, second, unrelated;
  try {
    holder = await acquireCheckResources(f.repo, ['backend'], { timeoutMs: 2000 });
    assert.equal(holder.ok, true);
    const order = [];
    const pendingFirst = acquireCheckResources(f.repo, ['backend'], { timeoutMs: 10000 }).then((lock) => {
      first = lock;
      order.push('first');
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pendingSecond = acquireCheckResources(f.repo, ['backend'], { timeoutMs: 10000 }).then((lock) => {
      second = lock;
      order.push('second');
      return lock;
    });
    unrelated = await acquireCheckResources(f.repo, ['frontend'], { timeoutMs: 1000 });
    assert.equal(unrelated.ok, true);
    holder.release();
    assert.equal((await pendingFirst).ok, true);
    assert.deepEqual(order, ['first']);
    first.release();
    assert.equal((await pendingSecond).ok, true);
    assert.deepEqual(order, ['first', 'second']);
  } finally {
    for (const lock of [holder, first, second, unrelated]) lock?.release?.();
    await removeTemporaryDirectory(f.root);
  }
});

test('validation Git commands ignore a foreign hook repository and index', async () => {
  const f = await fixture();
  try {
    const result = await executeCommand('git rev-parse HEAD', f.repo, 5000, f.repo, {
      GIT_DIR: path.join(f.root, 'foreign.git'), GIT_WORK_TREE: f.root, GIT_INDEX_FILE: 'foreign-index',
    });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.stdout.trim(), await git(f.repo, ['rev-parse', 'HEAD']));
  } finally { await removeTemporaryDirectory(f.root); }
});

test('explicit fresh evidence disables even deterministic check cache reuse', async () => {
  const f = await fixture({ validationCommands: {
    tiers: { quick: ['node check.mjs'], standard: ['node check.mjs'], deep: [] },
    checks: [{ id: 'test', command: 'node check.mjs', deterministic: true, evidenceScope: 'fresh' }],
  } });
  try {
    assert.equal((await verifyProject(f.repo, { reuse: true })).status, 'passed');
    assert.equal((await verifyProject(f.repo, { reuse: true })).status, 'passed');
    assert.equal((await readFile(f.counter, 'utf8')).trim().split('\n').length, 2);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('ordinary push rejects multiple refs and deletions before running checks', async () => {
  const f = await fixture();
  try {
    const source = await f.source('A');
    const head = await git(source, ['rev-parse', 'HEAD']);
    await f.installHook();
    await writeFile(path.join(f.repo, 'check.mjs'), 'throw new Error("dirty checkout must not execute");\n');
    await assert.rejects(
      git(f.repo, ['push', 'origin', `${head}:refs/heads/one`, `${head}:refs/heads/two`]),
      (error) => /PUSH_TARGET_UNVERIFIED/u.test(String(error.stderr ?? error.message)),
    );
    await assert.rejects(
      git(f.repo, ['push', 'origin', ':refs/heads/one']),
      (error) => /PUSH_TARGET_UNVERIFIED/u.test(String(error.stderr ?? error.message)),
    );
    assert.equal(existsSync(f.counter), false);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('ordinary exact current-branch push confirms Git only despite a dirty primary', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.repo, 'src'), { recursive: true });
    await writeFile(path.join(f.repo, 'src/exact.txt'), 'exact\n');
    await git(f.repo, ['add', 'src/exact.txt']);
    await git(f.repo, ['commit', '-qm', 'feat: exact push']);
    const head = await git(f.repo, ['rev-parse', 'HEAD']);
    await f.installHook();
    await writeFile(path.join(f.repo, 'check.mjs'), 'throw new Error("dirty checkout must not execute");\n');
    await git(f.repo, ['push', 'origin', `${head}:refs/heads/develop`]);
    assert.equal(await git(f.origin, ['rev-parse', 'develop']), head);
    assert.equal(existsSync(f.counter), false, '普通 push 不运行项目检查');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('isolated ordinary push does not create a verification candidate', async () => {
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
    await git(source, ['push', 'origin', `${head}:refs/heads/feat/A`]);
    assert.equal(await git(f.origin, ['rev-parse', 'feat/A']), head);
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

test('bootstrap 不创建推送证明，普通 push 不运行质量验证', async () => {
  const f = await fixture({ validationCommands: {
    tiers: { quick: ['node check.mjs'], standard: [], deep: ['node -e "process.exit(42)"'] },
    checks: [{ id: 'test', command: 'node check.mjs' }],
  } });
  try {
    const source = await f.source('A');
    const head = await git(source, ['rev-parse', 'HEAD']);
    const update = { localRef: 'refs/heads/feat/A', sha: head, remoteSha: '0'.repeat(40) };
    assert.equal(await resolvePushBaseline(f.repo, update), null);
    assert.equal(await resolvePushBaseline(f.repo, { ...update, localRef: 'refs/heads/unknown' }), null);
    await f.installHook();
    await git(source, ['push', 'origin', 'feat/A']);
    assert.equal(existsSync(f.counter), false, '普通 push 不创建候选验证树或运行检查');
    await writeFile(path.join(source, 'src/A.txt'), 'second change');
    await git(source, ['commit', '-qam', 'fix: second change']);
    await git(source, ['push', 'origin', 'feat/A']);
    assert.equal(existsSync(f.counter), false);
    await git(source, ['branch', 'unproven']);
    await assert.rejects(git(source, ['push', 'origin', 'unproven']), /verification|failed|push/iu);
    await assert.rejects(git(f.origin, ['rev-parse', '--verify', 'refs/heads/unproven']));
  } finally { await removeTemporaryDirectory(f.root); }
});

test('纯文档 stage 不启动任何质量验证，即使传入旧 tier 参数', async () => {
  const f = await fixture({ validationCommands: {
    tiers: { quick: ['node check.mjs', 'node check.mjs docs'], standard: [], deep: [] },
    checks: [{ id: 'test', command: 'node check.mjs' }, { id: 'docs', command: 'node check.mjs docs' }],
  } });
  try {
    assert.equal((await f.run('bootstrap', '--task', 'DOC:feat/DOC', '--write')).status, 'passed');
    const source = path.join(f.root, 'worktrees/DOC');
    await mkdir(path.join(source, 'docs'));
    await writeFile(path.join(source, 'docs/note.md'), '# Note\n');
    await git(source, ['add', '.']);
    await git(source, ['commit', '-qm', 'docs: note']);
    const base = ['stage', '--task', 'DOC'];
    assert.equal((await f.run(...base)).selectedChecks, undefined);
    assert.equal((await f.run(...base, '--tier', 'quick')).selectedChecks, undefined);
    const staged = await f.run(...base, '--write');
    assert.equal(staged.status, 'passed', JSON.stringify(staged));
    assert.equal(staged.integrationStatus, 'local_integrated');
    assert.equal(existsSync(f.counter), false);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('死亡运行者的 running 锁立即报告待恢复，不凭 PID 消失抢锁', async () => {
  const f = await fixture();
  try {
    const resource = 'fixture/stale';
    const dir = path.join(f.repo, '.git/vibe-harness-check-resources');
    const file = path.join(dir, `${createHash('sha256').update(resource).digest('hex')}.json`);
    await mkdir(dir, { recursive: true });
    const record = { token: randomUUID(), pid: 2147483647, hostname: hostname(), name: resource, phase: 'running' };
    await writeFile(file, JSON.stringify(record));
    const blocked = await acquireCheckResources(f.repo, [resource], { timeoutMs: 5000 });
    assert.equal(blocked.code, 'CHECK_RESOURCE_RECOVERY_REQUIRED');
    assert.equal(blocked.owner.pid, record.pid);
    assert.ok(blocked.waitMs < 5000);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
  } finally { await removeTemporaryDirectory(f.root); }
});

test('资源组等待时释放先取得的资源，并报告实际持有者', async () => {
  const f = await fixture();
  const holder = await acquireCheckResources(f.repo, ['z/frontend']);
  try {
    const events = [];
    const waiting = acquireCheckResources(f.repo, ['a/backend', 'z/frontend'], {
      timeoutMs: 600, onWait: (event) => events.push(event),
    });
    // The event is emitted after the partial reservation has been released.
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.length > 0, '资源竞争必须立即提供等待事件');
    const independent = await acquireCheckResources(f.repo, ['a/backend'], { timeoutMs: 100 });
    try { assert.equal(independent.ok, true); } finally { independent.release?.(); }
    const blocked = await waiting;
    assert.equal(blocked.code, 'CHECK_RESOURCE_BUSY');
    assert.equal(events[0].resource, 'z/frontend');
    assert.equal(events[0].owner.pid, process.pid);
  } finally { holder.release(); await removeTemporaryDirectory(f.root); }
});

test('候选验证的进度区分快照、资源获取与检查执行', async () => {
  const f = await fixture();
  try {
    const events = [];
    const report = await verifyProject(f.repo, { noReuse: true, onProgress: (event) => events.push(event) });
    assert.equal(report.status, 'passed', JSON.stringify(report));
    const phases = events.map((event) => event.phase);
    assert.ok(phases.includes('snapshot-start'), JSON.stringify(events));
    assert.ok(phases.includes('resource-acquire'), JSON.stringify(events));
    assert.ok(phases.indexOf('resource-acquire') < phases.indexOf('check-start'));
    assert.ok(events.filter((event) => event.phase === 'heartbeat').every((event) => event.stage));
  } finally { await removeTemporaryDirectory(f.root); }
});

test('死亡预留锁可回收，PID 身份不符与损坏锁均保留', async () => {
  const f = await fixture();
  try {
    const resource = 'fixture/recovery';
    const dir = path.join(f.repo, '.git/vibe-harness-check-resources');
    const file = path.join(dir, `${createHash('sha256').update(resource).digest('hex')}.json`);
    await mkdir(dir, { recursive: true });
    const reserved = { token: randomUUID(), pid: 2147483647, hostname: hostname(), name: resource, phase: 'reserved' };
    await writeFile(file, JSON.stringify(reserved));
    const recovered = await acquireCheckResources(f.repo, [resource], { timeoutMs: 1000 });
    try { assert.equal(recovered.ok, true); } finally { recovered.release?.(); }
    const recycled = { ...reserved, pid: process.pid, processStartTime: 'not-the-current-process' };
    await writeFile(file, JSON.stringify(recycled));
    const refused = await acquireCheckResources(f.repo, [resource], { timeoutMs: 1000 });
    assert.equal(refused.code, ['win32', 'linux'].includes(process.platform)
      ? 'CHECK_RESOURCE_RECOVERY_REQUIRED' : 'CHECK_RESOURCE_BUSY');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), recycled);
    await writeFile(file, '{');
    const unreadable = await acquireCheckResources(f.repo, [resource], { timeoutMs: 50 });
    assert.equal(unreadable.code, 'CHECK_RESOURCE_BUSY');
    assert.equal(await readFile(file, 'utf8'), '{');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('验证等待 running 资源时不发送检查启动事件且保留锁', async () => {
  const f = await fixture({ validationCommands: {
    test: 'node check.mjs', tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
    checks: [{ id: 'test', command: 'node check.mjs', resources: ['fixture/busy'] }],
  } });
  const holder = await acquireCheckResources(f.repo, ['fixture/busy']);
  holder.begin();
  try {
    const events = [];
    const report = await verifyProject(f.repo, {
      noReuse: true, timeout: 1000, onProgress: (event) => events.push(event),
    });
    assert.equal(report.status, 'blocked', JSON.stringify(report));
    assert.equal(report.checks.test.code, 'CHECK_RESOURCE_BUSY');
    assert.equal(report.checks.test.owner.pid, process.pid);
    assert.ok(events.some((event) => event.phase === 'resource-wait'));
    assert.ok(!events.some((event) => event.phase === 'check-start'));
  } finally { holder.release(); await removeTemporaryDirectory(f.root); }
});

test('验证命令超时返回 blocked，保留结果而不等待继承管道永久关闭', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, 'wait.mjs'), 'setInterval(() => {}, 1000);\n');
    const started = Date.now();
    const result = await executeCommand('node wait.mjs', f.repo, 100);
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 10000, '超时后必须有界返回，而非无限等待 close');
  } finally { await removeTemporaryDirectory(f.root); }
});

test('验证命令超时终止自建子进程，不只结束直接父进程', async () => {
  const f = await fixture();
  let childPid;
  let childIdentity;
  try {
    await writeFile(path.join(f.repo, 'tree.mjs'), [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
      "writeFileSync('owned-child.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const running = executeCommand('node tree.mjs', f.repo, 4000);
    const marker = path.join(f.repo, 'owned-child.pid');
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker), '必须实际启动子进程才算树清理证据');
    childPid = Number(await readFile(marker, 'utf8'));
    childIdentity = processStartIdentity(childPid);
    const result = await running;
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'TIMEOUT');
    const goneDeadline = Date.now() + 5000;
    while (processStartIdentity(childPid) !== 'missing' && Date.now() < goneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processStartIdentity(childPid), 'missing', '超时后不应遗留仍运行的已知子进程');
  } finally {
    if (childPid && childIdentity && !['missing', 'unreadable'].includes(childIdentity)
      && processStartIdentity(childPid) === childIdentity) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* The owned test child already exited. */ }
    }
    await removeTemporaryDirectory(f.root);
  }
});
