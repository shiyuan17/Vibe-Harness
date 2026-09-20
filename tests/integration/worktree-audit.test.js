import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import {
  defaultWorktreePath,
  isTaskBranch,
  parseWorktreeList,
  pathKey,
  resolveWorktreeRoot,
  summarizeWorktreeAudit,
  validateWorktrees,
} from '../../scripts/lib/worktree-audit.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const WORKTREE_CLI = path.join(repositoryRoot, 'scripts', 'worktree.js');

const NUL = '\0';
const REPO = path.resolve('/work/app');
const OUTSIDE = path.resolve('/work/app-worktrees/ENG-1');

// git writes one `key [value]` field per NUL and closes a record with an empty
// field, so records are joined by a double NUL.
function listing(records) {
  return `${records.map((fields) => fields.join(NUL)).join(NUL + NUL)}${NUL}${NUL}`;
}

function entry({ branch, detached = false, head = 'a'.repeat(40), locked, path: worktreePath, prunable }) {
  const fields = [`worktree ${worktreePath}`, `HEAD ${head}`];
  if (detached) fields.push('detached');
  else fields.push(`branch refs/heads/${branch}`);
  if (locked !== undefined) fields.push(`locked ${locked}`);
  if (prunable !== undefined) fields.push(prunable === true ? 'prunable' : `prunable ${prunable}`);
  return { fields };
}

function codes(audit) {
  return audit.problems.map((problem) => problem.code);
}

test('parseWorktreeList reads the NUL-separated porcelain records', () => {
  const parsed = parseWorktreeList(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', head: 'b'.repeat(40), locked: 'in use by task', path: OUTSIDE }).fields,
  ]));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    bare: false,
    branch: 'main',
    branchRef: 'refs/heads/main',
    detached: false,
    head: 'a'.repeat(40),
    locked: null,
    path: REPO,
    primary: true,
    prunable: null,
  });
  assert.equal(parsed[1].primary, false);
  assert.equal(parsed[1].branch, 'feat/ENG-1-add-dag');
  assert.equal(parsed[1].locked, 'in use by task');

  const detached = parseWorktreeList(listing([entry({ detached: true, path: OUTSIDE }).fields]));
  assert.equal(detached[0].detached, true);
  assert.equal(detached[0].branch, null);

  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
});

test('the branch convention is <type>/<ISSUE-ID>-<slug>', () => {
  assert.equal(isTaskBranch('feat/ENG-1-add-dag', 'ENG-1'), true);
  assert.equal(isTaskBranch('hotfix/ENG-1-restore', 'ENG-1'), true);
  assert.equal(isTaskBranch('codex/ENG-1-add-dag', 'ENG-1', { branchPrefix: 'codex/' }), true);
  assert.equal(isTaskBranch('feature/ENG-1-add-dag', 'ENG-1'), false);
  assert.equal(isTaskBranch('feat/ENG-1-', 'ENG-1'), false);
  assert.equal(isTaskBranch('feat/ENG-1-Add-Dag', 'ENG-1'), false);
  assert.equal(isTaskBranch('feat/ENG-2-add-dag', 'ENG-1'), false);
  assert.equal(isTaskBranch('ENG-1-add-dag', 'ENG-1'), false);
  assert.equal(isTaskBranch('feat/ENG-1-add-dag', ''), false);
  assert.equal(defaultWorktreePath(REPO, 'ENG-1'), OUTSIDE);
});

test('an inside-repository or nested worktree fails closed', () => {
  const inside = path.join(REPO, 'nested-worktree');
  const insideAudit = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: inside }).fields,
  ]), {
    branchPrefix: undefined,
    repositoryRoot: REPO,
    tasks: [{ branch: 'feat/ENG-1-add-dag', id: 'ENG-1', path: inside }],
  });
  assert.equal(insideAudit.ok, false);
  assert.ok(codes(insideAudit).includes('WORKTREE_INSIDE_REPOSITORY'));
  assert.equal(insideAudit.cleanupAllowed, false);

  const outer = path.resolve('/work/wt-outer');
  const nested = path.join(outer, 'inner');
  const nestedAudit = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: outer }).fields,
    entry({ branch: 'feat/ENG-2-add-dag', path: nested }).fields,
  ]), { repositoryRoot: REPO });
  assert.ok(codes(nestedAudit).includes('WORKTREE_NESTED'));
  assert.equal(nestedAudit.ok, false);
});

