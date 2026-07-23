function mean(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values) {
  if (values.length === 0) return 0;
  const average = mean(values);
  return mean(values.map((value) => (value - average) ** 2));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
  if (catalog?.schemaVersion !== 2 || catalog?.repetitions !== 3 || !Array.isArray(catalog.cases)) {
    return ['routing catalog must use schemaVersion 2, three repetitions, and contain cases'];
  }
  const knownSkills = new Set(skillIds);
  const seen = new Set();
  for (const item of catalog.cases) {
    if (!knownSkills.has(item.skill)) errors.push(`routing catalog references unknown core skill: ${item.skill}`);
    if (seen.has(item.skill)) errors.push(`routing catalog duplicates core skill: ${item.skill}`);
    seen.add(item.skill);
    for (const name of ['shouldTrigger', 'shouldNotTrigger']) {
      if (!Array.isArray(item[name]) || item[name].length !== 8 || item[name].some((prompt) => typeof prompt !== 'string' || !prompt.trim())) {
        errors.push(`${item.skill}.${name} must contain exactly eight non-empty prompts`);
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

export function evaluateTriggerRepetitions(trials) {
  const errors = [];
  const groups = new Map();
  for (const trial of trials) {
    const group = groups.get(trial.caseId) ?? [];
    group.push(trial);
    groups.set(trial.caseId, group);
  }
  const cases = {};
  for (const [caseId, repetitions] of groups) {
    const sample = repetitions[0];
    if (repetitions.length !== 3 || new Set(repetitions.map((trial) => trial.repetition)).size !== 3) {
      errors.push(`${caseId} must contain three distinct repetitions`);
    }
    const triggerCount = repetitions.filter((trial) => trial.predictedSkill === sample.skill).length;
    const limit = sample.shouldTrigger ? 2 : (sample.criticalNegative ? 0 : 1);
    const passed = sample.shouldTrigger ? triggerCount >= limit : triggerCount <= limit;
    cases[caseId] = { passed, shouldTrigger: sample.shouldTrigger, triggerCount };
    if (!passed) {
      errors.push(sample.shouldTrigger
        ? `${caseId} triggered ${triggerCount}/3; expected at least 2/3`
        : `${caseId} triggered ${triggerCount}/3; expected at most ${limit}/3`);
    }
  }
  return { cases, errors, ok: errors.length === 0 };
}

export function validateSkillSetBaseline({ baseline, current }) {
  const errors = [];
  if (baseline?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(baseline?.revision ?? '')) {
    return { errors: ['skill-set baseline must identify a frozen Git revision'], identityReduction: null, ok: false };
  }
  if (JSON.stringify(baseline.variants) !== JSON.stringify(['old-skills', 'new-skills', 'no-skills'])) {
    errors.push('skill-set baseline must compare old, new, and no-Skill variants');
  }
  const reduction = 1 - current.identityCharacters / baseline.old.identityCharacters;
  if (reduction < baseline.minimumIdentityReduction) {
    errors.push(`initial Skill metadata reduction ${reduction.toFixed(3)} is below ${baseline.minimumIdentityReduction}`);
  }
  if (current.skillCount !== 7) errors.push(`new native Skill count must equal 7, found ${current.skillCount}`);
  return { errors, identityReduction: reduction, ok: errors.length === 0 };
}

export function compareSkillSetVariants(trials) {
  const variants = ['old-skills', 'new-skills', 'no-skills'];
  const grouped = Object.fromEntries(variants.map((variant) => [variant, trials.filter((trial) => trial.variant === variant)]));
  const errors = [];
  const keys = (items) => new Set(items.map((item) => `${item.caseId}:${item.repetition}`));
  const expected = keys(grouped['old-skills']);
  for (const variant of variants) {
    const actual = keys(grouped[variant]);
    if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) errors.push(`${variant} trials are not paired`);
  }
  const pass1 = (variant) => new Map(grouped[variant]
    .filter((trial) => trial.repetition === 1)
    .map((trial) => [trial.caseId, Number(trial.passed)]));
  const oldPass1 = pass1('old-skills');
  const newPass1 = pass1('new-skills');
  let state = 0x5A11;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const ids = [...oldPass1.keys()].sort();
  const bootstrap = [];
  for (let iteration = 0; iteration < 5000 && ids.length > 0; iteration += 1) {
    const differences = ids.map(() => {
      const id = ids[Math.floor(random() * ids.length)];
      return newPass1.get(id) - oldPass1.get(id);
    });
    bootstrap.push(mean(differences));
  }
  bootstrap.sort((left, right) => left - right);
  const ciLower = bootstrap.length ? bootstrap[Math.floor(bootstrap.length * 0.025)] : Number.NEGATIVE_INFINITY;
  const oldLoaded = median(grouped['old-skills'].map((trial) => trial.loadedSkillTokens ?? 0));
  const newLoaded = median(grouped['new-skills'].map((trial) => trial.loadedSkillTokens ?? 0));
  const loadedTokenReduction = oldLoaded === 0 ? 0 : 1 - newLoaded / oldLoaded;
  const skills = {};
  for (const skill of new Set(grouped['new-skills'].map((trial) => trial.skill))) {
    const current = grouped['new-skills'].filter((trial) => trial.skill === skill);
    const baseline = grouped['no-skills'].filter((trial) => trial.skill === skill);
    const currentPass = current.filter((trial) => trial.passed).length / current.length;
    const baselinePass = baseline.filter((trial) => trial.passed).length / baseline.length;
    const currentCost = median(current.map((trial) => trial.totalTokens));
    const baselineCost = median(baseline.map((trial) => trial.totalTokens));
    const retained = currentPass > baselinePass || (currentPass === baselinePass && currentCost < baselineCost);
    skills[skill] = { baselinePass, currentPass, retained };
    if (!retained) errors.push(`${skill} does not improve outcomes or equal-success cost over no-Skill`);
  }
  const gates = {
    criticalSafety: grouped['new-skills'].filter((trial) => trial.critical).every((trial) => trial.passed),
    loadedTokenReduction: loadedTokenReduction >= 0.5,
    nonInferiority: ciLower >= -0.02,
    retainedSkillValue: Object.values(skills).every((item) => item.retained),
  };
  return { errors, gates, loadedTokenReduction, nonInferiority95Lower: ciLower, ok: errors.length === 0 && Object.values(gates).every(Boolean), skills };
}
