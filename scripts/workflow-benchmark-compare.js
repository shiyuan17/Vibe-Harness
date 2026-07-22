#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareWorkflowBenchmarkRuns, readWorkflowBenchmark } from './lib/workflow-benchmark.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!args.adaptive || !args.strict) throw new Error('Usage: workflow-benchmark-compare --adaptive <run.json> --strict <run.json>');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = compareWorkflowBenchmarkRuns(
  await readWorkflowBenchmark(path.join(rootDir, 'evals/workflow-benchmark/cases.json')),
  await readWorkflowBenchmark(path.resolve(args.adaptive)),
  await readWorkflowBenchmark(path.resolve(args.strict)),
);
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
