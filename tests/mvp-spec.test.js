import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('init --project writes the MVP loopengine.config.json defaults', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-init-'));
  try {
    await runCli(['init', '--project', target]);

    const config = JSON.parse(await readFile(path.join(target, 'loopengine.config.json'), 'utf8'));
    assert.equal(config.projectName, path.basename(target));
    assert.equal(config.language, 'zh-CN');
    assert.equal(config.packageManager, 'pnpm');
    assert.equal(config.target, 'codex');
    assert.equal(config.profile, 'core');
    assert.equal(config.validationCommands.governance, 'pnpm run check:governance');
    assert.deepEqual(config.crossRepo, { backendRepo: '', enabled: false });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP dry-run uses --project for path and --target codex for adapter without writing AGENTS.md', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-dryrun-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    const report = await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'minimal',
      '--dry-run',
    ]);

    assert.equal(report.target, 'codex');
    assert.equal(report.profile, 'minimal');
    assert.equal(report.dryRun, true);
    assert.equal(report.targetDir, path.resolve(target));
    assert.equal(report.previewFiles.some((file) => file.target === 'AGENTS.md'), true);
    assert.equal(report.previewFiles.find((file) => file.target === 'AGENTS.md').content.includes(path.basename(target)), true);
    assert.equal(await exists(path.join(target, 'AGENTS.md')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP --write backs up an existing AGENTS.md before installing rendered content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-write-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(path.join(target, 'AGENTS.md'), 'local agents\n', 'utf8');

    const report = await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--write',
    ]);

    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.equal(report.written.some((file) => file.endsWith('AGENTS.md')), true);
    assert.equal(agents.includes('LoopEngine'), true);
    assert.equal(agents.includes(path.basename(target)), true);
    assert.equal(await exists(path.join(target, '.loopengine/backups')), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate --project rejects invalid config and forbidden generated output terms', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-invalid-config-'));
  try {
    await writeFile(
      path.join(target, 'loopengine.config.json'),
      JSON.stringify({ projectName: 'SYBaseProjectWeb', target: 'codex', profile: 'core' }),
      'utf8',
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /forbidden term/i,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