test('a detached non-primary worktree and a duplicated branch are errors', () => {
  const detached = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ detached: true, path: OUTSIDE }).fields,
  ]), { repositoryRoot: REPO });
  assert.ok(codes(detached).includes('WORKTREE_DETACHED'));
  assert.equal(detached.counts.detached, 1);

  const duplicated = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: path.resolve('/work/app-worktrees/ENG-1-copy') }).fields,
  ]), { repositoryRoot: REPO });
  assert.ok(codes(duplicated).includes('WORKTREE_DUPLICATE_BRANCH'));
});

test('a prunable residue is an error that blocks cleanup until recovered', () => {
  const residue = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE, prunable: 'worktree directory missing' }).fields,
  ]), { repositoryRoot: REPO });
  // The directory is gone while Git still holds the metadata and the branch
  // binding, so the audit fails on top of the unmanaged warning.
  assert.deepEqual(codes(residue), ['WORKTREE_PRUNABLE_RESIDUE', 'WORKTREE_UNMANAGED']);
  assert.equal(residue.ok, false);
  assert.equal(residue.errorCount, 1);
  assert.equal(residue.cleanupAllowed, false);
  assert.match(
    residue.problems.find((problem) => problem.code === 'WORKTREE_PRUNABLE_RESIDUE').message,
    /worktree directory missing.*worktree recover/us,
  );

  // A live worktree is only unmanaged, and the primary worktree never counts
  // as residue even when Git marks it prunable.
  const live = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE }).fields,
  ]), { repositoryRoot: REPO });
  assert.deepEqual(codes(live), ['WORKTREE_UNMANAGED']);
  assert.equal(live.ok, true);

  const primary = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO, prunable: 'worktree directory missing' }).fields,
  ]), { repositoryRoot: REPO });
  assert.deepEqual(codes(primary), []);
  assert.equal(primary.ok, true);
});

test('task registration reports a missing branch, a bad branch and an unbound path', () => {
  const audit = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE }).fields,
  ]), {
    repositoryRoot: REPO,
    tasks: [
      { id: 'ENG-1', branch: 'feat/ENG-1-add-dag', path: OUTSIDE },
      { id: 'ENG-2', branch: 'feature/ENG-2-nope', path: path.resolve('/work/app-worktrees/ENG-2') },
      { id: 'ENG-3', branch: null },
      { id: 'ENG-4', branch: 'feat/ENG-4-add-dag' },
    ],
  });
  // ENG-1 is registered; the other three are not.
  assert.ok(codes(audit).includes('WORKTREE_BRANCH_INVALID'));
  assert.ok(codes(audit).includes('WORKTREE_BRANCH_MISSING'));
  assert.equal(audit.counts.unregistered, 3);
  assert.equal(audit.counts.unmanaged, 0);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.tasks.find((task) => task.id === 'ENG-1').worktree, OUTSIDE);

  const mismatched = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE }).fields,
  ]), {
    repositoryRoot: REPO,
    tasks: [{ branch: 'feat/ENG-1-other-slug', id: 'ENG-1', path: OUTSIDE }],
  });
  assert.ok(codes(mismatched).includes('WORKTREE_BRANCH_UNBOUND'));
  assert.equal(mismatched.ok, false);

  const unmanaged = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: OUTSIDE }).fields,
  ]), { repositoryRoot: REPO });
  assert.deepEqual(codes(unmanaged), ['WORKTREE_UNMANAGED']);
  assert.equal(unmanaged.ok, true);
  assert.equal(unmanaged.warningCount, 1);
  assert.match(summarizeWorktreeAudit(unmanaged), /unmanaged/u);
});

