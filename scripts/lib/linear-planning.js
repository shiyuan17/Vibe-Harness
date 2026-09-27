import { DAG_CONCURRENCY_DEFAULTS } from './task-dag.js';

export const EXECUTION_MODES = Object.freeze(['auto', 'single', 'parallel']);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const LINEAR_PLAN_SCHEMA = 'vibe-harness.linear-plan/v1';

export const WALL_CLOCK_DEFAULTS = Object.freeze({
  planningBudgetMinutes: 30,
  minimumSavingsMinutes: 45,
  minimumSavingsRatio: 0.25,
  uncertaintyBufferRatio: 0.2,
  maxWriteAgents: DAG_CONCURRENCY_DEFAULTS.maxWriteAgents,
  maxReadAgents: DAG_CONCURRENCY_DEFAULTS.maxReadAgents,
});

export const LINEAR_PLAN_BLOCK_PATTERN = /```(?:json[ \t]+)?linear-plan[ \t]*\r?\n([\s\S]*?)```/u;

function assertMinutes(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
}

function normalizeUnit(unit, index) {
  if (!unit || typeof unit !== 'object') {
    throw new TypeError(`units[${index}] must be an object`);
  }
  const id = typeof unit.id === 'string' && unit.id.trim() ? unit.id : `unit-${index + 1}`;
  const activeMinutes = unit.activeMinutes ?? 0;
  const verificationMinutes = unit.verificationMinutes ?? 0;
  assertMinutes(activeMinutes, `units[${index}].activeMinutes`);
  assertMinutes(verificationMinutes, `units[${index}].verificationMinutes`);
  return {
    id,
    activeMinutes,
    verificationMinutes,
    minutes: activeMinutes + verificationMinutes,
  };
}

/**
 * Estimate serial and bounded parallel wall-clock time for independent units.
 *
 * @param {{
 *   sharedPreparationMinutes?: number,
 *   units?: Array<{id?: string, activeMinutes?: number, verificationMinutes?: number}>,
 *   externalWaitBlockMinutes?: number,
 *   finalIntegrationMinutes?: number,
 *   coordinationMinutes?: number,
 *   fanInMinutes?: number,
 *   uncertaintyBufferRatio?: number,
 *   criticalPath?: string[],
 * }} options
 */
export function estimateWallClock({
  sharedPreparationMinutes = 0,
  units,
  externalWaitBlockMinutes = 0,
  finalIntegrationMinutes = 0,
  coordinationMinutes = 0,
  fanInMinutes = 0,
  uncertaintyBufferRatio = WALL_CLOCK_DEFAULTS.uncertaintyBufferRatio,
  criticalPath,
} = {}) {
  assertMinutes(sharedPreparationMinutes, 'sharedPreparationMinutes');
  assertMinutes(externalWaitBlockMinutes, 'externalWaitBlockMinutes');
  assertMinutes(finalIntegrationMinutes, 'finalIntegrationMinutes');
  assertMinutes(coordinationMinutes, 'coordinationMinutes');
  assertMinutes(fanInMinutes, 'fanInMinutes');
  if (!Number.isFinite(uncertaintyBufferRatio) || uncertaintyBufferRatio < 0) {
    throw new TypeError('uncertaintyBufferRatio must be a non-negative finite number');
  }
  if (!Array.isArray(units) || units.length === 0) {
    throw new TypeError('units must contain at least one unit');
  }

  const normalizedUnits = units.map(normalizeUnit);
  const serialUnitMinutes = normalizedUnits.reduce((total, unit) => total + unit.minutes, 0);
  const longestUnitMinutes = Math.max(...normalizedUnits.map((unit) => unit.minutes));
  const singleAgentMinutes = sharedPreparationMinutes + externalWaitBlockMinutes + serialUnitMinutes + finalIntegrationMinutes;
  const unbufferedParallelMinutes = sharedPreparationMinutes
    + externalWaitBlockMinutes
    + longestUnitMinutes
    + coordinationMinutes
    + fanInMinutes
    + finalIntegrationMinutes;
  const parallelAgentMinutes = Math.ceil(unbufferedParallelMinutes * (1 + uncertaintyBufferRatio));
  const expectedSavingsMinutes = singleAgentMinutes - parallelAgentMinutes;
  const expectedSavingsRatio = singleAgentMinutes === 0
    ? 0
    : expectedSavingsMinutes / singleAgentMinutes;
  const longestUnit = normalizedUnits.filter((unit) => unit.minutes === longestUnitMinutes).map((unit) => unit.id);

  return {
    singleAgentMinutes,
    parallelAgentMinutes,
    expectedSavingsMinutes,
    expectedSavingsRatio,
    activeWorkMinutes: normalizedUnits.reduce((total, unit) => total + unit.activeMinutes, 0),
    verificationMinutes: normalizedUnits.reduce((total, unit) => total + unit.verificationMinutes, 0),
    externalWaitBlockMinutes,
    coordinationMinutes,
    fanInMinutes,
    criticalPath: Array.isArray(criticalPath) && criticalPath.length > 0 ? [...criticalPath] : longestUnit,
    units: normalizedUnits,
  };
}

