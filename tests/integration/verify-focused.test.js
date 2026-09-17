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
} from '../../scripts/verify-focused.js';

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

    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-focused.js');
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

test('verify-focused --run 默认只执行快速层并把更深检查标为 deferred', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'verify-focused-tier-'));
  const git = (...args) => execFileAsync('git', ['-C', dir, ...args]);
  try {
    await git('init');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Vibe-Harness Test');
    const scripts = {
      'test:unit': 'node run-unit.mjs',
      'test:component': 'node run-component.mjs',
      'test:integration': 'node run-integration.mjs',
      'test:e2e': 'node run-e2e.mjs',
      'smoke:lifecycle': 'node run-smoke.mjs',
    };
    const packageJson = { name: 'verify-focused-tier-fixture', private: true, scripts };
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson));
    for (const name of ['unit', 'component', 'integration', 'e2e', 'smoke']) {
      await writeFile(
        path.join(dir, `run-${name}.mjs`),
        `console.log('${name}-ran');\n`,
        'utf8',
      );
    }
    // pnpm installs missing dependencies before running a script, which would
    // change the worktree mid-verification and invalidate the receipt.
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    const installCommand = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'pnpm.cmd', 'install', '--ignore-scripts']]
      : ['pnpm', ['install', '--ignore-scripts']];
    await execFileAsync(installCommand[0], installCommand[1], { cwd: dir });
    await git('add', '.');
    await git('commit', '-m', 'base');
    // package.json is a high-risk path, so the risk plan derives the whole
    // matrix; the cost layer decides which part of it this run pays for.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...packageJson, version: '0.0.1' }));

    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-focused.js');
    const fast = JSON.parse((await execFileAsync(process.execPath, [scriptPath, '--run', '--json'], {
      cwd: dir,
      maxBuffer: 1024 * 1024 * 8,
    })).stdout);

    assert.equal(fast.ok, true);
    assert.equal(fast.verification.executionTier, 'quick');
    assert.equal(fast.verification.scopeStatus, 'partial');
    assert.equal(fast.verification.nextTier, 'standard');
    assert.deepEqual(
      fast.verification.focused.commands.map((item) => item.command),
      ['pnpm test:unit', 'pnpm test:component'],
    );
    assert.deepEqual(fast.verification.deferredChecks.map((item) => item.costTier), ['standard', 'deep']);
    assert.deepEqual(
      fast.results.map((item) => [item.command, item.status]),
      [['pnpm test:unit', 'passed'], ['pnpm test:component', 'passed']],
    );
    assert.match(fast.results[0].stdout, /unit-ran/u);

    const deep = JSON.parse((await execFileAsync(process.execPath, [scriptPath, '--run', '--json', '--tier', 'deep'], {
      cwd: dir,
      maxBuffer: 1024 * 1024 * 8,
    })).stdout);

    assert.equal(deep.ok, true);
    assert.equal(deep.verification.executionTier, 'deep');
    assert.equal(deep.verification.scopeStatus, 'complete');
    assert.deepEqual(deep.verification.deferredChecks, []);
    assert.deepEqual(
      deep.results.map((item) => item.command),
      ['pnpm test:unit', 'pnpm test:component', 'pnpm test:integration', 'pnpm smoke:lifecycle'],
    );
    assert.deepEqual(deep.results.map((item) => item.status), ['passed', 'passed', 'passed', 'passed']);
  } finally {
    await rm(dir, { force: true, recursive: true });
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

    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/verify-focused.js');
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
    // TD-2026-09-15-8: the structured timeout receipt is asserted above; this
    // wall-clock check only requires that the run does not end before the
    // declared timeout and finishes within a process-tree reclamation budget.
    const declaredTimeoutMs = 1000;
    const reclamationBudgetMs = 30_000;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs >= declaredTimeoutMs, true);
    assert.equal(elapsedMs < declaredTimeoutMs + reclamationBudgetMs, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
