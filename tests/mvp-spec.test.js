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

async function initAndDryRunProfile(profile) {
  const target = await mkdtemp(path.join(tmpdir(), `loopengine-${profile}-profile-`));
  await runCli(['init', '--project', target]);
  const report = await runCli([
    'install',
    '--project',
    target,
    '--target',
    'codex',
    '--profile',
    profile,
    '--dry-run',
  ]);
  return { report, target };
}

function targetsFrom(report) {
  return report.actions.map((action) => action.relativeTarget).sort();
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

test('minimal profile excludes lifecycle, review, loop, and skills assets', async () => {
  const { report, target } = await initAndDryRunProfile('minimal');
  try {
    const targets = targetsFrom(report);

    assert.equal(targets.includes('AGENTS.md'), true);
    assert.equal(targets.includes('docs/rules/agent-collaboration.md'), true);
    assert.equal(targets.includes('docs/templates/workflow-packet.md'), true);
    assert.equal(targets.includes('docs/rules/task-lifecycle.md'), false);
    assert.equal(targets.includes('docs/rules/task-rules.md'), false);
    assert.equal(targets.includes('docs/rules/review-rules.md'), false);
    assert.equal(targets.includes('docs/rules/loop-engineering.md'), false);
    assert.equal(targets.includes('.agents/skills/loop-planning/SKILL.md'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('core profile includes lifecycle assets but excludes full review and loop assets', async () => {
  const { report, target } = await initAndDryRunProfile('core');
  try {
    const targets = targetsFrom(report);

    assert.equal(targets.includes('docs/rules/task-lifecycle.md'), true);
    assert.equal(targets.includes('docs/rules/task-rules.md'), true);
    assert.equal(targets.includes('docs/rules/skill-routing.md'), true);
    assert.equal(targets.includes('.agents/skills/task-intake/SKILL.md'), true);
    assert.equal(targets.includes('docs/workflows/full.md'), true);
    assert.equal(targets.includes('docs/rules/review-rules.md'), false);
    assert.equal(targets.includes('docs/rules/loop-engineering.md'), false);
    assert.equal(targets.includes('docs/workflows/review.md'), false);
    assert.equal(targets.includes('docs/workflows/loop.md'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full profile adds review and loop assets beyond core', async () => {
  const core = await initAndDryRunProfile('core');
  const full = await initAndDryRunProfile('full');
  try {
    const coreTargets = targetsFrom(core.report);
    const fullTargets = targetsFrom(full.report);

    assert.equal(fullTargets.length > coreTargets.length, true);
    assert.equal(fullTargets.includes('docs/rules/review-rules.md'), true);
    assert.equal(fullTargets.includes('docs/rules/loop-engineering.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/review-checklist/SKILL.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/loop-planning/SKILL.md'), true);
    assert.equal(fullTargets.includes('docs/workflows/review.md'), true);
    assert.equal(fullTargets.includes('docs/workflows/loop.md'), true);
  } finally {
    await rm(core.target, { force: true, recursive: true });
    await rm(full.target, { force: true, recursive: true });
  }
});

test('validate and install require init-generated loopengine.config.json', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-missing-config-'));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /loopengine\.config\.json/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        'install',
        '--project',
        target,
        '--target',
        'codex',
        '--profile',
        'core',
        '--dry-run',
      ]),
      /loopengine\.config\.json/,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rendered AGENTS surface matches minimal, core, full, and internal profile installs', async () => {
  const minimal = await initAndDryRunProfile('minimal');
  const core = await initAndDryRunProfile('core');
  const full = await initAndDryRunProfile('full');
  const internalTarget = await mkdtemp(path.join(tmpdir(), 'loopengine-internal-profile-'));

  try {
    const minimalAgents = minimal.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const coreAgents = core.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const fullAgents = full.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const internalReport = await runCli([
      'install',
      '--target',
      internalTarget,
      '--profile',
      'codex-internal',
      '--dry-run',
    ]);
    const internalAgents = internalReport.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(minimalAgents.includes('.agents/skills/'), false);
    assert.equal(minimalAgents.includes('.codex/hooks.json'), false);
    assert.equal(coreAgents.includes('.agents/skills/'), true);
    assert.equal(coreAgents.includes('.codex/hooks.json'), false);
    assert.equal(fullAgents.includes('.agents/skills/'), true);
    assert.equal(fullAgents.includes('.codex/hooks.json'), false);
    assert.equal(fullAgents.includes('review / loop'), true);
    assert.equal(internalAgents.includes('.agents/skills/'), true);
    assert.equal(internalAgents.includes('.codex/hooks.json'), true);
  } finally {
    await rm(minimal.target, { force: true, recursive: true });
    await rm(core.target, { force: true, recursive: true });
    await rm(full.target, { force: true, recursive: true });
    await rm(internalTarget, { force: true, recursive: true });
  }
});

test('validate --project catches generated AGENTS references that are not installed by the profile', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-mismatched-agents-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(
      path.join(target, 'loopengine.config.json'),
      JSON.stringify({
        projectName: path.basename(target),
        language: 'zh-CN',
        packageManager: 'pnpm',
        target: 'codex',
        profile: 'minimal',
        validationCommands: {
          lint: 'pnpm lint',
          typecheck: 'pnpm check:type',
          governance: 'pnpm run check:governance',
        },
        riskZones: {
          red: ['auth'],
          yellow: ['shared components'],
        },
        crossRepo: {
          enabled: false,
          backendRepo: '',
        },
        installedSurface: {
          skillsLine: '- Skills 位于 `.agents/skills/`。',
          hooksLine: '- Codex hook 配置位于 `.codex/hooks.json`。',
        },
      }),
      'utf8',
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /not installed by profile/i,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
