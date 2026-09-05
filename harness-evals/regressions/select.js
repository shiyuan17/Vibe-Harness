export function selectScenariosForChanges({ changedPaths = [], impactMap, allScenarioIds = [] } = {}) {
  if (!Array.isArray(changedPaths) || !impactMap || !Array.isArray(impactMap.rules)) {
    throw new TypeError('changedPaths and an impact map are required');
  }
  const selected = new Set(impactMap.fixedCritical ?? []);
  const matches = [];
  const unknown = [];
  for (const changedPath of changedPaths) {
    const rules = impactMap.rules.filter((rule) => changedPath === rule.prefix || changedPath.startsWith(rule.prefix));
    if (rules.length === 0) unknown.push(changedPath);
    for (const rule of rules) {
      matches.push({ path: changedPath, prefix: rule.prefix, scenarios: rule.scenarios });
      for (const scenario of rule.scenarios) selected.add(scenario);
    }
  }
  const fallbackUsed = unknown.length > 0;
  if (fallbackUsed) for (const id of allScenarioIds) selected.add(id);
  return {
    schemaVersion: 1,
    selectedScenarioIds: allScenarioIds.filter((id) => selected.has(id)),
    fixedCritical: [...(impactMap.fixedCritical ?? [])],
    matches,
    unknownPaths: unknown,
    fallbackUsed,
  };
}
