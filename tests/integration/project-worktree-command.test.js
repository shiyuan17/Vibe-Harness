import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { landLockTimeoutMs, runCommand } from '../../runtime/commands/run.mjs';
import { GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS, MIN_GIT_TIMEOUT_MS, gitTimeoutMs } from '../../runtime/lib/git-timeouts.mjs';
import { expandMirrors, linkOrCopyMirrors, removeMirrorLinks } from '../../runtime/lib/worktree-mirrors.mjs';
import { acquireDeliveryTurn, releaseDeliveryTurn } from '../../runtime/lib/worktree-delivery-queue.mjs';

// `run.mjs worktree` is the installed entry point for worktree provisioning and
// cleanup under docs/rules/git-rules.md §Worktree: read-only by default and
// `--write` for real writes. `worktree stage` builds and verifies a local
// candidate outside the queue without fetching or moving the primary checkout.
// `worktree publish` auto-reconciles against the remote, and only its
// seconds-scale finalize section takes a repository FIFO turn; verification,
// merges and cleanup run entirely outside the queue. These tests pin both
// flows, the receipt shape, and the safety gates.

const execFileAsync = promisify(execFile);
const gitIdentity = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture'];
const runtimePath = fileURLToPath(new URL('../../runtime/commands/run.mjs', import.meta.url));

async function git(cwd, args) {
  // An undefined cwd would make the git child fall back to the host process's
  // working directory, silently asserting against the developer's own repo.
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error(`git helper requires an explicit cwd, got ${JSON.stringify(cwd)}`);
  }
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
  validationCommands = null,
  verification = null,
  delivery = null,
  worktree = {},
} = {}) {
  // The runtime reports canonical paths for the project it is pointed at, and
  // `git worktree list` already does. Resolve the fixture root once so the
  // expectations here compare the same form the product reports; a raw
  // `mkdtemp` path can be an 8.3 alias (`RUNNER~1`) or a junction on Windows.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vibe-harness-worktree-command-')));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'frontend/packages/contracts'), { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // `worktree stage` builds candidates with real `git merge` commits, which need
  // a committer identity from the checkout itself. A clean CI runner has no
  // global identity, so the fixture records one instead of inheriting the
  // developer machine's.
  await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repo, ['config', 'user.name', 'Fixture']);
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
    ...(validationCommands ? { validationCommands } : {}),
    ...(verification ? { verification } : {}),
    ...(delivery ? { delivery } : {}),
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

