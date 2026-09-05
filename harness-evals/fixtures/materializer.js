import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertPortableRelativePath } from '../../scripts/lib/manifest.js';

function assertInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return candidate;
  throw new Error(`${label} escapes its fixture root`);
}

async function writeEntries(root, entries = []) {
  for (const entry of entries) {
    assertPortableRelativePath(entry.path, 'fixture file path');
    const target = assertInside(root, path.resolve(root, entry.path), entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    const content = entry.content.endsWith('\\n') ? `${entry.content.slice(0, -2)}\n` : entry.content;
    await writeFile(target, content, { encoding: 'utf8', mode: entry.executable ? 0o700 : 0o600 });
    if (entry.executable) await chmod(target, 0o700);
  }
}

function run(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(output);
      else reject(new Error(`${program} ${args[0] ?? ''} exited ${code}: ${diagnostic || output}`));
    });
  });
}

async function initializeGit(workspace, manifest, fixtureRoot) {
  if (!manifest.git?.initialize) return { initialized: false, head: null, branches: [], worktrees: [] };
  await run('git', ['init', '--initial-branch=main'], workspace);
  await run('git', ['config', 'user.name', 'Harness Evals'], workspace);
  await run('git', ['config', 'user.email', 'harness-evals@invalid.local'], workspace);
  await run('git', ['add', '--all'], workspace);
  await run('git', ['commit', '-m', 'fixture: initial state'], workspace);

  const declaredBranches = new Set(manifest.git.branches ?? []);
  for (const change of manifest.git.branchChanges ?? []) {
    if (!declaredBranches.has(change.branch)) throw new Error(`branch change uses undeclared branch: ${change.branch}`);
    await run('git', ['switch', '-c', change.branch, 'main'], workspace);
    await writeEntries(workspace, change.files);
    await run('git', ['add', '--all'], workspace);
    await run('git', ['commit', '-m', change.message], workspace);
  }
  await run('git', ['switch', 'main'], workspace);
  const changedBranches = new Set((manifest.git.branchChanges ?? []).map((change) => change.branch));
  for (const branch of declaredBranches) {
    if (!changedBranches.has(branch)) await run('git', ['branch', branch, 'main'], workspace);
  }

  const worktrees = [];
  for (const name of manifest.git.worktrees ?? []) {
    const worktree = assertInside(fixtureRoot, path.join(fixtureRoot, 'worktrees', name), `worktree ${name}`);
    await mkdir(path.dirname(worktree), { recursive: true });
    await run('git', ['worktree', 'add', '-b', name, worktree, 'main'], workspace);
    worktrees.push({ name, path: worktree });
  }
  return {
    initialized: true,
    head: await run('git', ['rev-parse', 'HEAD'], workspace),
    branches: [...declaredBranches],
    worktrees,
  };
}

function expandHiddenChecks(hiddenChecks, oracle) {
  return hiddenChecks.map((check) => ({
    ...check,
    args: check.args.map((argument) => argument.replaceAll('{ORACLE_DIR}', oracle)),
  }));
}

function initialFiles(manifest) {
  return Object.fromEntries(manifest.files.map((entry) => [
    entry.path,
    createHash('sha256').update(entry.content.endsWith('\\n') ? `${entry.content.slice(0, -2)}\n` : entry.content).digest('hex'),
  ]));
}

export async function materializeFixture(manifest, { baseDir = tmpdir() } = {}) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.id !== 'string') {
    throw new TypeError('fixture manifest schemaVersion 1 with an id is required');
  }
  await mkdir(baseDir, { recursive: true });
  const root = await mkdtemp(path.join(baseDir, `harness-eval-${manifest.id}-`));
  const workspace = path.join(root, 'workspace');
  const oracle = path.join(root, 'oracle');
  const evidence = path.join(root, 'evidence');
  try {
    await Promise.all([mkdir(workspace), mkdir(oracle), mkdir(evidence, { mode: 0o700 })]);
    await writeEntries(workspace, manifest.files);
    await writeEntries(oracle, manifest.oracleFiles ?? []);
    const git = await initializeGit(workspace, manifest, root);
    return {
      id: manifest.id,
      root,
      agent: { id: manifest.id, workspace, worktrees: git.worktrees },
      controller: {
        workspace,
        oracle,
        evidence,
        faults: structuredClone(manifest.faults),
        hiddenChecks: expandHiddenChecks(manifest.hiddenChecks, oracle),
        initialFiles: initialFiles(manifest),
        git,
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function createFixtureManager({ scenariosDir, baseDir, projectHarness } = {}) {
  if (!path.isAbsolute(scenariosDir ?? '')) throw new TypeError('scenariosDir must be absolute');
  const fixtureDir = path.resolve(scenariosDir, '../fixtures');
  return Object.freeze({
    async prepare({ scenario }) {
      const manifestPath = path.resolve(scenariosDir, scenario.fixture.ref);
      assertInside(fixtureDir, manifestPath, 'scenario.fixture.ref');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.id !== scenario.id) throw new Error(`fixture ${manifest.id} does not match scenario ${scenario.id}`);
      const fixture = await materializeFixture(manifest, { baseDir });
      try {
        if (typeof projectHarness === 'function') {
          await projectHarness({ fixture, scenario });
          if (fixture.controller.git.initialized) {
            await run('git', ['add', '--all'], fixture.controller.workspace);
            const pending = await run('git', ['status', '--porcelain'], fixture.controller.workspace);
            if (pending) await run('git', ['commit', '-m', 'fixture: project harness'], fixture.controller.workspace);
            fixture.controller.git.head = await run('git', ['rev-parse', 'HEAD'], fixture.controller.workspace);
            for (const worktree of fixture.controller.git.worktrees) {
              await run('git', ['merge', '--ff-only', 'main'], worktree.path);
            }
          }
        }
        return fixture;
      } catch (error) {
        await rm(fixture.root, { recursive: true, force: true });
        throw error;
      }
    },
    async cleanup({ fixture }) {
      if (fixture?.root) await rm(fixture.root, { recursive: true, force: true });
    },
  });
}
