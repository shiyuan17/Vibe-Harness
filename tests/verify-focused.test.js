import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  collectChangedPaths,
  parseNulPathList,
  parseNulPorcelainPaths,
} from '../scripts/verify-focused.js';

const execFileAsync = promisify(execFile);

test('NUL-delimited path parsers preserve spaces, quotes, newlines, and rename destinations', () => {
  const diffOutput = [
    'docs/space name.md',
    'scripts/"quoted".js',
    'tests/line\nbreak.js',
    '',
  ].join('\0');
  assert.deepEqual(parseNulPathList(diffOutput), [
    'docs/space name.md',
    'scripts/"quoted".js',
    'tests/line\nbreak.js',
  ]);

  const statusOutput = [
    ' M docs/space name.md',
    'R  scripts/new name.js',
    'docs/rules/old\nname.js',
    '?? tests/"quoted".test.js',
    '',
  ].join('\0');
  assert.deepEqual(parseNulPorcelainPaths(statusOutput), [
    'docs/space name.md',
    'scripts/new name.js',
    'tests/"quoted".test.js',
  ]);
});

test('collectChangedPaths reports committed, staged, unstaged, untracked, and renamed paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    await mkdir(path.join(dir, 'docs/rules'), { recursive: true });
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await mkdir(path.join(dir, 'docs'), { recursive: true });
    await writeFile(path.join(dir, 'docs/rules', 'staged.md'), 'base\n');
    await writeFile(path.join(dir, 'scripts', 'unstaged.js'), 'base\n');
    await writeFile(path.join(dir, 'docs', 'rename old.md'), 'base\n');
    await git('add', '.');
    await git('commit', '-m', 'base');

    await mkdir(path.join(dir, 'evals'), { recursive: true });
    await writeFile(path.join(dir, 'evals', 'x.json'), '{}\n');
    await git('add', '.');
    await git('commit', '-m', 'second');

    await writeFile(path.join(dir, 'docs/rules', 'staged.md'), 'staged\n');
    await git('add', 'docs/rules/staged.md');
    await writeFile(path.join(dir, 'scripts', 'unstaged.js'), 'unstaged\n');
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await writeFile(path.join(dir, 'tests', 'untracked space.test.js'), 'untracked\n');
    await mkdir(path.join(dir, 'adapters'), { recursive: true });
    await git('mv', 'docs/rename old.md', 'adapters/renamed file.md');

    const paths = await collectChangedPaths({ base: 'HEAD~1', cwd: dir });
    assert.deepEqual([...paths].sort(), [
      'adapters/renamed file.md',
      'docs/rules/staged.md',
      'evals/x.json',
      'scripts/unstaged.js',
      'tests/untracked space.test.js',
    ]);
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

test('verify-focused --run --json emits one reviewable receipt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-receipt-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'verify-focused-fixture',
      private: true,
      scripts: { 'test:unit': 'node -e "console.log(42)"' },
    }));
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    await writeFile(path.join(dir, 'tests', 'check.txt'), 'base\n');
    const installCommand = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'pnpm.cmd', 'install', '--ignore-scripts']]
      : ['pnpm', ['install', '--ignore-scripts']];
    await execFileAsync(installCommand[0], installCommand[1], { cwd: dir });
    await git('add', '.');
    await git('commit', '-m', 'base');
    await writeFile(path.join(dir, 'tests', 'check.txt'), 'changed\n');

    const scriptPath = path.resolve(import.meta.dirname, '../scripts/verify-focused.js');
    const result = await execFileAsync(process.execPath, [scriptPath, '--run', '--json'], {
      cwd: dir,
      maxBuffer: 1024 * 1024 * 8,
    });
    const report = JSON.parse(result.stdout);

    assert.equal(report.ok, true);
    assert.deepEqual(report.verification.focused.changedPaths, ['tests/check.txt']);
    assert.deepEqual(report.verification.focused.commands.map((item) => item.command), ['pnpm test:unit']);
    assert.equal(report.results[0].status, 'passed');
    assert.equal(report.verification.snapshotComparison, 'match');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify-focused --run terminates a hanging command with project timeout recovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-timeout-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'verify-focused-timeout-fixture',
      private: true,
      scripts: { 'test:unit': 'node -e "setInterval(() => {}, 1000)"' },
    }));
    await writeFile(path.join(dir, 'vibe-harness.config.json'), JSON.stringify({
      verification: { timeoutMs: 1000 },
    }));
    await writeFile(path.join(dir, 'tests', 'check.txt'), 'base\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    await writeFile(path.join(dir, 'tests', 'check.txt'), 'changed\n');

    const scriptPath = path.resolve(import.meta.dirname, '../scripts/verify-focused.js');
    const startedAt = Date.now();
    await assert.rejects(
      execFileAsync(process.execPath, [scriptPath, '--run'], {
        cwd: dir,
        maxBuffer: 1024 * 1024 * 8,
      }),
      (error) => {
        assert.match(error.stderr, /Focused verification failed at: pnpm test:unit/u);
        assert.match(error.stderr, /Recovery: pnpm verify:focused --run/u);
        return true;
      },
    );
    assert.equal(Date.now() - startedAt < 5000, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
