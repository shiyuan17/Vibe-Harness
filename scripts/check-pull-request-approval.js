#!/usr/bin/env node
// Required-approval conformance check for high-risk pull requests.
//
// ADR-0006 keeps approval advisory until a non-author collaborator with write
// access exists, so the default mode is `shadow`: the check records whether a
// current external approval exists without failing the run. Setting
// VIBE_HARNESS_PR_APPROVAL_MODE=required makes a missing approval fail.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function hasCurrentExternalApproval({ author, reviews }) {
  const latestByReviewer = new Map();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || login === author || !review.submitted_at) continue;
    const current = latestByReviewer.get(login);
    if (!current || Date.parse(review.submitted_at) > Date.parse(current.submitted_at)) latestByReviewer.set(login, review);
  }
  return [...latestByReviewer.values()].some((review) => review.state === 'APPROVED');
}

async function fetchReviews({ pullNumber, repository, token }) {
  const reviews = [];
  for (let page = 1; ; page += 1) {
    const url = 'https://api.github.com/repos/' + repository + '/pulls/' + pullNumber + '/reviews?per_page=100&page=' + page;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error('GitHub review query failed with status ' + response.status);
    const pageItems = /** @type {Array<Record<string, any>>} */ (await response.json());
    reviews.push(...pageItems);
    if (pageItems.length < 100) return reviews;
  }
}

async function main() {
  const mode = process.env.VIBE_HARNESS_PR_APPROVAL_MODE === 'required' ? 'required' : 'shadow';
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) throw new Error('GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest) {
    console.log(JSON.stringify({ code: 'NOT_A_PULL_REQUEST', mode, ok: true }, null, 2));
    return;
  }
  let reviews;
  try {
    reviews = await fetchReviews({ pullNumber: pullRequest.number, repository, token });
  } catch (error) {
    // A shadow run observes; it must not turn an unreadable review list into a
    // failed check. A required run still fails closed.
    const ok = mode === 'shadow';
    console.log(JSON.stringify({ code: 'APPROVAL_QUERY_FAILED', detail: error?.message ?? String(error), mode, ok }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  const approved = hasCurrentExternalApproval({ author: pullRequest.user?.login, reviews });
  const ok = approved || mode === 'shadow';
  console.log(JSON.stringify({ code: approved ? 'HIGH_RISK_APPROVED' : 'HIGH_RISK_APPROVAL_REQUIRED', mode, ok }, null, 2));
  if (!ok) process.exitCode = 1;
}

// pathToFileURL keeps this guard correct on Windows, where a bare `new URL()`
// would read the drive letter as a URL scheme.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
