#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkflowBenchmark, validateWorkflowBenchmarkSuite } from './lib/workflow-benchmark.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
validateWorkflowBenchmarkSuite(await readWorkflowBenchmark(path.join(rootDir, 'evals/workflow-benchmark/cases.json')));
console.log('Cognis adaptive/strict workflow benchmark contract passed.');
