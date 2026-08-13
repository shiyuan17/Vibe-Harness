#!/usr/bin/env node
import path from 'node:path';

import { runBehavioralEvaluation } from './lib/eval-behavioral.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const report = await runBehavioralEvaluation(rootDir);
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
