import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { collectChangedPaths, selectFocusedChecks } from '../scripts/verify-focused.js';

const execFileAsync = promisify(execFile);

function commands(result) {
  return result.commands.map((item) => item.command);
}

test('selectFocusedChecks maps rules changes to unit tests and eval:check with a fingerprint note', () => {
  const result = selectFocusedChecks(['rules/governance-core.md']);
  assert.deepEqual(commands(result), ['pnpm test:unit', 'pnpm eval:check']);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /fingerprint/u);
  assert.match(result.notes[0], /reference update checklist/u);
});

test('selectFocusedChecks prefers the rules bucket over the docs bucket for docs/rules paths', () => {
  const result = selectFocusedChecks(['docs/rules/test-rules.md']);
  assert.deepEqual(commands(result), ['pnpm test:unit', 'pnpm eval:check']);
});

test('selectFocusedChecks merges buckets, de-duplicates, and preserves first-seen order', () => {
  const result = selectFocusedChecks(['rules/x.md', 'scripts/tool.js', 'runtime/hooks/lib/policy.mjs']);
  assert.deepEqual(commands(result), ['pnpm test:unit', 'pnpm eval:check', 'pnpm test:integration']);
});

test('selectFocusedChecks maps eval suites, skills, workflows, and adapters to their checks', () => {
  assert.deepEqual(commands(selectFocusedChecks(['evals/suites/a.json'])), ['pnpm eval:check', 'pnpm test:eval']);
  assert.deepEqual(commands(selectFocusedChecks(['skills/core/x/SKILL.md'])), [
    'pnpm skills:audit',
    'pnpm eval:check',
    'pnpm test:eval',
  ]);
  assert.deepEqual(commands(selectFocusedChecks(['.github/workflows/ci.yml'])), ['pnpm test:eval']);
  assert.deepEqual(commands(selectFocusedChecks(['adapters/codex/AGENTS.template.md'])), [
    'pnpm check',
    'pnpm test:integration',
  ]);
  assert.deepEqual(commands(selectFocusedChecks(['.agents/runtime/hooks/lib/context.mjs'])), [
    'pnpm test:unit',
    'pnpm eval:check',
  ]);
});

test('selectFocusedChecks falls back to pnpm check for unrecognized paths', () => {
  assert.deepEqual(commands(selectFocusedChecks(['package.json'])), ['pnpm check']);
  assert.deepEqual(commands(selectFocusedChecks(['docs/README.md', 'AGENTS.md'])), ['pnpm check']);
  assert.deepEqual(commands(selectFocusedChecks([])), []);
});

test('collectChangedPaths reports committed, working-tree, and untracked changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    await mkdir(path.join(dir, 'rules'), { recursive: true });
    await writeFile(path.join(dir, 'rules', 'a.md'), 'base\n');
    await git('add', '.');
    await git('commit', '-m', 'base');

    await mkdir(path.join(dir, 'evals'), { recursive: true });
    await writeFile(path.join(dir, 'evals', 'x.json'), '{}\n');
    await git('add', '.');
    await git('commit', '-m', 'second');

    // Working-tree modification plus an untracked directory.
    await writeFile(path.join(dir, 'rules', 'a.md'), 'changed\n');
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs', 'new.md'), 'untracked\n');

    const paths = await collectChangedPaths({ base: 'HEAD~1', cwd: dir });
    // Untracked directories are reported by status as collapsed "dir/" entries.
    assert.deepEqual([...paths].sort(), ['docs/', 'evals/x.json', 'rules/a.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectChangedPaths returns an empty list for a clean worktree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    await writeFile(path.join(dir, 'README.md'), 'x\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    const paths = await collectChangedPaths({ cwd: dir });
    assert.deepEqual(paths, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
