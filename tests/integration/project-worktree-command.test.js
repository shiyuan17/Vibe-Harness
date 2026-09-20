import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { runCommand } from '../../runtime/commands/run.mjs';

// `run.mjs worktree` is the installed entry point for worktree provisioning and
// cleanup under docs/rules/git-rules.md §Worktree: read-only by default,
// `--write` for real writes, no cleanup before merge-back and never a branch
// delete. `worktree recover` is the exception: it removes crash residue, and a
// branch is deleted only after being proven to sit at the base ref with a clean
// tree. These tests pin the receipt shape and the safety gates.

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
async function makeWorkspaceFixture({
  extraFiles = {},
  gitignore = 'node_modules\n.vibe-harness/\n',
  hooks = null,
  installDependencies = true,
  trackContracts = true,
  worktree = {},
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-harness-worktree-command-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'frontend/packages/contracts'), { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(repo, '.gitignore'), gitignore, 'utf8');
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
      ...worktree,
    },
    ...(hooks ? { hooks } : {}),
  });
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(repo, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await git(repo, ['add', trackContracts ? '.' : '--', '.gitignore', 'frontend/package.json', 'vibe-harness.config.json']);
  await git(repo, ['commit', '-q', '-m', 'fixture']);
  // The installed dependencies are build artifacts, so they stay untracked.
  if (installDependencies) {
    await mkdir(path.join(repo, 'frontend/node_modules/dep-a'), { recursive: true });
    await writeJson(path.join(repo, 'frontend/node_modules/dep-a/package.json'), { name: 'dep-a', version: '2.0.0' });
  }
  return { repo, root, worktreePath: path.join(root, 'repo-worktrees', 'ENG-1') };
}

