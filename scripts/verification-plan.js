#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { readProjectConfig, resolveValidationCommands } from './lib/project-config.js';
import { inspectValidationCommands } from './lib/command-status.js';
import { detectProjectProfile } from './lib/project-profile.js';
import { buildVerificationPlan } from './lib/verification-plan.js';
import { collectChangedDetails, collectChangedPaths } from './verify-focused.js';

const targetDir = process.cwd();
const config = await readProjectConfig(targetDir);
const profile = await detectProjectProfile({ config, targetDir });
const commandStatus = await inspectValidationCommands({
  commands: resolveValidationCommands(config, profile),
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
    eval: plan.selectedChecks.some((item) => item.id === 'eval' || item.id === 'eval-test'),
    evalCheck: plan.selectedChecks.some((item) => item.id === 'eval-check'),
    docs: plan.selectedChecks.some((item) => item.id === 'docs'),
    skills: plan.selectedChecks.some((item) => item.id === 'skills'),
    integration: plan.selectedChecks.some((item) => item.id === 'integration')
      || plan.impactGroups.some((item) => ['adapters', 'manifests', 'schemas', 'runtime'].includes(item)),
    smoke: plan.riskLevel === 'high' || plan.lifecycle,
    supplyChain: plan.riskLevel === 'high' || plan.impactGroups.some((item) => ['runtime', 'manifests', 'config', 'schemas'].includes(item)),
    full: forceFull || plan.riskLevel === 'high',
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
    `eval=${report.required.eval}`,
    `evalCheck=${report.required.evalCheck}`,
    `docs=${report.required.docs}`,
    `skills=${report.required.skills}`,
  ];
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
}
