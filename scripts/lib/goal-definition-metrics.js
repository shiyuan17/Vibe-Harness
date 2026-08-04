const expectedKinds = new Map([
  ['execution', 4],
  ['exploration', 3],
  ['activation', 3],
  ['near-miss', 2],
]);

export function validateGoalDefinitionCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== 1 || catalog?.repetitions !== 3 || catalog?.maxObjectiveCharacters !== 4000 || !Array.isArray(catalog.cases)) {
    return ['goal catalog must use schemaVersion 1, three repetitions, a 4000-character maximum, and contain cases'];
  }
  const ids = new Set();
  for (const item of catalog.cases) {
    if (!item.id || ids.has(item.id)) errors.push(`invalid or duplicate goal case id: ${item.id ?? '<missing>'}`);
    ids.add(item.id);
    if (!expectedKinds.has(item.kind)) errors.push(`${item.id} has invalid kind`);
    if (!item.prompt || !item.expectedAction) errors.push(`${item.id} must declare prompt and expectedAction`);
    if (!Array.isArray(item.requiredSections) || !Array.isArray(item.forbiddenBehaviors)) {
      errors.push(`${item.id} must declare section and forbidden-behavior arrays`);
    }
    if (item.kind === 'activation') {
      if (typeof item.nativeGoalAvailable !== 'boolean' || typeof item.explicitActivation !== 'boolean' || !item.existingGoalStatus) {
        errors.push(`${item.id} must declare native activation context`);
      }
    }
  }
  for (const [kind, count] of expectedKinds) {
    const actual = catalog.cases.filter((item) => item.kind === kind).length;
    if (actual !== count) errors.push(`goal catalog requires ${count} ${kind} cases, found ${actual}`);
  }
  return errors.sort();
}

export function evaluateGoalDefinition({ catalog, trials }) {
  const byId = new Map(catalog.cases.map((item) => [item.id, item]));
  const expectedRepetitions = Number.isInteger(catalog.repetitions) ? catalog.repetitions : 1;
  const repetitionsByCase = new Map(catalog.cases.map((item) => [item.id, new Set()]));
  const seenTrials = new Set();
  let required = 0;
  let covered = 0;
  const errors = [];
  if (!Array.isArray(trials)) {
    return { errors: ['goal trials must be an array'], ok: false, sectionCoverage: 0 };
  }
  for (const trial of trials) {
    const item = byId.get(trial.caseId);
    if (!item) {
      errors.push(`unknown goal case: ${trial.caseId}`);
      continue;
    }
    const repetition = trial.repetition ?? (expectedRepetitions === 1 ? 1 : null);
    if (!Number.isInteger(repetition) || repetition < 1 || repetition > expectedRepetitions) {
      errors.push(`${trial.caseId} has invalid repetition ${repetition ?? '<missing>'}`);
    } else {
      const trialKey = `${trial.caseId}:${repetition}`;
      if (seenTrials.has(trialKey)) errors.push(`${trial.caseId} has duplicate repetition ${repetition}`);
      seenTrials.add(trialKey);
      repetitionsByCase.get(trial.caseId).add(repetition);
    }
    const sections = new Set(trial.coveredSections ?? []);
    required += item.requiredSections.length;
    covered += item.requiredSections.filter((section) => sections.has(section)).length;
    if (item.requiredSections.some((section) => !sections.has(section))) errors.push(`${trial.caseId} is missing required sections`);
    if (trial.action !== item.expectedAction) errors.push(`${trial.caseId} used ${trial.action ?? '<missing>'}; expected action ${item.expectedAction}`);
    if (!Number.isInteger(trial.objectiveCharacters) || trial.objectiveCharacters < 0) {
      errors.push(`${trial.caseId} must report a non-negative integer objectiveCharacters value`);
    } else if (trial.objectiveCharacters > catalog.maxObjectiveCharacters) {
      errors.push(`${trial.caseId} exceeded the 4000-character goal limit`);
    }
    for (const violation of trial.violations ?? []) errors.push(`${trial.caseId} violated ${violation}`);
  }
  for (const item of catalog.cases) {
    if (repetitionsByCase.get(item.id).size !== expectedRepetitions) {
      errors.push(`${item.id} must contain ${expectedRepetitions} distinct repetitions`);
    }
  }
  return {
    errors,
    ok: errors.length === 0,
    sectionCoverage: required === 0 ? 1 : covered / required,
  };
}
