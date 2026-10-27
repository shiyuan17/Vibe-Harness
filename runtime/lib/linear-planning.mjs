// Pure shared planning contract. No provider calls or installation dependencies.
export const EXECUTION_MODES = Object.freeze(['auto', 'single', 'parallel']);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const LINEAR_PLAN_SCHEMA = 'vibe-harness.linear-plan/v2';
export const WALL_CLOCK_DEFAULTS = Object.freeze({ planningBudgetMinutes: 30,
  minimumSavingsMinutes: 10, minimumSavingsRatio: 0.15, uncertaintyBufferRatio: 0.2,
  maxWriteAgents: 2, maxReadAgents: 4 });
export const LINEAR_PLAN_BLOCK_PATTERN = /```(?:json[ \t]+)?linear-plan[ \t]*\r?\n([\s\S]*?)```/u;
const minutes = (n) => Number.isFinite(n) && n >= 0;
const cap = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Deterministic list scheduling, ordered by remaining dependency-chain cost.
 * @param {any} options
 */
export function estimateWallClock(options = {}) {
  const { units, sharedPreparationMinutes = 0, externalWaitBlockMinutes = 0,
    finalIntegrationMinutes = 0, coordinationMinutes = 0, fanInMinutes = 0,
    uncertaintyBufferRatio = WALL_CLOCK_DEFAULTS.uncertaintyBufferRatio, maxWriteAgents, maxReadAgents, maxAgents } = options;
  for (const [key, value] of Object.entries({ sharedPreparationMinutes, externalWaitBlockMinutes,
    finalIntegrationMinutes, coordinationMinutes, fanInMinutes, uncertaintyBufferRatio })) {
    if (!minutes(value)) throw new TypeError(`${key} must be a non-negative finite number`);
  }
  if (!Array.isArray(units) || !units.length) throw new TypeError('units must contain at least one unit');
  const ids = new Set();
  const normalized = units.map((unit) => {
    if (!unit || typeof unit.id !== 'string' || !unit.id.trim() || ids.has(unit.id)
      || !minutes(unit.activeMinutes) || !minutes(unit.verificationMinutes)) throw new TypeError('unit ids/minutes are invalid');
    ids.add(unit.id);
    return { ...unit, minutes: unit.activeMinutes + unit.verificationMinutes };
  });
  const complete = cap(maxWriteAgents, 2) && cap(maxReadAgents, 4) && cap(maxAgents, 6)
    && normalized.every((unit) => ['read', 'write'].includes(unit.kind) && Array.isArray(unit.dependsOn));
  const nodes = new Map(normalized.map((unit) => [unit.id, unit]));
  for (const unit of normalized) {
    if (unit.dependsOn !== undefined && (!Array.isArray(unit.dependsOn)
      || new Set(unit.dependsOn).size !== unit.dependsOn.length
      || unit.dependsOn.some((id) => !ids.has(id) || id === unit.id))) throw new TypeError('unit dependencies must be unique declared ids');
  }
  const visiting = new Set();
  const remaining = new Map();
  const chain = (id) => {
    if (visiting.has(id)) throw new TypeError('unit dependency cycle');
    if (remaining.has(id)) return remaining.get(id);
    visiting.add(id);
    const children = normalized.filter((unit) => unit.dependsOn?.includes(id));
    const value = nodes.get(id).minutes + Math.max(0, ...children.map((child) => chain(child.id)));
    visiting.delete(id); remaining.set(id, value); return value;
  };
  for (const unit of normalized) chain(unit.id);
  const priority = (a, b) => remaining.get(b.id) - remaining.get(a.id) || compareId(a.id, b.id);
  const done = new Set();
  const schedule = [];
  let running = [];
  let time = 0;
  let peak = 0;
  while (done.size < normalized.length) {
    const ready = normalized.filter((unit) => !done.has(unit.id)
      && !running.some((job) => job.id === unit.id)
      && (unit.dependsOn ?? []).every((id) => done.has(id))).sort(priority);
    for (const unit of ready) {
      const kind = unit.kind ?? 'write';
      const kindLimit = complete ? kind === 'read' ? maxReadAgents : maxWriteAgents : 1;
      if (running.length >= (complete ? maxAgents : 1)
        || running.filter((job) => job.kind === kind).length >= kindLimit) continue;
      const job = { id: unit.id, kind, start: time, end: time + unit.minutes };
      running.push(job); schedule.push(job); peak = Math.max(peak, running.length);
    }
    if (!running.length) throw new TypeError('unit dependency cycle or unusable capacity');
    time = Math.min(...running.map((job) => job.end));
    for (const job of running.filter((job) => job.end === time)) done.add(job.id);
    running = running.filter((job) => job.end !== time);
  }
  const activeWorkMinutes = normalized.reduce((n, unit) => n + unit.activeMinutes, 0);
  const verificationMinutes = normalized.reduce((n, unit) => n + unit.verificationMinutes, 0);
  const shared = sharedPreparationMinutes + externalWaitBlockMinutes + finalIntegrationMinutes;
  const singleAgentMinutes = shared + activeWorkMinutes + verificationMinutes;
  const parallelAgentMinutes = Math.ceil((shared + time + coordinationMinutes + fanInMinutes) * (1 + uncertaintyBufferRatio));
  const expectedSavingsMinutes = singleAgentMinutes - parallelAgentMinutes;
  const criticalPath = [];
  let current = [...normalized].sort(priority)[0];
  while (current) {
    criticalPath.push(current.id);
    current = normalized.filter((unit) => unit.dependsOn?.includes(current.id)).sort(priority)[0];
  }
  return { singleAgentMinutes, parallelAgentMinutes, expectedSavingsMinutes,
    expectedSavingsRatio: singleAgentMinutes ? expectedSavingsMinutes / singleAgentMinutes : 0,
    activeWorkMinutes, verificationMinutes, externalWaitBlockMinutes, coordinationMinutes, fanInMinutes,
    criticalPath, units: normalized, schedule, capacityComplete: complete, peakAgents: peak,
    capacity: { maxWriteAgents: complete ? maxWriteAgents : 1,
      maxReadAgents: complete ? maxReadAgents : 1, maxAgents: complete ? maxAgents : 1 } };
}