/** Read `.vibe-harness/worktree-ports.json` from the main checkout. */
async function readRegistry(repo) {
  try {
    return JSON.parse(await readFile(path.join(repo, '.vibe-harness/worktree-ports.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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
    // Planning is read-only: neither the worktree nor the port registry exists.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await readRegistry(fixture.repo), null);
    assert.deepEqual(
      planned.report.results[0].steps.map((step) => step.kind),
      ['git-worktree-add', 'link-dependencies', 'allocate-ports', 'materialize-env-files', 'probe-toolchain'],
    );
    assert.equal(planned.report.results[0].steps[2].block, 1);
    assert.deepEqual(planned.report.results[0].steps[2].ports, { PORT: 3010 });

    const written = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.results[0].status, 'passed');
    assert.deepEqual(written.report.results[0].links[0].localPackages, ['@fixture/contracts']);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.deepEqual(written.report.results[0].toolchain, { git: true, node: true, pnpm: true });

    // The registry and the worktree env file are the two halves of the same
    // fact: the block number and the variables of that block.
    const registry = await readRegistry(fixture.repo);
    assert.equal(registry.base, 3000);
    assert.equal(registry.blockSize, 10);
    assert.deepEqual(registry.variables, ['PORT']);
    assert.deepEqual(registry.entries.map((entry) => [entry.id, entry.block, entry.ports]), [
      ['ENG-1', 1, { PORT: 3010 }],
    ]);
    const envFile = await readFile(path.join(fixture.worktreePath, '.vibe-harness/worktree.env'), 'utf8');
    assert.deepEqual(envFile.split(/\r?\n/u).filter(Boolean), [
      'PORT=3010',
      'VIBE_HARNESS_WORKTREE_ID=ENG-1',
      'VIBE_HARNESS_WORKTREE_BLOCK=1',
    ]);

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

test('同一 task 重复 bootstrap 复用既有端口块', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    const again = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(again.exitCode, 0, JSON.stringify(again.report));
    assert.equal(again.report.results[0].allocation.block, 1);
    assert.equal(again.report.results[0].allocation.reused, true);
    const registry = await readRegistry(fixture.repo);
    assert.equal(registry.entries.length, 1);
    // The worktree was reused instead of being created twice, and a fresh
    // bootstrap leaves the plan's first step marked as a reuse.
    assert.equal(again.report.results[0].steps[0].kind, 'reuse-worktree');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('并发 bootstrap 由锁串行化且不会分到同一个端口块', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    const [first, second] = await Promise.all([
      runCommand(['worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-3:feat/ENG-3-a', '--write', '--json'], { cwd: fixture.repo }),
      runCommand(['worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-4:feat/ENG-4-b', '--write', '--json'], { cwd: fixture.repo }),
    ]);
    assert.equal(first.exitCode, 0, JSON.stringify(first.report));
    assert.equal(second.exitCode, 0, JSON.stringify(second.report));
    const blocks = [first.report.results[0].allocation.block, second.report.results[0].allocation.block].sort();
    assert.deepEqual(blocks, [1, 2]);
    const ports = [first, second]
      .map((result) => result.report.results[0].allocation.ports.PORT)
      .sort((left, right) => left - right);
    assert.deepEqual(ports, [3010, 3020]);
    const registry = await readRegistry(fixture.repo);
    assert.deepEqual(registry.entries.map((entry) => entry.block).sort(), [1, 2]);
    // The lock file is released by the successful run.
    assert.equal(existsSync(path.join(fixture.repo, '.vibe-harness/worktree-ports.lock')), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('主检出缺 node_modules 时 bootstrap 为 blocked 并给出建议命令', async () => {
  const fixture = await makeWorkspaceFixture({ installDependencies: false });
  try {
    const result = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.results[0].status, 'blocked');
    assert.equal(result.report.results[0].code, 'WORKTREE_MAIN_DEPENDENCIES_MISSING');
    assert.match(result.report.results[0].error, /frontend\/node_modules/u);
    // Nothing is created by a blocked plan.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await readRegistry(fixture.repo), null);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('声明 setupCommands 时缺依赖改为 setup 先于 link 的顺序', async () => {
  // `node setup.mjs` stands in for the project's install command: it has to
  // leave the worktree able to resolve its own workspace package, because the
  // main checkout has no `node_modules` to overlay here.
  const setupScript = [
    "import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "mkdirSync('frontend/node_modules/@fixture', { recursive: true });",
    "symlinkSync(resolve('frontend/packages/contracts'), 'frontend/node_modules/@fixture/contracts', 'junction');",
    "writeFileSync('setup-ran.txt', 'ok\\n');",
    '',
  ].join('\n');
  const fixture = await makeWorkspaceFixture({
    extraFiles: { 'setup.mjs': setupScript },
    installDependencies: false,
    worktree: { provision: { setupCommands: ['node setup.mjs'] } },
  });
  try {
    const planned = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.deepEqual(
      planned.report.results[0].steps.map((step) => step.kind),
      ['git-worktree-add', 'setup-command', 'link-dependencies', 'allocate-ports', 'materialize-env-files', 'probe-toolchain'],
    );

    const written = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.deepEqual(written.report.results[0].setupCommands, [{ command: 'node setup.mjs', exitCode: 0, status: 'passed' }]);
    assert.equal(await readFile(path.join(fixture.worktreePath, 'setup-ran.txt'), 'utf8'), 'ok\n');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('setup 命令失败时回滚 worktree、分支与端口登记项', async () => {
  const fixture = await makeWorkspaceFixture({
    extraFiles: { 'setup.mjs': "console.error('boom');\nprocess.exit(3);\n" },
    worktree: { provision: { setupCommands: ['node setup.mjs', 'node --version'] } },
  });
  try {
    const result = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    const [task] = result.report.results;
    assert.equal(task.rolledBack, true);
    assert.equal(task.branchDeleted, true);
    assert.equal(task.released, true);
    // Only the failing command ran; the second command is never reached.
    assert.equal(result.report.results[0].status, 'failed');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
    // Command output is redacted and bounded before it reaches the receipt.
    assert.match(task.error, /node setup\.mjs/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('红区 env 文件默认 blocked，--confirm-red-zone 后才写入', async () => {
  const fixture = await makeWorkspaceFixture({
    extraFiles: { '.env': 'API_TOKEN=fixture\n' },
    hooks: { redZonePaths: ['.env'] },
    worktree: { ports: { base: 4100, blockSize: 5, variables: ['API_PORT'] }, provision: { envFiles: ['.env'] } },
  });
  try {
    const blocked = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.report.results[0].code, 'WORKTREE_RED_ZONE_CONFIRMATION_REQUIRED');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);

    const confirmed = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold',
      '--write', '--confirm-red-zone', '--json',
    ], { cwd: fixture.repo });
    assert.equal(confirmed.exitCode, 0, JSON.stringify(confirmed.report));
    // The declared port base and block size are honoured, and the red-zone env
    // file is materialized from the main checkout.
    const registry = await readRegistry(fixture.repo);
    assert.equal(registry.base, 4100);
    assert.equal(registry.blockSize, 5);
    assert.deepEqual(registry.entries[0].ports, { API_PORT: 4105 });
    // The checked-out copy carries the platform's line ending, so only the
    // content matters here.
    assert.deepEqual(
      (await readFile(path.join(fixture.worktreePath, '.env'), 'utf8')).split(/\r?\n/u).filter(Boolean),
      ['API_TOKEN=fixture'],
    );
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('cleanup 成功后在锁内释放端口登记项', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
    const cleaned = await runCommand([
      'worktree', 'cleanup', '--project', fixture.repo, '--task', 'ENG-1', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned.report));
    assert.equal(cleaned.report.results[0].portBlockReleased, true);
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
    assert.equal(existsSync(path.join(fixture.repo, '.vibe-harness/worktree-ports.lock')), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('check 报告端口冲突、env 漂移与未忽略的 env 文件', async () => {
  // `.env.local` is tracked and therefore never ignored, which is what the
  // not-ignored warning reports; the regenerated port env file stays ignored
  // and so keeps the worktree clean.
  const fixture = await makeWorkspaceFixture({
    extraFiles: { '.env.local': 'API_PORT=3999\n' },
    worktree: { provision: { envFiles: ['.env.local'] } },
  });
  try {
    await mkdir(path.join(fixture.repo, '.vibe-harness'), { recursive: true });
    await writeJson(path.join(fixture.repo, '.vibe-harness/worktree-ports.json'), {
      schemaVersion: 1,
      base: 3000,
      blockSize: 10,
      variables: ['PORT'],
      entries: [
        { block: 1, id: 'ENG-1', path: fixture.worktreePath, ports: { PORT: 3010 } },
        { block: 1, id: 'ENG-2', path: path.join(fixture.root, 'repo-worktrees', 'ENG-2'), ports: { PORT: 3011 } },
      ],
    });
    const conflict = await runCommand([
      'worktree', 'check', '--project', fixture.repo,
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    assert.equal(conflict.report.audit.problems.some((problem) => problem.code === 'WORKTREE_PORT_CONFLICT'), true);

    // A well-formed registry, but the worktree env file disagrees with it and
    // the file is not ignored, so both facts are reported without failing the
    // audit (they are warnings, not errors).
    await writeJson(path.join(fixture.repo, '.vibe-harness/worktree-ports.json'), {
      schemaVersion: 1,
      base: 3000,
      blockSize: 10,
      variables: ['PORT'],
      entries: [{ block: 1, id: 'ENG-1', path: fixture.worktreePath, ports: { PORT: 3010 } }],
    });
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await writeFile(path.join(fixture.worktreePath, '.vibe-harness/worktree.env'), 'PORT=9999\nVIBE_HARNESS_WORKTREE_BLOCK=7\n', 'utf8');
    const drifted = await runCommand([
      'worktree', 'check', '--project', fixture.repo,
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    const codes = drifted.report.audit.problems.map((problem) => problem.code);
    assert.ok(codes.includes('WORKTREE_PORT_ENV_DRIFT'), codes.join(','));
    assert.ok(codes.includes('WORKTREE_ENV_NOT_IGNORED'), codes.join(','));
    assert.equal(drifted.report.audit.ok, true);
    assert.equal(drifted.report.audit.cleanupAllowed, true);
    assert.equal(drifted.report.audit.ports.length, 1);
    assert.equal(drifted.report.audit.ports[0].block, 1);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree check 报告缺失的端口 env 文件', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await rm(path.join(fixture.worktreePath, '.vibe-harness/worktree.env'));
    const result = await runCommand(['worktree', 'check', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    assert.ok(result.report.audit.problems.some((problem) => problem.code === 'WORKTREE_PORT_ENV_MISSING'));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree recover reports residue as an error and only --write prunes it', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    // A hard kill between directory removal and `git worktree prune` leaves the
    // directory gone while Git still holds the binding.
    await rm(fixture.worktreePath, { force: true, recursive: true });

    const checked = await runCommand(['worktree', 'check', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(checked.exitCode, 1);
    assert.ok(
      checked.report.audit.problems.some((problem) => problem.code === 'WORKTREE_PRUNABLE_RESIDUE'),
      JSON.stringify(checked.report.audit.problems),
    );

    const planned = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.write, false);
    assert.equal(planned.report.prunable.length, 1);
    assert.equal(planned.report.pruned, null);
    assert.deepEqual(
      planned.report.orphanedBranches.map((item) => [item.branch, item.status]),
      [['feat/ENG-1-scaffold', 'planned']],
    );
    assert.deepEqual(
      planned.report.orphanedRegistry.map((item) => [item.id, item.status]),
      [['ENG-1', 'planned']],
    );
    // The dry run leaves the binding, the branch and the registry untouched.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(
      await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']),
      'feat/ENG-1-scaffold',
    );
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.pruned, true);
    assert.deepEqual(
      written.report.orphanedBranches.map((item) => [item.branch, item.status]),
      [['feat/ENG-1-scaffold', 'passed']],
    );
    assert.deepEqual(
      written.report.orphanedRegistry.map((item) => [item.id, item.status]),
      [['ENG-1', 'passed']],
    );
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
    // Removing the residue never takes the main checkout's dependencies with
    // it, even though the worktree linked into them.
    const mainDependency = path.join(fixture.repo, 'frontend/node_modules/dep-a/package.json');
    assert.equal(JSON.parse(await readFile(mainDependency, 'utf8')).name, 'dep-a');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree recover removes an incomplete worktree but never a user branch', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    // A bootstrap that died between `git worktree add` and the locked writes
    // leaves the worktree without its port env file. The user placeholder
    // branch is not bootstrap residue and must survive.
    await rm(path.join(fixture.worktreePath, '.vibe-harness/worktree.env'));
    await git(fixture.repo, ['branch', 'user/feature']);

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    const [result] = written.report.results;
    assert.equal(result.status, 'passed');
    assert.equal(result.branchDeleted, true);
    assert.equal(result.portBlockReleased, true);
    assert.deepEqual(written.report.orphanedBranches, []);
    assert.deepEqual(written.report.orphanedRegistry, []);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
    assert.equal(
      await git(fixture.repo, ['branch', '--list', 'user/feature', '--format=%(refname:short)']),
      'user/feature',
    );
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
    // The main checkout's dependencies survive the teardown.
    const mainDependency = path.join(fixture.repo, 'frontend/node_modules/dep-a/package.json');
    assert.equal(JSON.parse(await readFile(mainDependency, 'utf8')).name, 'dep-a');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree recover leaves touched, dirty and foreign worktrees alone', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    // A commit beyond the base ref means the branch may hold work.
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await writeFile(path.join(fixture.worktreePath, 'work.txt'), 'done\n', 'utf8');
    await git(fixture.worktreePath, ['add', '.']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: work']);

    // Uncommitted changes block removal even when the env file is missing.
    const secondWorktree = path.join(fixture.root, 'repo-worktrees', 'ENG-2');
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await rm(path.join(secondWorktree, '.vibe-harness/worktree.env'));
    await writeFile(path.join(secondWorktree, 'wip.txt'), 'wip\n', 'utf8');

    // A foreign worktree outside the configured root, never registered.
    await git(fixture.repo, ['worktree', 'add', '-q', '-b', 'user/foreign', path.join(fixture.root, 'elsewhere')]);

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.deepEqual(written.report.results, []);
    assert.deepEqual(written.report.orphanedBranches, []);
    assert.deepEqual(written.report.orphanedRegistry, []);
    assert.deepEqual(written.report.prunable, []);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await entryExists(fixture.repo, secondWorktree), true);
    assert.equal(await entryExists(fixture.repo, path.join(fixture.root, 'elsewhere')), true);
    assert.equal(
      await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']),
      'feat/ENG-1-scaffold',
    );
    assert.equal(
      await git(fixture.repo, ['branch', '--list', 'feat/ENG-2-scaffold', '--format=%(refname:short)']),
      'feat/ENG-2-scaffold',
    );
    assert.equal(
      await git(fixture.repo, ['branch', '--list', 'user/foreign', '--format=%(refname:short)']),
      'user/foreign',
    );
    assert.equal((await readRegistry(fixture.repo)).entries.length, 2);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});
