import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { landLockTimeoutMs, runCommand } from '../../runtime/commands/run.mjs';
import { GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS, MIN_GIT_TIMEOUT_MS, gitTimeoutMs } from '../../runtime/lib/git-timeouts.mjs';
import { expandMirrors, linkOrCopyMirrors, removeMirrorLinks } from '../../runtime/lib/worktree-mirrors.mjs';

// `run.mjs worktree` is the installed entry point for worktree provisioning and
// cleanup under docs/rules/git-rules.md §Worktree: read-only by default,
// `--write` for real writes, no cleanup before merge-back and never a branch
// delete. `worktree recover` removes crash residue, and a branch is deleted
// only after being proven to sit at the base ref with a clean tree. `worktree
// land` is the merge-back closure: merge into the primary checkout's current
// branch, gate through verify, clean up, and — only with `--push` on top of
// `--write` — push the target and delete the worktree branch. These tests pin
// the receipt shape and the safety gates.

const execFileAsync = promisify(execFile);
const gitIdentity = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture'];
const runtimePath = fileURLToPath(new URL('../../runtime/commands/run.mjs', import.meta.url));

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
  // `worktree land` makes a real merge commit through plain `git merge`, which
  // needs a committer identity from the checkout itself. A clean CI runner has
  // no global identity, so the fixture records one instead of inheriting the
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

// `worktree land` closes the loop git-rules.md §Worktree describes. The
// fixtures below move the primary checkout onto a landing branch (land refuses
// the protected branches the fixture repo starts on) and configure a trivial
// passing check so the verify gate has real evidence to run.

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