/** @param {any} options */
export function chooseExecutionMode({ estimate, candidateUnitCount = 0, isolationProven = false,
  sharedContractFrozen = false, availableWriteAgents = 1, availableReadAgents = 1,
  availableAgents = 1, minimumSavingsMinutes = WALL_CLOCK_DEFAULTS.minimumSavingsMinutes,
  minimumSavingsRatio = WALL_CLOCK_DEFAULTS.minimumSavingsRatio } = {}) {
  if (!estimate) throw new TypeError('estimate is required');
  const reasons = [];
  if (candidateUnitCount < 2 || estimate.peakAgents < 2) reasons.push('fewer-than-two-ready-units');
  if (isolationProven !== true) reasons.push('write-scope-or-resource-conflict');
  if (sharedContractFrozen !== true) reasons.push('shared-contract-not-frozen');
  if (!estimate.capacityComplete || availableAgents < estimate.capacity.maxAgents
    || availableWriteAgents < estimate.capacity.maxWriteAgents
    || availableReadAgents < estimate.capacity.maxReadAgents) reasons.push('parallel-agent-capacity-unavailable');
  if (estimate.expectedSavingsMinutes < minimumSavingsMinutes
    || estimate.expectedSavingsRatio < minimumSavingsRatio) reasons.push('coordination-cost-exceeds-net-savings');
  return { mode: reasons.length ? 'single' : 'parallel', reasons,
    maxWriteAgents: reasons.length ? 1 : estimate.capacity.maxWriteAgents,
    maxReadAgents: estimate.capacity.maxReadAgents, criticalPath: estimate.criticalPath,
    wallClock: { singleAgentMinutes: estimate.singleAgentMinutes, parallelAgentMinutes: estimate.parallelAgentMinutes,
      expectedSavingsMinutes: estimate.expectedSavingsMinutes, expectedSavingsRatio: estimate.expectedSavingsRatio } };
}

