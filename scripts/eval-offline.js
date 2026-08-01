#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvalAssets, validateEvalAssets } from './lib/eval-contract.js';
import { buildOfflineRun } from './lib/eval-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exit(1);
}

const run = await buildOfflineRun(assets.suite);
try {
  assert.deepEqual(run, assets.run);
} catch {
  console.error(JSON.stringify({ errors: ['offline replay differs from the checked-in result'], ok: false }, null, 2));
  process.exit(1);
}

console.log('Vibe-Harness offline evaluation passed.');
console.log(JSON.stringify({
  criticalPassRate: run.criticalPassRate,
  overallScore: run.overallScore,
  status: run.status,
  suite: run.suite.id,
}, null, 2));
