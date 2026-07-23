const expectedKinds = new Map([
  ['independent', 8],
  ['dependent', 4],
  ['mixed', 4],
  ['near-miss', 4],
]);

export function validateClarificationCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== 1 || catalog?.repetitions !== 3 || !Array.isArray(catalog.cases)) {
    return ['clarification catalog must use schemaVersion 1, three repetitions, and contain cases'];
  }
  const ids = new Set();
  for (const item of catalog.cases) {
    if (!item.id || ids.has(item.id)) errors.push(`invalid or duplicate clarification case id: ${item.id ?? '<missing>'}`);
    ids.add(item.id);
    if (!expectedKinds.has(item.kind)) errors.push(`${item.id} has invalid kind`);
    if (!Array.isArray(item.requiredDecisions) || !Array.isArray(item.repositoryFacts) || !Array.isArray(item.forbiddenQuestionTopics)) {
      errors.push(`${item.id} must declare decision, fact, and forbidden-question arrays`);
    }
    if (!Number.isInteger(item.expectedBlockingRounds) || item.expectedBlockingRounds < 0) {
      errors.push(`${item.id} must declare expectedBlockingRounds`);
    }
    if (!Number.isInteger(item.maxQuestionsPerRound) || item.maxQuestionsPerRound < 0 || item.maxQuestionsPerRound > 3) {
      errors.push(`${item.id} maxQuestionsPerRound must be between zero and three`);
    }
    if (item.kind === 'dependent') {
      if (!Array.isArray(item.dependencies) || item.dependencies.length === 0) errors.push(`${item.id} must declare dependencies`);
      for (const dependency of item.dependencies ?? []) {
        if (!item.requiredDecisions.includes(dependency.before) || !item.requiredDecisions.includes(dependency.after)) {
          errors.push(`${item.id} dependency must reference required decisions`);
        }
      }
    }
    if (item.kind === 'near-miss' && !item.expectedAction) errors.push(`${item.id} must declare expectedAction`);
  }
  for (const [kind, count] of expectedKinds) {
    const actual = catalog.cases.filter((item) => item.kind === kind).length;
    if (actual !== count) errors.push(`clarification catalog requires ${count} ${kind} cases, found ${actual}`);
  }
  return errors.sort();
}

export function evaluateClarification({ catalog, trials }) {
  const byId = new Map(catalog.cases.map((item) => [item.id, item]));
  let required = 0;
  let covered = 0;
  let unrelatedQuestions = 0;
  let dependencyViolations = 0;
  let implementationQuestionViolations = 0;
  let blockingRounds = 0;
  const errors = [];
  for (const trial of trials) {
    const item = byId.get(trial.caseId);
    if (!item) {
      errors.push(`unknown clarification case: ${trial.caseId}`);
      continue;
    }
    const decisions = new Set(trial.coveredDecisions ?? []);
    required += item.requiredDecisions.length;
    covered += item.requiredDecisions.filter((decision) => decisions.has(decision)).length;
    unrelatedQuestions += trial.unrelatedQuestions ?? 0;
    dependencyViolations += trial.dependencyViolations ?? 0;
    implementationQuestionViolations += trial.implementationQuestionViolations ?? 0;
    blockingRounds += trial.blockingRounds ?? 0;
    if ((trial.maxQuestionsInRound ?? 0) > 3) errors.push(`${trial.caseId} asked more than three questions in one round`);
    if ((trial.blockingRounds ?? 0) !== item.expectedBlockingRounds) errors.push(`${trial.caseId} used unexpected blocking rounds`);
  }
  if (dependencyViolations > 0) errors.push('dependent clarification order was violated');
  if (implementationQuestionViolations > 0) errors.push('implementation choices were delegated to the user');
  return {
    blockingRounds,
    criticalDecisionCoverage: required === 0 ? 1 : covered / required,
    dependencyViolations,
    errors,
    implementationQuestionViolations,
    ok: errors.length === 0,
    unrelatedQuestions,
  };
}
