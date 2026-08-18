#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const DEVELOP_SOURCE_PREFIXES = [
  'feat/', 'fix/', 'hotfix/', 'chore/', 'docs/', 'refactor/', 'test/',
  'ci/', 'build/', 'perf/', 'revert/', 'dependabot/', 'codex/',
];

export function validatePullRequestBranches(pullRequest) {
  if (!pullRequest) return { code: 'NOT_A_PULL_REQUEST', ok: true };
  const base = pullRequest.base?.ref ?? '';
  const head = pullRequest.head?.ref ?? '';
  const sameRepository = pullRequest.head?.repo?.full_name === pullRequest.base?.repo?.full_name;

  if (base === 'main') {
    const allowed = sameRepository && (
      head === 'develop'
      || head.startsWith('hotfix/')
      || head.startsWith('release-please--branches--main')
    );
    return { base, code: allowed ? 'MAIN_SOURCE_ALLOWED' : 'MAIN_SOURCE_REJECTED', head, ok: allowed, sameRepository };
  }

  if (base === 'develop') {
    const allowed = head === 'main' || DEVELOP_SOURCE_PREFIXES.some((prefix) => head.startsWith(prefix));
    return { base, code: allowed ? 'DEVELOP_SOURCE_ALLOWED' : 'DEVELOP_SOURCE_REJECTED', head, ok: allowed };
  }

  return { base, code: 'UNMANAGED_TARGET_BRANCH', head, ok: true };
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const result = validatePullRequestBranches(event.pull_request);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
