import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeMicroChecks, normalizeValidationChecks } from '../../scripts/lib/verification-contract.js';
import { dependencyFingerprint } from '../../runtime/lib/verification-inputs.mjs';
import { buildDeliveryVerificationPlan } from '../../runtime/lib/verification-risk.mjs';

test('structured Micro declarations normalize with safe defaults', () => {
  const [check] = normalizeMicroChecks([{
    id: 'normalize',
    kind: 'pure',
    entry: 'scripts/probes/normalize.mjs',
    args: { value: 'x' },
  }]);
  assert.equal(check.kind, 'pure');
  assert.equal(check.entry, 'scripts/probes/normalize.mjs');
  assert.deepEqual(check.expectedExitCodes, [0]);
  assert.equal(check.network, 'deny');
  assert.equal(check.workspaceWrite, 'deny');
  assert.deepEqual(check.allowedEnv, []);
  assert.equal(check.legacy, false);
});

test('structured Micro declarations reject absolute and unsafe entries', () => {
  assert.throws(() => normalizeMicroChecks([{
    id: 'bad', kind: 'module', entry: 'C:/tmp/probe.mjs',
  }]), /project-relative/u);
  assert.throws(() => normalizeMicroChecks([{
    id: 'bad', kind: 'module', entry: '../probe.mjs',
  }]), /project-relative/u);
});

test('parallel validation requires explicit resources and survives normalization', () => {
  const check = { id: 'test', command: 'node check.mjs', parallel: true };
  assert.throws(() => normalizeValidationChecks([check]), /named resources/u);
  assert.equal(normalizeValidationChecks([{ ...check, resources: ['test-db'] }])[0].parallel, true);
  assert.throws(() => normalizeValidationChecks([{ ...check, parallel: 'yes' }]), /boolean/u);
});

test('dependency snapshots stream and deduplicate real targets but rescan later snapshots', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'dependency-merkle-'));
  try {
    const shared = path.join(project, 'shared');
    const modules = path.join(project, 'node_modules');
    await mkdir(shared);
    await mkdir(modules);
    await writeFile(path.join(shared, 'value.js'), 'a'.repeat(150000));
    await symlink(shared, path.join(modules, 'one'), 'junction');
    await symlink(shared, path.join(modules, 'two'), 'junction');
    const before = dependencyFingerprint(project);
    assert.equal(before.available, true);
    assert.equal(before.files, 1);
    assert.equal(before.bytes, 150000);
    assert.equal(before.memoHits, 1);
    assert.equal(dependencyFingerprint(project).fingerprint, before.fingerprint);
    await writeFile(path.join(shared, 'value.js'), 'b'.repeat(150000));
    const after = dependencyFingerprint(project);
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(after.bytes, 150000);
    // Cycles must terminate and must not memoize an ancestor-dependent subtree.
    await symlink(modules, path.join(shared, 'cycle'), 'junction');
    assert.equal(dependencyFingerprint(project).available, true);
    assert.equal(dependencyFingerprint(project, { worktree: { dependencyRoots: ['../outside'] } }).available, false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('风险必需证据可由覆盖者提供，显式 full 仍执行全部检查', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'risk-coverage-'));
  try {
    const config = { validationCommands: {
      tiers: { quick: ['node changed.mjs', 'node full.mjs'], standard: [], deep: [] },
      checks: [{ id: 'changed', command: 'node changed.mjs' },
        { id: 'full', command: 'node full.mjs', subsumes: ['changed'] }],
    } };
    const plan = buildDeliveryVerificationPlan({ changedPaths: ['unknown.bin'], config, projectDir: project });
    assert.deepEqual(plan.selectedNames, ['full']);
    assert.equal(plan.subsumedChecks.find((check) => check.id === 'changed').subsumedBy, 'full');
    const full = buildDeliveryVerificationPlan({ changedPaths: ['unknown.bin'], config, projectDir: project, full: true });
    assert.deepEqual(full.selectedNames, ['changed', 'full']);
    assert.deepEqual(full.subsumedChecks, []);
  } finally { await rm(project, { recursive: true, force: true }); }
});