test('dirty worktrees and a pending merge-back are reported without cleanup', () => {
  const branch = 'feat/ENG-1-add-dag';
  const records = listing([entry({ branch: 'main', path: REPO }).fields, entry({ branch, path: OUTSIDE }).fields]);
  const tasks = [{ branch, id: 'ENG-1', path: OUTSIDE }];

  const dirty = validateWorktrees(records, { dirty: new Map([[pathKey(OUTSIDE), true]]), repositoryRoot: REPO, tasks });
  assert.ok(codes(dirty).includes('WORKTREE_DIRTY'));
  assert.equal(dirty.ok, true);
  assert.equal(dirty.counts.dirty, 1);
  assert.equal(dirty.cleanupAllowed, false);

  const pending = validateWorktrees(records, {
    baseRef: 'origin/develop',
    integration: new Map([[branch, { baseDrift: false, integrated: false, mergeBaseSha: 'c'.repeat(40), targetRef: 'origin/develop' }]]),
    repositoryRoot: REPO,
    tasks,
  });
  assert.ok(codes(pending).includes('WORKTREE_MERGE_BACK_PENDING'));
  assert.equal(pending.cleanupAllowed, false);

  const drifted = validateWorktrees(records, {
    integration: new Map([[branch, { baseDrift: true, integrated: true, mergeBaseSha: 'd'.repeat(40), targetRef: 'HEAD' }]]),
    repositoryRoot: REPO,
    tasks: [{ ...tasks[0], baseSha: 'e'.repeat(40) }],
  });
  assert.ok(codes(drifted).includes('WORKTREE_BASE_DRIFT'));
  assert.equal(drifted.ok, false);
});

test('a registered outside worktree with a clean merge-back passes', () => {
  const branch = 'feat/ENG-1-add-dag';
  const audit = validateWorktrees(listing([
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch, path: OUTSIDE }).fields,
  ]), {
    baseRef: 'HEAD',
    dirty: new Map([[pathKey(OUTSIDE), false]]),
    integration: new Map([[branch, { baseDrift: false, integrated: true, mergeBaseSha: 'f'.repeat(40), targetRef: 'HEAD' }]]),
    repositoryRoot: REPO,
    tasks: [{ branch, id: 'ENG-1', path: OUTSIDE }],
  });
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.ok, true);
  assert.equal(audit.cleanupAllowed, true);
  assert.deepEqual(audit.counts, { detached: 0, dirty: 0, tasks: 1, unmanaged: 0, unregistered: 0, worktrees: 2 });
  assert.match(summarizeWorktreeAudit(audit), /status: passed/u);
});

test('an unparsable listing fails closed', () => {
  const audit = validateWorktrees(42, { repositoryRoot: REPO });
  assert.equal(audit.ok, false);
  assert.deepEqual(codes(audit), ['WORKTREE_LIST_INVALID']);
});

test('a worktree outside the configured root fails while the root itself passes', () => {
  const configuredRoot = path.resolve('/work/app-worktrees');
  assert.equal(resolveWorktreeRoot(REPO, '../app-worktrees'), configuredRoot);
  assert.equal(resolveWorktreeRoot(REPO, '/work/app-worktrees'), configuredRoot);
  assert.equal(resolveWorktreeRoot(REPO), path.resolve('/work/app-worktrees'));

  const listing = (worktreePath) => `${[
    entry({ branch: 'main', path: REPO }).fields,
    entry({ branch: 'feat/ENG-1-add-dag', path: worktreePath }).fields,
  ].map((fields) => fields.join(NUL)).join(NUL + NUL)}${NUL}${NUL}`;

  const inside = validateWorktrees(listing(OUTSIDE), { configuredRoot, repositoryRoot: REPO });
  assert.deepEqual(codes(inside), ['WORKTREE_UNMANAGED']);
  assert.equal(inside.configuredRoot, configuredRoot);

  const outside = validateWorktrees(listing(path.resolve('/work/elsewhere/ENG-1')), { configuredRoot, repositoryRoot: REPO });
  assert.ok(codes(outside).includes('WORKTREE_OUTSIDE_CONFIGURED_ROOT'));
  assert.equal(outside.ok, false);
  assert.equal(outside.cleanupAllowed, false);
});

