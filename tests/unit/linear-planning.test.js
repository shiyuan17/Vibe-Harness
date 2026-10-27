import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseExecutionMode,
  estimateWallClock,
  parseLinearPlanBlock,
  validateWallClockPlan,
  WALL_CLOCK_DEFAULTS,
} from '../../scripts/lib/linear-planning.js';

test('三个写单元在两个槽位按容量调度且不夸大收益', () => {
  const result = estimateWallClock({
    units: ['A', 'B', 'C'].map((id) => ({ id, kind: 'write', dependsOn: [], activeMinutes: 120, verificationMinutes: 0 })),
    maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2,
  });
  assert.equal(result.parallelAgentMinutes, 288);
  assert.equal(result.expectedSavingsRatio, 0.2);
  assert.equal(chooseExecutionMode({ estimate: result, candidateUnitCount: 3,
    isolationProven: true, sharedContractFrozen: true, availableWriteAgents: 2,
    availableReadAgents: 4, availableAgents: 2 }).mode, 'parallel');
});

test('并行门槛统一为十分钟且百分之十五，两个边界都必须满足', () => {
  assert.equal(WALL_CLOCK_DEFAULTS.minimumSavingsMinutes, 10);
  assert.equal(WALL_CLOCK_DEFAULTS.minimumSavingsRatio, 0.15);
  const candidate = { peakAgents: 2, capacityComplete: true, capacity: { maxAgents: 2, maxReadAgents: 1, maxWriteAgents: 2 },
    expectedSavingsMinutes: 10, expectedSavingsRatio: 0.15 };
  const decide = (estimate) => chooseExecutionMode({ estimate, candidateUnitCount: 2, isolationProven: true,
    sharedContractFrozen: true, availableAgents: 2, availableReadAgents: 1, availableWriteAgents: 2 }).mode;
  assert.equal(decide(candidate), 'parallel');
  assert.equal(decide({ ...candidate, expectedSavingsMinutes: 9.99 }), 'single');
  assert.equal(decide({ ...candidate, expectedSavingsRatio: 0.149 }), 'single');
});

function v2Plan(options, executionMode = 'auto') {
  const result = estimateWallClock(options);
  return { schema: 'vibe-harness.linear-plan/v2', executionMode,
    wallClock: { budgetMinutes: result.singleAgentMinutes, sharedPreparationMinutes: 0,
      externalWaitBlockMinutes: 0, coordinationMinutes: 0, fanInMinutes: 0,
      finalIntegrationMinutes: 0, uncertaintyBufferRatio: 0.2, confidence: 'high',
      ...options, ...result },
    agentPlan: { maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2,
      fanInOwner: 'parent-agent', isolationProven: true, sharedContractFrozen: true } };
}

test('单 Agent 七十分钟且并行八十四分钟时允许 single 预算', () => {
  const plan = v2Plan({ units: [{ id: 'A', kind: 'write', dependsOn: [],
    activeMinutes: 70, verificationMinutes: 0 }], maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2 }, 'single');
  assert.equal(plan.wallClock.parallelAgentMinutes, 84);
  assert.equal(validateWallClockPlan(plan).ok, true);
  assert.equal(validateWallClockPlan({ ...plan, executionMode: 'auto' }).executionMode, 'single');
});

test('共享契约后可并行派发且字符串标志不能证明隔离', () => {
  const plan = v2Plan({ maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2, units: [
    { id: 'contract', kind: 'write', dependsOn: [], activeMinutes: 10, verificationMinutes: 0 },
    ...['A', 'B'].map((id) => ({ id, kind: 'write', dependsOn: ['contract'],
      activeMinutes: 240, verificationMinutes: 0 })),
  ] });
  const valid = validateWallClockPlan(plan);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  assert.equal(valid.executionMode, 'parallel');
  for (const key of ['isolationProven', 'sharedContractFrozen']) {
    const invalid = validateWallClockPlan({ ...plan, executionMode: 'parallel',
      agentPlan: { ...plan.agentPlan, [key]: 'false' } });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some((message) => message.includes(key)));
  }
});