test('runtime help exposes the worktree delivery surface and explicit candidate paths', async () => {
  const result = await runCommand(['help', '--json']);
  assert.equal(result.exitCode, 0);
  assert.match(result.report.worktree, /<list\|check\|bootstrap\|stage\|publish\|status\|discard\|cleanup\|recover>/u);
  assert.match(result.report.worktree, /only publish takes a repository FIFO turn/u);
  assert.match(result.report.worktree, /stores refs\/vibe-harness\/staged\/<batchId>/u);
  assert.match(result.report.worktree, /publish --batch <id> auto-reconciles/u);
  assert.match(result.report.worktree, /recover takes no --batch\/--archive-integrated/u);
  assert.match(result.report.worktree, /VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS defaults to 30 minutes/u);
  assert.match(result.report.verify, /\[--paths <path\.\.\.>\]/u);
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
      ['git-worktree-add', 'link-dependencies', 'link-package-roots', 'mirror-governance', 'allocate-ports', 'materialize-env-files', 'probe-toolchain'],
    );
    assert.equal(planned.report.results[0].steps[4].block, 1);
    assert.deepEqual(planned.report.results[0].steps[4].ports, { PORT: 3010 });

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

test('bootstrap 投影治理面镜像：目录链接、文件复制、skipped 与 present', async () => {
  const fixture = await makeWorkspaceFixture({
    extraFiles: {
      '.agents/skills/demo/SKILL.md': '# demo\n',
      '.serena/project.yml': 'project_name: fixture\n',
      'opencode.json': '{ "mcp": {} }\n',
    },
    gitignore: 'node_modules\n.vibe-harness/\n.agents/\n.serena/\nopencode.json\n',
    worktree: { mirrors: ['.agents', 'opencode.json', '.serena/project.yml', '.serena/.gitignore', 'missing-dir'] },
  });
  try {
    const bootArgs = ['worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json'];
    const written = await runCommand(bootArgs, { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    const byMirror = new Map(written.report.results[0].mirrors.map((item) => [item.mirror, item.status]));
    assert.equal(byMirror.get('.agents'), 'linked');
    assert.equal(byMirror.get('opencode.json'), 'copied');
    assert.equal(byMirror.get('.serena/project.yml'), 'copied');
    // The main checkout does not carry these, so they are reported without
    // failing the bootstrap.
    assert.equal(byMirror.get('.serena/.gitignore'), 'skipped');
    assert.equal(byMirror.get('missing-dir'), 'skipped');

    // A directory mirror is a link, so the worktree sees the main checkout's
    // Skills without copying 1 GB.
    assert.equal(
      await realpath(path.join(fixture.worktreePath, '.agents')),
      await realpath(path.join(fixture.repo, '.agents')),
    );
    // Copied files are real files inside the worktree, not links back.
    const opencodeReal = await realpath(path.join(fixture.worktreePath, 'opencode.json'));
    assert.notEqual(opencodeReal, await realpath(path.join(fixture.repo, 'opencode.json')));
    assert.equal(await readFile(path.join(fixture.worktreePath, '.serena/project.yml'), 'utf8'), 'project_name: fixture\n');

    // A mirror that already exists is `present` and never overwritten.
    await rm(path.join(fixture.worktreePath, '.agents'), { force: true, recursive: true });
    await mkdir(path.join(fixture.worktreePath, '.agents/local'), { recursive: true });
    await writeFile(path.join(fixture.worktreePath, '.agents/local/keep.txt'), 'mine\n', 'utf8');
    const again = await runCommand(bootArgs, { cwd: fixture.repo });
    assert.equal(again.exitCode, 0, JSON.stringify(again.report));
    const present = new Map(again.report.results[0].mirrors.map((item) => [item.mirror, item.status]));
    assert.equal(present.get('.agents'), 'present');
    assert.equal(await readFile(path.join(fixture.worktreePath, '.agents/local/keep.txt'), 'utf8'), 'mine\n');

    // A declared mirror that is a local copy instead of a link is a stale fact
    // the audit reports, and it never blocks cleanup of a merged worktree.
    const checked = await runCommand([
      'worktree', 'check', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--json',
    ], { cwd: fixture.repo });
    const codes = checked.report.audit.problems.map((problem) => problem.code);
    assert.ok(codes.includes('WORKTREE_MIRROR_STALE'), codes.join(','));
    assert.equal(checked.report.audit.cleanupAllowed, true);

    // Removing the local copy and re-running restores the link.
    await rm(path.join(fixture.worktreePath, '.agents'), { force: true, recursive: true });
    const restored = await runCommand(bootArgs, { cwd: fixture.repo });
    assert.equal(restored.exitCode, 0, JSON.stringify(restored.report));
    assert.equal(
      await realpath(path.join(fixture.worktreePath, '.agents')),
      await realpath(path.join(fixture.repo, '.agents')),
    );
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('bootstrap 链接 .bun store、跳过构建缓存并投影包级 node_modules', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    // Content-addressed bun store plus a build cache in the same point directory.
    await mkdir(path.join(fixture.repo, 'frontend/node_modules/.bun'), { recursive: true });
    await writeJson(path.join(fixture.repo, 'frontend/node_modules/.bun/marker.json'), { ok: true });
    await mkdir(path.join(fixture.repo, 'frontend/node_modules/.cache'), { recursive: true });
    await writeFile(path.join(fixture.repo, 'frontend/node_modules/.cache/stale.txt'), 'cache\n', 'utf8');
    // An isolated per-package install: the workspace package keeps its own
    // `node_modules`, which the hoisted root link alone would never cover.
    await mkdir(path.join(fixture.repo, 'frontend/packages/contracts/node_modules/dep-b'), { recursive: true });
    await writeJson(path.join(fixture.repo, 'frontend/packages/contracts/node_modules/dep-b/package.json'), { name: 'dep-b', version: '1.0.0' });

    const written = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));

    // `.bun` travels with the overlay; `.cache` stays in the main checkout.
    assert.equal(
      await realpath(path.join(fixture.worktreePath, 'frontend/node_modules/.bun')),
      await realpath(path.join(fixture.repo, 'frontend/node_modules/.bun')),
    );
    assert.equal(existsSync(path.join(fixture.worktreePath, 'frontend/node_modules/.cache')), false);

    // The per-package overlay links the third-party dependency back and keeps
    // the local package inside the worktree.
    const packageModules = path.join(fixture.worktreePath, 'frontend/packages/contracts/node_modules');
    assert.equal(existsSync(packageModules), true);
    assert.equal(
      await realpath(path.join(packageModules, 'dep-b')),
      await realpath(path.join(fixture.repo, 'frontend/packages/contracts/node_modules/dep-b')),
    );
    const worktreeRoot = await realpath(fixture.worktreePath);
    const localInPackage = await realpath(path.join(packageModules, '@fixture/contracts'));
    assert.equal(path.relative(worktreeRoot, localInPackage).startsWith('..'), false);
    assert.deepEqual(written.report.results[0].packageRoots.map((item) => item.package), ['@fixture/contracts']);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('bootstrap 失败回滚时清除镜像链接且不触碰主检出', async () => {
  const fixture = await makeWorkspaceFixture({
    extraFiles: {
      '.agents/skills/demo/SKILL.md': '# demo\n',
      'setup.mjs': 'process.exit(3);\n',
    },
    gitignore: 'node_modules\n.vibe-harness/\n.agents/\n',
    worktree: { mirrors: ['.agents'], provision: { setupCommands: ['node setup.mjs'] } },
  });
  try {
    const result = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.results[0].rolledBack, true);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    // The mirrored governance surface in the main checkout survived the
    // rolled-back junction: a recursive delete must never reach it.
    assert.equal(existsSync(path.join(fixture.repo, '.agents/skills/demo/SKILL.md')), true);
    assert.equal(await readFile(path.join(fixture.repo, '.agents/skills/demo/SKILL.md'), 'utf8'), '# demo\n');
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
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
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

test('复用 worktree 的回执与端口登记沿用既有分支而不是约定默认名', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-7:feat/ENG-7-reuse', '--write', '--json',
    ], { cwd: fixture.repo });
    // The second call names the task only: the path matches the existing
    // worktree, so the receipt and the registry must keep that branch instead
    // of falling back to `feat/ENG-7-worktree`.
    const again = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-7', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(again.exitCode, 0, JSON.stringify(again.report));
    assert.equal(again.report.results[0].steps[0].kind, 'reuse-worktree');
    assert.equal(again.report.results[0].branch, 'feat/ENG-7-reuse');
    const registry = await readRegistry(fixture.repo);
    assert.deepEqual(registry.entries.map((entry) => entry.branch), ['feat/ENG-7-reuse']);
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
      ['git-worktree-add', 'setup-command', 'link-dependencies', 'link-package-roots', 'mirror-governance', 'allocate-ports', 'materialize-env-files', 'probe-toolchain'],
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

test('复用 Worktree 初始化失败保留已有分支和未提交文件', async () => {
  const fixture = await makeWorkspaceFixture({
    extraFiles: { 'setup.mjs': "if (process.env.FAIL_SETUP) process.exit(3);\n" },
    worktree: { provision: { setupCommands: ['node setup.mjs'] } },
  });
  try {
    const taskArgs = ['worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json'];
    const created = await runCommand(taskArgs, { cwd: fixture.repo });
    assert.equal(created.exitCode, 0, JSON.stringify(created.report));
    await writeFile(path.join(fixture.worktreePath, 'keep.txt'), 'uncommitted\n', 'utf8');
    await writeFile(path.join(fixture.worktreePath, 'setup.mjs'), 'process.exit(3);\n', 'utf8');
    const failed = await runCommand(taskArgs, { cwd: fixture.repo });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.report.results[0].rolledBack, false);
    assert.equal(failed.report.results[0].branchDeleted, false);
    assert.equal(await readFile(path.join(fixture.worktreePath, 'keep.txt'), 'utf8'), 'uncommitted\n');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.match(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), /feat\/ENG-1-scaffold/u);
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('Worktree 环境文件拒绝父目录与链接逃逸且不产生越界写入', async () => {
  const fixture = await makeWorkspaceFixture({ worktree: { ports: { envFile: '../outside.env' } } });
  try {
    const taskArgs = ['worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json'];
    const escaped = await runCommand(taskArgs, { cwd: fixture.repo });
    assert.equal(escaped.exitCode, 1);
    assert.match(escaped.report.results[0].error, /must stay inside/iu);
    assert.equal(existsSync(path.join(path.dirname(fixture.worktreePath), 'outside.env')), false);

    const configPath = path.join(fixture.repo, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.worktree.ports.envFile = 'linked/outside.env';
    await writeJson(configPath, config);
    const linkedPath = path.join(fixture.root, 'repo-worktrees', 'ENG-2');
    await git(fixture.repo, ['worktree', 'add', linkedPath, '-b', 'feat/ENG-2-scaffold', 'main']);
    await symlink(fixture.root, path.join(linkedPath, 'linked'), 'junction');
    const linked = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(linked.exitCode, 1);
    assert.match(linked.report.results[0].error, /must stay inside/iu);
    assert.equal(linked.report.results[0].rolledBack, false);
    assert.equal(existsSync(path.join(fixture.root, 'outside.env')), false);
    assert.equal(await entryExists(fixture.repo, linkedPath), true);
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

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    // Recover prunes residue without taking a delivery turn; it only
    // inventories and reconciles retained queue tickets.
    assert.equal(written.report.queueReconciliation.ok, true, JSON.stringify(written.report.queueReconciliation));
    assert.deepEqual(written.report.queueInventory, []);
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

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
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

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
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

// `worktree stage` and `worktree publish` close the loop git-rules.md §Worktree
// describes. The fixtures below move the primary checkout onto a landing branch
// (stage refuses the protected branches the fixture repo starts on) and
// configure a trivial passing check so the verify gate has real evidence.

async function makeLandFixture({
  extraFiles = {}, validationCommands = { test: 'node --version' }, verification = null,
  delivery = null, worktree = {},
} = {}) {
  const fixture = await makeWorkspaceFixture({ extraFiles, validationCommands, verification, delivery, worktree });
  await git(fixture.repo, ['checkout', '-q', '-b', 'feat/landing-zone']);
  return fixture;
}

async function bootstrapWithWork(fixture) {
  await runCommand([
    'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
  ], { cwd: fixture.repo });
  await writeFile(path.join(fixture.worktreePath, 'work.txt'), 'done\n', 'utf8');
  await git(fixture.worktreePath, ['add', '.']);
  await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: work']);
}

async function bootstrapBatchSecond(fixture, content, name = 'second.txt') {
  const secondPath = path.join(fixture.root, 'repo-worktrees', 'ENG-2');
  const bootstrapped = await runCommand([
    'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
  ], { cwd: fixture.repo });
  assert.equal(bootstrapped.report.status, 'passed', JSON.stringify(bootstrapped.report));
  await writeFile(path.join(secondPath, name), content);
  await git(secondPath, ['add', name]);
  await git(secondPath, ['commit', '-q', '-m', 'feat: second']);
  return secondPath;
}

async function makeLocalFixture({ remote = true, ...options } = {}) {
  const fixture = await makeLandFixture(options);
  await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
  if (remote) {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    // Tests assert against the bare through fixture.origin; without this
    // assignment those asserts would silently run git in the host repo.
    fixture.origin = origin;
  }
  return fixture;
}

async function makeDevelopLandFixture(options = {}) {
  const fixture = await makeLocalFixture({ ...options, remote: false });
  fixture.origin = path.join(fixture.root, 'origin.git');
  await git(fixture.root, ['init', '--bare', '-q', fixture.origin]);

  await git(fixture.repo, ['remote', 'add', 'origin', fixture.origin]);
  await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
  await bootstrapWithWork(fixture);
  return fixture;
}

for (const batch of [false, true]) {
  test(`worktree ${batch ? 'batch' : 'single'} stage 冻结推送端点，publish 只推送到冻结的 develop`, async () => {
    const fixture = await makeDevelopLandFixture();
    try {
      if (batch) await bootstrapBatchSecond(fixture, 'two\n');
      const before = await git(fixture.repo, ['rev-parse', 'develop']);
      await git(fixture.repo, ['push', 'origin', `${before}:refs/heads/main`]);
      await git(fixture.repo, ['config', 'remote.origin.push', 'refs/heads/develop:refs/heads/main']);
      await git(fixture.repo, ['config', 'branch.develop.pushRemote', 'unavailable']);
      await git(fixture.repo, ['config', 'remote.pushDefault', 'unavailable']);
      await git(fixture.repo, ['config', 'branch.develop.merge', 'refs/heads/main']);
      const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        ...(batch ? ['--batch', '--task', 'ENG-2'] : []), '--task', 'ENG-1',
        '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
      assert.equal(staged.report.integrationStatus, 'local_staged');
      assert.equal(staged.report.queue, null);
      assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), before);
      // Publish pushes the frozen candidate head before any local sync, so the
      // hook can only assert on the candidate itself, not on local develop.
      const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
      await writeFile(hook, `#!/bin/sh\nread old new ref\ntest "$ref" = refs/heads/develop && test "$new" = ${staged.report.candidateHead}\n`);
      await chmod(hook, 0o755);
      const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
        '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
      { cwd: fixture.repo });
      assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
      assert.equal(published.report.integrationStatus, 'integrated');
      assert.equal(published.report.localRefSync, 'updated');
      assert.equal(await git(fixture.origin, ['rev-parse', 'main']), before);
      assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.candidateHead);
      assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.candidateHead);
    } finally {
      await removeTemporaryDirectory(fixture.root);
    }
  });
}

test('worktree publish 重试被拒推送时复用已验证候选', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const args = ['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'];
    const rejected = await runCommand(args, { cwd: fixture.repo });
    assert.notEqual(rejected.exitCode, 0);
    assert.equal(rejected.report.status, 'blocked', JSON.stringify(rejected.report));
    assert.equal(rejected.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    assert.equal(rejected.report.queue.state, 'cancelled');
    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.phase, 'push_uncertain');
    assert.equal(state.queue.state, 'cancelled');
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.targetBefore);
    assert.equal(await git(fixture.repo, ['rev-parse', staged.report.stagedRef]), staged.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    const unsafeCleanup = await runCommand(['worktree', 'cleanup', '--project', fixture.repo,
      '--task', 'ENG-1', '--base-ref', 'develop', '--write', '--json'], { cwd: fixture.repo });
    assert.notEqual(unsafeCleanup.exitCode, 0);
    assert.equal(unsafeCleanup.report.results[0].code, 'WORKTREE_CLEANUP_LAND_RESUME_REQUIRED');
    assert.equal(unsafeCleanup.report.results[0].batchId, staged.report.batchId);
    assert.match(unsafeCleanup.report.results[0].blockers[0], /publish --batch/);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
    await rm(hook);
    const retry = await runCommand(args, { cwd: fixture.repo });
    assert.equal(retry.report.status, 'passed', JSON.stringify(retry.report));
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage 拒绝 --target-mode remote，publish 不再接受该参数', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const before = await git(fixture.repo, ['show-ref']);
    const remoteBefore = await git(fixture.origin, ['show-ref']);
    for (const batch of [false, true]) {
      const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        '--task', 'ENG-1', ...(batch ? ['--batch'] : []), '--target-mode', 'remote',
        '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      assert.equal(result.report.status, 'blocked', JSON.stringify(result.report));
      assert.equal(result.report.code, 'LAND_BATCH_OPTIONS', JSON.stringify(result.report));
      assert.equal(await git(fixture.repo, ['show-ref']), before);
      assert.equal(await git(fixture.origin, ['show-ref']), remoteBefore);
    }
    const rejectedPublish = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', 'unknown-batch', '--target-mode', 'remote', '--json'], { cwd: fixture.repo });
    assert.equal(rejectedPublish.report.status, 'failed', JSON.stringify(rejectedPublish.report));
    assert.equal(rejectedPublish.report.code, 'WORKTREE_TARGET_MODE_INVALID', JSON.stringify(rejectedPublish.report));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

for (const mode of ['multiple-push-urls', 'mirror']) {
  test(`worktree stage 容忍误导性推送配置，publish 在 ${mode} 下拒绝推送`, async () => {
    const fixture = await makeDevelopLandFixture();
    try {
      const localBefore = await git(fixture.repo, ['show-ref', '--heads']);
      const remoteBefore = await git(fixture.origin, ['show-ref']);
      if (mode === 'mirror') await git(fixture.repo, ['config', 'remote.origin.mirror', 'true']);
      else {
        await git(fixture.repo, ['config', '--add', 'remote.origin.pushurl', fixture.origin]);
        await git(fixture.repo, ['config', '--add', 'remote.origin.pushurl', path.join(fixture.root, 'other.git')]);
      }
      const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
        '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
      assert.equal(staged.report.integrationStatus, 'local_staged');
      assert.equal(await git(fixture.repo, ['show-ref', '--heads']), localBefore);
      assert.equal(await git(fixture.origin, ['show-ref']), remoteBefore);
      const rejected = await runCommand(['worktree', 'publish', '--project', fixture.repo,
        '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      assert.equal(rejected.report.status, 'blocked', JSON.stringify(rejected.report));
      assert.equal(rejected.report.code, 'LAND_PUSH_TARGET_INVALID', JSON.stringify(rejected.report));
      assert.equal(await git(fixture.repo, ['show-ref', '--heads']), localBefore);
      assert.equal(await git(fixture.origin, ['show-ref']), remoteBefore);
      assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    } finally {
      await removeTemporaryDirectory(fixture.root);
    }
  });
}

test('worktree publish 推送结果不明时核对远端且不重复推送', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'post-receive');
    const count = path.join(fixture.origin, 'push-count');
    await writeFile(hook, '#!/bin/sh\necho push >> push-count\ngit config uploadpack.hideRefs refs/heads/develop\n');
    await chmod(hook, 0o755);
    const args = ['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'];
    const unknown = await runCommand(args, { cwd: fixture.repo });
    assert.equal(unknown.report.code, 'LAND_PUSH_UNCONFIRMED', JSON.stringify(unknown.report));
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
    const stillUnknown = await runCommand(args, { cwd: fixture.repo });
    assert.equal(stillUnknown.report.code, 'LAND_PUSH_UNCONFIRMED');
    await git(fixture.origin, ['config', '--unset', 'uploadpack.hideRefs']);
    const resumed = await runCommand(args, { cwd: fixture.repo });
    assert.equal(resumed.report.integrationStatus, 'integrated', JSON.stringify(resumed.report));
    assert.equal(resumed.report.queue, null);
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal((await readFile(count, 'utf8')).trim(), 'push');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 推送期间远端分叉时保留候选，重试时基于新基线重建', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const base = await git(fixture.repo, ['rev-parse', 'develop']);
    const tree = await git(fixture.repo, ['rev-parse', 'develop^{tree}']);
    const fork = await git(fixture.repo, ['commit-tree', tree, '-p', base, '-m', 'independent remote change']);
    await git(fixture.repo, ['push', 'origin', `${fork}:refs/heads/other`]);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'post-receive');
    await writeFile(hook, `#!/bin/sh\ngit update-ref refs/heads/develop ${fork}\n`);
    await chmod(hook, 0o755);
    const args = ['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'];
    const result = await runCommand(args, { cwd: fixture.repo });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.report.code, 'LAND_REMOTE_DIVERGED');
    assert.equal(result.report.remoteHead, fork, JSON.stringify(result.report));
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.targetBefore);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), fork);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    await rm(hook);
    const retry = await runCommand(args, { cwd: fixture.repo });
    assert.equal(retry.report.status, 'passed', JSON.stringify(retry.report));
    assert.equal(retry.report.reconcileHistory[0].kind, 'rebuilt', JSON.stringify(retry.report));
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), await git(fixture.origin, ['rev-parse', 'develop']));
    assert.equal(await git(fixture.origin, ['rev-list', '--count', `develop..${fork}`]), '0');
    assert.equal((await git(fixture.origin, ['show', 'develop:work.txt'])).trim(), 'done');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage 在脏主检出下只生成持久本地候选，不 fetch 也不移动远端', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const localBefore = await git(fixture.repo, ['rev-parse', 'develop']);
    const remoteBefore = await git(fixture.origin, ['rev-parse', 'develop']);
    await writeFile(path.join(fixture.repo, 'unrelated.txt'), 'preserve user work\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    assert.equal(staged.report.integrationStatus, 'local_staged');
    assert.equal(staged.report.commandStatus, 'passed');
    assert.equal(staged.report.remoteValidation, 'not_required');
    assert.equal(staged.report.localRefSync, 'not_attempted');
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), localBefore);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), remoteBefore);
    assert.equal(await git(fixture.repo, ['rev-parse', staged.report.stagedRef]), staged.report.candidateHead);
    assert.equal(await readFile(path.join(fixture.repo, 'unrelated.txt'), 'utf8'), 'preserve user work\n');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);

    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.status, 'passed', JSON.stringify(status.report));
    assert.equal(status.report.integrationStatus, 'local_staged');
    assert.equal(status.report.stagedRefValid, true);

    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.queue, null);
    assert.equal(typeof state.pushTarget.fingerprint, 'string');
    assert.equal(Object.hasOwn(state.pushTarget, 'url'), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 基于最新远端重建验证，主检出脏时延迟本地同步并保留用户改动', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const localBefore = await git(fixture.repo, ['rev-parse', 'develop']);
    const remoteBase = await git(fixture.origin, ['rev-parse', 'develop']);
    const remoteTree = await git(fixture.origin, ['rev-parse', 'develop^{tree}']);
    const remoteAdvance = await git(fixture.repo, [
      'commit-tree', remoteTree, '-p', remoteBase, '-m', 'remote advance',
    ]);
    await git(fixture.repo, ['push', 'origin', `${remoteAdvance}:refs/heads/develop`]);
    await writeFile(path.join(fixture.repo, 'unrelated.txt'), 'preserve user work\n');

    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated', JSON.stringify(published.report));
    assert.equal(published.report.localRefSync, 'deferred');
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), localBefore);
    const remoteHead = await git(fixture.origin, ['rev-parse', 'develop']);
    assert.equal(remoteHead, published.report.targetAfter);
    assert.equal(await git(fixture.repo, ['merge-base', '--is-ancestor', remoteAdvance, remoteHead]), '');
    assert.equal((await git(fixture.origin, ['show', 'develop:work.txt'])).trim(), 'done');
    assert.equal(await readFile(path.join(fixture.repo, 'unrelated.txt'), 'utf8'), 'preserve user work\n');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 独占仓库 FIFO，超时阻塞并在失败时释放', async () => {
  const fixture = await makeDevelopLandFixture();
  const previousTimeout = process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
  let held = null;
  try {
    held = await acquireDeliveryTurn(fixture.repo, { operation: 'publish', timeoutMs: 1000 });
    assert.equal(held.ok, true, JSON.stringify(held));
    process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = '150';
    const staged = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    assert.equal(staged.report.integrationStatus, 'local_staged');
    assert.equal(staged.report.queue, null);

    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    assert.equal(existsSync(statePath), true, JSON.stringify({
      statePath,
      gitEntries: await readdir(path.join(fixture.repo, '.git')),
      staged: staged.report,
    }));
    const legacyV4 = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(legacyV4.schemaVersion, 4);
    assert.equal(legacyV4.queue, null);
    await writeJson(statePath, { ...legacyV4, schemaVersion: 3 });
    const v3Status = await runCommand([
      'worktree', 'status', '--project', fixture.repo, '--batch', staged.report.batchId, '--json',
    ], { cwd: fixture.repo });
    assert.equal(v3Status.report.integrationStatus, 'local_staged', JSON.stringify(v3Status.report));
    const legacyV2 = { ...legacyV4, schemaVersion: 2 };
    delete legacyV2.queue;
    await writeJson(statePath, legacyV2);
    const v2Status = await runCommand([
      'worktree', 'status', '--project', fixture.repo, '--batch', staged.report.batchId, '--json',
    ], { cwd: fixture.repo });
    assert.equal(v2Status.report.integrationStatus, 'local_staged', JSON.stringify(v2Status.report));
    await writeJson(statePath, { ...legacyV2, schemaVersion: 1 });
    const v1Status = await runCommand([
      'worktree', 'status', '--project', fixture.repo, '--batch', staged.report.batchId, '--json',
    ], { cwd: fixture.repo });
    assert.equal(v1Status.report.integrationStatus, 'local_staged', JSON.stringify(v1Status.report));
    await writeJson(statePath, legacyV4);

    const blockedPublish = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blockedPublish.report.status, 'blocked', JSON.stringify(blockedPublish.report));
    assert.equal(blockedPublish.report.code, 'WORKTREE_QUEUE_TIMEOUT');
    assert.equal(blockedPublish.report.queue.owner.operation, 'publish');
    assert.equal(blockedPublish.report.queue.state, 'queued');
    const status = await runCommand([
      'worktree', 'status', '--project', fixture.repo, '--batch', staged.report.batchId, '--json',
    ], { cwd: fixture.repo });
    assert.equal(status.report.integrationStatus, 'local_staged', JSON.stringify(status.report));

    await releaseDeliveryTurn(held, 'completed');
    held = null;
    process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = '5000';
    const rejectHook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(rejectHook, '#!/bin/sh\nexit 1\n');
    await chmod(rejectHook, 0o755);
    const rejectedPublish = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(rejectedPublish.report.status, 'blocked', JSON.stringify(rejectedPublish.report));
    assert.equal(rejectedPublish.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejectedPublish.report));
    assert.equal(rejectedPublish.report.queue.state, 'cancelled');
    const failed = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(failed.schemaVersion, 4);
    assert.equal(failed.phase, 'push_uncertain');
    assert.equal(failed.queue.state, 'cancelled');

    await rm(rejectHook);
    const published = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.queue.state, 'completed');
    assert.equal(existsSync(statePath), false);
  } finally {
    if (previousTimeout === undefined) delete process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
    else process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = previousTimeout;
    if (held) await releaseDeliveryTurn(held, 'cancelled');
    await removeTemporaryDirectory(fixture.root);
  }
});

