#!/usr/bin/env node
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadEvalAssets, validateEvalAssets, validateEvalObserverCoverage, validateEvalSuiteSemantics } from './lib/eval-contract.js';
import { validateClarificationCatalog } from './lib/clarification-metrics.js';
import { readJson, validateJsonAgainstSchema } from './lib/manifest.js';
import { validateRoutingCatalog, validateSkillSetBaseline } from './lib/skill-routing-metrics.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = await loadEvalAssets(rootDir);
const errors = validateEvalAssets(assets);
const [clarificationCatalog, routingCatalog, skillSetBaseline, skills] = await Promise.all([
  readJson(path.join(rootDir, 'evals/clarification-cases.json')),
  readJson(path.join(rootDir, 'evals/skill-routing-cases.json')),
  readJson(path.join(rootDir, 'evals/skill-set-baseline.json')),
  readJson(path.join(rootDir, 'manifests/skills.json')),
]);
errors.push(...validateClarificationCatalog(clarificationCatalog));
errors.push(...validateRoutingCatalog({
  catalog: routingCatalog,
  skillIds: skills.items.filter((item) => item.kind === 'native').map((item) => item.id),
}));
let identityCharacters = 0;
for (const item of skills.items.filter((candidate) => candidate.kind === 'native')) {
  const content = await readFile(path.join(rootDir, item.source), 'utf8');
  identityCharacters += item.id.length + (content.match(/^description:\s*(.+)$/mu)?.[1]?.length ?? 0);
}
errors.push(...validateSkillSetBaseline({
  baseline: skillSetBaseline,
  current: { identityCharacters, skillCount: skills.items.filter((item) => item.kind === 'native').length },
}).errors);
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
