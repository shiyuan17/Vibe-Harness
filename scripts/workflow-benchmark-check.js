#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readWorkflowBenchmark,
  validateWorkflowBenchmarkSuite,
  workflowBenchmarkSuitePath,
} from './lib/workflow-benchmark.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv.includes('--suite')
  ? process.argv[process.argv.indexOf('--suite') + 1]
  : 'v1';
validateWorkflowBenchmarkSuite(await readWorkflowBenchmark(workflowBenchmarkSuitePath(rootDir, suite)));
console.log(`Cognis adaptive/strict workflow benchmark ${suite} contract passed.`);
