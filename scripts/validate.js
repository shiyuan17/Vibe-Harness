#!/usr/bin/env node
import { loadAllManifests, validateManifestSources } from './lib/manifest.js';
import { scanForForbiddenTerms } from './lib/redaction.js';

const rootDir = process.cwd();
const manifests = await loadAllManifests(rootDir);
const missing = await validateManifestSources(rootDir, manifests);
const leaks = await scanForForbiddenTerms({
  forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', 'T-024', '患者', '病理', '医疗'],
  includeDirs: ['rules', 'templates', 'skills/core', 'workflows', 'adapters/codex', 'manifests', 'schemas'],
  rootDir,
});

if (missing.length || leaks.length) {
  console.error(JSON.stringify({ leaks, missing }, null, 2));
  process.exit(1);
}

console.log('LoopEngine validation passed.');
