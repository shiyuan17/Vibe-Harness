import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverExecutables } from '../scripts/lib/executable-discovery.js';
import { runSkillsAudit, skillScanSummary } from '../scripts/lib/skills-audit.js';
import { scanWorkflowAssets } from '../scripts/lib/workflow-assets.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('executable discovery covers runtime and Skill scripts', async () => {
  const files = (await discoverExecutables(rootDir)).map((file) => path.relative(rootDir, file).replaceAll('\\', '/'));
  assert.equal(files.includes('runtime/hooks/lib/policy.mjs'), true);
  assert.equal(files.includes('runtime/evals/codex-runner.mjs'), true);
  assert.equal(files.includes('scripts/vibe-harness.js'), true);
  assert.equal(files.every((file) => /\.(?:cjs|js|mjs)$/u.test(file)), true);
});

test('executable discovery includes cjs and skips dependency directories', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-lint-discovery-'));
  try {
    await mkdir(path.join(target, 'runtime'), { recursive: true });
    await mkdir(path.join(target, 'node_modules', 'package'), { recursive: true });
    await writeFile(path.join(target, 'runtime', 'tool.cjs'), 'module.exports = {};\n', 'utf8');
    await writeFile(path.join(target, 'node_modules', 'package', 'ignored.js'), 'broken(', 'utf8');
    const files = await discoverExecutables(target);
    assert.deepEqual(files.map((file) => path.basename(file)), ['tool.cjs']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('workflow scan distinguishes clean from out-of-scope', async () => {
  const current = await scanWorkflowAssets(rootDir);
  assert.deepEqual(current, {
    findings: [],
    inventoryCount: 3,
    scannedCount: 3,
    status: 'clean',
  });

  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-workflow-scan-'));
  try {
    assert.deepEqual(await scanWorkflowAssets(target), {
      findings: [],
      inventoryCount: 0,
      scannedCount: 0,
      status: 'out-of-scope',
    });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('workflow scan reports malformed inventoried assets as findings', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-workflow-findings-'));
  try {
    const workflowDir = path.join(target, '.github', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, 'broken.yml'), 'name: Broken\n', 'utf8');
    const report = await scanWorkflowAssets(target);
    assert.equal(report.status, 'findings');
    assert.equal(report.inventoryCount, 1);
    assert.equal(report.scannedCount, 1);
    assert.equal(report.findings.length, 1);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('skill scan reports inventory and kind coverage separately from workflow assets', async () => {
  const report = skillScanSummary(await runSkillsAudit(rootDir));
  assert.equal(report.inventoryCount, 12);
  assert.equal(report.scannedCount, 12);
  assert.deepEqual(report.byKind, { native: 9, integration: 3, router: 0, compatibility: 0 });
  assert.equal(report.status, 'clean');
  assert.deepEqual(report.findings, []);
});
