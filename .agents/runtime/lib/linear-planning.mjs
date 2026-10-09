const SCHEMA = 'vibe-harness.linear-plan/v1';
const MODES = ['auto', 'single', 'parallel'];
const CONFIDENCE = ['low', 'medium', 'high'];
const BLOCK = /```(?:json[ \t]+)?linear-plan[ \t]*\r?\n([\s\S]*?)```/u;

function number(value) {
  return Number.isFinite(value) && value >= 0;
}

export function parseLinearPlanBlock(content) {
  const match = BLOCK.exec(content);
  if (!match) return { present: false, plan: null, errors: [], warnings: ['VIBE_HARNESS_LINEAR_PLAN_MISSING'] };
  let plan;
  try {
    plan = JSON.parse(match[1]);
  } catch (error) {
    return { present: true, plan: null, errors: [`VIBE_HARNESS_LINEAR_PLAN_INVALID: ${error.message}`], warnings: [] };
  }
  const errors = [];
  if (plan?.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!MODES.includes(plan?.executionMode)) errors.push('executionMode must be auto, single, or parallel');
  const wallClock = plan?.wallClock;
  if (!wallClock || typeof wallClock !== 'object') {
    errors.push('wallClock is required');
  } else {
    for (const field of [
      'budgetMinutes', 'sharedPreparationMinutes', 'externalWaitBlockMinutes',
      'activeWorkMinutes', 'verificationMinutes', 'singleAgentMinutes',
      'parallelAgentMinutes', 'coordinationMinutes', 'fanInMinutes',
      'finalIntegrationMinutes',
    ]) {
      if (!number(wallClock[field])) errors.push(`wallClock.${field} must be a non-negative number`);
    }
    if (!CONFIDENCE.includes(wallClock.confidence)) errors.push('wallClock.confidence is invalid');
    if (!Array.isArray(wallClock.units) || wallClock.units.length === 0) {
      errors.push('wallClock.units must contain at least one unit');
    } else {
      const ids = new Set();
      for (const unit of wallClock.units) {
        if (!unit || typeof unit.id !== 'string' || !unit.id.trim() || ids.has(unit.id)) errors.push('wallClock.units ids must be unique');
        ids.add(unit?.id);
        if (!number(unit?.activeMinutes) || !number(unit?.verificationMinutes)) errors.push('wallClock unit minutes are invalid');
      }
      if (Array.isArray(wallClock.criticalPath) && wallClock.criticalPath.some((id) => !ids.has(id))) {
        errors.push('wallClock.criticalPath must reference declared units');
      }
      const active = wallClock.units.reduce((sum, unit) => sum + unit.activeMinutes, 0);
      const verification = wallClock.units.reduce((sum, unit) => sum + unit.verificationMinutes, 0);
      const serial = wallClock.sharedPreparationMinutes + wallClock.externalWaitBlockMinutes
        + active + verification + wallClock.finalIntegrationMinutes;
      const longest = Math.max(...wallClock.units.map((unit) => unit.activeMinutes + unit.verificationMinutes));
      const parallel = Math.ceil((wallClock.sharedPreparationMinutes + wallClock.externalWaitBlockMinutes
        + longest + wallClock.coordinationMinutes + wallClock.fanInMinutes
        + wallClock.finalIntegrationMinutes) * (1 + (wallClock.uncertaintyBufferRatio ?? 0.2)));
      if (wallClock.activeWorkMinutes !== active) errors.push('wallClock.activeWorkMinutes total is stale');
      if (wallClock.verificationMinutes !== verification) errors.push('wallClock.verificationMinutes total is stale');
      if (wallClock.singleAgentMinutes !== serial) errors.push(`wallClock.singleAgentMinutes must equal ${serial}`);
      if (wallClock.parallelAgentMinutes !== parallel) errors.push(`wallClock.parallelAgentMinutes must equal ${parallel}`);
      if (wallClock.parallelAgentMinutes > wallClock.singleAgentMinutes) errors.push('parallel estimate exceeds serial estimate');
      if (wallClock.budgetMinutes < Math.max(serial, parallel)) errors.push('wallClock.budgetMinutes is too small');
    }
  }
  const agentPlan = plan?.agentPlan;
  if (!agentPlan || typeof agentPlan !== 'object') {
    errors.push('agentPlan is required');
  } else {
    if (!Number.isInteger(agentPlan.maxWriteAgents) || agentPlan.maxWriteAgents < 1 || agentPlan.maxWriteAgents > 2) errors.push('agentPlan.maxWriteAgents must be 1..2');
    if (!Number.isInteger(agentPlan.maxReadAgents) || agentPlan.maxReadAgents < 1 || agentPlan.maxReadAgents > 4) errors.push('agentPlan.maxReadAgents must be 1..4');
    if (agentPlan.fanInOwner !== 'parent-agent') errors.push('agentPlan.fanInOwner must be parent-agent');
    if (plan.executionMode === 'single' && agentPlan.maxWriteAgents !== 1) errors.push('single mode requires one write agent');
    if (plan.executionMode === 'parallel' && agentPlan.maxWriteAgents < 2) errors.push('parallel mode requires two write agents');
  }
  return { present: true, plan, errors, warnings: [] };
}
