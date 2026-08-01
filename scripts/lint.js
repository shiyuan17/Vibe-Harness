#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { discoverExecutables } from './lib/executable-discovery.js';

const files = await discoverExecutables(process.cwd());
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}
if (failed) process.exit(1);
console.log(`Vibe-Harness lint passed (${files.length} files checked).`);
