import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createDefaultProjectConfig } from '../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cognisCli = path.join(rootDir, 'scripts/cognis.js');
const legacyCli = path.join(rootDir, 'scripts/loopengine.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function seedLegacyProject(target, governance = 'node .agents/loopengine/governance/validate.mjs') {
  const config = createDefaultProjectConfig(target);
  config.validationCommands.governance = governance;
  await writeFile(
    path.join(target, 'loopengine.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  await mkdir(path.join(target, '.loopengine'));
  await writeFile(
    path.join(target, '.loopengine', 'install-state.json'),
    `${JSON.stringify({ adapter: 'codex', files: [], profile: 'core', stateVersion: 3, version: '0.4.0' })}\n`,
    'utf8',
  );
}

async function seedLegacyManagedAssets(target, targets) {
  const statePath = path.join(target, '.loopengine', 'install-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const [index, relativeTarget] of targets.entries()) {
    const content = `legacy managed asset ${index}\n`;
    const targetPath = path.join(target, relativeTarget);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    const targetHash = createHash('sha256').update(content).digest('hex');
    state.files.push({
      backup: null,
      created: true,
      group: 'legacy-brand',
      previousHash: null,
      redZone: false,
      source: `legacy/${index}`,
      sourceHash: targetHash,
      target: relativeTarget,
      targetHash,
    });
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

test('Cognis CLI init writes canonical configuration and machine-readable stdout', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-init-'));
  try {
    const result = await execFileAsync(process.execPath, [cognisCli, 'init', '--project', target]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.path, path.join(target, 'cognis.config.json'));
    assert.equal(result.stderr, '');
    const config = JSON.parse(await readFile(report.path, 'utf8'));
    assert.equal(config.validationCommands.governance, 'node .agents/cognis/governance/validate.mjs');
    assert.equal(config.governance.workflow, 'adaptive');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('init accepts an explicit strict workflow and rejects unknown workflows', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-workflow-'));
  try {
    await execFileAsync(process.execPath, [cognisCli, 'init', '--project', target, '--workflow', 'strict']);
    const config = JSON.parse(await readFile(path.join(target, 'cognis.config.json'), 'utf8'));
    assert.equal(config.governance.workflow, 'strict');
    await assert.rejects(
      execFileAsync(process.execPath, [cognisCli, 'init', '--project', `${target}-bad`, '--workflow', 'unknown']),
      /governance\.workflow/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
    await rm(`${target}-bad`, { force: true, recursive: true });
  }
});

test('upgrade writes strict for an existing canonical config without workflow while dry-run does not mutate it', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-workflow-upgrade-'));
  try {
    const config = createDefaultProjectConfig(target);
    delete config.governance.workflow;
    const configPath = path.join(target, 'cognis.config.json');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const preview = JSON.parse((await execFileAsync(process.execPath, [
      cognisCli, 'install', '--project', target, '--profile', 'core', '--upgrade', '--dry-run',
    ])).stdout);
    assert.equal(preview.governanceWorkflow, 'strict');
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).governance.workflow, undefined);

    await execFileAsync(process.execPath, [
      cognisCli, 'install', '--project', target, '--profile', 'core', '--upgrade', '--write',
    ]);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).governance.workflow, 'strict');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('legacy CLI alias preserves JSON stdout and emits deprecation only on stderr', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-legacy-'));
  try {
    const result = await execFileAsync(process.execPath, [legacyCli, 'init', '--project', target]);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /loopengine.*deprecated.*cognis/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('legacy product environment variables warn on stderr without corrupting JSON stdout', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-legacy-env-'));
  try {
    const env = { ...process.env, LOOPENGINE_TOOL_TIMEOUT_MS: '1000' };
    delete env.COGNIS_TOOL_TIMEOUT_MS;
    const result = await execFileAsync(process.execPath, [cognisCli, 'init', '--project', target], { env });
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /LOOPENGINE_TOOL_TIMEOUT_MS.*deprecated.*COGNIS_TOOL_TIMEOUT_MS/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('legacy configuration requires explicit upgrade before install', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-required-'));
  try {
    const config = createDefaultProjectConfig(target);
    config.validationCommands.governance = 'node .agents/loopengine/governance/validate.mjs';
    await writeFile(
      path.join(target, 'loopengine.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cognisCli, 'install', '--project', target, '--dry-run']),
      (error) => {
        const report = JSON.parse(error.stderr);
        return report.error?.code === 'COGNIS_CONFIG_MIGRATION_REQUIRED';
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('pre-v4 install state requires explicit upgrade even with canonical configuration', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-state-upgrade-required-'));
  try {
    await seedLegacyProject(target);
    const legacyConfig = await readFile(path.join(target, 'loopengine.config.json'), 'utf8');
    await writeFile(path.join(target, 'cognis.config.json'), legacyConfig, 'utf8');
    await rm(path.join(target, 'loopengine.config.json'));

    await assert.rejects(
      execFileAsync(process.execPath, [cognisCli, 'install', '--project', target, '--dry-run']),
      (error) => JSON.parse(error.stderr).error?.code === 'COGNIS_STATE_MIGRATION_REQUIRED',
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('upgrade transactionally migrates a legacy project configuration and rollback restores it', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-'));
  try {
    await seedLegacyProject(target);
    const preview = await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--dry-run',
      '--upgrade',
    ]);
    const previewReport = JSON.parse(preview.stdout);
    assert.deepEqual(previewReport.configMigration, {
      dryRun: true,
      from: 'loopengine.config.json',
      to: 'cognis.config.json',
    });
    assert.equal(await exists(path.join(target, 'cognis.config.json')), false);
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), true);

    await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--write',
      '--upgrade',
    ], { maxBuffer: 1024 * 1024 * 8 });

    const migrated = JSON.parse(await readFile(path.join(target, 'cognis.config.json'), 'utf8'));
    assert.equal(migrated.validationCommands.governance, 'node .agents/cognis/governance/validate.mjs');
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), false);
    const state = JSON.parse(await readFile(path.join(target, '.loopengine', 'install-state.json'), 'utf8'));
    assert.equal(state.stateVersion, 4);
    assert.equal(state.storageNamespace, 'loopengine');

    await execFileAsync(process.execPath, [cognisCli, 'rollback', '--project', target, '--write']);
    const restored = JSON.parse(await readFile(path.join(target, 'loopengine.config.json'), 'utf8'));
    assert.equal(restored.validationCommands.governance, 'node .agents/loopengine/governance/validate.mjs');
    assert.equal(await exists(path.join(target, 'cognis.config.json')), false);
    assert.equal(await exists(path.join(target, '.loopengine', 'install-state.json')), false);
    assert.equal(await exists(path.join(target, '.loopengine', 'transaction.lock')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('uninstall preserves the canonical user configuration after a legacy upgrade', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-uninstall-'));
  try {
    await seedLegacyProject(target);
    await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--write',
      '--upgrade',
    ], { maxBuffer: 1024 * 1024 * 8 });
    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.projectName = 'User-owned Cognis config';
    const expected = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, expected, 'utf8');

    await execFileAsync(process.execPath, [cognisCli, 'uninstall', '--project', target, '--write']);

    assert.equal(await readFile(configPath, 'utf8'), expected);
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), false);
    assert.equal(await exists(path.join(target, '.loopengine', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rollback does not overwrite a canonical configuration modified after migration', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-modified-'));
  try {
    await seedLegacyProject(target);
    await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--write',
      '--upgrade',
    ], { maxBuffer: 1024 * 1024 * 8 });
    const configPath = path.join(target, 'cognis.config.json');
    const modified = '{"projectName":"modified after upgrade"}\n';
    await writeFile(configPath, modified, 'utf8');

    const rollback = await execFileAsync(process.execPath, [cognisCli, 'rollback', '--project', target, '--write']);
    const report = JSON.parse(rollback.stdout);

    assert.deepEqual(report.skipped.find((item) => item.target === 'cognis.config.json'), {
      reason: 'target-modified',
      target: 'cognis.config.json',
    });
    assert.equal(await readFile(configPath, 'utf8'), modified);
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), false);
    assert.equal(await exists(path.join(target, '.loopengine', 'install-state.json')), true);
    assert.equal(report.retainedState, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('upgrade retires tracked legacy branded assets and rollback restores them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-assets-'));
  const legacyTargets = [
    '.agents/loopengine/governance/validate.mjs',
    '.agents/loopengine/evals/run.mjs',
    '.agents/skills/using-loopengine/SKILL.md',
    '.agents/evals/suites/loopengine-core.json',
    '.agents/evals/references/loopengine-core.offline.json',
  ];
  try {
    await seedLegacyProject(target);
    await seedLegacyManagedAssets(target, legacyTargets);

    const preview = await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--dry-run',
      '--upgrade',
    ]);
    const previewReport = JSON.parse(preview.stdout);
    assert.deepEqual(
      previewReport.actions.filter((action) => action.kind === 'retire').map((action) => action.relativeTarget).sort(),
      legacyTargets.slice().sort(),
    );

    await execFileAsync(process.execPath, [
      cognisCli,
      'install',
      '--project', target,
      '--target', 'codex',
      '--profile', 'core',
      '--write',
      '--upgrade',
    ], { maxBuffer: 1024 * 1024 * 8 });
    for (const relativeTarget of legacyTargets) {
      assert.equal(await exists(path.join(target, relativeTarget)), false);
    }
    assert.equal(await exists(path.join(target, '.agents/cognis/governance/validate.mjs')), true);
    assert.equal(await exists(path.join(target, '.agents/skills/clarify-requirements/SKILL.md')), true);
    assert.equal(await exists(path.join(target, '.agents/evals/suites/cognis-core.json')), true);

    await execFileAsync(process.execPath, [cognisCli, 'rollback', '--project', target, '--write']);
    for (const [index, relativeTarget] of legacyTargets.entries()) {
      assert.equal(await readFile(path.join(target, relativeTarget), 'utf8'), `legacy managed asset ${index}\n`);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('upgrade rejects custom commands that still reference the legacy runtime path', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-cli-upgrade-custom-'));
  try {
    await seedLegacyProject(target, 'node .agents/loopengine/custom/verify.mjs');
    await assert.rejects(
      execFileAsync(process.execPath, [
        cognisCli,
        'install',
        '--project', target,
        '--dry-run',
        '--upgrade',
      ]),
      (error) => JSON.parse(error.stderr).error?.code === 'COGNIS_CONFIG_MIGRATION_REQUIRED',
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