test('交付事务中的 repo-heavy 检查在队列外验证且不自锁', async () => {
  const previousTimeout = process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
  const fixture = await makeDevelopLandFixture({
    extraFiles: { 'repo-heavy.mjs': "console.log('repo-heavy passed');\n" },
    validationCommands: {
      test: 'node repo-heavy.mjs',
      tiers: { quick: ['node repo-heavy.mjs'], standard: [], deep: [] },
      checks: [{
        id: 'test',
        command: 'node repo-heavy.mjs',
        deterministic: true,
        cacheScope: 'tree',
        resourceClass: 'repo-heavy',
      }],
    },
    verification: { reuse: { mode: 'tree-content' } },
  });
  let held = null;
  try {
    held = await acquireDeliveryTurn(fixture.repo, { operation: 'publish', timeoutMs: 1000 });
    assert.equal(held.ok, true, JSON.stringify(held));
    process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = '1000';
    const staged = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    assert.equal(staged.report.integrationStatus, 'local_staged');
    assert.equal(staged.report.queue, null);
  } finally {
    if (previousTimeout === undefined) delete process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
    else process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = previousTimeout;
    if (held) await releaseDeliveryTurn(held, 'cancelled');
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree discard 回收未发布候选引用但保留任务工作区', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const discarded = await runCommand(['worktree', 'discard', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(discarded.report.status, 'passed', JSON.stringify(discarded.report));
    assert.equal(discarded.report.integrationStatus, 'not_integrated');
    const refs = await git(fixture.repo, ['for-each-ref', '--format=%(refname)', 'refs/vibe-harness']);
    assert.equal(refs, '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.match(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), /feat\/ENG-1-scaffold/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage 状态文件不落原始推送 URL 或凭据', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const token = 'stage-secret-token';
    await git(fixture.repo, ['remote', 'set-url', '--push', 'origin',
      `https://user:${token}@example.invalid/acme/repo.git`]);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    const raw = await readFile(statePath, 'utf8');
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes('https://'), false);
    assert.match(raw, /"fingerprint": "[0-9a-f]{64}"/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree discard 拒绝事务候选路径越界并保留现场', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.candidate = path.join(fixture.root, 'outside',
      `.vibe-harness-land-batch-${staged.report.batchId}`);
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const discarded = await runCommand(['worktree', 'discard', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(discarded.report.code, 'LAND_BATCH_STATE_INVALID', JSON.stringify(discarded.report));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['rev-parse', staged.report.stagedRef]), staged.report.candidateHead);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage 可按显式分支接收宿主创建且未登记端口的 worktree', async () => {
  const fixture = await makeDevelopLandFixture();
  const hostWorktree = path.join(fixture.root, 'host-worktrees', 'ENG-host');
  try {
    await mkdir(path.dirname(hostWorktree), { recursive: true });
    await git(fixture.repo, ['worktree', 'add', '-q', '-b', 'feat/ENG-host', hostWorktree, 'develop']);
    await writeFile(path.join(hostWorktree, 'host.txt'), 'host work\n');
    await git(hostWorktree, ['add', 'host.txt']);
    await git(hostWorktree, ['commit', '-q', '-m', 'feat: host work']);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-host:feat/ENG-host', '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    assert.equal(staged.report.sourceBranch, 'feat/ENG-host');
    assert.equal(await entryExists(fixture.repo, hostWorktree), true);
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.integrationStatus, 'integrated', JSON.stringify(published.report));
    assert.equal(await entryExists(fixture.repo, hostWorktree), false);
    assert.equal(await git(fixture.origin, ['show', 'develop:host.txt']), 'host work');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 推送被拒后保留暂存状态并在远端未变时重试原候选', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const rejected = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(rejected.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    assert.equal(rejected.report.integrationStatus, 'not_integrated');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.phase, 'push_uncertain');
    assert.equal(status.report.stagedRefValid, true);
    const discarded = await runCommand(['worktree', 'discard', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(discarded.report.code, 'LAND_DISCARD_PUSH_UNCERTAIN', JSON.stringify(discarded.report));
    await rm(hook);
    const retried = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(retried.report.integrationStatus, 'integrated', JSON.stringify(retried.report));
    assert.equal(retried.report.targetAfter, staged.report.candidateHead);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.candidateHead);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 在 push_uncertain 后按最新远端自动重建并验证', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const rejected = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(rejected.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    await rm(hook);

    const base = await git(fixture.origin, ['rev-parse', 'develop']);
    const tree = await git(fixture.origin, ['rev-parse', 'develop^{tree}']);
    const remoteAdvance = await git(fixture.repo, [
      'commit-tree', tree, '-p', base, '-m', 'remote advance before reconcile',
    ]);
    await git(fixture.repo, ['push', 'origin', `${remoteAdvance}:refs/heads/develop`]);

    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.batchId, staged.report.batchId);
    // Reconcile classified the divergence once and rebuilt from the newer baseline.
    assert.equal(published.report.reconcileHistory.length, 1, JSON.stringify(published.report.reconcileHistory));
    assert.equal(published.report.reconcileHistory[0].kind, 'rebuilt');
    assert.equal(published.report.reconcileHistory[0].fromPhase, 'push_uncertain');
    assert.equal(published.report.reconcileHistory[0].fromCandidateHead, staged.report.candidateHead);
    assert.equal(published.report.reconcileHistory[0].remoteHead, remoteAdvance);
    assert.equal(published.report.reconcileHistory[0].toCandidateHead, published.report.candidateHead);
    assert.notEqual(published.report.candidateHead, staged.report.candidateHead);
    assert.equal(await git(fixture.origin, [
      'merge-base', '--is-ancestor', remoteAdvance, published.report.targetAfter,
    ]), '');
    assert.equal((await git(fixture.origin, ['show', 'develop:work.txt'])).trim(), 'done');
    // Rebuild ran outside the queue, but the finalize still spent a real FIFO turn.
    assert.notEqual(published.report.queue, null, JSON.stringify(published.report.queue));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 自动确认被更新远端包含的候选', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const rejected = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(rejected.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    await rm(hook);

    const tree = await git(fixture.repo, ['rev-parse', `${staged.report.candidateHead}^{tree}`]);
    const descendant = await git(fixture.repo, [
      'commit-tree', tree, '-p', staged.report.candidateHead, '-m', 'remote descendant of uncertain candidate',
    ]);
    await git(fixture.repo, ['push', 'origin', `${descendant}:refs/heads/develop`]);
    const confirmed = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(confirmed.report.status, 'passed', JSON.stringify(confirmed.report));
    assert.equal(confirmed.report.integrationStatus, 'integrated');
    assert.equal(confirmed.report.targetAfter, descendant);
    assert.equal(confirmed.report.candidateHead, staged.report.candidateHead);
    assert.equal(confirmed.report.remoteAdvanced, true, JSON.stringify(confirmed.report));
    assert.equal(confirmed.report.reconcileHistory[0].kind, 'integrated', JSON.stringify(confirmed.report));
    assert.equal(confirmed.report.reconcileHistory[0].remoteHead, descendant);
    assert.equal(confirmed.report.reconcileHistory[0].toCandidateHead, staged.report.candidateHead);
    // The proof ran entirely outside the repository FIFO.
    assert.equal(confirmed.report.queue, null, JSON.stringify(confirmed.report.queue));
    assert.equal(confirmed.report.localRefSync, 'updated');
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), descendant);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 检测源已远端集成时自动归档事务', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    // Someone integrated the frozen sources on the remote before publish ran.
    await git(fixture.repo, ['push', 'origin', `${staged.report.sourceHead}:refs/heads/develop`]);

    const integrated = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(integrated.report.status, 'passed', JSON.stringify(integrated.report));
    assert.equal(integrated.report.integrationStatus, 'integrated');
    assert.equal(integrated.report.archived, true);
    assert.equal(integrated.report.archive.reason, 'sources-integrated');
    assert.equal(integrated.report.archive.remoteHead, staged.report.sourceHead);
    assert.equal(
      integrated.report.reconcileHistory[integrated.report.reconcileHistory.length - 1].kind,
      'archived-integrated',
    );
    // Archiving is proven entirely outside the repository FIFO.
    assert.equal(integrated.report.queue, null, JSON.stringify(integrated.report.queue));
    // Stage already reclaimed the candidate, so nothing was left to clean.
    assert.deepEqual(integrated.report.candidateCleanup, []);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.sourceHead);
    // The archived state file is the audit record and is intentionally retained.
    const statePath = path.join(fixture.repo, '.git',
      `vibe-harness-land-batch-${staged.report.batchId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.phase, 'archived_integrated');
    assert.equal(state.archive.reason, 'sources-integrated');
    assert.equal(state.archive.remoteHead, staged.report.sourceHead);
    // The source worktree survives: only the candidate was archived.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 在远端证明或源漂移时阻塞并保留现场', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const rejected = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(rejected.report.code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    await rm(hook);
    const base = await git(fixture.origin, ['rev-parse', 'develop']);
    const tree = await git(fixture.origin, ['rev-parse', 'develop^{tree}']);
    const remoteAdvance = await git(fixture.repo, [
      'commit-tree', tree, '-p', base, '-m', 'remote advance before reconcile proof',
    ]);
    await git(fixture.repo, ['push', 'origin', `${remoteAdvance}:refs/heads/develop`]);
    await git(fixture.origin, ['config', 'uploadpack.hideRefs', 'refs/heads/develop']);
    const unavailable = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(unavailable.report.code, 'LAND_PUSH_UNCONFIRMED', JSON.stringify(unavailable.report));
    await git(fixture.origin, ['config', '--unset', 'uploadpack.hideRefs']);

    await writeFile(path.join(fixture.worktreePath, 'later.txt'), 'source moved\n');
    await git(fixture.worktreePath, ['add', 'later.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: source moves after uncertain push']);
    const drifted = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(drifted.report.code, 'LAND_BATCH_SOURCE_CHANGED', JSON.stringify(drifted.report));
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), remoteAdvance);
    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.phase, 'push_uncertain', JSON.stringify(status.report));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 取消被取代候选的进行中验证并强制释放其租约', async () => {
  const fixture = await makeDevelopLandFixture();
  const commonDir = path.join(fixture.repo, '.git');
  const supersededUuid = '22222222-3333-4444-5555-666666666666';
  let holder = null;
  let exited = null;
  try {
    await bootstrapBatchSecond(fixture, 'two\n');
    const first = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(first.report.integrationStatus, 'local_staged', JSON.stringify(first.report));
    const second = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(second.report.integrationStatus, 'local_staged', JSON.stringify(second.report));
    const firstStatePath = path.join(commonDir, `vibe-harness-land-batch-${first.report.batchId}.json`);
    const firstState = JSON.parse(await readFile(firstStatePath, 'utf8'));

    // A live lease: a real in-flight verification process holds the candidate.
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],
      { stdio: 'ignore', windowsHide: true });
    exited = new Promise((resolve) => holder.on('exit', () => resolve(true)));
    const now = new Date().toISOString();
    await writeFile(path.join(commonDir, `vibe-harness-land-candidate-${first.report.batchId}.lock`),
      JSON.stringify({ heartbeatAt: now, leaseMs: 60_000, pid: holder.pid, startedAt: now }), 'utf8');
    // A crashed holder: the heartbeat is stale and its pid is already dead.
    const crashed = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1)'],
      { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => crashed.on('exit', resolve));
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(path.join(commonDir, `vibe-harness-land-candidate-${supersededUuid}.lock`),
      JSON.stringify({ heartbeatAt: staleAt, leaseMs: 60_000, pid: crashed.pid, startedAt: staleAt }), 'utf8');
    await writeJson(path.join(commonDir, `vibe-harness-land-batch-${supersededUuid}.json`), {
      id: supersededUuid,
      baseHead: first.report.targetBefore,
    });

    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', second.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.supersededCandidates.length, 2,
      JSON.stringify(published.report.supersededCandidates));
    const cancelled = published.report.supersededCandidates
      .find((item) => item.batchId === first.report.batchId);
    assert.deepEqual(cancelled, { batchId: first.report.batchId, pid: holder.pid, action: 'cancelled' });
    const released = published.report.supersededCandidates
      .find((item) => item.batchId === supersededUuid);
    assert.deepEqual(released, { batchId: supersededUuid, pid: crashed.pid, action: 'lease-released' });
    // The in-flight run was asked to stop and its process tree was killed.
    assert.equal(await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]), true);
    const cancel = JSON.parse(await readFile(path.join(firstState.candidate,
      '.vibe-harness', 'verification', 'CANCEL'), 'utf8'));
    assert.equal(cancel.reason, 'superseded');
    assert.equal(cancel.publishedHead, published.report.targetAfter);
    assert.equal(cancel.publishedBy, second.report.batchId);
    // Both leases are force-released even though their holders never finished.
    assert.equal(existsSync(path.join(commonDir,
      `vibe-harness-land-candidate-${first.report.batchId}.lock`)), false);
    assert.equal(existsSync(path.join(commonDir,
      `vibe-harness-land-candidate-${supersededUuid}.lock`)), false);
  } finally {
    if (holder && holder.exitCode === null) holder.kill('SIGKILL');
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 在远端回读前继续前进时确认候选祖先并同步实际远端 HEAD', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const hook = path.join(fixture.origin, 'hooks', 'post-receive');
    await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/develop" ]; then
    tree=$(git rev-parse "$new^{tree}") || exit 1
    child=$(git -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree "$tree" -p "$new" -m "remote follow-up") || exit 1
    git update-ref refs/heads/develop "$child" "$new" || exit 1
  fi
done
`);
    await chmod(hook, 0o755);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.integrationStatus, 'integrated', JSON.stringify(published.report));
    assert.equal(published.report.remoteAdvanced, true, JSON.stringify(published.report));
    assert.notEqual(published.report.targetAfter, staged.report.candidateHead);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), published.report.targetAfter);
    assert.equal(await git(fixture.repo, [
      'merge-base', '--is-ancestor', staged.report.candidateHead, published.report.targetAfter,
    ]), '');
    assert.equal(published.report.localRefSync, 'updated');
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), published.report.targetAfter);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 在 FIFO 等待期间检测推送地址变化', async () => {
  const fixture = await makeDevelopLandFixture();
  let held = null;
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    held = await acquireDeliveryTurn(fixture.repo, { operation: 'publish', timeoutMs: 1000 });
    assert.equal(held.ok, true, JSON.stringify(held));
    const publishing = execFileAsync(process.execPath, [
      runtimePath, 'worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json',
    ], {
      cwd: fixture.repo,
      env: { ...process.env, VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS: '8000' },
      windowsHide: true,
    });
    // The held FIFO turn pins publish inside its queue wait, so the endpoint
    // re-resolve inside the turn always observes the changed push URL.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const changedOrigin = path.join(fixture.root, 'changed-origin.git');
    await git(fixture.root, ['init', '--bare', '-q', changedOrigin]);
    await git(fixture.repo, ['remote', 'set-url', '--push', 'origin', changedOrigin]);
    await releaseDeliveryTurn(held, 'completed');
    held = null;
    const result = await publishing.then(
      ({ stdout }) => JSON.parse(stdout),
      (error) => JSON.parse(error.stdout),
    );
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.code, 'LAND_PUSH_TARGET_CHANGED', JSON.stringify(result));
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.targetBefore);
    assert.equal(await git(changedOrigin, ['branch', '--list', 'develop']), '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    if (held) await releaseDeliveryTurn(held, 'cancelled');
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 将本地目标领先发布候选报告为 diverged', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));
    await git(fixture.repo, ['merge', '--ff-only', staged.report.candidateHead]);
    await writeFile(path.join(fixture.repo, 'local-only.txt'), 'local only\n');
    await git(fixture.repo, ['add', 'local-only.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'local: keep unpushed work']);
    const localHead = await git(fixture.repo, ['rev-parse', 'develop']);
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(published.report.integrationStatus, 'integrated', JSON.stringify(published.report));
    assert.equal(published.report.localRefSync, 'diverged', JSON.stringify(published.report));
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), localHead);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal(await readFile(path.join(fixture.repo, 'local-only.txt'), 'utf8'), 'local only\n');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree publish 清理待重试时保留暂存引用且不依赖远端地址', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.integrationStatus, 'local_staged', JSON.stringify(staged.report));

    process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS = '1';
    let pending;
    try {
      pending = await runCommand(['worktree', 'publish', '--project', fixture.repo,
        '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
      { cwd: fixture.repo });
    } finally {
      delete process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS;
    }
    assert.equal(pending.report.integrationStatus, 'integrated_cleanup_pending', JSON.stringify(pending.report));

    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.integrationStatus, 'integrated_cleanup_pending');
    assert.equal(status.report.stagedRefValid, true, JSON.stringify(status.report));
    assert.equal(status.report.cleanupPending, true);

    const changedOrigin = path.join(fixture.root, 'cleanup-origin.git');
    await git(fixture.root, ['init', '--bare', '-q', changedOrigin]);
    await git(fixture.repo, ['remote', 'set-url', '--push', 'origin', changedOrigin]);
    const cleaned = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'],
    { cwd: fixture.repo });
    assert.equal(cleaned.report.status, 'passed', JSON.stringify(cleaned.report));
    assert.equal(cleaned.report.integrationStatus, 'integrated');
    assert.equal(await git(fixture.repo, ['for-each-ref', '--format=%(refname)', 'refs/vibe-harness']), '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(changedOrigin, ['branch', '--list', 'develop']), '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

for (const mutation of ['baseline', 'candidate', 'primary-branch']) {
  test(`worktree 核对候选验证期间的 ${mutation} 变化`, async () => {
    const script = `
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const repo = process.env.LAND_MUTATION_REPO;
const marker = repo + '/.git/verification-mutation';
if (!existsSync(marker)) {
  writeFileSync(marker, 'once');
  const git = (args, cwd = repo) => execFileSync('git', ['-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture', ...args], { cwd, windowsHide: true });
  if (${JSON.stringify(mutation)} === 'baseline') {
    writeFileSync(repo + '/other.txt', 'new baseline\\n');
    git(['add', 'other.txt']); git(['commit', '-qm', 'baseline advances']);
    git(['push', 'origin', 'develop']);
  } else if (${JSON.stringify(mutation)} === 'candidate') {
    git(['commit', '--allow-empty', '-qm', 'unverified candidate'], process.cwd());
  } else git(['checkout', '-qb', 'feat/other-target']);
}
`;
    const fixture = await makeDevelopLandFixture({ extraFiles: { 'mutate.mjs': script },
      validationCommands: { test: 'node mutate.mjs' } });
    const previous = process.env.LAND_MUTATION_REPO;
    try {
      process.env.LAND_MUTATION_REPO = fixture.repo;
      const before = await git(fixture.repo, ['rev-parse', 'develop']);
      const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
        '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      if (mutation === 'candidate') {
        assert.notEqual(staged.exitCode, 0, JSON.stringify(staged.report));
        assert.equal(staged.report.status, 'blocked');
        assert.equal(staged.report.code, 'LAND_VERIFY_ENVIRONMENT_FAILED', JSON.stringify(staged.report));
        assert.equal(staged.report.failureType, 'snapshot-drift');
        assert.equal(staged.report.integrationStatus, 'not_integrated');
        assert.equal(staged.report.verification.verification.snapshotComparison, 'changed');
        assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), before);
        assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), before);
        assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
        const statePath = path.join(fixture.repo, '.git', `vibe-harness-land-batch-${staged.report.batchId}.json`);
        const failed = JSON.parse(await readFile(statePath, 'utf8'));
        assert.equal(failed.phase, 'merged');
        assert.equal(failed.commandStatus, 'failed');
        assert.equal(failed.verifyFailure.candidateFailed, false);
        assert.equal(failed.verifyFailure.code, 'LAND_VERIFY_ENVIRONMENT_FAILED');
        assert.equal(failed.verifyFailure.failureType, 'snapshot-drift');
        const resumed = await runCommand(['worktree', 'stage', '--project', fixture.repo, '--resume',
          staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
        assert.equal(resumed.report.status, 'passed', JSON.stringify(resumed.report));
        assert.equal(resumed.report.integrationStatus, 'local_staged');
        assert.equal(resumed.report.queue, null);
      } else {
        assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
        assert.equal(staged.report.integrationStatus, 'local_staged');
        assert.equal(staged.report.queue, null);
      }
      const published = await runCommand(['worktree', 'publish', '--project', fixture.repo, '--batch',
        staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
      assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
      assert.equal(published.report.integrationStatus, 'integrated');
      assert.equal(published.report.queue.state, 'completed');
      if (mutation === 'baseline') {
        assert.equal(published.report.reconcileHistory[0].kind, 'rebuilt', JSON.stringify(published.report));
        assert.equal((await readFile(path.join(fixture.repo, 'other.txt'), 'utf8')).trim(), 'new baseline');
        assert.equal((await readFile(path.join(fixture.repo, 'work.txt'), 'utf8')).trim(), 'done');
        assert.equal(await git(fixture.repo, ['rev-list', '--count', '--merges', 'develop']), '1');
        assert.equal(await git(fixture.repo, ['rev-parse', 'develop']),
          await git(fixture.origin, ['rev-parse', 'develop']));
      } else if (mutation === 'primary-branch') {
        assert.equal(published.report.localRefSync, 'deferred');
        assert.equal(await git(fixture.repo, ['symbolic-ref', '--short', 'HEAD']), 'feat/other-target');
        assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), before);
        assert.notEqual(await git(fixture.origin, ['rev-parse', 'develop']), before);
      } else {
        assert.equal((await readFile(path.join(fixture.repo, 'work.txt'), 'utf8')).trim(), 'done');
      }
      assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    } finally {
      if (previous === undefined) delete process.env.LAND_MUTATION_REPO;
      else process.env.LAND_MUTATION_REPO = previous;
      await removeTemporaryDirectory(fixture.root);
    }
  });
}

