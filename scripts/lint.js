#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const includeDirs = ['scripts', 'tests'];
const scriptExtensions = new Set(['.js', '.mjs']);

async function collectScripts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectScripts(fullPath));
    } else if (scriptExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = [];
for (const includeDir of includeDirs) {
  files.push(...await collectScripts(path.join(rootDir, includeDir)));
}

let failed = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}

console.log(`LoopEngine lint passed (${files.length} files checked).`);
