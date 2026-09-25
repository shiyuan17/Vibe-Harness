import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMicroChecks } from '../../scripts/lib/verification-contract.js';

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
