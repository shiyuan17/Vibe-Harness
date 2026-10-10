import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { applyInstallPlan, createInstallPlan, diffTargetInstall } from '../../scripts/lib/install-planner.js';
import { checkSelfInstallConformance } from '../../scripts/lib/self-install-check.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
const packConfigPath = path.join(rootDir, 'vibe-harness.config.json');

// Conformance compares a real installed copy against the pack. The pack
// repository's own `.vibe-harness/` state is gitignored, so a clean checkout has
// nothing to compare against and reading a developer's local state would make
// the suite machine-dependent; every case installs the pack into a temporary
// project through the real CLI instead.
async function installPackIntoTemporaryProject({ modules, profile } = {}) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-self-install-'));
  const config = JSON.parse(await readFile(packConfigPath, 'utf8'));
  if (profile) config.profile = profile;
  if (modules) config.modules = modules;
  await writeFile(path.join(target, 'vibe-harness.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await execFileAsync(process.execPath, [
    cliPath,
    'install',
    '--project', target,
    '--target', 'codex',
    '--write',
    '--confirm-red-zone',
  ], { cwd: rootDir, windowsHide: true });
  return target;
}

async function readInstalledState(target) {
  return JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
}

// Conformance checks diff the full install plan, so they are I/O-bound and
// legitimately exceed the default test budget on slow filesystems.
test('装到干净项目后的自托管一致性检查为 clean', { timeout: 120000 }, async () => {
  const target = await installPackIntoTemporaryProject();
  try {
    const report = await checkSelfInstallConformance(rootDir, { targetDir: target });

    assert.equal(report.skipped, false);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.orphanedStateTargets, []);
    assert.deepEqual(report.staleProjections, []);
    assert.equal(report.ok, true);
    assert.deepEqual(report.targets, ['codex']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('已安装副本缺文件时自托管一致性检查失败', async () => {
  const target = await installPackIntoTemporaryProject();
  try {
    await rm(path.join(target, 'AGENTS.md'), { force: true });

    const report = await checkSelfInstallConformance(rootDir, { targetDir: target });

    assert.equal(report.ok, false);
    assert.ok(report.missing.includes('AGENTS.md'));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project-owned memory targets are seeded once and never reported as drift', { timeout: 120000 }, async () => {
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

// The project-specific rules file is the one accepted home for local
// governance: it is rendered on first install, then owned by the project. A
// project that records its own overrides there must never be blocked by the
// fail-closed upgrade guard, or the only way to keep local policy would be to
// stop upgrading.
test('project-specific rules are a project-owned seed, so local governance never blocks an upgrade', { timeout: 120000 }, async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-rules-seed-'));
  const rulesPath = path.join(target, 'docs/rules/project-specific-rules.md');
  const localRules = '# 项目专属规则\n\n## 本地治理条款\n\n- Pack 默认 / 本项目取值 / 依据与证据\n';
  const options = {
    adapterId: 'codex',
    allowPreview: true,
    profile: 'full',
    requestedModules: ['rules'],
    rootDir,
    targetDir: target,
  };
  try {
    await mkdir(path.dirname(rulesPath), { recursive: true });
    await writeFile(rulesPath, localRules, 'utf8');

    const diff = await diffTargetInstall({ ...options, dryRun: true });
    assert.equal(diff.changed.some((item) => item.target === 'docs/rules/project-specific-rules.md'), false);
    assert.equal(diff.same.some((item) => item.target === 'docs/rules/project-specific-rules.md'), true);

    const plan = await createInstallPlan({ ...options, dryRun: false, force: true });
    const action = plan.actions.find((item) => item.relativeTarget === 'docs/rules/project-specific-rules.md');
    assert.equal(action.projectOwned, true);
    await applyInstallPlan(plan);
    assert.equal(await readFile(rulesPath, 'utf8'), localRules);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('目标已消失且不在安装计划内的登记被报告为孤儿', async () => {
  const target = await installPackIntoTemporaryProject();
  try {
    const state = await readInstalledState(target);
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
    assert.deepEqual(report.missing, []);
    assert.equal(report.ok, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('安装释放孤儿登记而不把它带到下一次安装', async () => {
  const target = await installPackIntoTemporaryProject();
  try {
    const state = await readInstalledState(target);
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

    // The CLI confirms red zone explicitly before applying; a full install
    // leaves red-zone registrations that this minimal plan keeps.
    plan.redZoneConfirmed = true;
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
