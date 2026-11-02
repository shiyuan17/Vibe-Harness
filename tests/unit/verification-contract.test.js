import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { normalizeMicroChecks, normalizeValidationChecks } from '../../scripts/lib/verification-contract.js';
import { dependencyFingerprint } from '../../runtime/lib/verification-inputs.mjs';
import { verificationGitEnvironment } from '../../runtime/lib/git-fingerprint.mjs';
import { selectVerificationChecks } from '../../runtime/lib/verification-plan.mjs';
import { buildDeliveryVerificationPlan } from '../../runtime/lib/verification-risk.mjs';
import { authenticateDeliveryException, deliveryExceptionMessage, parseDeliveryException,
  qualityExceptionFor } from '../../runtime/lib/delivery-exception.mjs';

test('split-push 例外只消费可信签名且绑定树、ref、检查；不接受自报 JSON', () => {
  const tree = 'a'.repeat(40), ref = 'refs/heads/develop';
  const record = { tree, targetRef: ref, checks: [{ id: 'staged-lint', status: 'blocked' }],
    reason: 'tool unavailable', authorization: 'approved scoped quality exception', residualRisk: 'lint unverified' };
  assert.deepEqual(parseDeliveryException(deliveryExceptionMessage(record)), record);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const payload = { purpose: 'vibe-harness.split-push-exception/v1', tree, ref,
    checks: record.checks, authorization: record.authorization, reason: record.reason, residualRisk: record.residualRisk };
  const signed = { keyId: 'fixture', payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') };
  const grant = authenticateDeliveryException(record, signed, keys, { tree, ref });
  assert.equal(qualityExceptionFor([grant], 'staged-lint').status, 'blocked');
  assert.equal(qualityExceptionFor([record], 'staged-lint'), null);
  assert.equal(authenticateDeliveryException(record, signed, {}, { tree, ref }), null);
  assert.equal(authenticateDeliveryException(record, signed, keys, { tree: 'b'.repeat(40), ref }), null);
  assert.equal(authenticateDeliveryException(record, signed, keys, { tree, ref: 'refs/heads/main' }), null);
  assert.equal(authenticateDeliveryException({ ...record, residualRisk: 'hidden risk' }, signed, keys, { tree, ref }), null);
  for (const targetRef of ['refs/heads/main', 'refs/heads/master', 'refs/heads/release/1.0', 'refs/heads/chore/unrelated']) {
    assert.throws(() => deliveryExceptionMessage({ ...record, targetRef }), /INVALID/u);
  }
  assert.throws(() => deliveryExceptionMessage({ ...record, checks: [{ id: 'secret-scan', status: 'failed' }] }), /INVALID/u);
  assert.throws(() => deliveryExceptionMessage({ ...record, checks: [null] }), /INVALID/u);
});

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
  assert.equal(normalizeValidationChecks([{ id: 'slow', command: 'node check.mjs', timeoutMs: 1800000 }])[0].timeoutMs, 1800000);
  assert.throws(() => normalizeValidationChecks([{ id: 'slow', command: 'node check.mjs', timeoutMs: 999 }]), /timeoutMs/u);
  assert.equal(normalizeValidationChecks([{ id: 'local', command: 'node check.mjs', evidenceScope: 'transaction' }])[0].evidenceScope, 'transaction');
  assert.throws(() => normalizeValidationChecks([{ id: 'bad', command: 'node check.mjs', evidenceScope: 'forever' }]), /evidenceScope/u);
});

test('validation children drop hook-local Git discovery variables but retain unrelated environment', () => {
  const scoped = verificationGitEnvironment({
    GIT_DIR: 'foreign/.git', GIT_WORK_TREE: 'foreign', GIT_INDEX_FILE: 'foreign/index', VH_ENV_TEST: 'preserve',
  });
  assert.equal(scoped.GIT_DIR, undefined);
  assert.equal(scoped.GIT_WORK_TREE, undefined);
  assert.equal(scoped.GIT_INDEX_FILE, undefined);
  assert.equal(scoped.VH_ENV_TEST, 'preserve');
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
    // Cycles bind graph edges without recursively expanding ancestor subtrees.
    await symlink(modules, path.join(shared, 'cycle'), 'junction');
    assert.equal(dependencyFingerprint(project).available, true);
    assert.equal(dependencyFingerprint(project, { worktree: { dependencyRoots: ['../outside'] } }).available, false);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('tier deduplication preserves deterministic reuse and explicit evidence restrictions', () => {
  const command = 'node check.mjs';
  const tiers = { quick: [command], standard: [command], deep: [command] };
  const declaration = { id: 'test', command, deterministic: true };
  const plan = (metadata) => selectVerificationChecks({ tiers, metadata }).allChecks;
  const [ordinary] = plan([declaration]);
  assert.equal(ordinary.deterministic, true);
  assert.equal(ordinary.evidenceScope, undefined);
  assert.equal(plan([{ ...declaration, evidenceScope: 'transaction' }])[0].evidenceScope, 'transaction');
  assert.equal(plan([{ ...declaration, evidenceScope: 'fresh' }])[0].evidenceScope, 'fresh');
  const fresh = { ...declaration, id: 'fresh-alias', evidenceScope: 'fresh' };
  assert.equal(plan([declaration, fresh])[0].evidenceScope, 'fresh');
  assert.equal(plan([fresh, declaration])[0].evidenceScope, 'fresh');
  const transaction = { ...declaration, id: 'transaction-alias', evidenceScope: 'transaction' };
  assert.equal(plan([declaration, transaction])[0].evidenceScope, undefined);
  assert.equal(plan([transaction, declaration])[0].evidenceScope, undefined);
});

test('dense cyclic dependency graphs visit each physical node once and bind topology and bytes', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'dependency-graph-'));
  try {
    const modules = path.join(project, 'node_modules');
    await mkdir(modules);
    const packages = Array.from({ length: 8 }, (_, index) => path.join(modules, `pkg-${index}`));
    for (const directory of packages) {
      await mkdir(directory);
      await writeFile(path.join(directory, 'value.js'), 'original');
    }
    for (const directory of packages) {
      for (let index = 0; index < packages.length; index++) {
        await symlink(packages[index], path.join(directory, `edge-${index}`), 'junction');
      }
    }
    const before = dependencyFingerprint(project);
    assert.equal(before.available, true);
    assert.equal(before.entries, 17);
    assert.equal(before.files, 8);
    assert.ok(before.memoHits >= 64);
    await writeFile(path.join(packages[3], 'value.js'), 'modified');
    const changed = dependencyFingerprint(project);
    assert.notEqual(changed.fingerprint, before.fingerprint);
    // Remove the test-owned link, never recurse through a junction target.
    await unlink(path.join(packages[0], 'edge-1'));
    assert.notEqual(dependencyFingerprint(project).fingerprint, changed.fingerprint);
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
