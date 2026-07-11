import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ledgers = [
  ['DECISIONS.md', /\bDEC-\d{8}-\d{3}\b/gu, 'decision'],
  ['KNOWN_BUGS.md', /\bBUG-\d{8}-\d{3}\b/gu, 'bug'],
  ['TECH_DEBT.md', /\bDEBT-\d{8}-\d{3}\b/gu, 'technical debt'],
];

export function validateMemory(root) {
  const errors = [];
  for (const [file, pattern, label] of ledgers) {
    const fullPath = resolve(root, 'docs/memory', file);
    if (!existsSync(fullPath)) {
      errors.push(`Missing required governance memory file: docs/memory/${file}`);
      continue;
    }
    const ids = readFileSync(fullPath, 'utf8').match(pattern) ?? [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`Duplicate ${label} ID: ${id}`);
      seen.add(id);
    }
  }
  return errors;
}
