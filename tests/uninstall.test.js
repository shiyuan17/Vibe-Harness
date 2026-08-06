import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

async function runCliFailure(args) {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  } catch (error) {
    return {
      report: error.stdout ? JSON.parse(error.stdout) : null,
      stderr: error.stderr,
    };
  }
  assert.fail('Expected CLI command to fail.');
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error.code === 'EISDIR') return true;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('MVP uninstall previews then removes managed assets while retaining local project data', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-'));
  try {
    await runCli(['init', '--project', target]);
    await mkdir(path.join(target, 'docs'), { recursive: true });
    await writeFile(path.join(target, 'AGENTS.md'), '# Local agents\n', 'utf8');
    await writeFile(path.join(target, 'docs', 'product.md'), '# Product\n', 'utf8');
    const install = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'agents,rules', '--write',
    ]);

    const preview = await runCli(['uninstall', '--project', target, '--all-targets', '--dry-run']);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.actions.some((item) => item.target === 'AGENTS.md' && item.kind === 'remove-managed-instruction-block'), true);
    assert.equal(await exists(path.join(target, 'docs', 'rules', 'git-rules.md')), true);

    const result = await runCli(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.equal(result.retainedState, false);
    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), '# Local agents\n');
    assert.equal(await readFile(path.join(target, 'docs', 'product.md'), 'utf8'), '# Product\n');
    assert.equal(await exists(path.join(target, 'docs', 'rules', 'git-rules.md')), false);
    assert.equal(await exists(path.join(target, 'docs', 'rules')), false);
    assert.equal(await exists(path.join(target, 'vibe-harness.config.json')), true);
    assert.equal(await exists(path.join(target, '.agents', 'backup', install.baselineId, 'manifest.json')), true);
    assert.equal(await exists(path.join(target, '.vibe-harness', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('uninstall preserves an existing empty codebase-memory ignore file', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-empty-cbmignore-'));
  try {
    await runCli(['init', '--project', target, '--profile', 'full']);
    await writeFile(path.join(target, '.cbmignore'), '', 'utf8');
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--plugin', 'codebase-memory', '--write', '--force', '--confirm-red-zone',
    ]);

    await runCli([
      'uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone',
    ]);

    assert.equal(await exists(path.join(target, '.cbmignore')), true);
    assert.equal(await readFile(path.join(target, '.cbmignore'), 'utf8'), '');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP uninstall keeps modified ownership state and succeeds after the file is restored', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-retry-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'agents,rules', '--write',
    ]);
    const changedPath = path.join(target, 'docs', 'rules', 'git-rules.md');
    const installedContent = await readFile(changedPath, 'utf8');
    await writeFile(changedPath, 'user changed rules\n', 'utf8');

    const failed = await runCliFailure(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.equal(failed.report.retainedState, true);
    assert.deepEqual(failed.report.skipped, [{ reason: 'target-modified', target: 'docs/rules/git-rules.md' }]);
    const remaining = JSON.parse(await readFile(path.join(target, '.vibe-harness', 'install-state.json'), 'utf8'));
    assert.deepEqual(remaining.files.map((item) => item.target), ['docs/rules/git-rules.md']);

    await writeFile(changedPath, installedContent, 'utf8');
    const retried = await runCli(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.equal(retried.retainedState, false);
    assert.equal(await exists(changedPath), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP uninstall restores legacy unmarked AGENTS content from the install baseline', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-legacy-agents-'));
  try {
    await runCli(['init', '--project', target]);
    const legacy = [
      '# AGENTS.md',
      '',
      '## 最小启动步骤',
      '## 五条红线',
      '## 核心位置',
      'docs/rules/quickstart.md',
      '',
    ].join('\n');
    await writeFile(path.join(target, 'AGENTS.md'), legacy, 'utf8');
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write',
    ]);

    await runCli(['uninstall', '--project', target, '--all-targets', '--write']);

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), legacy);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP uninstall requires explicit confirmation before changing red-zone files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-red-zone-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--modules', 'hooks', '--write', '--confirm-red-zone',
    ]);

    const failed = await runCliFailure(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.match(failed.stderr, /red-zone/u);
    assert.equal(await exists(path.join(target, '.codex', 'hooks.json')), true);

    await runCli([
      'uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone',
    ]);
    assert.equal(await exists(path.join(target, '.codex', 'hooks.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP uninstall rejects install-state targets outside the project', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-uninstall-escape-'));
  const outside = path.join(path.dirname(target), `${path.basename(target)}-outside.md`);
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write',
    ]);
    const statePath = path.join(target, '.vibe-harness', 'install-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.files[0].target = `../${path.basename(outside)}`;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await writeFile(outside, 'outside\n', 'utf8');

    const failed = await runCliFailure(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.match(failed.stderr, /must not traverse parent directories|outside/u);
    assert.equal(await readFile(outside, 'utf8'), 'outside\n');
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(outside, { force: true });
  }
});
