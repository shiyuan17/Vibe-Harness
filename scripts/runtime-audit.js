#!/usr/bin/env node
import path from 'node:path';

import { auditRuntimeTools } from './lib/runtime-audit.js';

const report = await auditRuntimeTools(path.resolve('.'));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
