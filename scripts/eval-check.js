#!/usr/bin/env node
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadEvalAssets, validateEvalAssets, validateEvalObserverCoverage, validateEvalSuiteSemantics } from './lib/eval-contract.js';
import { readJson, validateJsonAgainstSchema } from './lib/manifest.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
const suiteFiles = (await readdir(path.join(rootDir, 'evals/suites'))).filter((name) => name.endsWith('.json'));
const onlineSuites = [];
for (const file of suiteFiles) {
  const suite = await readJson(path.join(rootDir, 'evals/suites', file));
  if (file.includes('online')) onlineSuites.push(suite);
  errors.push(...validateJsonAgainstSchema(suite, assets.schemas.suite, file));
  errors.push(...validateEvalSuiteSemantics(suite));
}
const observers = await readJson(path.join(rootDir, 'runtime/evals/observers.json'));
errors.push(...validateEvalObserverCoverage(onlineSuites, observers));

if (errors.length > 0) {
  console.error(JSON.stringify({ errors, ok: false }, null, 2));
  process.exit(1);
}

console.log('Cognis evaluation contracts passed.');
