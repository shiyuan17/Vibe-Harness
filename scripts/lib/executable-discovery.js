import { readdir } from 'node:fs/promises';
import path from 'node:path';

const EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const IGNORED_DIRECTORIES = new Set(['.git', '.cognis', 'node_modules']);

async function collect(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(fullPath, files);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
  }
}

export async function discoverExecutables(rootDir) {
  const files = [];
  for (const directory of ['scripts', 'tests', 'runtime', 'skills']) {
    await collect(path.join(rootDir, directory), files);
  }
  return files.sort((left, right) => left.localeCompare(right));
}
