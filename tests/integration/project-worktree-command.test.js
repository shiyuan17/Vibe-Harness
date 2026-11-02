import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { validateJsonAgainstSchema } from '../../scripts/lib/schema-validation.js';
import { landLockTimeoutMs, runCommand } from '../../runtime/commands/run.mjs';
import { GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS, MIN_GIT_TIMEOUT_MS, gitTimeoutMs } from '../../runtime/lib/git-timeouts.mjs';
import { expandMirrors, linkOrCopyMirrors, removeMirrorLinks } from '../../runtime/lib/worktree-mirrors.mjs';

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

test('runtime help exposes only local worktree delivery', async () => {
  const result = await runCommand(['help', '--json']);
  assert.equal(result.exitCode, 0);
  assert.match(result.report.worktree, /<list\|check\|bootstrap\|stage\|status\|discard\|cleanup\|recover>/u);
  assert.match(result.report.worktree, /never fetches or pushes/u);
  assert.match(result.report.worktree, /local_integrated/u);
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







async function makeLandFixture({
  extraFiles = {}, validationCommands = { test: 'node --version' }, verification = null,
  delivery = null, worktree = {},
} = {}) {
  validationCommands = { ...validationCommands, tiers: { quick: validationCommands.tiers?.quick ?? Object.values(validationCommands).filter((value) => typeof value === 'string'),
    ...validationCommands.tiers,
    standard: validationCommands.tiers?.standard?.length ? validationCommands.tiers.standard
      : validationCommands.tiers?.quick ?? Object.values(validationCommands).filter((value) => typeof value === 'string') } };
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

async function localRun(fixture, ...args) {
  return (await runCommand(['worktree', ...args, '--project', fixture.repo, '--json'], { cwd: fixture.repo })).report;
}

for (const remote of ['absent', 'invalid', 'offline']) {
  test(`local stage integrates with ${remote} remote without network or quality commands`, async () => {
    const fixture = await makeLocalFixture({ remote: false, validationCommands: { test: 'node missing-check.mjs' } });
    const trace = path.join(fixture.root, 'git-trace.log');
    const prior = process.env.GIT_TRACE;
    try {
      await bootstrapWithWork(fixture);
      if (remote !== 'absent') await git(fixture.repo, ['remote', 'add', 'origin',
        remote === 'invalid' ? path.join(fixture.root, 'missing.git') : 'https://127.0.0.1:1/unreachable.git']);
      const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
      process.env.GIT_TRACE = trace.replaceAll('\\', '/');
      const result = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
      assert.equal(result.integrationStatus, 'local_integrated', JSON.stringify(result));
      assert.equal(result.localIntegrated, true);
      assert.equal(result.delivery.profile, 'local-land');
      assert.equal(result.localMergeCommit, await git(fixture.repo, ['rev-parse', 'HEAD']));
      assert.equal((await git(fixture.repo, ['show', '-s', '--format=%P', 'HEAD'])).split(' ').length, 2);
      assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD^1']), before);
      assert.equal(existsSync(fixture.worktreePath), false);
      assert.equal(await git(fixture.repo, ['branch', '--list', 'feat/ENG-1-scaffold']), '');
      assert.doesNotMatch(await readFile(trace, 'utf8'), /built-in: git (?:fetch|ls-remote|push)\b/u);
      const state = JSON.parse(await readFile(path.join(fixture.repo, '.git', `vibe-harness-land-batch-${result.batchId}.json`), 'utf8'));
      assert.equal(state.schemaVersion, 6);
      assert.equal(state.localOnly, true);
      const schema = JSON.parse(await readFile(new URL('../../schemas/worktree-transaction.schema.json', import.meta.url), 'utf8'));
      assert.deepEqual(validateJsonAgainstSchema(state, schema), []);
      assert.equal(Object.keys(state).some((key) => /remote|push|queue|candidate/iu.test(key)), false);
      const cleanup = await localRun(fixture, 'cleanup', '--batch', result.batchId, '--write');
      assert.equal(cleanup.integrationStatus, 'local_integrated');
      assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), result.localMergeCommit);
    } finally {
      if (prior === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = prior;
      await removeTemporaryDirectory(fixture.root);
    }
  });
}

test('local stage dry-run is read-only and dirty develop gets the fixed checkpoint before merge', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await bootstrapWithWork(fixture);
    const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repo, 'user.txt'), 'user changes\n');
    const preview = await localRun(fixture, 'stage', '--task', 'ENG-1');
    assert.equal(preview.status, 'planned');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), before);
    assert.match(await git(fixture.repo, ['status', '--porcelain']), /user.txt/u);
    const result = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.preMergeHead, before);
    assert.equal(await git(fixture.repo, ['show', '-s', '--format=%s', result.checkpointCommit]),
      'chore(worktree): checkpoint local develop before merge');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD^1']), result.checkpointCommit);
    assert.equal(await git(fixture.repo, ['show', 'HEAD:user.txt']), 'user changes');
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage keeps the primary conflict and resumes only staged resolutions', async () => {
  const fixture = await makeLocalFixture({ remote: false, extraFiles: { 'shared.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.worktreePath, 'shared.txt'), 'source\n');
    await git(fixture.worktreePath, ['add', '.']);
    await git(fixture.worktreePath, ['commit', '-qm', 'feat: source']);
    await writeFile(path.join(fixture.repo, 'shared.txt'), 'primary\n');
    const conflict = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(conflict.phase, 'conflict', JSON.stringify(conflict));
    assert.equal(conflict.localIntegrated, false);
    assert.equal(conflict.integrationStatus, 'not_integrated');
    assert.match(await git(fixture.repo, ['diff', '--name-only', '--diff-filter=U']), /shared.txt/u);
    const unresolved = await localRun(fixture, 'stage', '--resume', conflict.batchId, '--write');
    assert.equal(unresolved.code, 'LAND_LOCAL_CONFLICT');
    await writeFile(path.join(fixture.repo, 'shared.txt'), 'resolved\n');
    await git(fixture.repo, ['add', 'shared.txt']);
    const resumed = await localRun(fixture, 'stage', '--resume', conflict.batchId, '--write');
    assert.equal(resumed.integrationStatus, 'local_integrated', JSON.stringify(resumed));
    assert.equal(await git(fixture.repo, ['show', 'HEAD:shared.txt']), 'resolved');
    assert.equal((await git(fixture.repo, ['show', '-s', '--format=%P', 'HEAD'])).split(' ').length, 2);
    const retry = await localRun(fixture, 'stage', '--resume', conflict.batchId, '--write');
    assert.equal(retry.localMergeCommit, resumed.localMergeCommit);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage preserves repository safety hooks and checkpoint failures are resumable', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await bootstrapWithWork(fixture);
    const hook = path.join(fixture.repo, '.git/hooks/pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    await writeFile(path.join(fixture.repo, 'user.txt'), 'keep\n');
    const before = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const blocked = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(blocked.code, 'LAND_LOCAL_CHECKPOINT_FAILED', JSON.stringify(blocked));
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), before);
    assert.ok(blocked.batchId);
    await rm(hook);
    const resumed = await localRun(fixture, 'stage', '--resume', blocked.batchId, '--write');
    assert.equal(resumed.integrationStatus, 'local_integrated', JSON.stringify(resumed));
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage retains host-created worktrees even after bootstrap adoption', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await git(fixture.repo, ['worktree', 'add', fixture.worktreePath, '-b', 'feat/host']);
    await bootstrapWithWork(fixture);
    const result = await localRun(fixture, 'stage', '--task', 'ENG-1:feat/host', '--write');
    assert.equal(result.integrationStatus, 'local_integrated_cleanup_pending', JSON.stringify(result));
    assert.equal(result.sources[0].harnessOwned, false);
    assert.equal(existsSync(fixture.worktreePath), true);
    const retry = await localRun(fixture, 'cleanup', '--batch', result.batchId, '--write');
    assert.equal(retry.integrationStatus, result.integrationStatus);
    assert.equal(existsSync(fixture.worktreePath), true);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local cleanup retries a locked Harness source without merging again', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await bootstrapWithWork(fixture);
    await git(fixture.repo, ['worktree', 'lock', fixture.worktreePath]);
    const result = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(result.integrationStatus, 'local_integrated_cleanup_pending');
    await git(fixture.repo, ['worktree', 'unlock', fixture.worktreePath]);
    const cleaned = await localRun(fixture, 'cleanup', '--batch', result.batchId, '--write');
    assert.equal(cleaned.integrationStatus, 'local_integrated', JSON.stringify(cleaned));
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), result.localMergeCommit);
    assert.equal(existsSync(fixture.worktreePath), false);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage rejects a wrong primary branch, dirty source and unsupported options before mutation', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await bootstrapWithWork(fixture);
    const head = await git(fixture.repo, ['rev-parse', 'HEAD']);
    await git(fixture.repo, ['checkout', 'main']);
    assert.equal((await localRun(fixture, 'stage', '--task', 'ENG-1', '--write')).code, 'LAND_LOCAL_TARGET');
    await git(fixture.repo, ['checkout', 'develop']);
    await writeFile(path.join(fixture.worktreePath, 'dirty.txt'), 'keep\n');
    assert.equal((await localRun(fixture, 'stage', '--task', 'ENG-1', '--write')).code, 'LAND_BATCH_PREFLIGHT');
    assert.equal((await localRun(fixture, 'stage', '--task', 'ENG-1', '--push', '--write')).code, 'WORKTREE_OPTION_RETIRED');
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), head);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage serializes concurrent transactions and keeps both sources in develop', async () => {
  const fixture = await makeLocalFixture({ remote: false });
  try {
    await bootstrapWithWork(fixture);
    await bootstrapBatchSecond(fixture, 'second\n');
    const results = await Promise.all(['ENG-1', 'ENG-2'].map((task) => localRun(fixture, 'stage', '--task', task, '--write')));
    assert.ok(results.every((result) => result.localIntegrated), JSON.stringify(results));
    for (const result of results) await git(fixture.repo, ['merge-base', '--is-ancestor', result.localMergeCommit, 'develop']);
    assert.equal(await git(fixture.repo, ['show', 'HEAD:second.txt']), 'second');
    assert.equal(await git(fixture.repo, ['show', 'HEAD:work.txt']), 'done');
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local discard aborts only its own merge and preserves the checkpoint and source', async () => {
  const fixture = await makeLocalFixture({ remote: false, extraFiles: { 'work.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.repo, 'work.txt'), 'primary\n');
    const conflict = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(conflict.phase, 'conflict');
    const blocked = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    assert.equal(blocked.code, 'LAND_LOCAL_ACTIVE_TRANSACTION');
    const discarded = await localRun(fixture, 'discard', '--batch', conflict.batchId, '--write');
    assert.equal(discarded.status, 'passed', JSON.stringify(discarded));
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), conflict.checkpointCommit);
    assert.equal((await readFile(path.join(fixture.repo, 'work.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'primary\n');
    assert.equal(existsSync(fixture.worktreePath), true);
    assert.equal((await localRun(fixture, 'status', '--batch', conflict.batchId)).phase, 'discarded');
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('legacy transaction inspection and conflict recovery never contact a remote', async () => {
  const fixture = await makeLocalFixture({ remote: false, extraFiles: { 'work.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    const batchId = randomUUID();
    const candidate = path.join(fixture.root, `.vibe-harness-land-batch-${batchId}`);
    const baseHead = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const sourceHead = await git(fixture.worktreePath, ['rev-parse', 'HEAD']);
    await git(fixture.repo, ['worktree', 'add', '--detach', candidate, baseHead]);
    await writeFile(path.join(candidate, 'work.txt'), 'legacy\n');
    await git(candidate, ['commit', '-qam', 'chore: legacy candidate']);
    await assert.rejects(git(candidate, ['merge', '--no-ff', '--no-edit', sourceHead]));
    const statePath = path.join(fixture.repo, '.git', `vibe-harness-land-batch-${batchId}.json`);
    const state = { schemaVersion: 5, id: batchId, target: 'develop', baseHead, candidate, next: 0, phase: 'conflict',
      sources: [{ id: 'ENG-1', path: fixture.worktreePath, branch: 'feat/ENG-1-scaffold', head: sourceHead }] };
    await writeFile(statePath, JSON.stringify(state));
    const status = await localRun(fixture, 'status', '--batch', batchId);
    assert.equal(status.code, 'WORKTREE_LEGACY_TRANSACTION');
    assert.match(status.error, /旧远端事务需迁移/u);
    assert.equal(status.integrationStatus, 'not_integrated');
    await writeFile(path.join(candidate, 'work.txt'), 'resolved legacy\n');
    await git(candidate, ['add', '.']);
    const resumed = await localRun(fixture, 'stage', '--resume', batchId, '--write');
    assert.equal(resumed.conflictResolved, true, JSON.stringify(resumed));
    assert.equal(await git(fixture.repo, ['rev-parse', 'HEAD']), baseHead);
    assert.equal((await localRun(fixture, 'cleanup', '--batch', batchId, '--write')).code, 'WORKTREE_LEGACY_TRANSACTION');
    const discarded = await localRun(fixture, 'discard', '--batch', batchId, '--write');
    assert.equal(discarded.status, 'passed', JSON.stringify(discarded));
    assert.equal(existsSync(fixture.worktreePath), true);
    assert.equal(existsSync(candidate), false);
  } finally { await removeTemporaryDirectory(fixture.root); }
});

test('local stage can resume an exact manually completed merge without a second commit', async () => {
  const fixture = await makeLocalFixture({ remote: false, extraFiles: { 'work.txt': 'base\n' } });
  try {
    await bootstrapWithWork(fixture);
    await writeFile(path.join(fixture.repo, 'work.txt'), 'primary\n');
    const conflict = await localRun(fixture, 'stage', '--task', 'ENG-1', '--write');
    await writeFile(path.join(fixture.repo, 'work.txt'), 'resolved\n');
    await git(fixture.repo, ['add', '.']);
    await git(fixture.repo, ['commit', '--no-edit']);
    const head = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const resumed = await localRun(fixture, 'stage', '--resume', conflict.batchId, '--write');
    assert.equal(resumed.integrationStatus, 'local_integrated', JSON.stringify(resumed));
    assert.equal(resumed.localMergeCommit, head);
  } finally { await removeTemporaryDirectory(fixture.root); }
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

















// Stopping registered services before a worktree is removed stays a best-effort
// step: a teardown that cannot be proven is evidence to report, not a gate over
// a push that already passed verification (docs/adr/ADR-0014-service-teardown-best-effort.md).
// The `stopOnTeardown: false` registration below is exactly the case that keeps
// the source worktree occupied as `integrated_cleanup_pending`.


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
