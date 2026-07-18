#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProjectEvaluations } from './lib/project-evaluation.js';
import { readProductEnv } from './lib/product-identity.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(rootDir, 'runtime/evals/codex-runner.mjs'))}`;
const enforce = readProductEnv(process.env, 'EVAL_ENFORCE');
if (enforce.deprecated) console.error(`${enforce.name} is deprecated; use COGNIS_EVAL_ENFORCE.`);
const config = {
  evaluations: {
    enabled: true,
    suites: ['evals/suites/cognis-online-canary.json'],
    reference: 'evals/references/cognis-online-canary.json',
    thresholds: { criticalPassRate: 1, overallScore: 0.9, maxCapabilityRegression: 0.05 },
    onlineRunner: runner,
    repetitions: 3,
  },
};
const report = await runProjectEvaluations({
  config,
  mode: 'online',
  rootDir,
  runner,
  suiteId: 'cognis-online-canary',
  targetDir: rootDir,
  write: true,
});
console.log(JSON.stringify(report, null, 2));
if (report.status === 'invalid' && enforce.value === '1') process.exitCode = 1;