test('batch stage verifies the merged candidate once and publish reuses the receipt', async () => {
  const counter = path.join(tmpdir(), `land-batch-${process.pid}-${Date.now()}.txt`);
  const fixture = await makeLocalFixture({
    extraFiles: { 'verify.mjs': "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.BATCH_VERIFY_COUNTER, 'run\\n');\n" },
    validationCommands: { tiers: { quick: ['node verify.mjs'], deep: ['node --version'] } },
  });
  const previous = process.env.BATCH_VERIFY_COUNTER;
  try {
    process.env.BATCH_VERIFY_COUNTER = counter;
    await bootstrapWithWork(fixture);
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    assert.equal(staged.report.integrationStatus, 'local_staged');
    assert.equal(staged.report.queue, null, 'stage never takes a repository FIFO turn');
    assert.equal(staged.report.integration.tier, 'quick');
    assert.equal(staged.report.integration.completion, 'pending_ci');
    assert.equal((await readFile(counter, 'utf8')).trim(), 'run');
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.targetAfter, staged.report.candidateHead);
    // Publish reuses the stage receipt, so verification never runs a second time.
    assert.equal((await readFile(counter, 'utf8')).trim(), 'run');
    assert.equal((await readFile(path.join(fixture.repo, 'work.txt'), 'utf8')).trim(), 'done');
    assert.equal((await readFile(path.join(fixture.repo, 'second.txt'), 'utf8')).trim(), 'two');
    // A confirmed publish cleans the source worktrees; only unpublished
    // candidates retain them.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await entryExists(fixture.repo, second), false);
  } finally {
    if (previous === undefined) delete process.env.BATCH_VERIFY_COUNTER;
    else process.env.BATCH_VERIFY_COUNTER = previous;
    await rm(counter, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch conflict retains candidate for agent resolution and resumes without moving target early', async () => {
  const fixture = await makeLocalFixture({ extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'shared.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: first shared']);
    const second = await bootstrapBatchSecond(fixture, 'second\n', 'shared.txt');
    const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const conflict = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(conflict.report.code, 'LAND_BATCH_CONFLICT', JSON.stringify(conflict.report));
    assert.equal(conflict.report.task, 'ENG-2');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), before);
    assert.equal(await entryExists(fixture.repo, second), true);
    const candidate = conflict.report.candidatePath;
    const unresolved = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--resume', conflict.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(unresolved.report.code, 'LAND_BATCH_CONFLICT_UNRESOLVED', JSON.stringify(unresolved.report));
    await writeFile(path.join(candidate, 'shared.txt'), 'first\nsecond\n');
    await git(candidate, ['add', 'shared.txt']);
    const resumed = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--resume', conflict.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(resumed.report.status, 'passed', JSON.stringify(resumed.report));
    assert.equal(resumed.report.integrationStatus, 'local_staged');
    assert.equal(resumed.report.integration.conflicts.length, 1);
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', resumed.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal((await readFile(path.join(fixture.repo, 'shared.txt'), 'utf8')).trim().replaceAll('\r\n', '\n'), 'first\nsecond');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch can resolve two successive conflicts before a single final verification', async () => {
  const fixture = await makeLocalFixture({ extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'shared.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: first shared']);
    await bootstrapBatchSecond(fixture, 'second\n', 'shared.txt');
    const thirdPath = path.join(fixture.root, 'repo-worktrees', 'ENG-3');
    const bootstrapped = await runCommand(['worktree', 'bootstrap', '--project', fixture.repo,
      '--task', 'ENG-3:feat/ENG-3-scaffold', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(bootstrapped.report.status, 'passed');
    await writeFile(path.join(thirdPath, 'shared.txt'), 'third\n');
    await git(thirdPath, ['add', 'shared.txt']);
    await git(thirdPath, ['commit', '-q', '-m', 'feat: third shared']);
    const first = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--task', 'ENG-3', '--delivery', 'local-land',
      '--write', '--json'], { cwd: fixture.repo });
    assert.equal(first.report.code, 'LAND_BATCH_CONFLICT', JSON.stringify(first.report));
    assert.equal(first.report.task, 'ENG-2');
    await writeFile(path.join(first.report.candidatePath, 'shared.txt'), 'first\nsecond\n');
    await git(first.report.candidatePath, ['add', 'shared.txt']);
    const second = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--resume', first.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(second.report.code, 'LAND_BATCH_CONFLICT', JSON.stringify(second.report));
    assert.equal(second.report.task, 'ENG-3');
    await writeFile(path.join(second.report.candidatePath, 'shared.txt'), 'first\nsecond\nthird\n');
    await git(second.report.candidatePath, ['add', 'shared.txt']);
    const done = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--resume', first.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(done.report.status, 'passed', JSON.stringify(done.report));
    assert.equal(done.report.integration.conflicts.length, 2);
    const published = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', done.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal((await readFile(path.join(fixture.repo, 'shared.txt'), 'utf8')).trim().replaceAll('\r\n', '\n'), 'first\nsecond\nthird');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch verification failure records recovery state and can be collected after inspection', async () => {
  const fixture = await makeLocalFixture({ validationCommands: { test: 'node missing-batch-check.mjs' } });
  try {
    await bootstrapWithWork(fixture);
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    const batchWorktree = path.join(fixture.root, 'repo-worktrees', 'batch');
    await runCommand(['worktree', 'bootstrap', '--project', fixture.repo,
      '--task', 'batch:feat/batch', '--write', '--json'], { cwd: fixture.repo });
    const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.code, 'LAND_VERIFY_FAILED', JSON.stringify(result.report));
    assert.equal(result.report.failureType, 'checks-failed');
    const candidate = result.report.candidatePath;
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), before);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await entryExists(fixture.repo, second), true);
    // A real task named "batch" must not make the generic recovery pattern
    // mistake a retained transaction candidate for abandoned task residue.
    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.report.status, 'passed', JSON.stringify(recovered.report));
    assert.equal(existsSync(candidate), false);
    assert.equal(await entryExists(fixture.repo, batchWorktree), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch resumed after target advance rebuilds and verifies a new candidate', async () => {
  const fixture = await makeLocalFixture({ extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'first\n');
    await git(fixture.worktreePath, ['add', 'shared.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: first shared']);
    await bootstrapBatchSecond(fixture, 'second\n', 'shared.txt');
    const conflict = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(conflict.report.code, 'LAND_BATCH_CONFLICT', JSON.stringify(conflict.report));
    await writeFile(path.join(fixture.repo, 'other.txt'), 'new baseline\n');
    await git(fixture.repo, ['add', 'other.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: advance target']);
    const advanced = await git(fixture.repo, ['rev-parse', 'HEAD']);
    // Resume is local-only: the moved local baseline is detected without any
    // fetch, and the replayed merges rebuild on top of it.
    const resumed = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--resume', conflict.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(resumed.report.code, 'LAND_BATCH_CONFLICT', JSON.stringify(resumed.report));
    assert.notEqual(resumed.report.candidatePath, conflict.report.candidatePath);
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), advanced);
    assert.equal((await readFile(path.join(fixture.repo, 'other.txt'), 'utf8')).trim(), 'new baseline');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch 推送被拒时保留本地候选和全部源工作区', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const origin = path.join(fixture.root, 'origin.git');
    await writeFile(path.join(origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(origin, 'hooks/pre-receive'), 0o755);
    const result = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.code, 'LAND_PUSH_FAILED', JSON.stringify(result.report));
    // Publish pushes the frozen candidate head directly; the local target
    // moves only at confirmation, so a rejected push leaves develop exactly
    // as it was staged.
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), before);
    assert.equal(await git(origin, ['rev-parse', 'develop']), before);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await entryExists(fixture.repo, second), true);
    // The task branches survive a rejected push too: only a confirmed publish
    // may delete them during cleanup.
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-2-scaffold', '--format=%(refname:short)']), 'feat/ENG-2-scaffold');
    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.phase, 'push_uncertain');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch confirmed push cleans both source worktrees and branches', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const result = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report));
    assert.equal(result.report.integrationStatus, 'integrated');
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), result.report.targetAfter);
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), result.report.targetAfter);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await entryExists(fixture.repo, second), false);
    assert.equal((await git(fixture.repo, ['branch', '--list', 'feat/ENG-*-scaffold'])).trim(), '');
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch reports cleanup failure after confirmed push without replaying the merge', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    await git(fixture.repo, ['worktree', 'lock', second]);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const result = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.code, 'LAND_BATCH_CLEANUP_INCOMPLETE', JSON.stringify(result.report));
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.integrationStatus, 'integrated_cleanup_pending');
    assert.equal(result.report.pushed, true);
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), result.report.targetAfter);
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), result.report.targetAfter);
    assert.equal(await entryExists(fixture.repo, second), true);
    assert.deepEqual((await readRegistry(fixture.repo)).entries.map((item) => item.id), ['ENG-2']);
    // Normal progress after integration must not prevent a cleanup-only retry.
    await writeFile(path.join(fixture.repo, 'later.txt'), 'later\n');
    await git(fixture.repo, ['add', 'later.txt']);
    await git(fixture.repo, ['commit', '-qm', 'later integration']);
    await git(fixture.repo, ['push', 'origin', 'develop']);
    const latest = await git(fixture.repo, ['rev-parse', 'HEAD']);
    // Cleanup-only recovery must not be blocked by unrelated work in the
    // primary checkout. The file also proves cleanup never stages or deletes it.
    await writeFile(path.join(fixture.repo, 'unrelated.txt'), 'preserve user work\n');
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    const count = path.join(fixture.origin, 'unexpected-push');
    await writeFile(hook, '#!/bin/sh\necho unexpected >> unexpected-push\nexit 1\n');
    await chmod(hook, 0o755);
    await git(fixture.repo, ['worktree', 'unlock', second]);
    const retry = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(retry.report.integrationStatus, 'integrated', JSON.stringify(retry.report));
    assert.equal(retry.report.localRefSync, 'deferred');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), latest);
    assert.equal(await git(fixture.origin, ['rev-parse', 'develop']), latest);
    assert.equal(existsSync(count), false, 'cleanup retry must never invoke push');
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
    assert.equal(await entryExists(fixture.repo, second), false);
    assert.equal(
      await readFile(path.join(fixture.repo, 'unrelated.txt'), 'utf8'),
      'preserve user work\n',
    );
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch cleanup timeout is integrated pending and retries only cleanup', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const second = await bootstrapBatchSecond(fixture, 'two\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));

    process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS = '1';
    const timedOut = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(timedOut.exitCode, 0, JSON.stringify(timedOut.report));
    assert.equal(timedOut.report.status, 'passed');
    assert.equal(timedOut.report.integrationStatus, 'integrated_cleanup_pending');
    assert.equal(timedOut.report.code, 'LAND_BATCH_CLEANUP_INCOMPLETE');
    assert.ok(timedOut.report.cleanup.some((item) => item.code === 'LAND_CLEANUP_TIMEOUT'));
    assert.equal(
      await git(fixture.origin, ['rev-parse', 'refs/heads/develop']),
      await git(fixture.repo, ['rev-parse', 'develop']),
    );
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await entryExists(fixture.repo, second), true);

    delete process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS;
    const hook = path.join(fixture.origin, 'hooks', 'pre-receive');
    const count = path.join(fixture.origin, 'unexpected-push');
    await writeFile(hook, '#!/bin/sh\necho unexpected >> unexpected-push\nexit 1\n');
    await chmod(hook, 0o755);
    const retry = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(retry.exitCode, 0, JSON.stringify(retry.report));
    assert.equal(retry.report.integrationStatus, 'integrated');
    assert.equal(existsSync(count), false, 'cleanup timeout retry must never invoke push');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await entryExists(fixture.repo, second), false);
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
  } finally {
    delete process.env.VIBE_HARNESS_LAND_CLEANUP_TIMEOUT_MS;
    await removeTemporaryDirectory(fixture.root);
  }
});

