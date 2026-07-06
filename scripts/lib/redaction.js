import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set(['.json', '.md', '.js', '.mjs', '.txt', '.template']);

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name.includes('.template.')) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function scanForForbiddenTerms({ forbiddenTerms, includeDirs, rootDir }) {
  const findings = [];
  for (const includeDir of includeDirs) {
    const baseDir = path.join(rootDir, includeDir);
    let files = [];
    try {
      files = await collectFiles(baseDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const term of forbiddenTerms) {
        if (content.includes(term)) {
          findings.push({ file: path.relative(rootDir, file).replaceAll('\\', '/'), term });
        }
      }
    }
  }
  return findings;
}
