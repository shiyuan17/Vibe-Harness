import path from 'node:path';

import { readJson, validateJsonAgainstSchema } from './manifest.js';
import { compareFingerprints } from './eval-scoring.js';

const DIMENSIONS = ['correctness', 'safety', 'evidenceQuality', 'efficiency'];

export function validateEvalSuiteSemantics(suite, manifests) {
  const errors = [];
  const ids = new Set();
  if (!Number.isInteger(suite.defaultRepetitions) || suite.defaultRepetitions < 1 || suite.defaultRepetitions > 3) {
    errors.push('defaultRepetitions must be an integer from 1 to 3');
  }
  const knownRuleIds = manifests?.rules?.items ? new Set(manifests.rules.items.map((item) => item.id)) : null;
  const knownSkillIds = manifests?.skills?.items ? new Set(manifests.skills.items.map((item) => item.id)) : null;
  for (const [index, item] of (suite.cases ?? []).entries()) {
    if (ids.has(item.id)) errors.push(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    let totalWeight = 0;
    const assertions = [
      ...(item.oracle?.requiredEvents ?? []),
      ...(item.oracle?.forbiddenEvents ?? []),
      ...(item.oracle?.requiredOutputFragments ?? []),
      ...(item.oracle?.forbiddenOutputFragments ?? []),
      ...(item.oracle?.requiredArtifacts ?? []),
      ...(item.oracle?.forbiddenArtifacts ?? []),
      ...(item.oracle?.exitCode ? [item.oracle.exitCode] : []),
      ...(item.oracle?.llmRubrics ?? []),
    ];
    for (const dimension of DIMENSIONS) {
      const value = item.weights?.[dimension];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
        errors.push(`cases[${index}].weights.${dimension} must be >= 0 and <= 10`);
      } else {
        totalWeight += value;
        if (value > 0 && !assertions.some((assertion) => assertion.dimension === dimension)) {
          errors.push(`cases[${index}].weights.${dimension} has weight but no assertion`);
        }
      }
    }
    if (totalWeight <= 0) errors.push(`cases[${index}].weights must have a positive weight`);
    if (!Number.isInteger(item.repetitions) || item.repetitions < 1 || item.repetitions > 3) {
      errors.push(`cases[${index}].repetitions must be an integer from 1 to 3`);
    }
    const expectedRules = item.reporting?.expected?.rules ?? [];
    const expectedSkills = item.reporting?.expected?.skills ?? [];
    const candidateOwners = item.reporting?.knowledgeCoverage?.candidateOwners ?? [];
    const expectedOwner = item.reporting?.workflowDemand?.expectedOwner;
    if (knownRuleIds) {
      for (const ruleId of expectedRules) {
        if (!knownRuleIds.has(ruleId)) errors.push(`cases[${index}].reporting.expected.rules references unknown rule id: ${ruleId}`);
      }
    }
    if (knownSkillIds) {
      for (const skillId of expectedSkills) {
        if (!knownSkillIds.has(skillId)) errors.push(`cases[${index}].reporting.expected.skills references unknown skill id: ${skillId}`);
      }
    }
    for (const owner of candidateOwners) {
      if (owner.kind === 'rule' && knownRuleIds && !knownRuleIds.has(owner.id)) {
        errors.push('cases[' + index + '].reporting.knowledgeCoverage references unknown rule id: ' + owner.id);
      }
      if (owner.kind === 'skill' && knownSkillIds && !knownSkillIds.has(owner.id)) {
        errors.push('cases[' + index + '].reporting.knowledgeCoverage references unknown skill id: ' + owner.id);
      }
    }
    if (expectedOwner?.kind === 'rule' && knownRuleIds && !knownRuleIds.has(expectedOwner.id)) {
      errors.push('cases[' + index + '].reporting.workflowDemand references unknown rule id: ' + expectedOwner.id);
    }
    if (expectedOwner?.kind === 'skill' && knownSkillIds && !knownSkillIds.has(expectedOwner.id)) {
      errors.push('cases[' + index + '].reporting.workflowDemand references unknown skill id: ' + expectedOwner.id);
    }
  }
  return errors.sort();
}

