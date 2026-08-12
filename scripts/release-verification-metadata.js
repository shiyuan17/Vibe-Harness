#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const git = promisify(execFile);
await git('git', ['diff', '--exit-code']);
const sha = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
if (!sha || !runId || !runAttempt) throw new Error('GitHub run identity is required');
const finishedAt = new Date().toISOString();
const id = 'github-actions:' + runId + ':' + runAttempt;
const checks = [
  'pnpm check', 'pnpm docs:audit', 'pnpm eval:check', 'pnpm eval:replay', 'pnpm test:eval',
  'pnpm test:integration', 'pnpm smoke:lifecycle', 'pnpm runtime:audit', 'pnpm pack:contract', 'pnpm pack',
];
await writeFile('release-artifacts/verification.json', JSON.stringify({ id, finishedAt, stable: true, sha, checks }, null, 2) + '\n', 'utf8');
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    'id=' + id,
    'finished_at=' + finishedAt,
    'sha=' + sha,
    'stable=true',
    'checks=' + checks.join(','),
    '',
  ].join('\n'), 'utf8');
}
