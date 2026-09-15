import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyInstallPlan, createInstallPlan, diffTargetInstall } from '../scripts/lib/install-planner.js';
import { checkSelfInstallConformance } from '../scripts/lib/self-install-check.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('the pack repository is conformant with its own installed copy', async () => {
  const report = await checkSelfInstallConformance(rootDir);

  assert.equal(report.skipped, false);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.orphanedStateTargets, []);
  assert.deepEqual(report.staleProjections, []);
  assert.equal(report.ok, true);
  assert.deepEqual(report.targets, ['codex']);
});

test('self-install conformance fails when the installed copy is absent', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-self-install-'));
  try {
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await cp(path.join(rootDir, 'vibe-harness.config.json'), path.join(target, 'vibe-harness.config.json'));
    await cp(
      path.join(rootDir, '.vibe-harness/install-state.json'),
      path.join(target, '.vibe-harness/install-state.json'),
    );

    const report = await checkSelfInstallConformance(rootDir, { targetDir: target });

    assert.equal(report.ok, false);
    assert.ok(report.missing.includes('AGENTS.md'));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project-owned memory targets are seeded once and never reported as drift', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-project-owned-'));
  const decisionsPath = path.join(target, 'docs/memory/DECISIONS.md');
  const projectDecisions = '# 决策索引\n\n- **ADR-0001** 项目自有决策 - accepted - 由项目维护\n';
  const options = {
    adapterId: 'codex',
    allowPreview: true,
    profile: 'full',
    requestedModules: ['memory'],
    rootDir,
    targetDir: target,
  };
  try {
    await mkdir(path.dirname(decisionsPath), { recursive: true });
    await writeFile(decisionsPath, projectDecisions, 'utf8');

    const diff = await diffTargetInstall({ ...options, dryRun: true });
    assert.equal(diff.changed.some((item) => item.target === 'docs/memory/DECISIONS.md'), false);
    assert.equal(diff.same.some((item) => item.target === 'docs/memory/DECISIONS.md'), true);

    const plan = await createInstallPlan({ ...options, dryRun: false, force: true });
    const action = plan.actions.find((item) => item.relativeTarget === 'docs/memory/DECISIONS.md');
    assert.equal(action.projectOwned, true);
    await applyInstallPlan(plan);
    assert.equal(await readFile(decisionsPath, 'utf8'), projectDecisions);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('a registration whose target is gone and unplanned is reported as an orphan', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-orphan-'));
  try {
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await cp(path.join(rootDir, 'vibe-harness.config.json'), path.join(target, 'vibe-harness.config.json'));
    const state = JSON.parse(await readFile(path.join(rootDir, '.vibe-harness/install-state.json'), 'utf8'));
    // Clone a real entry so the schema stays satisfied, then point it at a
    // target this pack does not ship and that is absent from the project.
    const template = state.files.find((file) => file.group === 'rules-minimal');
    const stale = { ...template, target: 'docs/rules/retired-example.md', source: 'docs/rules/retired-example.md' };
    await writeFile(
      path.join(target, '.vibe-harness/install-state.json'),
      JSON.stringify({ ...state, files: [...state.files, stale] }, null, 2),
      'utf8',
    );

    const report = await checkSelfInstallConformance(rootDir, { targetDir: target });

    assert.deepEqual(report.orphanedStateTargets, ['docs/rules/retired-example.md']);
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install releases an orphaned registration instead of carrying it forward', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-orphan-release-'));
  try {
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await cp(path.join(rootDir, 'vibe-harness.config.json'), path.join(target, 'vibe-harness.config.json'));
    const state = JSON.parse(await readFile(path.join(rootDir, '.vibe-harness/install-state.json'), 'utf8'));
    const template = state.files.find((file) => file.group === 'rules-minimal');
    const stale = { ...template, target: 'docs/rules/retired-example.md', source: 'docs/rules/retired-example.md' };
    await writeFile(
      path.join(target, '.vibe-harness/install-state.json'),
      JSON.stringify({ ...state, files: [...state.files, stale] }, null, 2),
      'utf8',
    );

    const options = {
      adapterId: 'codex',
      allowPreview: true,
      profile: 'minimal',
      requestedModules: ['rules'],
      rootDir,
      targetDir: target,
    };
    // An unplanned registration whose file is still on disk is a kept
    // installation, not an orphan: only the already-missing one is released.
    await mkdir(path.join(target, '.agents/skills/agentmemory'), { recursive: true });
    await writeFile(path.join(target, '.agents/skills/agentmemory/SKILL.md'), '# agentmemory\n', 'utf8');
    const plan = await createInstallPlan({ ...options, dryRun: false, force: true, redZoneConfirmed: true });
    const released = plan.actions.filter((action) => action.kind === 'retire-missing').map((action) => action.relativeTarget);
    assert.equal(released.includes('docs/rules/retired-example.md'), true);
    assert.equal(released.includes('.agents/skills/agentmemory/SKILL.md'), false);

    await applyInstallPlan(plan);

    const written = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.equal(written.files.some((file) => file.target === 'docs/rules/retired-example.md'), false);
    assert.equal(written.files.some((file) => file.target === '.agents/skills/agentmemory/SKILL.md'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('self-referential install entries are not drift', async () => {
  // docs/rules/project-specific-rules.md is both source and target in the pack
  // repository. Rendering its template placeholders changes the file, so a
  // rendered comparison would report permanent, unfixable drift.
  const report = await diffTargetInstall({
    adapterId: 'codex',
    allowPreview: true,
    managedAgentsBlock: true,
    profile: 'full',
    requestedModules: ['evals', 'memory', 'hooks'],
    requestedPlugins: [],
    rootDir,
    targetDir: rootDir,
  });

  assert.equal(report.changed.some((item) => item.target === 'docs/rules/project-specific-rules.md'), false);
  assert.equal(report.same.some((item) => item.target === 'docs/rules/project-specific-rules.md'), true);
});
