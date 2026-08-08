import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { autoCommit } from '../runtime/hooks/auto-commit.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, windowsHide: true })).stdout.trim();
}

async function setupRepo(callback, { branch = 'feat/test-task', config = true } = {}) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-auto-commit-'));
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: target, windowsHide: true });
    if (config) {
      await execFileAsync('git', ['config', '--local', 'user.email', 'test@example.test'], { cwd: target, windowsHide: true });
      await execFileAsync('git', ['config', '--local', 'user.name', 'Test'], { cwd: target, windowsHide: true });
      // Disable husky/commitlint so auto-commit's git commit can succeed.
      await execFileAsync('git', ['config', '--local', 'core.hooksPath', '/dev/null'], { cwd: target, windowsHide: true });
    }
    await writeFile(path.join(target, 'vibe-harness.config.json'), JSON.stringify({
      hooks: { mode: 'guarded', redZonePaths: ['.env', 'auth/', '.github/workflows/'] },
      validationCommands: { lint: null, typecheck: null, test: null, eval: null },
    }), 'utf8');
    // Provision a minimal trusted install-state so readHookSettings trusts config.
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await writeFile(path.join(target, '.vibe-harness', 'install-state.json'), JSON.stringify({
      product: 'vibe-harness',
      storageNamespace: 'vibe-harness',
      rtkHooksEnabled: false,
    }), 'utf8');
    // Initial commit on main so we can branch.
    await writeFile(path.join(target, 'README.md'), '# Init\n', 'utf8');
    await execFileAsync('git', ['add', '-A'], { cwd: target, windowsHide: true });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'init'], { cwd: target, windowsHide: true });
    if (branch !== 'main') {
      await execFileAsync('git', ['checkout', '--quiet', '-b', branch], { cwd: target, windowsHide: true });
    }
    return await callback(target);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
}

async function lastCommitMessage(cwd) {
  return git(cwd, ['log', '-1', '--format=%B']);
}

test('autoCommit skips when stop_hook_active is true', async () => {
  await setupRepo(async (target) => {
    await writeFile(path.join(target, 'src.js'), 'export const x = 1;\n', 'utf8');
    const result = await autoCommit({ cwd: target, stopHookActive: true });
    assert.deepEqual(result, {});
    // Nothing was committed.
    assert.equal(await git(target, ['status', '--porcelain']), '?? src.js');
  });
});

test('autoCommit skips on protected main branch', async () => {
  await setupRepo(async (target) => {
    await execFileAsync('git', ['checkout', '--quiet', '-b', 'main'], { cwd: target, windowsHide: true });
    await writeFile(path.join(target, 'src.js'), 'export const x = 1;\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.deepEqual(result, {});
    assert.equal(await git(target, ['status', '--porcelain']), '?? src.js');
  });
});

test('autoCommit skips when working tree is clean', async () => {
  await setupRepo(async (target) => {
    const result = await autoCommit({ cwd: target });
    assert.deepEqual(result, {});
  });
});

test('autoCommit skips outside a git repository', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-auto-commit-nogit-'));
  try {
    const result = await autoCommit({ cwd: target });
    assert.deepEqual(result, {});
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('autoCommit commits clean changes on a task branch', async () => {
  await setupRepo(async (target) => {
    await mkdir(path.join(target, 'src'), { recursive: true });
    await writeFile(path.join(target, 'src', 'app.js'), 'export const app = 1;\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /Auto-committed on feat\/test-task/u);
    assert.match(result.additionalContext, /Rollback: git reset --soft HEAD~1/u);
    const msg = await lastCommitMessage(target);
    assert.match(msg, /feat: auto-commit/u);
    assert.equal(await git(target, ['status', '--porcelain']), '');
  });
});

test('autoCommit cancels staging when syntax check fails', async () => {
  await setupRepo(async (target) => {
    // A genuinely broken JSON file trips JSON.parse regardless of module type.
    await writeFile(path.join(target, 'broken.json'), '{ invalid json\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /skipped/u);
    // File remains unstaged.
    assert.equal(await git(target, ['status', '--porcelain']), '?? broken.json');
  });
});

test('autoCommit cancels staging when a secret is staged', async () => {
  await setupRepo(async (target) => {
    await writeFile(path.join(target, 'config.js'), 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234";\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /skipped/u);
    assert.equal(await git(target, ['status', '--porcelain']), '?? config.js');
  });
});

test('autoCommit cancels staging when a red-zone path is touched', async () => {
  await setupRepo(async (target) => {
    await writeFile(path.join(target, '.env'), 'SECRET=hello\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /skipped/u);
    assert.equal(await git(target, ['status', '--porcelain']), '?? .env');
  });
});

test('autoCommit generates conventional commit message for test files', async () => {
  await setupRepo(async (target) => {
    await mkdir(path.join(target, 'tests'), { recursive: true });
    await writeFile(path.join(target, 'tests', 'example.test.js'), "test('passes', () => assert.ok(true));\n", 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /Auto-committed/u);
    const msg = await lastCommitMessage(target);
    assert.match(msg, /test: auto-commit/u);
  });
});

test('autoCommit generates docs commit for markdown files', async () => {
  await setupRepo(async (target) => {
    await mkdir(path.join(target, 'docs'), { recursive: true });
    await writeFile(path.join(target, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    const result = await autoCommit({ cwd: target });
    assert.match(result.additionalContext, /Auto-committed/u);
    const msg = await lastCommitMessage(target);
    assert.match(msg, /docs: auto-commit/u);
  });
});
