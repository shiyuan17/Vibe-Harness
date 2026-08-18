#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

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
    const pageItems = await response.json();
    reviews.push(...pageItems);
    if (pageItems.length < 100) return reviews;
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) throw new Error('GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error('pull_request event payload is required');
  const reviews = await fetchReviews({ pullNumber: pullRequest.number, repository, token });
  const ok = hasCurrentExternalApproval({ author: pullRequest.user?.login, reviews });
  console.log(JSON.stringify({ code: ok ? 'HIGH_RISK_APPROVED' : 'HIGH_RISK_APPROVAL_REQUIRED', ok }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
