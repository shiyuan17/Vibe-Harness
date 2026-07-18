import assert from 'node:assert/strict';
import test from 'node:test';

import { assessEvalHealth } from '../scripts/lib/eval-health.js';

test('online health warns for two degraded runs and fails on the third', () => {
  assert.deepEqual(assessEvalHealth({ current: 'degraded', history: [] }), {
    code: 'EVAL_DEGRADED', consecutiveDegraded: 1, ok: true, status: 'degraded',
  });
  assert.deepEqual(assessEvalHealth({ current: 'degraded', history: ['degraded'] }), {
    code: 'EVAL_DEGRADED', consecutiveDegraded: 2, ok: true, status: 'degraded',
  });
  assert.deepEqual(assessEvalHealth({ current: 'degraded', history: ['degraded', 'degraded'] }), {
    code: 'EVAL_DEGRADED_STREAK', consecutiveDegraded: 3, ok: false, status: 'degraded',
  });
});

test('online health resets the degraded streak after a ready run', () => {
  assert.deepEqual(assessEvalHealth({ current: 'ready', history: ['degraded', 'degraded'] }), {
    code: 'EVAL_READY', consecutiveDegraded: 0, ok: true, status: 'ready',
  });
  assert.equal(assessEvalHealth({ current: 'degraded', history: ['ready', 'degraded'] }).consecutiveDegraded, 1);
});

test('online health respects invalid enforcement and fails closed without a current status', () => {
  assert.equal(assessEvalHealth({ current: 'invalid', enforceInvalid: false, history: [] }).ok, true);
  assert.equal(assessEvalHealth({ current: 'invalid', enforceInvalid: true, history: [] }).ok, false);
  assert.deepEqual(assessEvalHealth({ current: null, history: [] }), {
    code: 'EVAL_HEALTH_UNAVAILABLE', consecutiveDegraded: 0, ok: false, status: 'unavailable',
  });
});
