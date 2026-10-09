#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProjectEvaluations } from './lib/project-evaluation.js';
import { resolveEvalRuntime } from './lib/eval-runtime-config.js';
import { readJson } from './lib/manifest.js';
import { readProductEnv } from './lib/product-identity.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(rootDir, 'runtime/evals/codex-runner.mjs'))}`;
const enforce = readProductEnv(process.env, 'EVAL_ENFORCE');
if (enforce.deprecated) console.error(`${enforce.name} is deprecated; use VIBE_HARNESS_EVAL_ENFORCE.`);
function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const suiteId = flag('--suite') ?? 'vibe-harness-online-canary';
if (!process.env.VIBE_HARNESS_EVAL_CODEX_BACKEND && suiteId === 'vibe-harness-role-routing') {
  process.env.VIBE_HARNESS_EVAL_CODEX_BACKEND = 'native';
}
const campaignId = flag('--campaign-id') ?? process.env.VIBE_HARNESS_EVAL_CAMPAIGN_ID ?? `campaign-${new Date().toISOString().replace(/[^0-9A-Za-z]/gu, '-')}`;
const suitePaths = {
  'linear-workflow-online': 'evals/suites/linear-workflow-online.json',
  'vibe-harness-online-canary': 'evals/suites/vibe-harness-online-canary.json',
  'vibe-harness-online-execution': 'evals/suites/vibe-harness-online-execution.json',
};
const suitesByReference = {
  'vibe-harness-online-canary': 'evals/references/vibe-harness-online-canary.json',
  'vibe-harness-online-execution': 'evals/references/vibe-harness-online-execution.json',
};
const reference = suitesByReference[suiteId] ?? `evals/references/${suiteId}.json`;
const suite = await readJson(path.join(rootDir, suitePaths[suiteId] ?? `evals/suites/${suiteId}.json`));
const selectedSuitePath = suitePaths[suiteId] ?? 'evals/suites/' + suiteId + '.json';
const repetitions = suite.cases.map((item) => ({ id: item.id, count: Math.min(item.repetitions ?? 3, 3) }));
const needsWrite = suite.cases.some((item) => (item.input?.fixture?.allowedWritePaths ?? []).length > 0);
const runtime = await resolveEvalRuntime({ needsWrite, repetitions });
for (const name of runtime.unset) delete process.env[name];
Object.assign(process.env, runtime.environment);
const caseTimeouts = suiteId === 'vibe-harness-online-canary'
  ? {
    'EVAL-GIT-DELIVER-001': 240000,
    'EVAL-GIT-DELIVER-002': 240000,
    'EVAL-GIT-DELIVER-003': 240000,
    'EVAL-GIT-DELIVER-004': 240000,
    'EVAL-HOOK-NO-AUTO-COMMIT-001': 240000,
  }
  : suiteId === 'linear-workflow-online'
    ? {
      'EVAL-LINEAR-014': 240000,
      'EVAL-LINEAR-015': 240000,
      'EVAL-LINEAR-016': 240000,
      'EVAL-LINEAR-017': 240000,
      'EVAL-LINEAR-018': 240000,
      'EVAL-LINEAR-019': 240000,
      'EVAL-LINEAR-020': 240000,
      'EVAL-LINEAR-021': 240000,
      'EVAL-LINEAR-022': 240000,
      'EVAL-LINEAR-023': 240000,
    }
    : {};
const config = {
  evaluations: {
    enabled: true,
    suites: [selectedSuitePath],
    reference,
    thresholds: { criticalPassRate: 1, overallScore: 0.9, maxCapabilityRegression: 0.05 },
    onlineRunner: runner,
    onlineConcurrency: /^(?:vibe-harness-online-canary|linear-workflow-online|vibe-harness-role-routing|vibe-harness-tool-routing)$/u.test(suiteId) ? 4 : 1,
    onlineWallTimeMs: /^(?:vibe-harness-online-canary|linear-workflow-online)$/u.test(suiteId)
      ? 1200000
      : /^(?:vibe-harness-role-routing|vibe-harness-tool-routing)$/u.test(suiteId) ? 900000 : null,
    onlineCaseWallTimeMs: /^(?:vibe-harness-role-routing|vibe-harness-tool-routing)$/u.test(suiteId) ? 900000 : null,
    onlineCaseWallTimeMsByCase: caseTimeouts,
    repetitions: 3,
  },
};
const report = await runProjectEvaluations({
  campaignId,
  config,
  mode: 'online',
  rootDir,
  runner,
  suiteId,
  targetDir: rootDir,
  write: true,
});
console.log(JSON.stringify(report, null, 2));
if (report.status === 'invalid' && enforce.value === '1') process.exitCode = 1;