/** v1 remains readable, but can never authorize parallel dispatch. */
export function validateWallClockPlan(plan) {
  const errors = [];
  const legacy = plan?.schema === 'vibe-harness.linear-plan/v1';
  if (!legacy && plan?.schema !== LINEAR_PLAN_SCHEMA) errors.push(`schema must be ${LINEAR_PLAN_SCHEMA} or v1`);
  if (!EXECUTION_MODES.includes(plan?.executionMode)) errors.push('executionMode is invalid');
  const clock = plan?.wallClock;
  const agents = plan?.agentPlan;
  if (!clock || typeof clock !== 'object') errors.push('wallClock is required');
  if (!agents || typeof agents !== 'object') errors.push('agentPlan is required');
  if (!cap(agents?.maxWriteAgents, 2)) errors.push('agentPlan.maxWriteAgents must be 1..2');
  if (!cap(agents?.maxReadAgents, 4)) errors.push('agentPlan.maxReadAgents must be 1..4');
  if (!legacy && !cap(agents?.maxAgents, 6)) errors.push('agentPlan.maxAgents must be 1..6 actual host slots');
  if (agents?.fanInOwner !== 'parent-agent') errors.push('agentPlan.fanInOwner must be parent-agent');
  for (const key of ['isolationProven', 'sharedContractFrozen']) {
    if (agents?.[key] !== undefined && typeof agents[key] !== 'boolean') errors.push(`agentPlan.${key} must be boolean`);
  }
  for (const key of ['budgetMinutes', 'sharedPreparationMinutes', 'externalWaitBlockMinutes', 'activeWorkMinutes',
    'verificationMinutes', 'singleAgentMinutes', 'parallelAgentMinutes', 'coordinationMinutes', 'fanInMinutes', 'finalIntegrationMinutes']) {
    if (!minutes(clock?.[key])) errors.push(`wallClock.${key} must be a non-negative finite number`);
  }
  if (!CONFIDENCE_LEVELS.includes(clock?.confidence)) errors.push('wallClock.confidence is invalid');
  if (!Array.isArray(clock?.criticalPath)) errors.push('wallClock.criticalPath is required');
  let estimate;
  let executionMode = 'single';
  try {
    estimate = estimateWallClock({ ...clock, ...agents });
    if (!legacy && !estimate.capacityComplete) errors.push('v2 units require kind and dependsOn with complete capacity');
    if (!legacy && (clock.uncertaintyBufferRatio ?? 0.2) < 0.2) errors.push('parallel uncertainty buffer must be at least 20%');
    for (const key of ['activeWorkMinutes', 'verificationMinutes', 'singleAgentMinutes', ...legacy ? [] : ['parallelAgentMinutes']]) {
      if (clock[key] !== estimate[key]) errors.push(`wallClock.${key} must equal calculated estimate (${estimate[key]})`);
    }
    if (clock.criticalPath?.some((id) => !estimate.units.some((unit) => unit.id === id))) errors.push('wallClock.criticalPath must reference declared units');
    if (!legacy) {
      const decision = chooseExecutionMode({ estimate,
        candidateUnitCount: estimate.peakAgents,
        isolationProven: agents.isolationProven, sharedContractFrozen: agents.sharedContractFrozen,
        availableWriteAgents: agents.maxWriteAgents, availableReadAgents: agents.maxReadAgents,
        availableAgents: agents.maxAgents });
      executionMode = plan.executionMode === 'auto' ? decision.mode : plan.executionMode;
      if (executionMode === 'parallel' && decision.mode !== 'parallel') errors.push(`parallel preconditions: ${decision.reasons.join(', ')}`);
    }
    const selected = executionMode === 'parallel' ? estimate.parallelAgentMinutes : estimate.singleAgentMinutes;
    if (clock.budgetMinutes < selected) errors.push(`wallClock.budgetMinutes must cover selected ${executionMode} estimate (${selected})`);
  } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, errors, executionMode,
    warnings: legacy ? ['LINEAR_PLAN_V1_SINGLE_ONLY: upgrade explicitly to v2 for parallel assessment'] : [] };
}
export function parseLinearPlanBlock(content) {
  const match = LINEAR_PLAN_BLOCK_PATTERN.exec(content);
  if (!match) return { present: false, plan: null, errors: [], warnings: ['VIBE_HARNESS_LINEAR_PLAN_MISSING'] };
  try {
    const plan = JSON.parse(match[1]);
    const validation = validateWallClockPlan(plan);
    return { present: true, plan: { ...plan, executionMode: validation.executionMode },
      errors: validation.errors, warnings: validation.warnings };
  } catch (error) {
    return { present: true, plan: null, errors: [`VIBE_HARNESS_LINEAR_PLAN_INVALID: ${error.message}`], warnings: [] };
  }
}