/**
 * Choose a safe execution mode from a wall-clock estimate and live capacity.
 *
 * @param {{
 *   estimate?: ReturnType<typeof estimateWallClock>,
 *   candidateUnitCount?: number,
 *   isolationProven?: boolean,
 *   sharedContractFrozen?: boolean,
 *   availableWriteAgents?: number,
 *   minimumSavingsMinutes?: number,
 *   minimumSavingsRatio?: number,
 * }} options
 */
export function chooseExecutionMode({
  estimate,
  candidateUnitCount = 0,
  isolationProven = false,
  sharedContractFrozen = false,
  availableWriteAgents = 1,
  minimumSavingsMinutes = WALL_CLOCK_DEFAULTS.minimumSavingsMinutes,
  minimumSavingsRatio = WALL_CLOCK_DEFAULTS.minimumSavingsRatio,
} = {}) {
  if (!estimate || typeof estimate !== 'object') throw new TypeError('estimate is required');
  const reasons = [];
  if (candidateUnitCount < 2) reasons.push('fewer-than-two-ready-units');
  if (!isolationProven) reasons.push('write-scope-or-resource-conflict');
  if (!sharedContractFrozen) reasons.push('shared-contract-not-frozen');
  if (availableWriteAgents < 2) reasons.push('parallel-agent-capacity-unavailable');
  if (estimate.expectedSavingsMinutes < minimumSavingsMinutes
    || estimate.expectedSavingsRatio < minimumSavingsRatio) {
    reasons.push('coordination-cost-exceeds-net-savings');
  }

  const parallel = reasons.length === 0;
  return {
    mode: parallel ? 'parallel' : 'single',
    maxWriteAgents: parallel ? WALL_CLOCK_DEFAULTS.maxWriteAgents : 1,
    maxReadAgents: WALL_CLOCK_DEFAULTS.maxReadAgents,
    reasons,
    criticalPath: estimate.criticalPath,
    wallClock: {
      singleAgentMinutes: estimate.singleAgentMinutes,
      parallelAgentMinutes: estimate.parallelAgentMinutes,
      expectedSavingsMinutes: estimate.expectedSavingsMinutes,
      expectedSavingsRatio: estimate.expectedSavingsRatio,
    },
  };
}

/**
 * Validate the machine-readable wall-clock planning contract.
 *
 * @param {any} plan
 */
