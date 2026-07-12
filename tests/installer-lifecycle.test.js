import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args, options = {}) {
  const effectiveArgs = args[0] === 'install' && (args.includes('--apply') || args.includes('--write')) && !args.includes('--dry-run') && !args.includes('--allow-degraded')
    ? [...args, '--allow-degraded']
    : args;
  const result = await execFileAsync(process.execPath, [cliPath, ...effectiveArgs], {
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

const legacyMemoryOperations = ['handoff', 'recall', 'remember', 'forget', 'recap', 'session-history'];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function seedLegacyMemoryInstall(target, { modifiedOperation } = {}) {
  const files = [];
  for (const operation of legacyMemoryOperations) {
    const relativeTarget = `.agents/skills/${operation}/SKILL.md`;
    const content = `legacy ${operation}\n`;
    const targetPath = path.join(target, relativeTarget);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    files.push({
      backup: null,
      created: true,
      group: 'skills-memory',
      previousHash: null,
      redZone: false,
      source: `skills/integrations/agentmemory/${operation}/SKILL.md`,
      sourceHash: sha256(content),
      target: relativeTarget,
      targetHash: sha256(content),
    });
  }
  await mkdir(path.join(target, '.loopengine'), { recursive: true });
  await writeFile(path.join(target, '.loopengine/install-state.json'), `${JSON.stringify({
    files,
    generatedDirectories: [],
    installedAt: new Date().toISOString(),
    profile: 'full',
    version: '0.2.0',
  }, null, 2)}\n`, 'utf8');
  if (modifiedOperation) {
    await writeFile(
      path.join(target, `.agents/skills/${modifiedOperation}/SKILL.md`),
      `user modified ${modifiedOperation}\n`,
      'utf8',
    );
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

test('agentmemory upgrade dry-run retires only legacy entries tracked by install state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-agentmemory-retire-preview-'));
  try {
    await seedLegacyMemoryInstall(target);
    const preview = await runCli(['install', '--target', target, '--profile', 'full', '--dry-run', '--upgrade']);
    assert.deepEqual(
      preview.actions.filter((action) => action.kind === 'retire').map((action) => action.relativeTarget).sort(),
      legacyMemoryOperations.map((operation) => `.agents/skills/${operation}/SKILL.md`).sort(),
    );
    assert.equal(await exists(path.join(target, '.agents/skills/handoff/SKILL.md')), true);

    const untracked = await mkdtemp(path.join(tmpdir(), 'loopengine-agentmemory-untracked-'));
    try {
      const untrackedTarget = path.join(untracked, '.agents/skills/recall/SKILL.md');
      await mkdir(path.dirname(untrackedTarget), { recursive: true });
      await writeFile(untrackedTarget, 'user owned\n', 'utf8');
      const untrackedPreview = await runCli(['install', '--target', untracked, '--profile', 'full', '--dry-run', '--upgrade']);
      assert.equal(untrackedPreview.actions.some((action) => action.relativeTarget === '.agents/skills/recall/SKILL.md'), false);
    } finally {
      await rm(untracked, { force: true, recursive: true });
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('agentmemory upgrade preserves modified legacy entries and rollback restores retired entries', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-agentmemory-retire-'));
  try {
    await seedLegacyMemoryInstall(target, { modifiedOperation: 'recall' });
    const result = await runCli([
      'install', '--target', target, '--profile', 'full', '--apply', '--upgrade', '--confirm-red-zone',
    ]);

    assert.equal(result.retired.length, 5);
    assert.ok(result.skipped.some((item) => item.target === '.agents/skills/recall/SKILL.md' && item.reason === 'target-modified'));
    assert.equal(await exists(path.join(target, '.agents/skills/forget/SKILL.md')), false);
    assert.equal(await readFile(path.join(target, '.agents/skills/recall/SKILL.md'), 'utf8'), 'user modified recall\n');
    assert.equal(await exists(path.join(target, '.agents/skills/agentmemory/references/forget.md')), true);

    const state = JSON.parse(await readFile(path.join(target, '.loopengine/install-state.json'), 'utf8'));
    assert.equal(state.retiredFiles.length, 5);

    const recreated = path.join(target, '.agents/skills/handoff/SKILL.md');
    await mkdir(path.dirname(recreated), { recursive: true });
    await writeFile(recreated, 'recreated handoff\n', 'utf8');
    const rollback = await runCli(['rollback', '--target', target, '--apply', '--confirm-red-zone']);
    assert.ok(rollback.skipped.some((item) => item.target === '.agents/skills/handoff/SKILL.md' && item.reason === 'target-recreated'));
    assert.equal(await readFile(recreated, 'utf8'), 'recreated handoff\n');
    assert.equal(await readFile(path.join(target, '.agents/skills/forget/SKILL.md'), 'utf8'), 'legacy forget\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP write upgrade uses the same tracked agentmemory retirement lifecycle', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-agentmemory-mvp-retire-'));
  try {
    await seedLegacyMemoryInstall(target);
    await runCli(['init', '--project', target]);
    const result = await runCli([
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'full',
      '--write',
      '--upgrade',
      '--confirm-red-zone',
    ]);

    assert.equal(result.retired.length, 6);
    assert.equal(result.skipped.length, 0);
    assert.equal(await exists(path.join(target, '.agents/skills/handoff/SKILL.md')), false);
    assert.equal(await exists(path.join(target, '.agents/skills/agentmemory/references/handoff.md')), true);
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

test('reinstall refuses generated-file registrations outside the project', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-reinstall-generated-escape-'));
  const outside = path.join(path.dirname(target), `${path.basename(target)}-outside.txt`);
  try {
    await runCli(['install', '--target', target, '--profile', 'codex-minimal', '--apply']);
    await writeFile(outside, 'outside\n', 'utf8');
    const statePath = path.join(target, '.loopengine/install-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.generatedFiles = [{ target: `../${path.basename(outside)}`, targetHash: 'not-the-real-hash' }];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'install', '--target', target, '--profile', 'codex-minimal', '--apply', '--force']),
      /outside target directory|portable relative path/,
    );
    await assert.rejects(access(path.join(target, '.loopengine/backups')), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(outside, { force: true });
  }
});
