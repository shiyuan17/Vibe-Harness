const FAST_SCENARIOS = Object.freeze(['H01', 'H04', 'H06', 'H09', 'H15', 'H20']);
const TIERS = new Set(['fast', 'nightly', 'full']);

function repetitions(scenario, tier) {
  return scenario.phase.regression.repetitions[tier] ?? (tier === 'fast' ? 1 : tier === 'nightly' ? 3 : 5);
}

export function planHarnessEval({
  scenarios,
  tier = 'fast',
  scenarioIds = [],
  backendCapabilities = [],
  attemptLimit = Number.POSITIVE_INFINITY,
} = {}) {
  if (!Array.isArray(scenarios)) throw new TypeError('scenarios must be an array');
  if (!TIERS.has(tier)) throw new Error('tier must be fast, nightly, or full');
  const requested = scenarioIds.length > 0
    ? new Set(scenarioIds)
    : tier === 'fast'
      ? new Set(FAST_SCENARIOS)
      : new Set(scenarios.map((scenario) => scenario.id));
  const unknown = [...requested].filter((id) => !scenarios.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new Error(`unknown scenario ids: ${unknown.join(', ')}`);
  let remaining = attemptLimit;
  const entries = scenarios.filter((scenario) => requested.has(scenario.id)).map((scenario) => {
    const missingCapabilities = scenario.capabilities.required.filter((capability) => !backendCapabilities.includes(capability));
    const desired = repetitions(scenario, tier);
    const scheduledAttempts = missingCapabilities.length > 0 ? 0 : Math.max(0, Math.min(desired, remaining));
    remaining -= scheduledAttempts;
    return {
      scenarioId: scenario.id,
      status: missingCapabilities.length > 0
        ? 'blocked'
        : scheduledAttempts === 0
          ? 'not-scheduled'
          : scheduledAttempts < desired
            ? 'partial'
            : 'ready',
      desiredAttempts: desired,
      scheduledAttempts,
      missingCapabilities,
    };
  });
  return {
    schemaVersion: 1,
    tier,
    backendCapabilities: [...backendCapabilities].sort(),
    entries,
    summary: {
      selectedScenarios: entries.length,
      readyScenarios: entries.filter((entry) => entry.status === 'ready').length,
      partialScenarios: entries.filter((entry) => entry.status === 'partial').length,
      notScheduledScenarios: entries.filter((entry) => entry.status === 'not-scheduled').length,
      blockedScenarios: entries.filter((entry) => entry.status === 'blocked').length,
      scheduledAttempts: entries.reduce((sum, entry) => sum + entry.scheduledAttempts, 0),
    },
    external: tier === 'full' ? ['swe-bench', 'terminal-bench', 'cooperbench'] : [],
  };
}

export { FAST_SCENARIOS };