test('dependency-link evidence reports missing and stale links separately', () => {
  const branch = 'feat/ENG-1-add-dag';
  const records = listing([entry({ branch: 'main', path: REPO }).fields, entry({ branch, path: OUTSIDE }).fields]);
  const tasks = [{ branch, id: 'ENG-1', path: OUTSIDE }];
  const clean = {
    dirty: new Map([[pathKey(OUTSIDE), false]]),
    integration: new Map([[branch, { baseDrift: false, integrated: true, mergeBaseSha: 'f'.repeat(40), targetRef: 'HEAD' }]]),
    repositoryRoot: REPO,
    tasks,
  };

  const missing = validateWorktrees(records, {
    ...clean,
    dependencyEvidence: new Map([[pathKey(OUTSIDE), [{ dependencyRoot: 'frontend', status: 'missing' }]]]),
  });
  assert.ok(codes(missing).includes('WORKTREE_DEPENDENCY_MISSING'));
  assert.equal(missing.ok, true);
  // A link the worktree never had describes provisioning, not merge-back, so it
  // must not block removing an already-merged worktree.
  assert.equal(missing.cleanupAllowed, true);

  const stale = validateWorktrees(records, {
    ...clean,
    dependencyEvidence: new Map([[pathKey(OUTSIDE), [{ dependencyRoot: 'frontend', localPackage: '@demo/contracts', resolved: REPO, status: 'stale' }]]]),
  });
  assert.ok(codes(stale).includes('WORKTREE_DEPENDENCY_STALE'));
  assert.equal(stale.ok, false);
  assert.equal(stale.cleanupAllowed, true);
  assert.match(summarizeWorktreeAudit(stale), /WORKTREE_DEPENDENCY_STALE/u);
});

test('integrationAll reports merge-back for worktrees no task registered', () => {
  const branch = 'feat/ENG-1-add-dag';
  const records = listing([entry({ branch: 'main', path: REPO }).fields, entry({ branch, path: OUTSIDE }).fields]);
  const audit = validateWorktrees(records, {
    integration: new Map([[branch, { baseDrift: false, integrated: false, mergeBaseSha: 'c'.repeat(40), targetRef: 'origin/develop' }]]),
    integrationAll: true,
    repositoryRoot: REPO,
  });
  assert.ok(codes(audit).includes('WORKTREE_MERGE_BACK_PENDING'));
  assert.equal(audit.worktrees[1].integrated, false);
  assert.equal(audit.worktrees[1].targetRef, 'origin/develop');
  assert.equal(audit.cleanupAllowed, false);
});

test('端口与 env 事实按补齐状态报告，不参与 merge-back 判定', () => {
  const branch = 'feat/ENG-1-add-dag';
  const records = listing([entry({ branch: 'main', path: REPO }).fields, entry({ branch, path: OUTSIDE }).fields]);
  const tasks = [{ branch, id: 'ENG-1', path: OUTSIDE }];
  const clean = {
    dirty: new Map([[pathKey(OUTSIDE), false]]),
    integration: new Map([[branch, { baseDrift: false, integrated: true, mergeBaseSha: 'f'.repeat(40), targetRef: 'HEAD' }]]),
    repositoryRoot: REPO,
    tasks,
  };

  const conflict = validateWorktrees(records, {
    ...clean,
    portProblems: [{ code: 'WORKTREE_PORT_CONFLICT', message: 'block 1 is claimed by both ENG-1 and ENG-2', severity: 'error' }],
  });
  assert.deepEqual(codes(conflict), ['WORKTREE_PORT_CONFLICT']);
  assert.equal(conflict.ok, false);
  // A shared block blocks the work in that worktree; it must not block removal
  // of an already-merged worktree.
  assert.equal(conflict.cleanupAllowed, true);

  const drift = validateWorktrees(records, {
    ...clean,
    portProblems: [
      { code: 'WORKTREE_PORT_ENV_MISSING', message: `${OUTSIDE}: the regenerated env file is missing`, severity: 'error' },
      { code: 'WORKTREE_PORT_ENV_DRIFT', message: `${OUTSIDE}: PORT expected 3010, found 9999`, severity: 'warning' },
      { code: 'WORKTREE_ENV_NOT_IGNORED', message: '.vibe-harness/worktree.env is not ignored', severity: 'warning' },
    ],
    portSummary: [{ block: 1, id: 'ENG-1', path: OUTSIDE, ports: { PORT: 3010 } }],
  });
  assert.deepEqual(codes(drift), ['WORKTREE_ENV_NOT_IGNORED', 'WORKTREE_PORT_ENV_DRIFT', 'WORKTREE_PORT_ENV_MISSING']);
  assert.equal(drift.ok, false);
  assert.equal(drift.cleanupAllowed, true);
  assert.deepEqual(drift.ports, [{ block: 1, id: 'ENG-1', path: OUTSIDE, ports: { PORT: 3010 } }]);
  assert.match(summarizeWorktreeAudit(drift), /ports: .*block 1 \(PORT=3010\)/u);
});

