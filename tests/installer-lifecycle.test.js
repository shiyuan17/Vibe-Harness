import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args, options = {}) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    ...options,
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout ? JSON.parse(result.stdout) : null;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('apply install writes install state with hashes and red-zone metadata', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-state-'));
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']);

    const state = JSON.parse(await readFile(path.join(target, '.loopengine/install-state.json'), 'utf8'));
    const agents = state.files.find((file) => file.target === 'AGENTS.md');
    const hooks = state.files.find((file) => file.target === '.codex/hooks.json');

    const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
    assert.equal(state.version, pkg.version);
    assert.equal(state.profile, 'codex-internal');
    assert.equal(state.files.length > 0, true);
    assert.match(state.installedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(agents.source, 'adapters/codex/AGENTS.template.md');
    assert.match(agents.sourceHash, /^[a-f0-9]{64}$/);
    assert.match(agents.targetHash, /^[a-f0-9]{64}$/);
    assert.equal(hooks.redZone, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('diff reports missing, same, changed, red-zone, and unmanaged files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-diff-'));
  try {
    let report = await runCli(['diff', '--target', target, '--profile', 'codex-internal']);
    assert.ok(report.missing.some((item) => item.target === 'AGENTS.md'));
    assert.ok(report.redZone.some((item) => item.target === '.codex/hooks.json'));

    await runCli(['install', '--target', target, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']);
    await writeFile(path.join(target, 'local-only.md'), 'unmanaged\n', 'utf8');
    await writeFile(path.join(target, 'docs/templates/task.md'), 'user changed template\n', 'utf8');

    report = await runCli(['diff', '--target', target, '--profile', 'codex-internal']);
    assert.ok(report.same.some((item) => item.target === 'AGENTS.md'));
    assert.ok(report.changed.some((item) => item.target === 'docs/templates/task.md'));
    assert.ok(report.unmanaged.some((item) => item.target === 'local-only.md'));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('upgrade refuses user modified managed files unless force is used and force creates backup', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-upgrade-'));
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']);
    await writeFile(path.join(target, 'docs/templates/task.md'), 'user changed template\n', 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        'install',
        '--target',
        target,
        '--profile',
        'codex-internal',
        '--apply',
        '--upgrade',
        '--confirm-red-zone',
      ]),
      /Refusing to upgrade user-modified file/,
    );

    await runCli(['install', '--target', target, '--profile', 'codex-internal', '--apply', '--upgrade', '--force', '--confirm-red-zone']);

    const state = JSON.parse(await readFile(path.join(target, '.loopengine/install-state.json'), 'utf8'));
    const changedTemplate = state.files.find((file) => file.target === 'docs/templates/task.md');
    const backups = await readdir(path.join(target, '.loopengine/backups'));

    assert.equal(backups.length, 1);
    assert.ok(changedTemplate.backup);
    assert.equal(await readFile(path.join(target, changedTemplate.backup), 'utf8'), 'user changed template\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rollback defaults to dry-run and apply restores backups and removes safe created files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-rollback-'));
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-minimal', '--apply']);

    const preview = await runCli(['rollback', '--target', target]);
    assert.equal(preview.dryRun, true);
    assert.ok(preview.actions.some((action) => action.target === 'AGENTS.md' && action.kind === 'delete-created'));
    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8').then((content) => content.includes('## 启动')), true);

    await runCli(['rollback', '--target', target, '--apply']);
    await assert.rejects(readFile(path.join(target, 'AGENTS.md'), 'utf8'), /ENOENT/);
    assert.equal(await exists(path.join(target, '.loopengine/install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rollback does not overwrite user changes made after a forced install', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-rollback-modified-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'original local agents\n', 'utf8');
    await runCli(['install', '--target', target, '--profile', 'codex-minimal', '--apply', '--force']);
    await writeFile(path.join(target, 'AGENTS.md'), 'user changed after install\n', 'utf8');

    const result = await runCli(['rollback', '--target', target, '--apply']);

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'user changed after install\n');
    assert.ok(result.skipped.some((item) => item.target === 'AGENTS.md' && item.reason === 'target-modified'));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rollback blocks red-zone changes without explicit confirmation', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-rollback-redzone-'));
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'rollback', '--target', target, '--apply']),
      /red-zone/,
    );

    await runCli(['rollback', '--target', target, '--apply', '--confirm-red-zone']);
    await assert.rejects(readFile(path.join(target, '.codex/hooks.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rollback refuses install-state targets outside the project', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-rollback-escape-'));
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-minimal', '--apply']);
    const statePath = path.join(target, '.loopengine/install-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.files[0].target = '../escape.md';
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'rollback', '--target', target, '--apply']),
      /outside target directory|portable relative path/,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
