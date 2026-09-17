import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { applyInstallPlan, createInstallPlan, createMultiTargetInstallPlan } from '../../scripts/lib/install-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');

test('dry-run install plans full files without writing them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-dry-run-'));
  try {
    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'full',
      rootDir,
      targetDir: target,
    });

    assert.equal(plan.profile, 'full');
    assert.equal(plan.dryRun, true);
    assert.ok(plan.actions.some((action) => action.target.endsWith('AGENTS.md')));
    assert.ok(plan.actions.some((action) => action.target.endsWith(path.join('docs', 'rules', 'governance-core.md'))));
    assert.ok(plan.actions.some((action) => action.redZone === true));

    const result = await applyInstallPlan(plan);
    assert.equal(result.written.length, 0);

    await assert.rejects(readFile(path.join(target, 'AGENTS.md'), 'utf8'), /ENOENT/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install refuses to overwrite existing files unless force is used', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });

    const conflict = plan.actions.find((action) => action.target.endsWith('AGENTS.md'));
    assert.equal(conflict.kind, 'conflict');
    await assert.rejects(applyInstallPlan(plan), /Refusing to overwrite/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('dry-run reports conflicts without failing or writing files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-dry-run-conflict-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');

    const plan = await createInstallPlan({
      dryRun: true,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });
    const result = await applyInstallPlan(plan);

    assert.equal(plan.actions.find((action) => action.relativeTarget === 'AGENTS.md').kind, 'conflict');
    assert.deepEqual(result.written, []);
    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'user-owned content\n');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('actual install blocks red-zone files without explicit confirmation', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-redzone-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'full',
      rootDir,
      targetDir: target,
    });

    assert.ok(plan.actions.some((action) => action.redZone === true));
    await assert.rejects(applyInstallPlan(plan), /red-zone/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('actual install refuses to write outside the target directory', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-escape-'));
  try {
    const plan = await createInstallPlan({
      dryRun: false,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });
    const agents = plan.actions.find((action) => action.relativeTarget === 'AGENTS.md');
    agents.relativeTarget = '../escape.md';
    agents.target = path.resolve(target, '../escape.md');

    await assert.rejects(applyInstallPlan(plan), /outside target directory|portable relative path/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('failed install rolls back every file before install state is committed', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-transaction-failure-'));
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'user-owned content\n', 'utf8');
    const plan = await createInstallPlan({
      dryRun: false,
      force: true,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });

    await assert.rejects(
      applyInstallPlan(plan, {
        afterFileWrite() {
          throw new Error('injected install failure');
        },
      }),
      /injected install failure/,
    );

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'user-owned content\n');
    await assert.rejects(readFile(path.join(target, 'docs/rules/governance-core.md'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'), /ENOENT/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('multi-target install rolls back every projection and config migration as one transaction', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-multi-transaction-failure-'));
  const configPath = path.join(target, 'vibe-harness.config.json');
  const legacyConfig = JSON.stringify({ profile: 'core', target: 'codex' }, null, 2) + '\n';
  try {
    await writeFile(path.join(target, 'AGENTS.md'), 'local agents\n', 'utf8');
    await writeFile(path.join(target, 'CLAUDE.md'), 'local claude\n', 'utf8');
    await writeFile(configPath, legacyConfig, 'utf8');
    const plan = await createMultiTargetInstallPlan({
      configUpdate: {
        config: { profile: 'core', targets: ['codex', 'claude'] },
        path: configPath,
      },
      dryRun: false,
      force: true,
      managedAgentsBlock: true,
      profile: 'core',
      rootDir,
      selectedTargets: ['codex', 'claude'],
      targetDir: target,
      targets: ['codex', 'claude'],
    });

    await assert.rejects(
      applyInstallPlan(plan, {
        afterFileWrite({ action }) {
          if (action.relativeTarget === 'CLAUDE.md') throw new Error('injected projection failure');
        },
      }),
      /injected projection failure/u,
    );

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), 'local agents\n');
    assert.equal(await readFile(path.join(target, 'CLAUDE.md'), 'utf8'), 'local claude\n');
    assert.equal(await readFile(configPath, 'utf8'), legacyConfig);
    await assert.rejects(readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI write mode writes files when red-zone confirmation is explicit', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-apply-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'full']);
    await execFileAsync(process.execPath, [
      cliPath,
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'full',
      '--write',
      '--confirm-red-zone',
      '--allow-degraded',
    ]);

    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');
    const deliveryTemplate = await readFile(path.join(target, 'docs/templates/delivery.md'), 'utf8');
    const clarifySkill = await readFile(path.join(target, '.agents/skills/clarify-requirements/SKILL.md'), 'utf8');

    assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8').then((content) => content.includes('## 启动')), true);
    assert.equal(await readFile(path.join(target, '.codex/hooks.json'), 'utf8').then((content) => content.includes('hooks')), true);
    assert.equal(taskTemplate.includes('档位：'), true);
    assert.equal(deliveryTemplate.includes('实际变更'), true);
    assert.equal(deliveryTemplate.includes('本轮验证'), true);
    assert.equal(clarifySkill.includes('澄清关键需求'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI write mode installs localized en-US templates when language is en-US', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-enus-'));
  try {
    const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'full']);
    // init defaults to zh-CN; switch to en-US before installing so the
    // sourceForEntry localization picks the .en-US.md template sources.
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.language = 'en-US';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await execFileAsync(process.execPath, [
      cliPath,
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'full',
      '--write',
      '--confirm-red-zone',
      '--allow-degraded',
    ]);

    const deliveryTemplate = await readFile(path.join(target, 'docs/templates/delivery.md'), 'utf8');
    const taskTemplate = await readFile(path.join(target, 'docs/templates/task.md'), 'utf8');
    assert.equal(deliveryTemplate.includes('Actual changes'), true);
    assert.equal(deliveryTemplate.includes('Verification performed this run'), true);
    assert.equal(taskTemplate.includes('档位：'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

const tierScripts = {
  lint: 'oxlint .',
  'test:unit': 'vitest run',
  'test:integration': 'vitest run --dir tests/integration',
  'test:e2e': 'playwright test',
};

async function legacyTierProject({ tiers } = {}) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tier-migration-'));
  await writeFile(
    path.join(target, 'package.json'),
    `${JSON.stringify({ packageManager: 'pnpm@10.33.0', scripts: tierScripts }, null, 2)}\n`,
    'utf8',
  );
  const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
  await execFileAsync(process.execPath, [cliPath, 'init', '--project', target, '--target', 'codex', '--profile', 'core']);
  // A config written before the tiers existed has no `tiers` key; that is the
  // upgrade surface, so the fixture drops it (or seeds a partial one).
  const configPath = path.join(target, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.validationCommands.tiers;
  if (tiers) config.validationCommands.tiers = tiers;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { configPath, cliPath, target };
}

async function readConfig(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

test('install --upgrade 预演报告将要补充的层键且不写入', async () => {
  const { cliPath, configPath, target } = await legacyTierProject();
  try {
    const before = await readFile(configPath, 'utf8');
    const plan = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--upgrade', '--dry-run',
    ]);
    const report = JSON.parse(plan.stdout);

    assert.equal(report.dryRun, true);
    assert.equal(report.configUpdate.relativeTarget, 'vibe-harness.config.json');
    assert.deepEqual(report.configUpdate.addedTiers, ['quick', 'standard', 'deep']);
    assert.deepEqual(report.configUpdate.tiers, {
      quick: ['pnpm lint', 'pnpm test:unit'],
      standard: ['pnpm test:integration'],
      deep: ['pnpm test:e2e'],
    });
    assert.equal(await readFile(configPath, 'utf8'), before);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install --upgrade 未经红区确认拒绝写回分层配置', async () => {
  const { cliPath, configPath, target } = await legacyTierProject();
  try {
    const before = await readFile(configPath, 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--upgrade', '--write', '--allow-degraded',
      ]),
      /validationCommands\.tiers.*confirm-red-zone/u,
    );
    assert.equal(await readFile(configPath, 'utf8'), before);
    assert.equal(Object.hasOwn((await readConfig(configPath)).validationCommands, 'tiers'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install --upgrade --write 只补充缺失的层键', async () => {
  const { cliPath, configPath, target } = await legacyTierProject({ tiers: { quick: [] } });
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--upgrade',
      '--write',
      '--confirm-red-zone',
      '--allow-degraded',
    ]);
    const config = await readConfig(configPath);

    // The empty array is a deliberate "disabled" statement, so the migration
    // must keep it while filling the two absent keys.
    assert.deepEqual(config.validationCommands.tiers, {
      quick: [],
      standard: ['pnpm test:integration'],
      deep: ['pnpm test:e2e'],
    });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install --upgrade 不改动已完整声明的分层配置', async () => {
  const declared = { quick: ['pnpm lint:project'], standard: [], deep: [] };
  const { cliPath, configPath, target } = await legacyTierProject({ tiers: declared });
  try {
    const result = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--upgrade', '--dry-run',
    ]);
    const report = JSON.parse(result.stdout);

    assert.equal(report.configUpdate, null);
    assert.deepEqual((await readConfig(configPath)).validationCommands.tiers, declared);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