async function makeGitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-worktree-'));
  const repo = path.join(root, 'repo');
  const worktreePath = path.join(root, 'repo-worktrees', 'ENG-1');
  await mkdir(repo);
  await writeFile(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  await execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/codex/fixture'], { cwd: repo, windowsHide: true });
  await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
  await execFileAsync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '-m', 'fixture'], { cwd: repo, windowsHide: true });
  await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'feat/ENG-1-add-dag', worktreePath], { cwd: repo, windowsHide: true });
  return { repo, root, worktreePath };
}

// One shared fixture keeps the git subprocess cost of this file bounded: each
// temporary repository plus worktree costs several `git` spawns on Windows.
let fixture;
test.before(async () => { fixture = await makeGitFixture(); });
test.after(async () => { await removeTemporaryDirectory(fixture.root); });

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [WORKTREE_CLI, ...args], { windowsHide: true });
    return { code: 0, stderr, stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

test('the CLI lists and audits a registered outside worktree', { timeout: 120000 }, async () => {
  const listed = await runCli(['list', '--repo', fixture.repo, '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const entries = JSON.parse(listed.stdout);
  assert.deepEqual(entries.map((item) => item.branch), ['codex/fixture', 'feat/ENG-1-add-dag']);

  const checked = await runCli([
    'check', '--repo', fixture.repo, '--base-ref', 'HEAD',
    '--task', `ENG-1:feat/ENG-1-add-dag:${fixture.worktreePath}`, '--json',
  ]);
  assert.equal(checked.code, 0, checked.stderr);
  const audit = JSON.parse(checked.stdout);
  assert.equal(audit.ok, true);
  assert.equal(audit.errorCount, 0);
  assert.equal(audit.counts.worktrees, 2);
  assert.equal(audit.counts.unregistered, 0);
  assert.equal(audit.counts.unmanaged, 0);
  assert.equal(audit.tasks[0].materialized, true);
  assert.equal(audit.cleanupAllowed, true);
});

test('the CLI reports an unmanaged worktree and --strict fails on it', { timeout: 120000 }, async () => {
  const plain = await runCli(['check', '--repo', fixture.repo, '--base-ref', 'HEAD']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /WORKTREE_UNMANAGED/u);

  const strict = await runCli(['check', '--repo', fixture.repo, '--base-ref', 'HEAD', '--strict']);
  assert.equal(strict.code, 1);

  const plan = await runCli(['plan', '--repo', fixture.repo, '--base-ref', 'HEAD', '--task', 'ENG-2:feat/ENG-2-next', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  const step = JSON.parse(plan.stdout).steps[0];
  assert.equal(step.valid, true);
  assert.match(step.command, /worktree add/u);
  assert.match(step.command, /feat\/ENG-2-next/u);
  assert.match(step.path, /repo-worktrees[\\/]ENG-2$/u);
});

test('--deep reports uncommitted changes and the CLI never cleans up', { timeout: 120000 }, async () => {
  await writeFile(path.join(fixture.worktreePath, 'uncommitted.txt'), 'wip\n', 'utf8');
  const deep = await runCli(['check', '--repo', fixture.repo, '--base-ref', 'HEAD', '--deep', '--strict']);
  assert.equal(deep.code, 1);
  assert.match(deep.stdout, /WORKTREE_DIRTY/u);

  // The audit is read-only: the worktree and its branch survive the check.
  const after = await runCli(['list', '--repo', fixture.repo, '--json']);
  assert.deepEqual(JSON.parse(after.stdout).map((item) => item.branch), ['codex/fixture', 'feat/ENG-1-add-dag']);
});

test('an unresolvable base ref and an unresolvable repository are reported', { timeout: 120000 }, async () => {
  const unresolved = await runCli(['check', '--repo', fixture.repo, '--base-ref', 'origin/absent']);
  assert.equal(unresolved.code, 0, unresolved.stderr);
  assert.match(unresolved.stdout, /WORKTREE_BASE_REF_UNRESOLVED/u);

  const notARepo = await runCli(['list', '--repo', path.join(fixture.root, 'missing')]);
  assert.equal(notARepo.code, 1);
  assert.match(notARepo.stderr, /not a Git worktree/u);
});

test('开发面 CLI 一并报告主检出登记表的端口事实', { timeout: 120000 }, async () => {
  const portFixture = await makeGitFixture();
  const registryFile = path.join(portFixture.repo, '.vibe-harness/worktree-ports.json');
  try {
    await mkdir(path.dirname(registryFile), { recursive: true });
    // A block two worktrees claim is an error on its own, even before the
    // worktree it names exists.
    await writeFile(registryFile, JSON.stringify({
      base: 3000,
      blockSize: 10,
      entries: [
        { block: 1, id: 'ENG-1', path: portFixture.worktreePath, ports: { PORT: 3010 } },
        { block: 1, id: 'ENG-2', path: path.join(portFixture.root, 'repo-worktrees', 'ENG-2'), ports: { PORT: 3020 } },
      ],
      schemaVersion: 1,
      variables: ['PORT'],
    }, null, 2), 'utf8');
    const conflict = await runCli(['check', '--repo', portFixture.repo, '--base-ref', 'HEAD', '--json']);
    assert.ok(
      JSON.parse(conflict.stdout).problems.some((problem) => problem.code === 'WORKTREE_PORT_CONFLICT'),
      conflict.stdout,
    );

    // A well-formed registry is reported per worktree, including the env file
    // that no longer matches the block it was generated from.
    await writeFile(registryFile, JSON.stringify({
      base: 3000,
      blockSize: 10,
      entries: [{
        block: 1,
        branch: 'feat/ENG-1-add-dag',
        id: 'ENG-1',
        path: portFixture.worktreePath,
        ports: { PORT: 3010 },
      }],
      schemaVersion: 1,
      variables: ['PORT'],
    }, null, 2), 'utf8');
    await mkdir(path.join(portFixture.worktreePath, '.vibe-harness'), { recursive: true });
    await writeFile(
      path.join(portFixture.worktreePath, '.vibe-harness/worktree.env'),
      'PORT=9999\nVIBE_HARNESS_WORKTREE_BLOCK=7\n',
      'utf8',
    );
    const drifted = await runCli([
      'check', '--repo', portFixture.repo, '--base-ref', 'HEAD',
      '--task', `ENG-1:feat/ENG-1-add-dag:${portFixture.worktreePath}`, '--json',
    ]);
    assert.equal(drifted.code, 0, drifted.stderr);
    const audit = JSON.parse(drifted.stdout);
    const reported = audit.problems.map((problem) => problem.code);
    assert.ok(reported.includes('WORKTREE_PORT_ENV_DRIFT'), reported.join(','));
    assert.ok(reported.includes('WORKTREE_ENV_NOT_IGNORED'), reported.join(','));
    assert.equal(audit.ports.length, 1);
    assert.equal(audit.ports[0].block, 1);
    assert.deepEqual(audit.ports[0].ports, { PORT: 3010 });
    assert.equal(pathKey(audit.ports[0].path), pathKey(portFixture.worktreePath));
  } finally {
    await removeTemporaryDirectory(portFixture.root);
  }
});
