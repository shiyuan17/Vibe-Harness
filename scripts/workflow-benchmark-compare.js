#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareWorkflowBenchmarkRuns,
  readWorkflowBenchmark,
  workflowBenchmarkSuitePath,
} from './lib/workflow-benchmark.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!args.adaptive || !args.strict) {
  throw new Error('Usage: workflow-benchmark-compare --adaptive <run.json> --strict <run.json> [--suite v1|v2]');
}
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = compareWorkflowBenchmarkRuns(
  await readWorkflowBenchmark(workflowBenchmarkSuitePath(rootDir, args.suite ?? 'v1')),
  await readWorkflowBenchmark(path.resolve(args.adaptive)),
  await readWorkflowBenchmark(path.resolve(args.strict)),
);
console.log(JSON.stringify(result, null, 2));
if (args.output) {
  const output = path.resolve(args.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
if (result.status !== 'passed') process.exitCode = 1;
