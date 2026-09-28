import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseExecutionMode,
  estimateWallClock,
  validateWallClockPlan,
  WALL_CLOCK_DEFAULTS,
} from '../../scripts/lib/linear-planning.js';

function estimate(overrides = {}) {
  return estimateWallClock({
    sharedPreparationMinutes: 30,
    units: [
      { id: 'contract', activeMinutes: 120, verificationMinutes: 30 },
      { id: 'slice-a', activeMinutes: 150, verificationMinutes: 30 },
      { id: 'slice-b', activeMinutes: 120, verificationMinutes: 30 },
    ],
    finalIntegrationMinutes: 60,
    coordinationMinutes: 30,
    fanInMinutes: 45,
    ...overrides,
  });
}

test('wall-clock estimation separates serial work, parallel overhead, and critical path', () => {
  const result = estimate({ externalWaitBlockMinutes: 15 });
  assert.equal(result.singleAgentMinutes, 585);
  assert.equal(result.parallelAgentMinutes, 432);
  assert.equal(result.expectedSavingsMinutes, 153);
  assert.equal(result.activeWorkMinutes, 390);
  assert.equal(result.verificationMinutes, 90);
  assert.equal(result.externalWaitBlockMinutes, 15);
  assert.equal(result.criticalPath[0], 'slice-a');
});

test('parallel mode requires isolation, frozen contract, capacity, and net savings', () => {
  const result = chooseExecutionMode({
    estimate: estimate(),
    candidateUnitCount: 2,
    isolationProven: true,
    sharedContractFrozen: true,
    availableWriteAgents: 2,
  });
  assert.equal(result.mode, 'parallel');
  assert.equal(result.maxWriteAgents, WALL_CLOCK_DEFAULTS.maxWriteAgents);
  assert.equal(result.maxReadAgents, WALL_CLOCK_DEFAULTS.maxReadAgents);
  assert.deepEqual(result.reasons, []);
});

test('single mode is fail-safe when capacity or contract conditions are missing', () => {
  const result = chooseExecutionMode({
    estimate: estimate(),
    candidateUnitCount: 2,
    isolationProven: true,
    sharedContractFrozen: false,
    availableWriteAgents: 1,
  });
  assert.equal(result.mode, 'single');
  assert.deepEqual(result.reasons, [
    'shared-contract-not-frozen',
    'parallel-agent-capacity-unavailable',
  ]);
});

test('single mode rejects parallelism when coordination erases the wall-clock gain', () => {
  const result = chooseExecutionMode({
    estimate: estimate({
      coordinationMinutes: 180,
      fanInMinutes: 180,
    }),
    candidateUnitCount: 2,
    isolationProven: true,
    sharedContractFrozen: true,
    availableWriteAgents: 2,
  });
  assert.equal(result.mode, 'single');
  assert.ok(result.reasons.includes('coordination-cost-exceeds-net-savings'));
});

test('wall-clock planning contract validates bounded agent caps and fan-in ownership', () => {
  const valid = validateWallClockPlan({
    schema: 'vibe-harness.linear-plan/v1',
    executionMode: 'auto',
    wallClock: {
      budgetMinutes: 600,
      sharedPreparationMinutes: 30,
      externalWaitBlockMinutes: 15,
      activeWorkMinutes: 390,
      verificationMinutes: 90,
      singleAgentMinutes: 585,
      parallelAgentMinutes: 432,
      coordinationMinutes: 30,
      fanInMinutes: 45,
      finalIntegrationMinutes: 60,
      uncertaintyBufferRatio: 0.2,
      units: [
        { id: 'contract', activeMinutes: 120, verificationMinutes: 30 },
        { id: 'slice-a', activeMinutes: 150, verificationMinutes: 30 },
        { id: 'slice-b', activeMinutes: 120, verificationMinutes: 30 },
      ],
      criticalPath: ['slice-a'],
      confidence: 'medium',
    },
    agentPlan: {
      maxWriteAgents: 2,
      maxReadAgents: 4,
      fanInOwner: 'parent-agent',
    },
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));

  const invalid = validateWallClockPlan({
    schema: 'vibe-harness.linear-plan/v1',
    executionMode: 'parallel',
    wallClock: { criticalPath: [], confidence: 'unknown' },
    agentPlan: { maxWriteAgents: 3, maxReadAgents: 5, fanInOwner: 'child-agent' },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 8);
});

test('wall-clock validation rejects stale totals, missing units, and undersized budgets', () => {
  const result = validateWallClockPlan({
    schema: 'vibe-harness.linear-plan/v1',
    executionMode: 'parallel',
    wallClock: {
      budgetMinutes: 10,
      sharedPreparationMinutes: 0,
      externalWaitBlockMinutes: 0,
      activeWorkMinutes: 10,
      verificationMinutes: 0,
      singleAgentMinutes: 100,
      parallelAgentMinutes: 120,
      coordinationMinutes: 0,
      fanInMinutes: 0,
      finalIntegrationMinutes: 0,
      units: [{ id: 'missing', activeMinutes: 10, verificationMinutes: 0 }],
      criticalPath: ['unknown'],
      confidence: 'high',
    },
    agentPlan: { maxWriteAgents: 2, maxReadAgents: 4, fanInOwner: 'parent-agent' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /budgetMinutes/u.test(error)));
  assert.ok(result.errors.some((error) => /singleAgentMinutes/u.test(error)));
  assert.ok(result.errors.some((error) => /criticalPath/u.test(error)));
});