export function validateWallClockPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] };
  if (plan.schema !== LINEAR_PLAN_SCHEMA) {
    errors.push(`schema must be ${LINEAR_PLAN_SCHEMA}`);
  }
  if (!EXECUTION_MODES.includes(plan.executionMode)) {
    errors.push(`executionMode must be one of ${EXECUTION_MODES.join(', ')}`);
  }

  const wallClock = plan.wallClock;
  if (!wallClock || typeof wallClock !== 'object') {
    errors.push('wallClock is required');
  } else {
    for (const field of [
      'budgetMinutes',
      'sharedPreparationMinutes',
      'externalWaitBlockMinutes',
      'activeWorkMinutes',
      'verificationMinutes',
      'singleAgentMinutes',
      'parallelAgentMinutes',
      'coordinationMinutes',
      'fanInMinutes',
      'finalIntegrationMinutes',
    ]) {
      if (!Number.isFinite(wallClock[field]) || wallClock[field] < 0) {
        errors.push(`wallClock.${field} must be a non-negative finite number`);
      }
    }
    if (!Array.isArray(wallClock.criticalPath) || wallClock.criticalPath.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push('wallClock.criticalPath must be an array of non-empty strings');
    }
    if (!CONFIDENCE_LEVELS.includes(wallClock.confidence)) {
      errors.push(`wallClock.confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
    }
    if (!Array.isArray(wallClock.units) || wallClock.units.length === 0) {
      errors.push('wallClock.units must contain at least one unit');
    } else {
      const ids = new Set();
      for (const [index, unit] of wallClock.units.entries()) {
        if (!unit || typeof unit !== 'object') {
          errors.push(`wallClock.units[${index}] must be an object`);
          continue;
        }
        if (typeof unit.id !== 'string' || !unit.id.trim() || ids.has(unit.id)) {
          errors.push(`wallClock.units[${index}].id must be a unique non-empty string`);
        }
        ids.add(unit.id);
        for (const field of ['activeMinutes', 'verificationMinutes']) {
          if (!Number.isFinite(unit[field]) || unit[field] < 0) {
            errors.push(`wallClock.units[${index}].${field} must be a non-negative finite number`);
          }
        }
      }
      if (Array.isArray(wallClock.criticalPath) && wallClock.criticalPath.some((id) => !ids.has(id))) {
        errors.push('wallClock.criticalPath must reference declared wallClock.units');
      }
      if (Number.isFinite(wallClock.activeWorkMinutes)
        && Number.isFinite(wallClock.verificationMinutes)) {
        const active = wallClock.units.reduce((total, unit) => total + unit.activeMinutes, 0);
        const verification = wallClock.units.reduce((total, unit) => total + unit.verificationMinutes, 0);
        if (wallClock.activeWorkMinutes !== active) errors.push('wallClock.activeWorkMinutes must equal unit activeMinutes total');
        if (wallClock.verificationMinutes !== verification) errors.push('wallClock.verificationMinutes must equal unit verificationMinutes total');
      }
      const estimate = estimateWallClock({
        sharedPreparationMinutes: wallClock.sharedPreparationMinutes,
        externalWaitBlockMinutes: wallClock.externalWaitBlockMinutes,
        finalIntegrationMinutes: wallClock.finalIntegrationMinutes,
        coordinationMinutes: wallClock.coordinationMinutes,
        fanInMinutes: wallClock.fanInMinutes,
        uncertaintyBufferRatio: wallClock.uncertaintyBufferRatio ?? WALL_CLOCK_DEFAULTS.uncertaintyBufferRatio,
        units: wallClock.units,
        criticalPath: wallClock.criticalPath,
      });
      for (const field of ['singleAgentMinutes', 'parallelAgentMinutes']) {
        if (wallClock[field] !== estimate[field]) {
          errors.push(`wallClock.${field} must equal calculated estimate (${estimate[field]})`);
        }
      }
      if (wallClock.parallelAgentMinutes > wallClock.singleAgentMinutes) {
        errors.push('wallClock.parallelAgentMinutes must not exceed singleAgentMinutes');
      }
      if (wallClock.budgetMinutes < Math.max(wallClock.singleAgentMinutes, wallClock.parallelAgentMinutes)) {
        errors.push('wallClock.budgetMinutes must cover the larger execution estimate');
      }
    }
  }

  const agentPlan = plan.agentPlan;
  if (!agentPlan || typeof agentPlan !== 'object') {
    errors.push('agentPlan is required');
  } else {
    if (!Number.isInteger(agentPlan.maxWriteAgents)
      || agentPlan.maxWriteAgents < 1
      || agentPlan.maxWriteAgents > WALL_CLOCK_DEFAULTS.maxWriteAgents) {
      errors.push(`agentPlan.maxWriteAgents must be an integer from 1 to ${WALL_CLOCK_DEFAULTS.maxWriteAgents}`);
    }
    if (!Number.isInteger(agentPlan.maxReadAgents)
      || agentPlan.maxReadAgents < 1
      || agentPlan.maxReadAgents > WALL_CLOCK_DEFAULTS.maxReadAgents) {
      errors.push(`agentPlan.maxReadAgents must be an integer from 1 to ${WALL_CLOCK_DEFAULTS.maxReadAgents}`);
    }
    if (agentPlan.fanInOwner !== 'parent-agent') errors.push('agentPlan.fanInOwner must be parent-agent');
    if (plan.executionMode === 'single' && agentPlan.maxWriteAgents !== 1) {
      errors.push('single executionMode requires agentPlan.maxWriteAgents=1');
    }
    if (plan.executionMode === 'parallel' && agentPlan.maxWriteAgents < 2) {
      errors.push('parallel executionMode requires at least two write agents');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseLinearPlanBlock(content) {
  const match = LINEAR_PLAN_BLOCK_PATTERN.exec(content);
  if (!match) {
    return { present: false, plan: null, errors: [], warnings: ['VIBE_HARNESS_LINEAR_PLAN_MISSING'] };
  }
  try {
    const plan = JSON.parse(match[1]);
    const validation = validateWallClockPlan(plan);
    return {
      present: true,
      plan,
      errors: validation.errors,
      warnings: [],
    };
  } catch (error) {
    return {
      present: true,
      plan: null,
      errors: [`VIBE_HARNESS_LINEAR_PLAN_INVALID: ${error.message}`],
      warnings: [],
    };
  }
}
