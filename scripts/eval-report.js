#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEvalReportModel, renderEvalReport } from './lib/eval-report.js';
import { suiteHash } from './lib/eval-replay.js';
import { assertInsideDir, assertPortableRelativePath, readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function flags(name) {
  return process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1]] : []).filter(Boolean);
}

function resolveProjectFile(relative, label) {
  if (!relative) throw new Error(`${label} is required`);
  assertPortableRelativePath(relative, label);
  const target = path.resolve(rootDir, relative);
  assertInsideDir(rootDir, target, label);
  return target;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const executionPath = resolveProjectFile(flag('--execution-run'), '--execution-run');
const canaryPath = resolveProjectFile(flag('--canary-run'), '--canary-run');
const outputRelative = flag('--output') ?? 'audit-reports/online-eval-report.html';
const outputPath = resolveProjectFile(outputRelative, '--output');
const comparisonExecutionRelative = flag('--comparison-execution-run');
const comparisonCanaryRelative = flag('--comparison-canary-run');
const executionAttemptRelatives = flags('--execution-attempt');
const canaryAttemptRelatives = flags('--canary-attempt');
const [executionRun, canaryRun, runSchema, executionComparisonRun, canaryComparisonRun, executionAttempts, canaryAttempts] = await Promise.all([
  readJson(executionPath), readJson(canaryPath), readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
  comparisonExecutionRelative ? readJson(resolveProjectFile(comparisonExecutionRelative, '--comparison-execution-run')) : null,
  comparisonCanaryRelative ? readJson(resolveProjectFile(comparisonCanaryRelative, '--comparison-canary-run')) : null,
  Promise.all(executionAttemptRelatives.map((item) => readJson(resolveProjectFile(item, '--execution-attempt')))),
  Promise.all(canaryAttemptRelatives.map((item) => readJson(resolveProjectFile(item, '--canary-attempt')))),
]);
for (const [label, run] of [['execution', executionRun], ['canary', canaryRun], ['comparison execution', executionComparisonRun], ['comparison canary', canaryComparisonRun]]) {
  if (!run) continue;
  const errors = validateJsonAgainstSchema(run, runSchema, label);
  if (errors.length > 0) throw new Error(errors.join('\n'));
}
if (executionRun.suite.id !== 'cognis-online-execution') throw new Error('--execution-run must reference cognis-online-execution');
if (canaryRun.suite.id !== 'cognis-online-canary') throw new Error('--canary-run must reference cognis-online-canary');
if (executionRun.campaignId && canaryRun.campaignId && executionRun.campaignId !== canaryRun.campaignId) throw new Error('run campaign ids do not match');
if (executionRun.fingerprint.model !== canaryRun.fingerprint.model) throw new Error('run model fingerprints do not match');
if (executionRun.fingerprint.agent !== canaryRun.fingerprint.agent) throw new Error('run CLI fingerprints do not match');
if (executionRun.runtime && canaryRun.runtime) {
  for (const field of ['provider', 'reasoningEffort', 'wireApi']) {
    if (executionRun.runtime[field] !== canaryRun.runtime[field]) throw new Error(`run runtime fingerprints do not match: ${field}`);
  }
  for (const run of [executionRun, canaryRun]) {
    if (!run.fingerprint.runner.endsWith(`-${run.runtime.backend}`)) throw new Error(`run backend fingerprint is inconsistent: ${run.suite.id}`);
  }
}
const [executionSuite, canarySuite] = await Promise.all([
  readJson(resolveProjectFile(executionRun.suite.path, 'execution suite path')),
  readJson(resolveProjectFile(canaryRun.suite.path, 'canary suite path')),
]);
if (suiteHash(executionSuite) !== executionRun.suite.hash) throw new Error('execution suite hash does not match the run artifact');
if (suiteHash(canarySuite) !== canaryRun.suite.hash) throw new Error('canary suite hash does not match the run artifact');
function validateAttempt(attempt, suiteId, label) {
  if (!['degraded', 'failed', 'passed'].includes(attempt?.status) || attempt?.suite?.id !== suiteId || !attempt?.attemptSummary) throw new Error(`${label} must be a campaign attempt artifact for ${suiteId}`);
  const current = suiteId === executionRun.suite.id ? executionRun : canaryRun;
  if (attempt.campaignId && current.campaignId && attempt.campaignId !== current.campaignId) throw new Error(`${label} campaign does not match the selected run`);
  for (const field of ['model', 'agent']) {
    if (attempt.fingerprint?.[field] && attempt.fingerprint[field] !== 'unavailable' && attempt.fingerprint[field] !== current.fingerprint[field]) throw new Error(`${label} fingerprint does not match: ${field}`);
  }
  if (attempt.suite?.hash && attempt.suite.hash !== current.suite.hash) throw new Error(`${label} suite hash does not match`);
  if (attempt.fingerprint?.configHash && attempt.fingerprint.configHash !== 'unavailable' && attempt.fingerprint.configHash !== current.fingerprint.configHash) throw new Error(`${label} fingerprint does not match: configHash`);
  for (const field of ['provider', 'reasoningEffort', 'backend', 'wireApi']) {
    if (attempt.runtime?.[field] && attempt.runtime[field] !== current.runtime?.[field]) throw new Error(`${label} runtime does not match: ${field}`);
  }
}
executionAttempts.forEach((item, index) => validateAttempt(item, 'cognis-online-execution', `execution attempt ${index + 1}`));
canaryAttempts.forEach((item, index) => validateAttempt(item, 'cognis-online-canary', `canary attempt ${index + 1}`));
const model = buildEvalReportModel({ canaryAttempts, canaryComparisonRun, canaryRun, canarySuite, executionAttempts, executionComparisonRun, executionRun, executionSuite });
const preview = {
  dryRun: !process.argv.includes('--write'),
  metrics: model.metrics,
  output: outputRelative,
  suites: model.runs.map((run) => ({ id: run.suiteId, status: run.status, version: run.suiteVersion })),
};
if (process.argv.includes('--write')) {
  if (await exists(outputPath) && !process.argv.includes('--force')) throw new Error('report output exists; pass --force to replace it');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderEvalReport(model), 'utf8');
}
console.log(JSON.stringify(preview, null, 2));
