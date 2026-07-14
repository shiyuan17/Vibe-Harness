#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProjectEvaluations } from './lib/project-evaluation.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(rootDir, 'runtime/evals/codex-runner.mjs'))}`;
const config = {
  evaluations: {
    enabled: true,
    suites: ['evals/suites/loopengine-online-canary.json'],
    reference: 'evals/references/loopengine-online-canary.json',
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
  suiteId: 'loopengine-online-canary',
  targetDir: rootDir,
  write: true,
});
console.log(JSON.stringify(report, null, 2));
if (report.status === 'invalid' && process.env.LOOPENGINE_EVAL_ENFORCE === '1') process.exitCode = 1;