test('调度遵循依赖链读写容量与确定性同优先级顺序', () => {
  const result = estimateWallClock({ maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2, units: [
    { id: 'B', kind: 'read', dependsOn: [], activeMinutes: 60, verificationMinutes: 0 },
    { id: 'A', kind: 'write', dependsOn: [], activeMinutes: 30, verificationMinutes: 0 },
    { id: 'C', kind: 'write', dependsOn: ['A'], activeMinutes: 90, verificationMinutes: 0 },
    { id: 'D', kind: 'write', dependsOn: ['B', 'C'], activeMinutes: 15, verificationMinutes: 0 },
  ] });
  assert.deepEqual(result.schedule.map((job) => [job.id, job.start, job.end]),
    [['A', 0, 30], ['B', 0, 60], ['C', 30, 120], ['D', 120, 135]]);
  assert.equal(result.parallelAgentMinutes, 162);
  const serial = estimateWallClock({ units: result.units, maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 1 });
  assert.equal(serial.peakAgents, 1);
  assert.equal(serial.parallelAgentMinutes, 234);
  const tied = estimateWallClock({ units: ['B', 'A'].map((id) => ({ id, kind: 'read',
    dependsOn: [], activeMinutes: 10, verificationMinutes: 0 })), maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2 });
  assert.deepEqual(tied.schedule.map((job) => job.id), ['A', 'B']);
});

test('容量不完整时保守串行且非法依赖被拒绝', () => {
  const units = ['A', 'B'].map((id) => ({ id, activeMinutes: 120, verificationMinutes: 0 }));
  const result = estimateWallClock({ units });
  assert.equal(result.capacityComplete, false);
  assert.equal(result.parallelAgentMinutes, 288);
  assert.equal(result.peakAgents, 1);
  assert.throws(() => estimateWallClock({ units: units.map((unit) => ({ ...unit,
    dependsOn: [unit.id === 'A' ? 'B' : 'A'] })) }), /cycle/u);
  assert.throws(() => estimateWallClock({ units: [{ ...units[0], dependsOn: ['missing'] }] }), /dependencies/u);
});

test('并行允许收益恰好达到门槛且共享成本只计一次', () => {
  const result = estimateWallClock({ units: ['A', 'B'].map((id) => ({ id,
    kind: 'write', dependsOn: [], activeMinutes: 90, verificationMinutes: 0 })),
  maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2, coordinationMinutes: 22.5 });
  assert.equal(result.expectedSavingsMinutes, 45);
  assert.equal(result.expectedSavingsRatio, 0.25);
  assert.equal(chooseExecutionMode({ estimate: result, candidateUnitCount: 2,
    isolationProven: true, sharedContractFrozen: true,
    availableWriteAgents: 2, availableReadAgents: 4, availableAgents: 2 }).mode, 'parallel');
  const shared = estimateWallClock({ units: result.units, maxWriteAgents: 2, maxReadAgents: 4,
    maxAgents: 2, sharedPreparationMinutes: 10, externalWaitBlockMinutes: 20,
    coordinationMinutes: 5, fanInMinutes: 5, finalIntegrationMinutes: 10 });
  assert.equal(shared.singleAgentMinutes, 220);
  assert.equal(shared.parallelAgentMinutes, 168);
});

test('v1 保守读取为 single 且 v2 拒绝不完整并行合同', () => {
  const plan = v2Plan({ units: [{ id: 'A', kind: 'write', dependsOn: [],
    activeMinutes: 70, verificationMinutes: 0 }], maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 2 });
  const legacy = { ...plan, schema: 'vibe-harness.linear-plan/v1', executionMode: 'parallel' };
  const parsed = parseLinearPlanBlock('```linear-plan\n' + JSON.stringify(legacy) + '\n```');
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.plan.executionMode, 'single');
  assert.match(parsed.warnings[0], /V1_SINGLE_ONLY/u);
  const invalid = structuredClone(plan);
  delete invalid.wallClock.units[0].dependsOn;
  assert.equal(validateWallClockPlan(invalid).ok, false);
});

function estimate(overrides = {}) {
  return estimateWallClock({
    maxWriteAgents: 2, maxReadAgents: 4, maxAgents: 4,
    sharedPreparationMinutes: 30,
    units: [
      { id: 'contract', kind: 'read', dependsOn: [], activeMinutes: 120, verificationMinutes: 30 },
      { id: 'slice-a', kind: 'read', dependsOn: [], activeMinutes: 150, verificationMinutes: 30 },
      { id: 'slice-b', kind: 'read', dependsOn: [], activeMinutes: 120, verificationMinutes: 30 },
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
    availableWriteAgents: 2, availableReadAgents: 4, availableAgents: 4,
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
    availableWriteAgents: 1, availableReadAgents: 4, availableAgents: 4,
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
    availableWriteAgents: 2, availableReadAgents: 4, availableAgents: 4,
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
        { id: 'contract', kind: 'read', dependsOn: [], activeMinutes: 120, verificationMinutes: 30 },
        { id: 'slice-a', kind: 'read', dependsOn: [], activeMinutes: 150, verificationMinutes: 30 },
        { id: 'slice-b', kind: 'read', dependsOn: [], activeMinutes: 120, verificationMinutes: 30 },
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
      budgetMinutes: 9,
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
