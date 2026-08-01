#!/usr/bin/env node
import { validatePack } from './lib/pack-validation.js';

const rootDir = process.cwd();
const report = await validatePack(rootDir);

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log('Vibe-Harness validation passed.');
