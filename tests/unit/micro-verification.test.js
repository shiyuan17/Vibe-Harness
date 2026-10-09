import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMicroChecks } from '../../scripts/lib/verification-contract.js';
import { splitMicroCommand } from '../../scripts/micro-verify.js';

test('Micro checks require bounded, explicit execution metadata', () => {
  const [check] = normalizeMicroChecks([{
    id: 'pure-probe',
    command: 'node scripts/probe.mjs',
  }]);
  assert.equal(check.maxDurationMs, 5000);
  assert.equal(check.outputLimit, 8192);
  assert.equal(check.deterministic, true);
  assert.equal(check.environment, 'cold');
});

test('Micro command policy rejects inline REPL, network, and mutation forms', () => {
  for (const command of [
    'node -e "process.stdout.write(1)"',
    'node --eval "console.log(1)"',
    'curl https://example.invalid',
    'pnpm test --write',
    'node scripts/probe.mjs > output.txt',
  ]) {
    assert.throws(() => splitMicroCommand(command), /shell metacharacters|unsafe|empty/u);
  }
});

test('Micro command policy accepts a declared module entry without shell evaluation', () => {
  assert.deepEqual(splitMicroCommand('node scripts/probe.mjs --input fixture.json'), [
    'node',
    'scripts/probe.mjs',
    '--input',
    'fixture.json',
  ]);
});
