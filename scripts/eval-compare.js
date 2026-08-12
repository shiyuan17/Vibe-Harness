#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareEvalWindows } from './lib/eval-compare.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function runs(directory) {
  if (!directory) return [];
  const output = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = JSON.parse(await readFile(fullPath, 'utf8'));
          if (value.schemaVersion === 1 && value.suite && value.fingerprint) output.push(value);
        } catch {}
      }
    }
  }
  try {
    await visit(path.resolve(directory));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

const historyRuns = await runs(argument('--history-dir'));
const currentRuns = await runs(argument('--current-dir'));
const ordered = [...historyRuns, ...currentRuns]
  .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)));
const latestDays = [...new Set(ordered.map((run) => String(run.generatedAt).slice(0, 10)))].slice(-14);
const baselineDays = new Set(latestDays.slice(0, 7));
const candidateDays = new Set(latestDays.slice(7));
const comparison = compareEvalWindows({
  baselineRuns: ordered.filter((run) => baselineDays.has(String(run.generatedAt).slice(0, 10))),
  candidateRuns: ordered.filter((run) => candidateDays.has(String(run.generatedAt).slice(0, 10))),
});
console.log(JSON.stringify(comparison, null, 2));
