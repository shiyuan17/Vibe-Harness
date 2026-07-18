import assert from 'node:assert/strict';
import test from 'node:test';

import { removeTemporaryDirectory } from '../scripts/lib/temp-cleanup.js';

test('temporary cleanup retries transient Windows filesystem locks', async () => {
  const calls = [];
  await removeTemporaryDirectory('temporary-project', {
    remove: async (target, options) => { calls.push({ options, target }); },
  });
  assert.deepEqual(calls, [{
    target: 'temporary-project',
    options: { force: true, maxRetries: 20, recursive: true, retryDelay: 250 },
  }]);
});
