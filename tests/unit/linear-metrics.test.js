import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperationsEvent,
  summarizeOperations,
  validateOperationsEvent,
} from '../../scripts/lib/linear-metrics.js';

test('operations events are append-only safe and aggregate read-only metrics', () => {
  const events = [
    buildOperationsEvent({
      issueId: 'ENG-123',
      phase: 'active',
      durationMinutes: 20,
      agentCount: 1,
      occurredAt: '2026-09-27T10:00:00.000Z',
    }),
    buildOperationsEvent({
      issueId: 'ENG-123',
      phase: 'fan-in',
      durationMinutes: 10,
      conflictCount: 1,
      reworkCount: 2,
      occurredAt: '2026-09-27T10:30:00.000Z',
    }),
  ];
  const summary = summarizeOperations(events);
  assert.equal(summary.ok, true);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.activeMinutes, 30);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.rework, 2);
  assert.equal(summary.unavailable, null);
});

test('operations metrics reject sensitive fields and report unavailable evidence', () => {
  const event = buildOperationsEvent({ issueId: 'ENG-123', phase: 'blocked' });
  event.hostname = 'host';
  assert.equal(validateOperationsEvent(event).ok, false);
  const summary = summarizeOperations([event]);
  assert.equal(summary.ok, false);
  assert.equal(summary.unavailable, 'invalid-events');
});
