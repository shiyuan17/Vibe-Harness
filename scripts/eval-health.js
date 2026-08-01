#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

import { assessEvalHealth, readEvalHistory, readEvalStatus } from './lib/eval-health.js';
import { readProductEnv } from './lib/product-identity.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const currentDir = path.resolve(argument('--current-dir') ?? '.vibe-harness/evals/runs');
const historyDir = path.resolve(argument('--history-dir') ?? '.vibe-harness/evals/history');
const enforce = readProductEnv(process.env, 'EVAL_ENFORCE');
if (enforce.deprecated) console.error(`${enforce.name} is deprecated; use VIBE_HARNESS_EVAL_ENFORCE.`);
const report = assessEvalHealth({
  current: await readEvalStatus(currentDir),
  enforceInvalid: enforce.value === '1',
  history: await readEvalHistory(historyDir),
});
const summary = [
  '## Vibe-Harness online evaluation health',
  '',
  `- Status: ${report.status}`,
  `- Code: ${report.code}`,
  `- Consecutive degraded runs: ${report.consecutiveDegraded}`,
  '',
].join('\n');
const summaryPath = argument('--summary');
if (summaryPath) await appendFile(summaryPath, summary, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
