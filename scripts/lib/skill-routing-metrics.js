function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values) {
  if (values.length === 0) return 0;
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function summarizeTrials(trials) {
  return {
    durationMs: { mean: mean(trials.map((trial) => trial.durationMs)), variance: variance(trials.map((trial) => trial.durationMs)) },
    passRate: trials.length === 0 ? 0 : trials.filter((trial) => trial.passed).length / trials.length,
    tokens: { mean: mean(trials.map((trial) => trial.tokens)), variance: variance(trials.map((trial) => trial.tokens)) },
  };
}

export function validateRoutingCatalog({ catalog, skillIds }) {
  const errors = [];
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.cases)) return ['routing catalog must use schemaVersion 1 and contain cases'];
  const knownSkills = new Set(skillIds);
  const seen = new Set();
  for (const item of catalog.cases) {
    if (!knownSkills.has(item.skill)) errors.push(`routing catalog references unknown core skill: ${item.skill}`);
    if (seen.has(item.skill)) errors.push(`routing catalog duplicates core skill: ${item.skill}`);
    seen.add(item.skill);
    for (const name of ['shouldTrigger', 'shouldNotTrigger']) {
      if (!Array.isArray(item[name]) || item[name].length === 0 || item[name].some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
        errors.push(`${item.skill}.${name} must contain non-empty prompts`);
      }
    }
    if (!Array.isArray(item.confusion) || item.confusion.length === 0) {
      errors.push(`${item.skill}.confusion must contain at least one neighboring skill case`);
    } else {
      for (const confusion of item.confusion) {
        if (!confusion.prompt || confusion.expectedSkill !== item.skill || !knownSkills.has(confusion.competingSkill) || confusion.competingSkill === item.skill) {
          errors.push(`${item.skill}.confusion contains an invalid expected or competing skill`);
        }
      }
    }
  }
  for (const skillId of skillIds) if (!seen.has(skillId)) errors.push(`routing catalog is missing core skill: ${skillId}`);
  return errors.sort();
}

export function evaluateSkillRouting({ criticalSkills = [], trials }) {
  const errors = [];
  const critical = new Set(criticalSkills);
  const withSkill = trials.filter((trial) => trial.variant === 'with-skill');
  const withoutSkill = trials.filter((trial) => trial.variant === 'without-skill');
  const skillIds = [...new Set(withSkill.flatMap((trial) => [trial.expectedSkill, trial.predictedSkill]).filter(Boolean))].sort();
  const skills = {};
  for (const skillId of skillIds) {
    const truePositive = withSkill.filter((trial) => trial.expectedSkill === skillId && trial.predictedSkill === skillId).length;
    const falsePositive = withSkill.filter((trial) => trial.expectedSkill !== skillId && trial.predictedSkill === skillId).length;
    const falseNegative = withSkill.filter((trial) => trial.expectedSkill === skillId && trial.predictedSkill !== skillId).length;
    const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
    const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
    const threshold = critical.has(skillId) ? 0.95 : 0.9;
    skills[skillId] = { precision, recall, threshold };
    if (precision < threshold) errors.push(`${skillId} precision ${precision.toFixed(3)} is below ${threshold}`);
    if (recall < threshold) errors.push(`${skillId} recall ${recall.toFixed(3)} is below ${threshold}`);
  }

  const criticalCases = new Map();
  for (const trial of withSkill.filter((item) => item.critical)) {
    criticalCases.set(trial.caseId, [...(criticalCases.get(trial.caseId) ?? []), trial]);
  }
  for (const [caseId, repetitions] of criticalCases) {
    if (repetitions.length !== 3 || repetitions.some((trial) => !trial.passed)) {
      errors.push(`${caseId} must pass all three repetitions`);
    }
  }

  const withSummary = summarizeTrials(withSkill);
  const withoutSummary = summarizeTrials(withoutSkill);
  if (withSkill.length > 0 && withoutSkill.length > 0 && withSummary.passRate < withoutSummary.passRate) {
    errors.push(`A/B pass rate regressed: with-skill=${withSummary.passRate}, without-skill=${withoutSummary.passRate}`);
  }
  return {
    ab: {
      durationMs: { withSkill: withSummary.durationMs, withoutSkill: withoutSummary.durationMs },
      passRate: { withSkill: withSummary.passRate, withoutSkill: withoutSummary.passRate },
      tokens: { withSkill: withSummary.tokens, withoutSkill: withoutSummary.tokens },
    },
    errors,
    ok: errors.length === 0,
    skills,
  };
}