test('worktree land 默认 dry-run:输出按序步骤计划且不落盘', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.targetBranch, 'feat/landing-zone');
    assert.equal(planned.report.tier, 'quick');
    assert.equal(planned.report.write, false);
    assert.deepEqual(
      planned.report.results[0].steps.map((step) => [step.id, step.status]),
      [['merge', 'planned'], ['verify', 'planned'], ['push', 'planned'], ['cleanup', 'planned'], ['delete-branch', 'planned']],
    );
    assert.equal(planned.report.results[0].alreadyMerged, false);
    // Planning is read-only: no merge commit on the target, worktree intact.
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal((await readRegistry(fixture.repo)).entries.length, 1);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 预检：收据要求显式审阅并把层升到无 deferred 的声明层', async () => {
  const fixture = await makeLandFixture({
    validationCommands: { tiers: { quick: ['node --version'], standard: ['node --version --no-warnings'] } },
  });
  try {
    await bootstrapWithWork(fixture);
    const base = ['worktree', 'land', '--project', fixture.repo, '--delivery', 'local-land', '--task', 'ENG-1', '--json'];
    // A completion receipt needs a relevance review the planner can never
    // attest on its own, so the preflight refuses this landing.
    const missingReview = await runCommand(base, { cwd: fixture.repo });
    assert.equal(missingReview.report.status, 'blocked', JSON.stringify(missingReview.report));
    const blockers = missingReview.report.blockers ?? missingReview.report.results?.[0]?.blockers ?? [];
    assert.ok(
      blockers.some((line) => /explicit relevance review/u.test(line)),
      JSON.stringify(missingReview.report),
    );
    // An explicitly named layer that still leaves declared checks deferred can
    // never produce an acceptable receipt, so it is a preflight blocker.
    const explicit = await runCommand([...base, '--tier', 'quick', '--reviewed', 'all'], { cwd: fixture.repo });
    assert.equal(explicit.report.status, 'blocked');
    assert.ok(
      (explicit.report.blockers ?? explicit.report.results?.[0]?.blockers ?? []).some((line) => /deferred check/u.test(line)),
      JSON.stringify(explicit.report),
    );
    // Unnamed: the landing escalates to the cheapest layer with no deferred
    // evidence and records the escalation.
    const escalated = await runCommand([...base, '--reviewed', 'all'], { cwd: fixture.repo });
    assert.equal(escalated.report.status, 'planned', JSON.stringify(escalated.report));
    assert.equal(escalated.report.tier, 'standard');
    assert.deepEqual(escalated.report.tierEscalation, { from: 'quick', to: 'standard' });
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('develop + reviewPolicy:none land 不需要 --reviewed 且仍产出完整完成收据', async () => {
  const fixture = await makeLandFixture({
    delivery: {
      default: 'local-land',
      profiles: {
        'local-land': {
          merge: 'no-ff',
          cleanup: 'ancestor',
          requireReceipt: true,
          reviewPolicy: 'none',
        },
      },
    },
  });
  try {
    await bootstrapWithWork(fixture);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    const planned = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--json',
    ], { cwd: fixture.repo });
    assert.equal(planned.report.status, 'planned', JSON.stringify(planned.report));
    assert.equal(planned.report.targetBranch, 'develop');

    const written = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(written.report.completion.verification.review.status, 'not_required');
    assert.equal(written.report.completion.verification.review.reasonCode, 'REVIEW_NOT_REQUIRED');
    assert.equal(written.report.completion.verification.review.reviewPolicy, 'none');
    assert.equal(written.report.completion.verification.review.targetBranch, 'develop');
    assert.equal(written.report.completion.verification.acceptance.status, 'accepted');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 在相同代码树的候选 worktree 复用已通过的确定性检查', async () => {
  const counter = path.join(tmpdir(), `vibe-harness-land-cache-${process.pid}-${Date.now()}.txt`);
  const previousCounter = process.env.VIBE_HARNESS_TEST_COUNTER;
  const fixture = await makeLandFixture({
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
      'worktree', 'land', '--project', fixture.repo, '--delivery', 'local-land',
      '--reviewed', 'all', '--write', '--json',
    ], { cwd: fixture.repo });
    assert.equal(landed.exitCode, 0, JSON.stringify(landed.report));
    assert.equal(landed.report.status, 'passed', JSON.stringify(landed.report));
    assert.equal(landed.report.results[0].steps[1].status, 'passed');
    assert.equal(landed.report.timingsMs.checks.find((check) => check.id === 'test').status, 'reused');
    assert.equal(await readFile(counter, 'utf8'), 'run\n');
  } finally {
    if (previousCounter === undefined) delete process.env.VIBE_HARNESS_TEST_COUNTER;
    else process.env.VIBE_HARNESS_TEST_COUNTER = previousCounter;
    await rm(counter, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree land --push 无 --write 直接拒绝', async () => {
  const fixture = await makeLandFixture();
  try {
    const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--push', '--json'], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    assert.match(result.report.error, /--push requires --write/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree land 拒绝合入保护分支但允许 develop 直落', async () => {
  const fixture = await makeWorkspaceFixture();
  try {
    await bootstrapWithWork(fixture);
    // main、master 与 release/* 仍受保护：本地 land 不得绕过发布边界门禁。
    for (const branch of ['main', 'master', 'release/1.0.0']) {
      if (branch !== 'main') await git(fixture.repo, ['checkout', '-q', '-b', branch]);
      const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
      assert.equal(result.exitCode, 1, branch);
      assert.equal(result.report.status, 'failed', branch);
      assert.equal(result.report.code, 'LAND_TARGET_PROTECTED', branch);
    }
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);

    // develop 按 ADR-0013 允许本地 no-ff 直落：dry-run 给出落地计划而不是拒绝。
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 0, JSON.stringify(planned.report));
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.targetBranch, 'develop');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('worktree land 的 --base-ref 是意图断言而不是选择器', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--base-ref', 'main', '--json'], { cwd: fixture.repo });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, 'failed');
    assert.match(result.report.error, /check out main first or omit --base-ref/u);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('脏工作区与未完成锚点单元都把 land 置为 blocked', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'wip.txt'), 'wip\n', 'utf8');
    const dirtyWorktree = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(dirtyWorktree.report.status, 'blocked');
    assert.match(dirtyWorktree.report.blockers.join('; '), /the worktree has uncommitted changes/u);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    await rm(path.join(fixture.worktreePath, 'wip.txt'));

    await writeFile(path.join(fixture.repo, 'primary-wip.txt'), 'wip\n', 'utf8');
    const dirtyPrimary = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(dirtyPrimary.report.status, 'blocked');
    assert.match(dirtyPrimary.report.blockers.join('; '), /the primary checkout has uncommitted changes/u);
    assert.equal(dirtyPrimary.report.preflight.primaryCheckout.dirty, true);
    assert.equal(dirtyPrimary.report.preflight.primaryCheckout.untrackedChangeCount, 1);
    assert.ok(dirtyPrimary.report.preflight.primaryCheckout.changes.some((change) => change.path === 'primary-wip.txt'));
    assert.equal(typeof dirtyPrimary.report.preflight.baseline.targetHead, 'string');
    assert.equal(typeof dirtyPrimary.report.preflight.baseline.mergeBase, 'string');
    assert.equal(typeof dirtyPrimary.report.preflight.baseline.baseRefDrift, 'boolean');
    await rm(path.join(fixture.repo, 'primary-wip.txt'));

    // An anchor with a unit still in progress means the slice is not done
    // yet; landing it would merge half-finished work.
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
    const pendingAnchor = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(pendingAnchor.report.status, 'blocked');
    assert.match(pendingAnchor.report.blockers.join('; '), /has units not done \(impl\)/u);

    // A failed unit is its own blocker with a dedicated code: land reuses the
    // same predecessor judgement the dispatch gate uses, so a red unit cannot
    // be quietly landed as long as its dependents are simply absent from the
    // anchor's unit list.
    await writeJson(path.join(fixture.repo, '.vibe-harness/tasks/ENG-1.json'), {
      ...anchor,
      schemaVersion: 1,
      units: [{ id: 'impl', status: 'failed' }],
    });
    const failedUnit = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(failedUnit.report.status, 'blocked');
    assert.equal(failedUnit.report.code, 'LAND_UNIT_PREDECESSOR_FAILED');
    assert.deepEqual(failedUnit.report.unitGate, { failed: ['impl'], waiting: [] });
    assert.match(failedUnit.report.blockers.join('; '), /has failed or blocked units \(impl\)/u);

    // All units done unblocks the plan, and a full-risk anchor escalates the
    // verify tier from quick to standard.
    await writeJson(path.join(fixture.repo, '.vibe-harness/tasks/ENG-1.json'), {
      ...anchor,
      schemaVersion: 1,
      riskLevel: 'full',
      stage: 'implement',
      units: [{ id: 'impl', status: 'done' }],
    });
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.tier, 'standard');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('多个归因 worktree 时 land 要求 --task 指定', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    await runCommand([
      'worktree', 'bootstrap', '--project', fixture.repo, '--task', 'ENG-2:feat/ENG-2-scaffold', '--write', '--json',
    ], { cwd: fixture.repo });
    const ambiguous = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(ambiguous.exitCode, 1);
    assert.match(ambiguous.report.error, /multiple attributed worktrees/u);
    assert.match(ambiguous.report.error, /ENG-2/u);

    const chosen = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--json'], { cwd: fixture.repo });
    assert.equal(chosen.exitCode, 0, JSON.stringify(chosen.report));
    assert.equal(chosen.report.status, 'planned');
    assert.equal(chosen.report.results[0].id, 'ENG-1');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land --write 合并、验证并清理,但不推送不删分支', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const written = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed');
    assert.deepEqual(
      written.report.results[0].steps.map((step) => [step.id, step.status]),
      [['merge', 'passed'], ['verify', 'passed'], ['push', 'skipped'], ['cleanup', 'passed'], ['delete-branch', 'skipped']],
    );
    assert.equal(typeof written.report.results[0].steps[1].receipt, 'string');
    assert.equal(written.report.results[0].pushed, false);
    assert.equal(written.report.results[0].branchDeleted, false);
    assert.equal(written.report.results[0].portBlockReleased, true);
    // The merge is a real --no-ff merge commit: fixture + work + merge.
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '3');
    assert.match(await git(fixture.repo, ['log', '-1', '--format=%s']), /^Merge branch/u);
    // Worktree and registry entry gone, branch kept for the manual push.
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 候选合并不执行表单 Hook，并报告分项耗时', async () => {
  const marker = path.join(tmpdir(), `vibe-harness-form-hook-${Date.now()}.marker`);
  const normalizedMarker = marker.replaceAll('\\', '/');
  const fixture = await makeLandFixture({
    extraFiles: { '.githooks/post-merge': `#!/bin/sh\ntouch "${normalizedMarker}"\n` },
  });
  try {
    await chmod(path.join(fixture.repo, '.githooks/post-merge'), 0o755);
    await git(fixture.repo, ['config', 'core.hooksPath', '.githooks']);
    await bootstrapWithWork(fixture);
    const written = await runCommand(['worktree', 'land', '--project', fixture.repo, '--delivery', 'local-land', '--reviewed', 'all', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.equal(existsSync(marker), false, 'candidate merge must not run repository form hooks');
    assert.equal(typeof written.report.timingsMs.setupMs, 'number');
    assert.equal(typeof written.report.timingsMs.mergeMs, 'number');
    assert.equal(typeof written.report.timingsMs.verifyMs, 'number');
    assert.equal(typeof written.report.timingsMs.cleanupMs, 'number');
  } finally {
    await rm(marker, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 预检报告残留 candidate 与缺失依赖根', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const residue = path.join(fixture.root, '.vibe-harness-land-ENG-1-residual');
    await mkdir(residue, { recursive: true });
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--json'], { cwd: fixture.repo });
    assert.equal(planned.exitCode, 1);
    assert.equal(planned.report.status, 'blocked');
    assert.ok(planned.report.preflight.residualCandidates.some((candidate) => candidate.includes('.vibe-harness-land-ENG-1-residual')));
    assert.ok(planned.report.blockers.some((line) => /residual land candidate/u.test(line)));
    await rm(residue, { recursive: true, force: true });
    await rm(path.join(fixture.repo, 'frontend/node_modules'), { recursive: true, force: true });
    const blocked = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--json'], { cwd: fixture.repo });
    assert.equal(blocked.report.status, 'blocked');
    assert.ok(blocked.report.preflight.dependencyBlockers.some((item) => ['LAND_DEPENDENCY_ROOT_MISSING', 'LAND_DEPENDENCY_JUNCTION_BROKEN'].includes(item.code)));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land 预检在 deep 验证锁被持有时 blocked 且不创建候选', async () => {
  const fixture = await makeLandFixture({
    validationCommands: {
      tiers: {
        quick: ['node --version'],
        standard: ['node --version --no-warnings'],
        deep: ['node --version --no-warnings'],
      },
    },
  });
  const lockPath = path.join(fixture.repo, '.git', 'vibe-harness-deep-verify.lock');
  try {
    await bootstrapWithWork(fixture);
    await writeJson(lockPath, {
      schemaVersion: 1,
      nonce: 'fixture',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs: 10 * 60 * 1000,
    });
    const blocked = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--delivery', 'local-land',
      '--tier', 'deep', '--reviewed', 'all', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blocked.report.status, 'blocked', JSON.stringify(blocked.report));
    assert.equal(blocked.report.preflight.deepLock.held, true);
    assert.ok(blocked.report.blockers.some((line) => /deep or backend-wide verification/u.test(line)));
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
  } finally {
    await rm(lockPath, { force: true });
    await removeTemporaryDirectory(fixture.root);
  }
});

test('已并入时 land 幂等重试:merge 跳过、verify 与清理照常', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    // A previous land attempt merged but died before cleanup, reproduced by a
    // manual merge of the same branch.
    await git(fixture.repo, ['merge', '--no-ff', '-q', '-m', 'merge ENG-1', 'feat/ENG-1-scaffold']);
    const relanded = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(relanded.exitCode, 0, JSON.stringify(relanded.report));
    assert.equal(relanded.report.results[0].alreadyMerged, true);
    assert.deepEqual(
      relanded.report.results[0].steps.map((step) => [step.id, step.status]),
      [['merge', 'skipped'], ['verify', 'passed'], ['push', 'skipped'], ['cleanup', 'passed'], ['delete-branch', 'skipped']],
    );
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.deepEqual((await readRegistry(fixture.repo)).entries, []);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('验证门禁失败时中止:主检出不改变并保留任务分支', async () => {
  const fixture = await makeLandFixture({
    extraFiles: { 'fail.mjs': 'process.exit(1);\n' },
    validationCommands: { test: 'node fail.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const failed = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.report.status, 'failed');
    const steps = failed.report.results[0].steps;
    // The merge only exists in the isolated candidate; the primary and the
    // source worktree remain untouched after a failed verify.
    assert.deepEqual(steps.map((step) => [step.id, step.status]), [['merge', 'passed'], ['verify', 'failed']]);
    assert.equal(steps[1].code, 'LAND_VERIFY_FAILED');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
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

test('--no-verify 可预览但拒绝写入', async () => {
  const fixture = await makeLandFixture({
    extraFiles: { 'fail.mjs': 'process.exit(1);\n' },
    validationCommands: { test: 'node fail.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--no-verify', '--json'], { cwd: fixture.repo });
    assert.equal(planned.report.results[0].steps[1].detail, 'skipped by --no-verify');
    const written = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--no-verify', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 1, JSON.stringify(written.report));
    assert.equal(written.report.code, 'LAND_VERIFY_REQUIRED');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('land --write --push 在唯一 origin 远端时建立跟踪并删除分支', async () => {
  const fixture = await makeLandFixture();
  try {
    // A bare repo stands in for origin: the target branch has no upstream yet,
    // so the push policy starts tracking under the sole-origin rule.
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await bootstrapWithWork(fixture);
    const pushed = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--write', '--push', '--json',
    ], { cwd: fixture.repo });
    assert.equal(pushed.exitCode, 0, JSON.stringify(pushed.report));
    assert.equal(pushed.report.results[0].pushed, true);
    assert.equal(pushed.report.results[0].branchDeleted, true);
    assert.deepEqual(
      pushed.report.results[0].steps.map((step) => [step.id, step.status]),
      [['merge', 'passed'], ['verify', 'passed'], ['push', 'passed'], ['cleanup', 'passed'], ['delete-branch', 'passed']],
    );
    assert.equal(await git(fixture.repo, ['rev-parse', '--abbrev-ref', 'feat/landing-zone@{upstream}']), 'origin/feat/landing-zone');
    assert.equal((await git(origin, ['rev-parse', '--verify', 'refs/heads/feat/landing-zone'])).length, 40);
    // The worktree branch is gone only now, after the push succeeded.
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('无 upstream 且远端面不满足推送策略时 --push 被 blocked', async () => {
  const fixture = await makeLandFixture();
  try {
    // A remote that is not origin breaks the sole-origin rule, so the push
    // policy refuses to set an upstream.
    await git(fixture.repo, ['remote', 'add', 'upstream', path.join(fixture.root, 'up.git')]);
    await bootstrapWithWork(fixture);
    const blocked = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--write', '--push', '--json',
    ], { cwd: fixture.repo });
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.report.status, 'blocked');
    assert.match(blocked.report.blockers.join('; '), /push policy does not allow setting one/u);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    // Without --push the same state plans cleanly.
    const planned = await runCommand(['worktree', 'land', '--project', fixture.repo, '--json'], { cwd: fixture.repo });
    assert.equal(planned.report.status, 'planned');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('两个进程同时 land 同一目标时第二个因共享锁超时且不改动目标', async () => {
  const fixture = await makeLandFixture({
    extraFiles: {
      'slow.mjs': "import { writeFileSync } from 'node:fs'; import path from 'node:path'; writeFileSync(path.resolve('..', 'landing-ready'), 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);\n",
    },
    validationCommands: { test: 'node slow.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const first = execFileAsync(process.execPath, [
      runtimePath, 'worktree', 'land', '--project', fixture.repo, '--write', '--json',
    ], { cwd: fixture.repo, windowsHide: true });
    const marker = path.join(fixture.root, 'landing-ready');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(marker), true);
    // The default budget is sized for a full verified landing, so the test
    // shortens the parent-owned knob instead of waiting it out (the first land
    // is already holding the lock in its own process).
    process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS = '300';
    let second;
    try {
      second = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    } finally {
      delete process.env.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS;
    }
    assert.equal(second.report.status, 'blocked');
    assert.equal(second.report.code, 'LAND_LOCK_TIMEOUT');
    // The receipt names the budget the caller asked for, so a shortened wait is
    // distinguishable from the default one.
    assert.match(second.report.blockers.join('; '), /held by another land operation after 300ms/u);
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
    const firstResult = JSON.parse((await first).stdout);
    assert.equal(firstResult.status, 'passed', JSON.stringify(firstResult));
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '3');
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

test('等待锁期间目标前进时以新 HEAD 创建候选并保留两项改动', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    const lockPath = path.join(fixture.repo, '.git', 'vibe-harness-worktree-land.lock');
    await writeFile(lockPath, 'held\n', 'utf8');
    const landing = execFileAsync(process.execPath, [
      runtimePath, 'worktree', 'land', '--project', fixture.repo, '--write', '--json',
    ], { cwd: fixture.repo, windowsHide: true });
    await writeFile(path.join(fixture.repo, 'other.txt'), 'independent\n', 'utf8');
    await git(fixture.repo, ['add', 'other.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: other']);
    await rm(lockPath);
    const result = JSON.parse((await landing).stdout);
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '4');
    assert.equal((await readFile(path.join(fixture.repo, 'other.txt'), 'utf8')).trim(), 'independent');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('验证期间目标 HEAD 前进时阻断落地并保留任务 worktree', async () => {
  const fixture = await makeLandFixture({
    extraFiles: {
      'slow.mjs': "import { writeFileSync } from 'node:fs'; import path from 'node:path'; writeFileSync(path.resolve('..', 'landing-ready'), 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n",
    },
    validationCommands: { test: 'node slow.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const landing = execFileAsync(process.execPath, [
      runtimePath, 'worktree', 'land', '--project', fixture.repo, '--write', '--json',
    ], { cwd: fixture.repo, windowsHide: true });
    const marker = path.join(fixture.root, 'landing-ready');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(marker), true);
    await writeFile(path.join(fixture.repo, 'other.txt'), 'independent\n', 'utf8');
    await git(fixture.repo, ['add', 'other.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: other']);
    const result = JSON.parse((await landing.catch((error) => error)).stdout);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.results[0].steps.at(-1).code, 'LAND_BASELINE_CHANGED');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '2');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('验证期间主检出切换分支时不落到错误目标', async () => {
  const fixture = await makeLandFixture({
    extraFiles: {
      'slow.mjs': "import { writeFileSync } from 'node:fs'; import path from 'node:path'; writeFileSync(path.resolve('..', 'landing-ready'), 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n",
    },
    validationCommands: { test: 'node slow.mjs' },
  });
  try {
    await bootstrapWithWork(fixture);
    const landing = execFileAsync(process.execPath, [
      runtimePath, 'worktree', 'land', '--project', fixture.repo, '--write', '--json',
    ], { cwd: fixture.repo, windowsHide: true });
    const marker = path.join(fixture.root, 'landing-ready');
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(marker), true);
    await git(fixture.repo, ['checkout', '-q', '-b', 'feat/other-target']);
    const result = JSON.parse((await landing.catch((error) => error)).stdout);
    assert.equal(result.code, 'LAND_BASELINE_CHANGED');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/other-target']), '1');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '1');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('候选合并冲突只影响候选工作区，不污染主检出', async () => {
  const fixture = await makeLandFixture({ extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'source\n');
    await git(fixture.worktreePath, ['add', 'shared.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: source']);
    await writeFile(path.join(fixture.repo, 'shared.txt'), 'target\n');
    await git(fixture.repo, ['add', 'shared.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'feat: target']);
    const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.results[0].steps[0].code, 'LAND_MERGE_CONFLICT');
    assert.equal(await git(fixture.repo, ['rev-list', '--count', 'feat/landing-zone']), '2');
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
    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.report.candidates[0].status, 'passed');
    assert.equal(await entryExists(fixture.repo, candidate), false);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
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
    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(recovered.report.status, 'failed');
    assert.equal(recovered.report.candidates[0].status, 'blocked');
    assert.equal(await entryExists(fixture.repo, candidate), true);
    assert.equal(await entryExists(fixture.repo, foreign), true);
    assert.equal((await readFile(path.join(candidate, 'unowned.txt'), 'utf8')).trim(), 'keep');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('不带 --push 的 land 不写远端引用且保留任务分支', async () => {
  const fixture = await makeLandFixture();
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await bootstrapWithWork(fixture);
    const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.status, 'passed', JSON.stringify(result.report));
    assert.equal(result.report.results[0].pushed, false);
    assert.equal(result.report.results[0].branchDeleted, false);
    assert.equal(await git(origin, ['branch', '--list', 'feat/landing-zone']), '');
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

// Stopping registered services before a worktree is removed stays a best-effort
// step: a teardown that cannot be proven is evidence to report, not a gate over
// a merge that already passed verification (docs/adr/ADR-0014-service-teardown-best-effort.md).
// The `stopOnTeardown: false` registration below is exactly the case that used
// to block `land` with SERVICE_TEARDOWN_BLOCKED.
test('land 在服务 teardown 无法证明停止时仍完成落地并写入 services 结果', async () => {
  const fixture = await makeLandFixture();
  try {
    await bootstrapWithWork(fixture);
    await registerOptedOutService(fixture.repo, fixture.worktreePath);
    const written = await runCommand(['worktree', 'land', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
    assert.equal(written.exitCode, 0, JSON.stringify(written.report));
    assert.equal(written.report.status, 'passed', JSON.stringify(written.report));
    assert.deepEqual(
      written.report.results[0].steps.map((step) => [step.id, step.status]),
      [['merge', 'passed'], ['verify', 'passed'], ['push', 'skipped'], ['cleanup', 'passed'], ['delete-branch', 'skipped']],
    );
    const cleanup = written.report.results[0].steps[3];
    assert.equal(cleanup.services.status, 'blocked');
    assert.equal(cleanup.services.processes[0].reason, 'service-opted-out-of-teardown');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
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

    const recovered = await runCommand(['worktree', 'recover', '--project', fixture.repo, '--write', '--json'], { cwd: fixture.repo });
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

    const landed = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--base-ref', 'develop',
      '--delivery', 'local-land', '--reviewed', 'all', '--write', '--push', '--json',
    ], { cwd: fixture.repo });
    assert.equal(landed.report.status, 'passed', JSON.stringify(landed.report));
    assert.deepEqual(landed.report.results[0].steps.map((step) => [step.id, step.status]), [
      ['merge', 'passed'], ['verify', 'passed'], ['push', 'passed'], ['cleanup', 'passed'], ['delete-branch', 'passed'],
    ]);
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), await git(fixture.repo, ['rev-parse', 'develop']));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('脏主检出从核实的 origin/develop 引导，分批提交后仅远端落地', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    const originalHead = await git(fixture.repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repo, 'local-only.txt'), 'do not copy\n');
    await writeFile(path.join(fixture.repo, 'work.txt'), 'unrelated local edit\n');
    const dirtyBefore = await git(fixture.repo, ['status', '--porcelain=v1']);
    const boot = await runCommand(['worktree', 'bootstrap', '--project', fixture.repo, '--base-ref', 'origin/develop',
      '--task', 'ENG-1:feat/ENG-1-scaffold', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(boot.report.status, 'passed', JSON.stringify(boot.report));
    assert.equal(boot.report.results[0].baseSha, originalHead);
    assert.equal(await git(fixture.worktreePath, ['rev-parse', 'HEAD']), originalHead);
    assert.equal(existsSync(path.join(fixture.worktreePath, 'local-only.txt')), false);
    assert.equal(existsSync(path.join(fixture.worktreePath, 'work.txt')), false);
    await writeFile(path.join(fixture.worktreePath, 'first.txt'), 'one\n');
    await git(fixture.worktreePath, ['add', 'first.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: first slice']);
    await writeFile(path.join(fixture.worktreePath, 'second.txt'), 'two\n');
    await git(fixture.worktreePath, ['add', 'second.txt']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'feat: second slice']);
    const dry = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1',
      '--base-ref', 'develop', '--delivery', 'local-land', '--target-mode', 'remote', '--reviewed', 'all', '--json'], { cwd: fixture.repo });
    assert.equal(dry.report.status, 'planned', JSON.stringify(dry.report));
    assert.equal(dry.report.targetBefore, originalHead);
    assert.equal(dry.report.results[0].steps.find((step) => step.id === 'push').status, 'planned');
    const noPush = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1',
      '--base-ref', 'develop', '--delivery', 'local-land', '--target-mode', 'remote', '--write', '--json'], { cwd: fixture.repo });
    assert.equal(noPush.report.code, 'LAND_REMOTE_MODE_INVALID');
    const landed = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1',
      '--base-ref', 'develop', '--delivery', 'local-land', '--target-mode', 'remote', '--reviewed', 'all', '--write', '--push', '--json'], { cwd: fixture.repo });
    assert.equal(landed.report.status, 'passed', JSON.stringify(landed.report));
    const remoteHead = await git(origin, ['rev-parse', 'refs/heads/develop']);
    assert.equal(landed.report.targetAfter, remoteHead);
    assert.equal(landed.report.completion.target.head, remoteHead);
    assert.equal(landed.report.completion.target.before, originalHead);
    assert.equal(await git(fixture.repo, ['rev-parse', 'develop']), originalHead);
    assert.equal(await git(fixture.repo, ['status', '--porcelain=v1']), dirtyBefore);
    assert.equal(await readFile(path.join(fixture.repo, 'work.txt'), 'utf8'), 'unrelated local edit\n');
    assert.equal(await git(origin, ['show', 'refs/heads/develop:first.txt']), 'one');
    assert.equal(await git(origin, ['show', 'refs/heads/develop:second.txt']), 'two');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('远端 land 拒绝本地 develop 未推送提交且默认模式仍拒绝脏主检出', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.repo, 'local-only.txt'), 'unchanged\n');
    const base = ['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1',
      '--base-ref', 'develop', '--delivery', 'local-land', '--reviewed', 'all', '--json'];
    const standard = await runCommand(base, { cwd: fixture.repo });
    assert.equal(standard.report.status, 'blocked');
    assert.match(standard.report.blockers.join(' '), /primary checkout has uncommitted changes/);
    await git(fixture.repo, ['add', 'local-only.txt']);
    await git(fixture.repo, ['commit', '-q', '-m', 'chore: local only']);
    const remote = await runCommand([...base, '--target-mode', 'remote'], { cwd: fixture.repo });
    assert.equal(remote.report.code, 'LAND_LOCAL_TARGET_AHEAD');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('远端 land 在远端漂移、验证失败及推送拒绝时保留任务树并可安全重试', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    const args = ['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--base-ref', 'develop',
      '--delivery', 'local-land', '--target-mode', 'remote', '--reviewed', 'all', '--write', '--push', '--json'];
    const peer = path.join(fixture.root, 'peer');
    await git(fixture.root, ['clone', '-q', '-b', 'develop', origin, peer]);
    await git(peer, ['commit', '-q', '--allow-empty', '-m', 'chore: remote advance']);
    await git(peer, ['push', 'origin', 'develop']);
    const stale = await runCommand(args, { cwd: fixture.repo });
    assert.equal(stale.report.code, 'LAND_REMOTE_BASE_STALE');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    await git(fixture.repo, ['fetch', 'origin', 'develop']);
    // A real validation failure must not publish a candidate.
    await writeJson(path.join(fixture.worktreePath, 'vibe-harness.config.json'), {
      worktree: { baseRef: 'origin/develop', dependencyRoots: ['frontend'], localPackages: ['@fixture/contracts'], root: '../repo-worktrees' },
      validationCommands: { test: 'node -e "process.exit(1)"' },
    });
    await git(fixture.worktreePath, ['add', 'vibe-harness.config.json']);
    await git(fixture.worktreePath, ['commit', '-q', '-m', 'test: exercise validation gate']);
    const failedVerify = await runCommand(args, { cwd: fixture.repo });
    assert.equal(failedVerify.report.results[0].steps.find((step) => step.id === 'verify').code, 'LAND_VERIFY_FAILED', JSON.stringify(failedVerify.report));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), await git(fixture.repo, ['rev-parse', 'origin/develop']));
    await git(fixture.worktreePath, ['checkout', 'origin/develop', '--', 'vibe-harness.config.json']);
    await git(fixture.worktreePath, ['commit', '-q', '-am', 'fix: restore validation']);
    const preReceive = path.join(origin, 'hooks', 'pre-receive');
    await writeFile(preReceive, '#!/bin/sh\nexit 1\n');
    await chmod(preReceive, 0o755);
    const rejected = await runCommand(args, { cwd: fixture.repo });
    assert.equal(rejected.report.results[0].steps.find((step) => step.id === 'push').code, 'LAND_PUSH_FAILED', JSON.stringify(rejected.report));
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), await git(fixture.repo, ['rev-parse', 'origin/develop']));
    await rm(preReceive);
    const retry = await runCommand(args, { cwd: fixture.repo });
    assert.equal(retry.report.status, 'passed', JSON.stringify(retry.report));
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), retry.report.targetAfter);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('远端 land 候选合并冲突不移动远端或主检出', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    const primaryHead = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const peer = path.join(fixture.root, 'peer');
    await git(fixture.root, ['clone', '-q', '-b', 'develop', origin, peer]);
    await writeFile(path.join(peer, 'work.txt'), 'conflicting remote\n');
    await git(peer, ['add', 'work.txt']);
    await git(peer, ['commit', '-q', '-m', 'feat: conflicting remote']);
    await git(peer, ['push', 'origin', 'develop']);
    await git(fixture.repo, ['fetch', 'origin', 'develop']);
    const remoteBefore = await git(origin, ['rev-parse', 'refs/heads/develop']);
    const result = await runCommand(['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1',
      '--base-ref', 'develop', '--delivery', 'local-land', '--target-mode', 'remote',
      '--reviewed', 'all', '--write', '--push', '--json'], { cwd: fixture.repo });
    assert.equal(result.report.code, 'LAND_MERGE_CONFLICT', JSON.stringify(result.report));
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), remoteBefore);
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), primaryHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('远端已推送而源 worktree 清理失败时重试仅清理不重复合并', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    const hook = path.join(origin, 'hooks', 'post-receive');
    const injected = path.join(fixture.worktreePath, 'late-untracked.txt');
    await writeFile(hook, `#!/bin/sh\nprintf 'new work\\n' > '${injected.replaceAll('\\', '/')}'\n`);
    await chmod(hook, 0o755);
    const args = ['worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--base-ref', 'develop',
      '--delivery', 'local-land', '--target-mode', 'remote', '--reviewed', 'all', '--write', '--push', '--json'];
    const first = await runCommand(args, { cwd: fixture.repo });
    assert.equal(first.report.code, 'LAND_SOURCE_WORKTREE_DIRTY', JSON.stringify(first.report));
    assert.equal(first.report.results[0].pushed, true);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    const pushedHead = await git(origin, ['rev-parse', 'refs/heads/develop']);
    assert.equal(first.report.targetAfter, pushedHead);
    await rm(hook);
    await rm(injected);
    await git(fixture.repo, ['fetch', 'origin', 'develop']);
    const retry = await runCommand(args, { cwd: fixture.repo });
    assert.equal(retry.report.status, 'passed', JSON.stringify(retry.report));
    assert.equal(retry.report.results[0].alreadyMerged, true);
    assert.equal(retry.report.results[0].steps.find((step) => step.id === 'merge').status, 'skipped');
    assert.equal(await git(origin, ['rev-parse', 'refs/heads/develop']), pushedHead);
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), false);
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
});

test('develop local-land 推送被拒后保留任务分支与 worktree', async () => {
  const fixture = await makeWorkspaceFixture({ validationCommands: { test: 'node --version' }, worktree: { baseRef: 'origin/develop' } });
  try {
    const origin = path.join(fixture.root, 'origin.git');
    await git(fixture.root, ['init', '--bare', '-q', origin]);
    await git(fixture.repo, ['remote', 'add', 'origin', origin]);
    await git(fixture.repo, ['checkout', '-q', '-b', 'develop']);
    await git(fixture.repo, ['push', '-u', 'origin', 'develop']);
    await bootstrapWithWork(fixture);
    const preReceive = path.join(origin, 'hooks', 'pre-receive');
    await writeFile(preReceive, '#!/bin/sh\nexit 1\n');
    // Git runs a hook only when it is executable, and `writeFile` creates the
    // file without the exec bit: without it the fixture asserts nothing about a
    // rejected push on POSIX, where the push would simply succeed.
    await chmod(preReceive, 0o755);

    const rejected = await runCommand([
      'worktree', 'land', '--project', fixture.repo, '--task', 'ENG-1', '--base-ref', 'develop',
      '--delivery', 'local-land', '--reviewed', 'all', '--write', '--push', '--json',
    ], { cwd: fixture.repo });
    assert.equal(rejected.report.status, 'failed', JSON.stringify(rejected.report));
    assert.equal(rejected.report.results[0].steps.find((step) => step.id === 'push').code, 'LAND_PUSH_FAILED');
    assert.equal(await entryExists(fixture.repo, fixture.worktreePath), true);
    assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold', '--format=%(refname:short)']), 'feat/ENG-1-scaffold');
    assert.notEqual(await git(origin, ['rev-parse', 'refs/heads/develop']), await git(fixture.repo, ['rev-parse', 'develop']));
  } finally {
    await removeTemporaryDirectory(fixture.root);
  }
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
    // The private literal is the exact shape that made `worktree land` fail on a
    // slow volume: the call is killed mid-flight and the caller then reads the
    // empty result as "no fact available" instead of as a timeout.
    assert.doesNotMatch(source, /15_000/u, `${name} must not keep its own Git budget`);
  }
});