test('batch rejects an explicit quick tier for high-risk paths', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const second = await bootstrapBatchSecond(fixture, 'contract\n', 'schemas.json');
    // A top-level contract file is not a risk directory; place one under the
    // declared public contract boundary to exercise the source-diff guard.
    await mkdir(path.join(second, 'schemas'), { recursive: true });
    await writeFile(path.join(second, 'schemas', 'model.json'), '{}\n');
    await git(second, ['add', 'schemas/model.json']);
    await git(second, ['commit', '-q', '-m', 'feat: contract']);
    const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--task', 'ENG-2', '--delivery', 'local-land',
      '--tier', 'quick', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.code, 'LAND_BATCH_RISK_TIER', JSON.stringify(result.report));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

/**
 * Register one managed service for `worktreePath` that opts out of teardown.
 *
 * `stopOnTeardown: false` is the registration the worktree commands cannot
 * prove stopped — `teardownServices` refuses it without touching a process — so
 * the fixture needs no real service tree and no signalling.
 */
async function registerOptedOutService(project, worktreePath) {
  const resolved = await realpath(worktreePath);
  await mkdir(path.join(project, '.vibe-harness'), { recursive: true });
  await writeJson(path.join(project, '.vibe-harness', 'processes.json'), {
    schemaVersion: 1,
    processes: [{
      commandFingerprint: 'fixture',
      cwd: resolved,
      pid: 1,
      port: 1,
      serviceId: 'web',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      stopOnTeardown: false,
      supervisorPid: 1,
      taskId: path.basename(worktreePath),
      teardownStatus: 'unverified',
      worktree: resolved,
    }],
  });
}

