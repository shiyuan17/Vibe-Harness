#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { readProjectConfig, resolveValidationCommands } from './lib/project-config.js';
import { inspectValidationCommands } from './lib/command-status.js';
import { buildVerificationPlan } from './lib/verification-plan.js';
import { collectChangedDetails, collectChangedPaths } from './lib/change-impact.js';

const targetDir = process.cwd();
const config = await readProjectConfig(targetDir);
const commandStatus = await inspectValidationCommands({
  commands: resolveValidationCommands(config),
  targetDir,
});
const base = process.env.BASE_SHA || null;
const changedPaths = await collectChangedPaths({ base, cwd: targetDir });
let changedDetails = [];
try {
  changedDetails = await collectChangedDetails({ base, cwd: targetDir });
} catch {
  // Path-only classification remains fail-safe when a diff is unavailable.
}
const forceFull = process.env.FORCE_FULL === 'true';
const plan = await buildVerificationPlan({ changedDetails, changedPaths, commandStatus, config, full: forceFull, targetDir });
const report = {
  ...plan,
  required: {
    lint: plan.selectedChecks.some((item) => item.id === 'lint'),
    validate: plan.selectedChecks.some((item) => item.id === 'validate'),
    unit: plan.selectedChecks.some((item) => item.id === 'test'),
    component: plan.selectedChecks.some((item) => item.id === 'component'),
    eval: plan.selectedChecks.some((item) => item.id === 'eval'),
    evalCheck: plan.selectedChecks.some((item) => item.id === 'eval-check'),
    docs: plan.selectedChecks.some((item) => item.id === 'docs'),
    skills: plan.selectedChecks.some((item) => item.id === 'skills'),
    integration: plan.selectedChecks.some((item) => item.id === 'integration')
      || plan.impactGroups.some((item) => ['adapters', 'manifests', 'schemas', 'runtime'].includes(item)),
    smoke: plan.riskLevel === 'high' || plan.lifecycle,
    supplyChain: plan.riskLevel === 'high' || plan.impactGroups.some((item) => ['runtime', 'manifests', 'config', 'schemas'].includes(item)),
    full: forceFull || plan.riskLevel === 'high',
    // A docs-only diff selects nothing but the docs audit, so the code
    // baseline (eslint, typecheck, unit) cannot be affected by it. CI gates
    // those steps on this flag instead of duplicating the decision in YAML.
    docsOnly: plan.selectedChecks.length > 0 && plan.selectedChecks.every((item) => item.id === 'docs'),
  },
};
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `riskLevel=${report.riskLevel}`,
    `integration=${report.required.integration}`,
    `smoke=${report.required.smoke}`,
    `supplyChain=${report.required.supplyChain}`,
    `full=${report.required.full}`,
    `lint=${report.required.lint}`,
    `validate=${report.required.validate}`,
    `unit=${report.required.unit}`,
    `component=${report.required.component}`,
    `eval=${report.required.eval}`,
    `evalCheck=${report.required.evalCheck}`,
    `docs=${report.required.docs}`,
    `skills=${report.required.skills}`,
    `docsOnly=${report.required.docsOnly}`,
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}
