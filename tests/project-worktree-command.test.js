import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../scripts/lib/temp-cleanup.js';
import { runCommand } from '../runtime/commands/run.mjs';

// `run.mjs worktree` is the installed entry point for worktree provisioning and
// cleanup under docs/rules/git-rules.md §Worktree: read-only by default,
// `--write` for real writes, no cleanup before merge-back and never a branch
// delete. These tests pin the receipt shape and the safety gates.

const execFileAsync = promisify(execFile);
const gitIdentity = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture'];

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', [...gitIdentity, ...args], { cwd, windowsHide: true });
  return stdout.trim();
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * A minimal monorepo: `frontend` owns the hoisted `node_modules` and one local
 * workspace package the worktree has to resolve from its own sources.
 */
async function makeWorkspaceFixture({ trackContracts = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-harness-worktree-command-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'frontend/packages/contracts'), { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(repo, '.gitignore'), 'node_modules\n', 'utf8');
  await writeJson(path.join(repo, 'frontend/package.json'), {
    name: 'fixture-frontend',
    private: true,
    workspaces: { packages: ['packages/*'] },
  });
  await writeJson(path.join(repo, 'frontend/packages/contracts/package.json'), {
    name: '@fixture/contracts',
    version: '1.0.0',
  });
  await writeJson(path.join(repo, 'vibe-harness.config.json'), {
    worktree: {
      baseRef: 'main',
      dependencyRoots: ['frontend'],
      localPackages: ['@fixture/contracts'],
      root: '../repo-worktrees',
    },
  });
  await git(repo, ['add', trackContracts ? '.' : '--', '.gitignore', 'frontend/package.json', 'vibe-harness.config.json']);
  await git(repo, ['commit', '-q', '-m', 'fixture']);
  // The installed dependencies are build artifacts, so they stay untracked.
  await mkdir(path.join(repo, 'frontend/node_modules/dep-a'), { recursive: true });
  await writeJson(path.join(repo, 'frontend/node_modules/dep-a/package.json'), { name: 'dep-a', version: '2.0.0' });
  return { repo, root, worktreePath: path.join(root, 'repo-worktrees', 'ENG-1') };
}

async function entryExists(project, worktreePath) {
  const result = await runCommand(['worktree', 'list', '--project', project, '--json'], { cwd: project });
  return result.report.worktrees.some((entry) => path.resolve(entry.path) === path.resolve(worktreePath));
}

test('worktree list reports the primary worktree and writes nothing', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    const result = await runCommand(['worktree', 'list', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.subcommand, 'list');
    assert.equal(result.report.worktrees.length, 1);
    assert.equal(result.report.worktrees[0].primary, true);
    assert.equal(result.report.worktrees[0].branch, 'main');

    const text = await runCommand(['worktree', 'list', '--project', fixture.repo], { cwd: fixture.repo });
    assert.match(text.report.worktrees[0].path, /repo$/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree check audits tasks, merge-back and a configured root', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    const result = await runCommand([
      'worktree', 'check', '--project', fixture.repo,
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.audit.configuredRoot, path.join(fixture.root, 'repo-worktrees'));
    assert.equal(result.report.audit.counts.unregistered, 1);
    assert.deepEqual(result.report.localPackages, ['@fixture/contracts']);
    const codes = result.report.audit.problems.map((problem) => problem.code);
    assert.ok(codes.includes('WORKTREE_UNREGISTERED'));

    // Warnings only: --strict is what turns them into a failure.
    const strict = await runCommand([
      'worktree', 'check', '--project', fixture.repo,
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--strict', '--json',
    ], { cwd: fixture.repo });
    assert.equal(strict.exitCode, 1);
    assert.equal(strict.report.audit.ok, true);
    assert.equal(strict.report.audit.cleanupAllowed, false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree bootstrap plans by default and only --write creates the worktree', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    const planned = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.report.status, 'planned');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);

    const written = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.results[0].status, 'passed');
    assert.deepEqual(written.report.results[0].links[0].localPackages, ['@fixture/contracts']);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);

    // The local package must resolve to this worktree's sources, not the main
    // checkout, or the shared junction would hand the worktree stale code.
    const resolved = await realpath(path.join(fixture.worktreePath, 'frontend/node_modules/@fixture/contracts'));
    const expected = await realpath(path.join(fixture.worktreePath, 'frontend/packages/contracts'));
    assert.equal(resolved, expected);
    // The third-party dependency still comes from the main checkout.
    const dependency = await realpath(path.join(fixture.worktreePath, 'frontend/node_modules/dep-a'));
    const mainDependency = await realpath(path.join(fixture.repo, 'frontend/node_modules/dep-a'));
    assert.equal(dependency, mainDependency);

    const checked = await runCommand([
      'worktree', 'check', '--project', fixture.repo,
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--strict', '--json',
    ], { cwd: fixture.repo });
    const codes = checked.report.audit.problems.map((problem) => problem.code);
    assert.deepEqual(codes.filter((code) => code.startsWith('WORKTREE_DEPENDENCY_')), []);
    assert.equal(checked.exitCode, 0);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('a half-provisioned bootstrap rolls back and leaves no branch behind', async () => {
  // `frontend/packages/contracts` exists on disk but not in the commit, so the
  // worktree cannot link it and the run has to undo itself.
  const fixture = await makeWorkspaceFixture({ trackContracts: false });
  try {
    const result = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    const [task] = result.report.results;
    assert.equal(task.rolledBack, true);
    assert.equal(task.branchDeleted, true);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    const branches = await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']);
    assert.equal(branches, '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree cleanup refuses an unmerged worktree and keeps the branch', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await writeFile(path.join(fixture.worktreePath, 'work.txt'), 'done\n', 'utf8');
    await git(fixture.worktreePath, ['add', '.']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: work']);

    const blocked = await runCommand([
      'worktree', 'cleanup', '--project', fixture.repo, '--task', 'ENG-1', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.report.status, 'failed');
    assert.equal(blocked.report.results[0].status, 'blocked');
    assert.match(blocked.report.results[0].blockers.join('; '), /not merged/u);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);

    // Merge-back is what unblocks cleanup; the branch survives the removal.
    await git(fixture.repo, ['merge', '--no-ff', '-q', '-m', 'merge ENG-1', 'feat/ENG-1-scaffold']);
    const cleaned = await runCommand([
      'worktree', 'cleanup', '--project', fixture.repo, '--task', 'ENG-1', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned.report));
    assert.equal(cleaned.report.results[0].status, 'passed');
    // The dependency links the bootstrap created are torn down first, so Git
    // can remove the whole directory instead of leaving the junction behind.
    assert.deepEqual(cleaned.report.results[0].removedLinks, ['frontend/node_modules']);
    assert.equal(cleaned.report.results[0].remainingDirectory, false);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), 'feat/ENG-1-scaffold');
    // The main checkout's dependencies are untouched by the teardown.
    const mainDependency = path.join(fixture.repo, 'frontend/node_modules/dep-a/package.json');
    assert.equal(JSON.parse(await readFile(mainDependency, 'utf8')).name, 'dep-a');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree cleanup without --write only reports the plan', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    const planned = await runCommand([
      'worktree', 'cleanup', '--project', fixture.repo, '--task', 'ENG-2', '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0);
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.results[0].status, 'planned');
    assert.equal(await entryExists(fixture.repo, path.join(fixture.root, 'repo-worktrees', 'ENG-2')), true);

    const unknown = await runCommand(['worktree', 'cleanup', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.report.error, /--task/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});
