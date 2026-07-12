import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, LOOPENGINE_TEST_OFFLINE: '1' },
  });
  return JSON.parse(stdout);
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

test('MVP install previews then writes one reusable project baseline backup', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-install-baseline-'));
  try {
    await runCli(['init', '--project', target]);
    await mkdir(path.join(target, 'docs', 'nested'), { recursive: true });
    await mkdir(path.join(target, '.github'), { recursive: true });
    await writeFile(path.join(target, 'AGENTS.md'), '# Local agents\n', 'utf8');
    await writeFile(path.join(target, 'CLAUDE.md'), '# Claude rules\n', 'utf8');
    await writeFile(path.join(target, '.github', 'copilot-instructions.md'), '# Copilot rules\n', 'utf8');
    await writeFile(path.join(target, 'docs', 'nested', 'project.md'), '# Project docs\n', 'utf8');

    const preview = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);

    assert.equal(preview.backupActions.some((item) => item.source === 'AGENTS.md'), true);
    assert.equal(preview.backupActions.some((item) => item.source === 'CLAUDE.md'), true);
    assert.equal(preview.backupActions.some((item) => item.source === '.github/copilot-instructions.md'), true);
    assert.equal(preview.backupActions.some((item) => item.source === 'docs/nested/project.md'), true);
    assert.equal(await exists(path.join(target, '.agents', 'backup')), false);

    const first = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--write',
    ]);
    assert.match(first.baselineId, /^\d{8}T\d{6}\d{3}Z$/u);
    const baselineDir = path.join(target, '.agents', 'backup', first.baselineId);
    const manifest = JSON.parse(await readFile(path.join(baselineDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.some((item) => item.source === 'docs/nested/project.md'), true);
    assert.equal(
      await readFile(path.join(baselineDir, 'files', 'CLAUDE.md'), 'utf8'),
      '# Claude rules\n',
    );

    const stateAfterFirst = JSON.parse(await readFile(path.join(target, '.loopengine', 'install-state.json'), 'utf8'));
    const firstAgents = stateAfterFirst.files.find((item) => item.target === 'AGENTS.md');
    assert.equal(stateAfterFirst.baseline.id, first.baselineId);
    assert.equal(firstAgents.created, false);

    const second = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--write', '--upgrade',
    ]);
    const stateAfterSecond = JSON.parse(await readFile(path.join(target, '.loopengine', 'install-state.json'), 'utf8'));
    assert.equal(second.baselineId, first.baselineId);
    assert.equal(stateAfterSecond.files.find((item) => item.target === 'AGENTS.md').created, false);
    const repeatedRule = stateAfterSecond.files.find((item) => item.target === 'docs/rules/git-rules.md');
    assert.equal(repeatedRule.originalCreated, true);
    assert.equal(repeatedRule.originalBackup, null);
    assert.match(repeatedRule.backup, /^\.loopengine\/backups\//u);
    assert.deepEqual(await readdir(path.join(target, '.agents', 'backup')), [first.baselineId]);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('baseline backup failure happens before any install target is changed', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-install-baseline-failure-'));
  try {
    await runCli(['init', '--project', target]);
    await mkdir(path.join(target, '.agents'), { recursive: true });
    await writeFile(path.join(target, '.agents', 'backup'), 'blocks baseline directory\n', 'utf8');
    await writeFile(path.join(target, 'AGENTS.md'), '# Original agents\n', 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write',
      ], { cwd: rootDir }),
    );

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), '# Original agents\n');
    assert.equal(await exists(path.join(target, 'docs', 'rules', 'governance-core.md')), false);
    assert.equal(await exists(path.join(target, '.loopengine', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