export function validateEvalObserverCoverage(suites, registry) {
  const errors = [];
  if (registry?.schemaVersion !== 1 || !registry.events || typeof registry.events !== 'object') {
    return ['evaluation observer registry must use schemaVersion 1 with an events object'];
  }
  const required = new Set();
  for (const suite of suites) {
    for (const definition of suite.cases ?? []) {
      for (const assertion of definition.oracle?.requiredEvents ?? []) required.add(assertion.value);
      for (const assertion of definition.oracle?.forbiddenEvents ?? []) required.add(assertion.value);
    }
  }
  for (const event of required) {
    const observer = registry.events[event];
    if (!observer || typeof observer.producer !== 'string' || typeof observer.observer !== 'string') {
      errors.push(`observed event requires a registered observer: ${event}`);
    }
  }
  return errors.sort();
}

function validateScore(value, label, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${label} must be a number from 0 to 1`);
  }
}

function validateAggregateScores(value, label, errors) {
  validateScore(value.overallScore, `${label}.overallScore`, errors);
  validateScore(value.criticalPassRate, `${label}.criticalPassRate`, errors);
  for (const [index, capability] of (value.capabilities ?? []).entries()) {
    validateScore(capability.score, `${label}.capabilities[${index}].score`, errors);
  }
}

function validateRunScores(run, errors) {
  validateAggregateScores(run, 'run', errors);
  for (const [index, result] of (run.cases ?? []).entries()) {
    validateScore(result.score, `run.cases[${index}].score`, errors);
    for (const dimension of DIMENSIONS) {
      validateScore(result.dimensionScores?.[dimension], `run.cases[${index}].dimensionScores.${dimension}`, errors);
    }
  }
}

export async function loadEvalAssets(rootDir) {
  const [suiteSchema, runSchema, referenceSchema, suite, run, reference] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-reference.schema.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json')),
    readJson(path.join(rootDir, 'evals/results/vibe-harness-core.offline.json')),
    readJson(path.join(rootDir, 'evals/references/vibe-harness-core.offline.json')),
  ]);
  return {
    suite,
    run,
    reference,
    schemas: { suite: suiteSchema, run: runSchema, reference: referenceSchema },
  };
}

export function validateEvalAssets({ suite, run, reference, schemas }) {
  const errors = [
    ...validateJsonAgainstSchema(suite, schemas.suite, 'suite'),
    ...validateJsonAgainstSchema(run, schemas.run, 'run'),
    ...validateJsonAgainstSchema(reference, schemas.reference, 'reference'),
    ...validateEvalSuiteSemantics(suite),
  ];
  // llmRubrics assertions invoke a non-deterministic judge model and are only
  // valid for online runs; offline replay must stay deterministic.
  if (run.mode === 'offline') {
    for (const [index, item] of (suite.cases ?? []).entries()) {
      if (item.oracle?.llmRubrics?.length > 0) {
        errors.push(`cases[${index}].oracle.llmRubrics are not allowed in offline suites`);
      }
    }
  }
  validateRunScores(run, errors);
  validateAggregateScores(reference, 'reference', errors);
  if (run.suite?.id !== suite.id || reference.suite?.id !== suite.id) {
    errors.push('suite id must match run and reference');
  }
  if (run.suite?.version !== suite.version || reference.suite?.version !== suite.version) {
    errors.push('suite version must match run and reference');
  }
  const comparison = compareFingerprints(run.fingerprint, reference.fingerprint);
  for (const mismatch of comparison.mismatches) {
    errors.push(`fingerprint mismatch for ${mismatch.field}`);
  }
  if (run.overallScore !== reference.overallScore) errors.push('run overall score must match reference');
  if (run.criticalPassRate !== reference.criticalPassRate) errors.push('run critical pass rate must match reference');
  return errors.sort();
}
