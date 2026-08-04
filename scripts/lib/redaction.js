import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Broader text-bearing surface so config/doc formats are not silently skipped.
const TEXT_EXTENSIONS = new Set([
  '.json', '.jsonc', '.md', '.markdown',
  '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.txt', '.template',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.html', '.htm', '.xml', '.csv',
]);

function isTextFile(name) {
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.has(path.extname(lower))) return true;
  // .template. infix (e.g. AGENTS.template.md) is case-insensitive too.
  return lower.includes('.template.');
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (isTextFile(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function scanForForbiddenTerms({ forbiddenTerms, includeDirs, rootDir }) {
  const findings = [];
  // Precompute lowercase terms once; matching is case-insensitive so leaked
  // identifiers survive any casing in the scanned content.
  const loweredTerms = forbiddenTerms.map((term) => ({ original: term, lowered: term.toLowerCase() }));
  for (const includeDir of includeDirs) {
    const baseDir = path.join(rootDir, includeDir);
    let files = [];
    try {
      const info = await stat(baseDir);
      if (info.isFile()) {
        if (isTextFile(baseDir)) files = [baseDir];
      } else {
        files = await collectFiles(baseDir);
      }
    } catch {
      continue;
    }
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const loweredContent = content.toLowerCase();
      for (const term of loweredTerms) {
        if (loweredContent.includes(term.lowered)) {
          findings.push({ file: path.relative(rootDir, file).replaceAll('\\', '/'), term: term.original });
        }
      }
    }
  }
  return findings;
}