test('worktree stage 默认 dry-run:输出落地计划且不落盘', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const planned = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1', '--delivery', 'local-land', '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.batch, true);
    assert.equal(planned.report.targetBranch, 'develop');
    assert.equal(planned.report.tier, 'quick');
    assert.equal(planned.report.write, false);
    assert.equal(planned.report.sources.length, 1);
    assert.equal(planned.report.sources[0].id, 'ENG-1');
    assert.ok(planned.report.selectedChecks.includes('test'), JSON.stringify(planned.report.selectedChecks));
    assert.equal(typeof planned.report.deferredCount, 'number');
    assert.equal(planned.report.warnings.length, 0);
    // Planning is read-only: no merge commit on the target, worktree intact.
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 预检不因收据或 deferred 自动升级，只执行请求的层级', async () => {
  const fixture = await makeLocalFixture({
    validationCommands: { tiers: { quick: ['node --version'], standard: ['node --version --no-warnings'] } },
  });
  try {
    await bootstrapWithWork(fixture);
    const base = ['worktree', 'stage', '--project', fixture.repo, '--delivery', 'local-land', '--task', 'ENG-1', '--json'];
    const missingReview = await runCommand(base, { cwd: fixture.repo });
    assert.equal(missingReview.report.status, 'planned', JSON.stringify(missingReview.report));
    assert.equal(missingReview.report.tier, 'quick');
    const ignoredReview = await runCommand([...base, '--reviewed', 'not-selected'], { cwd: fixture.repo });
    assert.equal(ignoredReview.report.status, 'planned', JSON.stringify(ignoredReview.report));
    assert.ok(ignoredReview.report.warnings.some((warning) => warning.code === 'LAND_REVIEW_METADATA_IGNORED'));
    const explicit = await runCommand([...base, '--tier', 'quick', '--reviewed', 'all'], { cwd: fixture.repo });
    assert.equal(explicit.report.status, 'planned', JSON.stringify(explicit.report));
    assert.equal(explicit.report.tier, 'quick');
    assert.equal(explicit.report.tierEscalation, undefined);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('develop stage 不需要审阅或完成收据，但必须实测最终候选', async () => {
  const fixture = await makeLocalFixture({
    delivery: {
      default: 'local-land',
      profiles: {
        'local-land': {
          merge: 'no-ff',
          cleanup: 'ancestor',
          requireReceipt: true,
        },
      },
    },
  });
  try {
    await bootstrapWithWork(fixture);

    const planned = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1', '--delivery', 'local-land', '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.report.status, 'planned', JSON.stringify(planned.report));
    assert.equal(planned.report.targetBranch, 'develop');

    const written = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(written.report.integrationStatus, 'local_staged');
    assert.equal(written.report.phase, 'staged');
    assert.equal(written.report.queue, null, 'stage never takes a repository FIFO turn');
    // requireReceipt、审阅等收据姿态不影响 stage：集成的证据只来自对最终候选的实测。
    assert.ok(written.report.integration.passedChecks.length > 0, 'final candidate must be verified by a real run');
    assert.equal(written.report.integration.tier, 'quick');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 在相同代码树的候选 worktree 复用已通过的确定性检查', async () => {
  const counter = path.join(tmpdir(), `vibe-harness-land-cache-${process.pid}-${Date.now()}.txt`);
  const previousCounter = process.env.VIBE_HARNESS_TEST_COUNTER;
  const fixture = await makeLocalFixture({
    extraFiles: {
      'check.mjs': "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.VIBE_HARNESS_TEST_COUNTER, 'run\\n');\n",
    },
    validationCommands: {
      test: 'node check.mjs',
      tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
      checks: [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }],
    },
    verification: { reuse: { mode: 'tree-content' } },
  });
  try {
    process.env.VIBE_HARNESS_TEST_COUNTER = counter;
    await bootstrapWithWork(fixture);
    const verified = await runCommand([
      'verify', '--project', fixture.worktreePath, '--tier', 'quick', '--reuse', '--json',
    ], { cwd: fixture.worktreePath });
    assert.equal(verified.report.status, 'passed', JSON.stringify(verified.report));
    assert.equal(await readFile(counter, 'utf8'), 'run\n');

    const landed = await runCommand([
      'worktree', 'stage', '--project', fixture.repo, '--task', 'ENG-1',
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(landed.exitCode, 0, JSON.stringify(landed.report));
    assert.equal(landed.report.status, 'passed', JSON.stringify(landed.report));
    assert.equal(landed.report.integrationStatus, 'local_staged');
    // The candidate tree matches the verified source tree, so the deterministic
    // check is reused instead of re-run: the counter must still hold one run.
    assert.ok(landed.report.integration.passedChecks.includes('test'), JSON.stringify(landed.report.integration));
    assert.equal(await readFile(counter, 'utf8'), 'run\n');
  } finally {
    if (previousCounter === undefined) delete process.env.VIBE_HARNESS_TEST_COUNTER;
    else process.env.VIBE_HARNESS_TEST_COUNTER = previousCounter;
    await rm(counter, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage --push 直接拒绝', async () => {
  const fixture = await makeLocalFixture();
  try {
    // The gate fires before any fixture-dependent work, in dry-run and write mode alike.
    for (const argv of [['--json'], ['--write', '--json']]) {
      const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        '--task', 'ENG-1', '--delivery', 'local-land', '--push', ...argv], { cwd: fixture.repo });
      assert.notEqual(result.exitCode, 0, JSON.stringify(result.report));
      assert.equal(result.report.status, 'blocked');
      assert.equal(result.report.code, 'LAND_STAGE_PUSH_INVALID');
      assert.match(result.report.error, /stage never publishes/u);
    }
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false, 'no worktree is touched');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree stage 拒绝合入保护分支但允许 develop 集成', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    // --base-ref 是意图断言而不是选择器：main、master 与 release/* 即使不存在
    // 也按名字直接拒绝，本地集成不得绕过发布边界门禁。
    for (const branch of ['main', 'master', 'release/1.0.0']) {
      const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        '--task', 'ENG-1', '--delivery', 'local-land', '--base-ref', branch, '--json'], { cwd: fixture.repo });
      assert.equal(result.exitCode, 1, branch);
      assert.equal(result.report.status, 'blocked', branch);
      assert.equal(result.report.code, 'LAND_BATCH_TARGET', branch);
      assert.match(result.report.error, /Stage requires the develop integration target/u, branch);
    }
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);

    // develop 按 ADR-0013 允许本地 no-ff 集成：dry-run 给出落地计划而不是拒绝。
    const planned = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--json'], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.targetBranch, 'develop');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('脏源工作区与未完成锚点单元都把 stage 置为 blocked', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const base = ['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--json'];

    await writeFile(path.join(fixture.worktreePath, 'wip.txt'), 'wip\n', 'utf8');
    const dirtyWorktree = await runCommand(base, { cwd: fixture.repo });
    assert.equal(dirtyWorktree.report.status, 'blocked', JSON.stringify(dirtyWorktree.report));
    assert.equal(dirtyWorktree.report.code, 'LAND_BATCH_PREFLIGHT');
    assert.match(dirtyWorktree.report.error, /task ENG-1 does not have a clean committed source/u);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    await rm(path.join(fixture.worktreePath, 'wip.txt'));

    // 脏主检出不再阻塞 stage：候选只从已提交的 develop 构建，主检出的本地
    // 同步由 publish 按需延迟（dirty → deferred）。
    await writeFile(path.join(fixture.repo, 'primary-wip.txt'), 'wip\n', 'utf8');
    const dirtyPrimary = await runCommand(base, { cwd: fixture.repo });
    assert.equal(dirtyPrimary.report.status, 'planned', JSON.stringify(dirtyPrimary.report));
    await rm(path.join(fixture.repo, 'primary-wip.txt'));

    // An anchor with a unit still in progress means the slice is not done
    // yet; staging it would merge half-finished work.
    const initialized = await runCommand([
      'task', 'init', 'ENG-1', '--project', fixture.repo,
      '--title', 'Landing fixture', '--goal', 'Land verified work', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(initialized.report.status, 'passed');
    const anchor = initialized.report.anchor;
    await writeJson(path.join(fixture.repo, '.vibe-harness/tasks/ENG-1.json'), {
      ...anchor,
      schemaVersion: 1,
      units: [{ id: 'impl', status: 'in_progress' }],
    });
    const pendingAnchor = await runCommand(base, { cwd: fixture.repo });
    assert.equal(pendingAnchor.report.status, 'blocked', JSON.stringify(pendingAnchor.report));
    assert.equal(pendingAnchor.report.code, 'LAND_BATCH_PREFLIGHT');
    assert.match(pendingAnchor.report.error, /task ENG-1 has unfinished anchor units or blockers/u);

    // A failed unit folds into the same preflight gate: a red unit cannot be
    // quietly staged as long as its anchor record marks it not done.
    await writeJson(path.join(fixture.repo, '.vibe-harness/tasks/ENG-1.json'), {
      ...anchor,
      schemaVersion: 1,
      units: [{ id: 'impl', status: 'failed' }],
    });
    const failedUnit = await runCommand(base, { cwd: fixture.repo });
    assert.equal(failedUnit.report.status, 'blocked', JSON.stringify(failedUnit.report));
    assert.equal(failedUnit.report.code, 'LAND_BATCH_PREFLIGHT');
    assert.match(failedUnit.report.error, /task ENG-1 has unfinished anchor units or blockers/u);

    // All units done unblocks the plan, and a full-risk anchor escalates the
    // verify tier from quick to standard.
    await writeJson(path.join(fixture.repo, '.vibe-harness/tasks/ENG-1.json'), {
      ...anchor,
      schemaVersion: 1,
      riskLevel: 'full',
      stage: 'implement',
      units: [{ id: 'impl', status: 'done' }],
    });
    const planned = await runCommand(base, { cwd: fixture.repo });
    assert.equal(planned.report.status, 'planned', JSON.stringify(planned.report));
    assert.equal(planned.report.tier, 'standard');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('多个归因 worktree 时 stage 要求 --task 指定', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    const ambiguous = await runCommand(['worktree', 'stage', '--project', fixture.repo, '--delivery', 'local-land', '--json'], { cwd: fixture.repo });
    assert.equal(ambiguous.exitCode, 1);
    assert.equal(ambiguous.report.status, 'blocked', JSON.stringify(ambiguous.report));
    assert.equal(ambiguous.report.code, 'LAND_BATCH_TASKS');
    assert.match(ambiguous.report.error, /distinct --task values/u);

    const chosen = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--json'], { cwd: fixture.repo });
    assert.equal(chosen.exitCode, 0, JSON.stringify(chosen.report));
    assert.equal(chosen.report.status, 'planned');
    assert.equal(chosen.report.sources.length, 1);
    assert.equal(chosen.report.sources[0].id, 'ENG-1');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage --write 合并并验证候选,但目标、源工作区与分支都不动', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const written = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.integrationStatus, 'local_staged');
    assert.equal(written.report.phase, 'staged');
    assert.equal(written.report.queue, null);
    assert.equal(typeof written.report.batchId, 'string');
    assert.equal(typeof written.report.stagedRef, 'string');
    assert.equal(typeof written.report.candidateHead, 'string');
    assert.equal(written.report.candidatePath, null, 'the candidate worktree is reclaimed once staged');
    // The merge is a real --no-ff merge commit: fixture + work + merge.
    assert.equal(await git(fixture.repo, ['rev-list', '--count', written.report.stagedRef]), '3');
    assert.equal(await git(fixture.repo, ['rev-parse', written.report.stagedRef]), written.report.candidateHead);
    assert.match(await git(fixture.repo, ['log', '-1', '--format=%s', written.report.candidateHead]), /^Merge/u);
    // Stage only freezes the candidate on the staged ref: the integration
    // target, the source worktree, its branch and the registry stay untouched.
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 候选合并不执行表单 Hook', async () => {
  const marker = path.join(tmpdir(), `vibe-harness-form-hook-${Date.now()}.marker`);
  const normalizedMarker = marker.replaceAll('\\', '/');
  const fixture = await makeLocalFixture({
    extraFiles: { '.githooks/post-merge': `#!/bin/sh\ntouch "${normalizedMarker}"\n` },
  });
  try {
    await chmod(path.join(fixture.repo, '.githooks/post-merge'), 0o755);
    // POSIX records the executable bit as a tracked change. Windows ignores
    // that mode, so the already-tracked hook content needs no second commit.
    if (process.platform !== 'win32') {
      await git(fixture.repo, ['add', '.githooks/post-merge']);
      await git(fixture.repo, ['commit', '-q', '-m', 'fixture: executable hook']);
    }
    await git(fixture.repo, ['config', 'core.hooksPath', '.githooks']);
    await bootstrapWithWork(fixture);
    const written = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(existsSync(marker), false, 'candidate merge must not run repository form hooks');
  } finally {
    await rm(marker, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 预检报告缺失依赖根', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    await rm(path.join(fixture.repo, 'frontend/node_modules'), { recursive: true, force: true });
    const blocked = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--json'], { cwd: fixture.repo });
    assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
    assert.equal(blocked.report.code, 'LAND_BATCH_PREFLIGHT');
    assert.match(blocked.report.error, /task ENG-1 has missing dependency roots/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('publish 在仓库队列占用时于预算内 blocked 且不推送', async () => {
  const fixture = await makeLocalFixture();
  let held = null;
  const previousTimeout = process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
  try {
    await bootstrapWithWork(fixture);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const originHead = await git(fixture.origin, ['rev-parse', 'refs/heads/develop']);
    // Only publish's seconds-scale finalize takes a repository FIFO turn, so a
    // foreign holder can already occupy the queue when publish arrives.
    held = await acquireDeliveryTurn(fixture.repo, { operation: 'publish', timeoutMs: 1000 });
    assert.equal(held.ok, true, JSON.stringify(held));
    process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = '150';
    const blocked = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
    assert.equal(blocked.report.code, 'WORKTREE_QUEUE_TIMEOUT');
    assert.equal(blocked.report.queue.owner.operation, 'publish');
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), originHead);
    assert.notEqual(originHead, staged.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    if (previousTimeout === undefined) delete process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
    else process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = previousTimeout;
    if (held) await releaseDeliveryTurn(held, 'cancelled');
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 验证环境未产出证据时保留同一候选供续验', async () => {
  const fixture = await makeLocalFixture({
    // Tier selection is cumulative: standard includes quick, so producing "no
    // evidence" at --tier standard requires every tier up to it to be empty.
    validationCommands: { tiers: { quick: [], standard: [], deep: [] } },
  });
  try {
    await bootstrapWithWork(fixture);
    const blocked = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--tier', 'standard', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
    assert.equal(blocked.report.code, 'LAND_VERIFY_ENVIRONMENT_FAILED');
    assert.match(blocked.report.error, /no evidence/u);
    assert.equal(blocked.report.failureType, 'not-run');
    // The merge only exists in the isolated candidate; the target and the
    // source worktree remain untouched, and the candidate is kept for a
    // `stage --resume` of the very same tree.
    assert.equal(typeof blocked.report.batchId, 'string');
    assert.equal(existsSync(blocked.report.candidatePath), true);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', blocked.report.batchId, '--json'], { cwd: fixture.repo });
    // The merge already completed, so the phase is 'merged' (not
    // 'recovery_required'): the candidate stays resumable for a same-tree
    // `stage --resume` once the environment produces evidence again.
    assert.equal(status.report.phase, 'merged', JSON.stringify(status.report));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 检查失败判定候选本身并要求重新暂存', async () => {
  const fixture = await makeLocalFixture({
    extraFiles: { 'fail.mjs': 'process.exit(1);\n' },
    validationCommands: { test: 'node fail.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const failed = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(failed.report.status, 'blocked', JSON.stringify(failed.report));
    assert.equal(failed.report.code, 'LAND_VERIFY_FAILED');
    assert.equal(failed.report.failureType, 'checks-failed');
    assert.match(failed.report.error, /fix the sources and start a new stage run/u);
    assert.equal(typeof failed.report.batchId, 'string');
    assert.equal(existsSync(failed.report.candidatePath), true);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    const status = await runCommand(['worktree', 'status', '--project', fixture.repo,
      '--batch', failed.report.batchId, '--json'], { cwd: fixture.repo });
    assert.equal(status.report.phase, 'recovery_required', JSON.stringify(status.report));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('镜像展开与拆除按两侧计算并拒绝链接祖先', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vibe-harness-mirrors-')));
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'worktree');
  try {
    await mkdir(path.join(main, 'tools/alpha'), { recursive: true });
    await mkdir(path.join(main, 'tools/beta'), { recursive: true });
    await mkdir(path.join(main, 'notes'), { recursive: true });
    await writeFile(path.join(main, 'notes/readme.md'), 'notes\n', 'utf8');
    await mkdir(worktree, { recursive: true });

    // A wildcard expands against the main checkout: the declarations alone.
    assert.deepEqual(expandMirrors(main, ['tools/*']), ['tools/alpha', 'tools/beta']);

    // Inside the worktree those leaves are links, so `Dirent.isDirectory()` is
    // false for them: the worktree side is only visible when links are followed.
    await linkOrCopyMirrors(main, worktree, ['tools/*']);
    assert.deepEqual(expandMirrors(worktree, ['tools/*']), []);
    assert.deepEqual(expandMirrors(worktree, ['tools/*'], { followDirectoryLinks: true }), ['tools/alpha', 'tools/beta']);

    // A nested declaration whose parent is already a link would be written
    // through the link into the main checkout, so it is reported instead.
    const nested = await linkOrCopyMirrors(main, worktree, ['notes', 'notes/readme.md']);
    const nestedByMirror = new Map(nested.map((item) => [item.mirror, item]));
    assert.equal(nestedByMirror.get('notes').status, 'linked');
    // A nested declaration reached through the parent link is never re-projected:
    // the ancestor check runs before the existence check, so it is reported as
    // skipped instead of being mistaken for a mirror the worktree owns.
    assert.equal(nestedByMirror.get('notes/readme.md').status, 'skipped');
    assert.equal(await readFile(path.join(main, 'notes/readme.md'), 'utf8'), 'notes\n');

    // The main checkout loses a wildcard leaf after bootstrap; the link inside
    // the worktree is only discoverable by expanding the worktree side, and it
    // still has to come down without the main checkout being touched.
    await rm(path.join(main, 'tools/beta'), { recursive: true, force: true });
    // A link the developer made by hand is not this bootstrap's projection: it
    // stays for `git worktree remove` even though the wildcard reaches it.
    const handMade = path.join(root, 'elsewhere');
    await mkdir(handMade, { recursive: true });
    await symlink(handMade, path.join(worktree, 'tools/custom'), 'junction');
    const removed = removeMirrorLinks(main, worktree, ['tools/*']);
    assert.deepEqual([...removed].sort(), ['tools/alpha', 'tools/beta']);
    assert.equal(existsSync(path.join(worktree, 'tools/alpha')), false);
    assert.equal(existsSync(path.join(worktree, 'tools/beta')), false);
    assert.equal(lstatSync(path.join(worktree, 'tools/custom')).isSymbolicLink(), true);
    assert.equal(existsSync(path.join(main, 'tools/alpha')), true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('--no-verify 拒绝 stage 预览与写入', async () => {
  const fixture = await makeLocalFixture({
    extraFiles: { 'fail.mjs': 'process.exit(1);\n' },
    validationCommands: { test: 'node fail.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    for (const tail of [['--json'], ['--write', '--json']]) {
      const blocked = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        '--task', 'ENG-1', '--delivery', 'local-land', '--no-verify', ...tail], { cwd: fixture.repo });
      assert.notEqual(blocked.exitCode, 0, JSON.stringify(blocked.report));
      assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
      assert.equal(blocked.report.code, 'LAND_BATCH_OPTIONS');
      assert.match(blocked.report.error, /verification/u);
    }
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('publish 显式推送 origin develop 且无需 upstream', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    // A bare repo stands in for origin: the target branch has no upstream yet,
    // so the push policy starts tracking under the sole-origin rule.
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['push', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const pushed = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(pushed.exitCode, 0, JSON.stringify(pushed.report));
    assert.equal(pushed.report.status, 'passed');
    assert.equal(pushed.report.integrationStatus, 'integrated');

    assert.equal((await git(origin, ['rev-parse', '--verify', 'refs/heads/develop'])).length, 40);
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), pushed.report.candidateHead);
    // The worktree branch is gone only now, after the push succeeded.
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('publish 忽略无关远端，端点冻结在 origin/develop', async () => {
  const fixture = await makeLocalFixture();
  try {
    // Unrelated remotes cannot redirect the frozen origin/develop endpoint.
    await git(fixture.repo, ['remote', 'add', 'upstream', path.join(fixture.root, 'up.git')]);
    await bootstrapWithWork(fixture);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const pushed = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(pushed.exitCode, 0, JSON.stringify(pushed.report));
    assert.equal(pushed.report.pushConfirmed, true);
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), pushed.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('源任务租约被占用时 stage 在缩短的预算内 blocked 且不建候选', async () => {
  const fixture = await makeLocalFixture();
  const previousTimeout = process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS;
  try {
    await bootstrapWithWork(fixture);
    const lockPath = path.join(fixture.repo, '.git',
      `vibe-harness-land-source-${createHash('sha256').update('ENG-1').digest('hex')}.lock`);
    const now = new Date().toISOString();
    await writeFile(lockPath, JSON.stringify({
      heartbeatAt: now,
      leaseMs: 60_000,
      pid: process.pid,
      startedAt: now,
    }), 'utf8');
    process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS = '300';
    let blocked;
    try {
      blocked = await runCommand(['worktree', 'stage', '--project', fixture.repo,
        '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    } finally {
      if (previousTimeout === undefined) delete process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS;
      else process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS = previousTimeout;
    }
    assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
    assert.equal(blocked.report.code, 'LAND_SOURCE_BUSY');
    assert.match(blocked.report.error, /already being integrated/u);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 锁等待预算默认 180 秒且只能被父进程环境变量缩短', () => {
  assert.equal(landLockTimeoutMs({}), 180_000);
  assert.equal(landLockTimeoutMs({ VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS: '300' }), 300);
  // The knob can only shorten the wait: a wider or unusable value keeps the
  // default instead of letting a caller extend a lock hold indefinitely.
  assert.equal(landLockTimeoutMs({ VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS: '600000' }), 180_000);
  assert.equal(landLockTimeoutMs({ VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS: 'not-a-number' }), 180_000);
  assert.equal(landLockTimeoutMs({ VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS: '0' }), 180_000);
  assert.equal(landLockTimeoutMs({ VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS: '-5' }), 180_000);
});

test('目标在 stage 后前进时 publish 推送已验证候选并报告本地分叉', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    await writeFile(path.join(fixture.repo, 'other.txt'), 'independent\n', 'utf8');
    await git(fixture.repo, ['add', 'other.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: other']);
    const published = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.localRefSync, 'diverged');
    // The push publishes the frozen candidate; the local target keeps its own
    // advance and is never rewound or clobbered.
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), staged.report.candidateHead);
    assert.equal((await readFile(path.join(fixture.repo, 'other.txt'), 'utf8')).trim(), 'independent');
    assert.notEqual(await git(fixture.repo, ['rev-parse', 'develop']), staged.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 验证期间目标前进不重建候选，publish 报告本地分叉', async () => {
  const fixture = await makeLocalFixture({
    extraFiles: {
      'slow.mjs': "import { writeFileSync } from 'node:fs'; import path from 'node:path'; writeFileSync(path.resolve('..', 'landing-ready'), 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n",
    },
    validationCommands: { test: 'node slow.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    // runCommand dispatches in-process, so stage stays un-awaited while its
    // verification command runs as a child process.
    const landing = runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    const marker = path.join(fixture.root, 'landing-ready');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(marker), true, 'verification must be running in the candidate');
    await writeFile(path.join(fixture.repo, 'other.txt'), 'independent\n', 'utf8');
    await git(fixture.repo, ['add', 'other.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: other']);
    const staged = await landing;
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const candidateHasOther = await git(fixture.repo,
      ['cat-file', '-e', `${staged.report.stagedRef}:other.txt`]).then(() => true, () => false);
    assert.equal(candidateHasOther, false, 'the candidate stays frozen at its stage baseline');
    const published = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.localRefSync, 'diverged');
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), staged.report.candidateHead);
    assert.equal((await readFile(path.join(fixture.repo, 'other.txt'), 'utf8')).trim(), 'independent');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('主检出切换分支后 publish 仍推送到冻结端点且不同步', async () => {
  const fixture = await makeLocalFixture({
    extraFiles: {
      'slow.mjs': "import { writeFileSync } from 'node:fs'; import path from 'node:path'; writeFileSync(path.resolve('..', 'landing-ready'), 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n",
    },
    validationCommands: { test: 'node slow.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const landing = runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    const marker = path.join(fixture.root, 'landing-ready');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(marker), true);
    await git(fixture.repo, ['checkout', '-q', '-b', 'feat/other-target']);
    const staged = await landing;
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const published = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(published.report.status, 'passed', JSON.stringify(published.report));
    assert.equal(published.report.integrationStatus, 'integrated');
    assert.equal(published.report.localRefSync, 'deferred');
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), staged.report.candidateHead);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/other-target']), '1');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('候选合并冲突只影响候选工作区，不污染主检出', async () => {
  const fixture = await makeLocalFixture({ extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'source\n');
    await git(fixture.worktreePath, ['add', 'shared.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: source']);
    await writeFile(path.join(fixture.repo, 'shared.txt'), 'target\n');
    await git(fixture.repo, ['add', 'shared.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: target']);
    const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'blocked', JSON.stringify(result.report));
    assert.equal(result.report.code, 'LAND_BATCH_CONFLICT');
    assert.match(result.report.error, /No target ref moved/u);
    assert.equal(result.report.task, 'ENG-1');
    assert.deepEqual(result.report.files, ['shared.txt']);
    assert.equal(existsSync(result.report.candidatePath), true, 'the conflicted candidate stays for resolution');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'develop']), '2');
    assert.equal(await git(fixture.repo, ['status', '--porcelain=v1']), '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('recover 只回收归因且干净的中断候选 worktree', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const candidate = path.join(fixture.root, '.vibe-harness-land-ENG-1-00000000-0000-4000-8000-000000000000');
    await git(fixture.repo, ['worktree', 'add', '--detach', candidate, 'HEAD']);
    const planned = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.report.candidates[0].status, 'planned');
    assert.equal(await entryExists(fixture.repo, candidate), true);
    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.report.candidates[0].status, 'passed');
    assert.equal(await entryExists(fixture.repo, candidate), false);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('recover 写操作必须显式限域，--task 只处理目标任务', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const engOne = path.join(fixture.root, '.vibe-harness-land-ENG-1-00000000-0000-4000-8000-000000000010');
    const engTwo = path.join(fixture.root, '.vibe-harness-land-ENG-2-00000000-0000-4000-8000-000000000011');
    await git(fixture.repo, ['worktree', 'add', '--detach', engOne, 'HEAD']);
    await git(fixture.repo, ['worktree', 'add', '--detach', engTwo, 'HEAD']);

    const unscoped = await runCommand(
      ['worktree', 'recover', '--project', fixture.repo, '--write', '--json'],
      { cwd: fixture.repo },
    );
    assert.equal(unscoped.report.code, 'WORKTREE_RECOVER_SCOPE_REQUIRED', JSON.stringify(unscoped.report));
    assert.equal(await entryExists(fixture.repo, engOne), true);
    assert.equal(await entryExists(fixture.repo, engTwo), true);

    const scoped = await runCommand(
      ['worktree', 'recover', '--project', fixture.repo, '--task', 'ENG-1', '--write', '--json'],
      { cwd: fixture.repo },
    );
    assert.equal(scoped.exitCode, 0, JSON.stringify(scoped.report));
    assert.equal(await entryExists(fixture.repo, engOne), false);
    assert.equal(await entryExists(fixture.repo, engTwo), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('recover 保留脏候选与无法归因的 worktree', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const candidate = path.join(fixture.root, '.vibe-harness-land-ENG-1-00000000-0000-4000-8000-000000000000');
    const foreign = path.join(fixture.root, '.vibe-harness-land-OTHER-00000000-0000-4000-8000-000000000001');
    await git(fixture.repo, ['worktree', 'add', '--detach', candidate, 'HEAD']);
    await git(fixture.repo, ['worktree', 'add', '--detach', foreign, 'HEAD']);
    await writeFile(path.join(candidate, 'unowned.txt'), 'keep\n');
    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.report.status, 'failed');
    assert.equal(recovered.report.candidates[0].status, 'blocked');
    assert.equal(await entryExists(fixture.repo, candidate), true);
    assert.equal(await entryExists(fixture.repo, foreign), true);
    assert.equal((await readFile(path.join(candidate, 'unowned.txt'), 'utf8')).trim(), 'keep');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('stage 不写远端引用且保留源工作区与任务分支', async () => {
  const fixture = await makeLocalFixture();
  try {
    const originHead = await git(fixture.origin, ['rev-parse', 'refs/heads/develop']);
    await bootstrapWithWork(fixture);
    const result = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report));
    assert.equal(result.report.integrationStatus, 'local_staged');
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), originHead);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

// Stopping registered services before a worktree is removed stays a best-effort
// step: a teardown that cannot be proven is evidence to report, not a gate over
// a push that already passed verification (docs/adr/ADR-0014-service-teardown-best-effort.md).
// The `stopOnTeardown: false` registration below is exactly the case that keeps
// the source worktree occupied as `integrated_cleanup_pending`.
test('publish 在服务 teardown 无法证明停止时仍完成推送并保留源工作区', async () => {
  const fixture = await makeLocalFixture();
  try {
    await bootstrapWithWork(fixture);
    await registerOptedOutService(fixture.repo, fixture.worktreePath);
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const written = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(written.report.integrationStatus, 'integrated_cleanup_pending');
    assert.equal(written.report.code, 'LAND_BATCH_CLEANUP_INCOMPLETE');
    assert.equal(written.report.cleanup[0].id, 'ENG-1');
    assert.equal(written.report.cleanup[0].status, 'blocked');
    assert.equal(written.report.cleanup[0].reason, 'source dirty or services still occupied');
    // The push itself is confirmed; only the unprovable teardown retains the
    // source worktree for a later cleanup retry.
    assert.equal(await git(fixture.origin, ['rev-parse', 'refs/heads/develop']), written.report.candidateHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('cleanup 在服务 teardown 无法证明停止时仍移除工作区并报告 services', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await writeFile(path.join(fixture.worktreePath, 'work.txt'), 'done\n', 'utf8');
    await git(fixture.worktreePath, ['add', '.']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: work']);
    await git(fixture.repo, ['merge', '--no-ff', '-q', '-m', 'merge ENG-1', 'feat/ENG-1-scaffold']);
    await registerOptedOutService(fixture.repo, fixture.worktreePath);

    const cleaned = await runCommand([
      'worktree', 'cleanup', '--project', fixture.repo, '--task', 'ENG-1', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(cleaned.exitCode, 0, JSON.stringify(cleaned.report));
    assert.equal(cleaned.report.results[0].status, 'passed');
    assert.equal(cleaned.report.results[0].services.status, 'blocked');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), 'feat/ENG-1-scaffold');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('recover 在服务 teardown 无法证明停止时仍回收崩溃残留', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    const worktreePath = path.join(fixture.root, 'repo-worktrees', 'ENG-2');
    // A bootstrap that died before the locked env write leaves the worktree
    // clean, still at the base ref and missing the port env file.
    await rm(path.join(worktreePath, '.vibe-harness/worktree.env'));
    await registerOptedOutService(fixture.repo, worktreePath);

    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.report));
    assert.equal(recovered.report.status, 'passed', JSON.stringify(recovered.report));
    assert.equal(recovered.report.results[0].status, 'passed');
    assert.equal(recovered.report.results[0].services.status, 'blocked');
    assert.equal(await entryExists(fixture.repo, worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('显式 develop local-land 从 origin/develop 引导并在推送后清理', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    const boot = await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--base-ref', 'origin/develop',
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(boot.report.status, 'passed', JSON.stringify(boot.report));
    await writeFile(path.join(fixture.worktreePath, 'work.txt'), 'done\n');
    await git(fixture.worktreePath, ['add', 'work.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: work']);

    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const written = await runCommand([
      'worktree', 'publish', '--project', fixture.repo, '--batch', staged.report.batchId,
      '--delivery', 'local-land', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(written.report.integrationStatus, 'integrated');
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), await git(fixture.repo, ['rev-parse', 'develop']));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('脏主检出不阻塞 publish 远端发布并保留用户文件', async () => {
  const fixture = await makeDevelopLandFixture();
  try {
    const head = await git(fixture.repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repo, 'unrelated.txt'), 'keep\n');
    const staged = await runCommand(['worktree', 'stage', '--project', fixture.repo,
      '--task', 'ENG-1', '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(staged.report.status, 'passed', JSON.stringify(staged.report));
    const result = await runCommand(['worktree', 'publish', '--project', fixture.repo,
      '--batch', staged.report.batchId, '--delivery', 'local-land', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report));
    assert.equal(result.report.integrationStatus, 'integrated');
    assert.equal(result.report.localRefSync, 'deferred');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), head);
    assert.notEqual(await git(fixture.origin, ['rev-parse', 'develop']), head);
    assert.equal(await readFile(path.join(fixture.repo, 'unrelated.txt'), 'utf8'), 'keep\n');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('Git 子进程预算默认 120 秒且可被父进程环境变量收紧或放大', () => {
  assert.equal(GIT_TIMEOUT_MS, 120_000);
  assert.equal(gitTimeoutMs({}), 120_000);
  assert.equal(gitTimeoutMs({ VIBE_HARNESS_GIT_TIMEOUT_MS: '1000' }), MIN_GIT_TIMEOUT_MS);
  assert.equal(gitTimeoutMs({ VIBE_HARNESS_GIT_TIMEOUT_MS: '180000' }), 180_000);
  // Unlike the land-lock budget this knob may widen the window: the measured
  // failure is a volume slower than the default (a `git worktree add` killed
  // mid-flight), not a stale lock that a caller must not extend.
  assert.equal(gitTimeoutMs({ VIBE_HARNESS_GIT_TIMEOUT_MS: '3600000' }), MAX_GIT_TIMEOUT_MS);
  for (const unusable of ['999', '3600001', '180000.5', 'not-a-number', '0', '-5', '']) {
    assert.equal(gitTimeoutMs({ VIBE_HARNESS_GIT_TIMEOUT_MS: unusable }), GIT_TIMEOUT_MS, unusable);
  }
  // `runGit` resolves the default parameter, so it must read the live
  // environment rather than a value captured at import time.
  process.env.VIBE_HARNESS_GIT_TIMEOUT_MS = '240000';
  try {
    assert.equal(gitTimeoutMs(), 240_000);
  } finally {
    delete process.env.VIBE_HARNESS_GIT_TIMEOUT_MS;
  }
});

test('每个 Git 调用都取共享预算而不是自带 15 秒字面量', async () => {
  const libDir = fileURLToPath(new URL('../../runtime/lib/', import.meta.url));
  for (const name of ['cli-runtime.mjs', 'git-fingerprint.mjs', 'verification-plan.mjs', 'worktree-command.mjs']) {
    const source = await readFile(path.join(libDir, name), 'utf8');
    assert.match(source, /gitTimeoutMs/u, `${name} must resolve the shared Git budget`);
    // The private literal is the exact shape that made a `worktree` call fail on
    // a slow volume: the call is killed mid-flight and the caller then reads the
    // empty result as "no fact available" instead of as a timeout.
    assert.doesNotMatch(source, /15_000/u, `${name} must not keep its own Git budget`);
  }
});

test('短 TTL 的活动租约会被心跳续期', async () => {
  const fixture = await makeWorkspaceFixture({ installDependencies: false });
  const lockPath = path.join(fixture.repo, '.git', 'heartbeat-test.lock');
  let heartbeat = null;
  let releaseLease = null;
  try {
    const leaseLock = await import('../../runtime/lib/lease-lock.mjs');
    const acquired = leaseLock.acquireLease(lockPath, { leaseMs: 80 });
    assert.equal(acquired.held, true);
    releaseLease = leaseLock.releaseLease;
    assert.equal(typeof leaseLock.startLeaseHeartbeat, 'function');
    heartbeat = leaseLock.startLeaseHeartbeat(lockPath, { heartbeatMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(leaseLock.readLease(lockPath).stale, false, 'heartbeat keeps the short lease from expiring');
    assert.equal(heartbeat.lost, false);
  } finally {
    heartbeat?.stop();
    releaseLease?.(lockPath);
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree 运行时源码与自安装副本保持一致', async () => {
  const filePairs = [
    ['runtime/lib/worktree-command.mjs', '.agents/runtime/lib/worktree-command.mjs'],
    ['runtime/lib/lease-lock.mjs', '.agents/runtime/lib/lease-lock.mjs'],
  ];
  for (const [sourceRelative, mirrorRelative] of filePairs) {
    const source = fileURLToPath(new URL(`../../${sourceRelative}`, import.meta.url));
    const mirror = fileURLToPath(new URL(`../../${mirrorRelative}`, import.meta.url));
    assert.equal(await readFile(source, 'utf8'), await readFile(mirror, 'utf8'), `${mirrorRelative} must mirror ${sourceRelative}`);
  }
});

test('recover 在基线前进后移除未修改的不完整分支', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    await rm(path.join(fixture.worktreePath, '.vibe-harness/worktree.env'));
    await git(fixture.repo, ['commit', '-q', '--allow-empty', '-m', 'chore: advance base']);

    const written = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.results[0].branchDeleted, true);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('新建租约的短暂不完整记录不会被并发获取者回收', async () => {
  const fixture = await makeWorkspaceFixture({ installDependencies: false });
  const lockPath = path.join(fixture.repo, '.git', 'partial-lease-test.lock');
  try {
    const { acquireLease, readLease, releaseLease } = await import('../../runtime/lib/lease-lock.mjs');
    await writeFile(lockPath, '{"pid":', 'utf8');
    assert.equal(readLease(lockPath).stale, false, 'a fresh partial record may still be in flight');
    assert.equal(acquireLease(lockPath).held, false, 'the peer must not replace a fresh partial record');
    assert.equal(await readFile(lockPath, 'utf8'), '{"pid":');

    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    assert.equal(readLease(lockPath).stale, true, 'a crashed partial record becomes reclaimable');
    assert.equal(acquireLease(lockPath).held, true);
    assert.equal(releaseLease(lockPath), true);
  } finally {
    await rm(lockPath, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});
