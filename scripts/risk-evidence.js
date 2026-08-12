#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { assessRiskEvidence } from './lib/risk-evidence.js';

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
const event = JSON.parse(await readFile(eventPath, 'utf8'));
if (!event.pull_request) {
  console.log(JSON.stringify({ level: 'ordinary', highRiskPaths: [], missing: [], ok: true }, null, 2));
  process.exit(0);
}
const body = event.pull_request?.body ?? '';
const git = promisify(execFile);
const comparison = event.pull_request.base.sha + '...' + event.pull_request.head.sha;
const { stdout } = await git('git', ['diff', '--name-only', comparison], { encoding: 'utf8' });
const changedPaths = stdout.split(/\r?\n/u).filter(Boolean);
const report = assessRiskEvidence({ body, changedPaths });
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
