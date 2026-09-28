import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { onDiskTestFiles } from './test-enumeration.js';

// Static extraction only sees literal specifiers, so this map is a LOWER bound
// of the real dependency graph: tests that reach a source through readFile or a
// subprocess are invisible to it. Consumers must treat "not listed" as
// "unknown", never as "unaffected".
const SPECIFIER_PATTERNS = [
  /\bimport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*['"]([^'"]+)['"]/gu,
  /\bexport\s+[^;'"]*?from\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];

// Node's resolution order for the suffixes an import may omit: the exact name,
// then the extensions, then the directory index.
const RESOLUTION_SUFFIXES = ['', '.js', '.mjs', '/index.js', '/index.mjs'];

function toPosix(file) {
  return file.split(path.sep).join('/');
}

/**
 * Extract the local (relative) import specifiers of `source`, resolved against
 * `fromFile`'s directory and normalised to repo-relative posix paths. Bare and
 * node: specifiers are ignored. A specifier that only appears in a comment or a
 * string yields a false positive edge, which merely widens attribution — the
 * safe direction for a lower bound.
 *
 * @param {string} source
 * @param {string} fromFile
 * @returns {string[]} Sorted repo-relative file paths.
 */
export function extractLocalSpecifiers(source, fromFile) {
  const dir = path.posix.dirname(toPosix(fromFile));
  const resolved = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      resolved.add(path.posix.normalize(path.posix.join(dir, specifier)));
    }
  }
  return [...resolved].sort();
}

/**
 * Map every on-disk layer test file to the local files it transitively imports
 * (the test file itself excluded). Each test file gets an entry even when it
 * imports nothing, and import cycles terminate instead of diverging.
 * `testFiles` overrides the discovered set, which keeps the function testable
 * against a synthetic tree.
 *
 * @param {string} rootDir
 * @param {{testFiles?: string[]}} [options]
 * @returns {Promise<Record<string, string[]>>}
 */
export async function buildTestCoverageMap(rootDir, { testFiles } = {}) {
  const discovered = testFiles ?? (await onDiskTestFiles(rootDir)).onDisk;
  // One read per file for the whole run: every test file's traversal re-walks
  // the shared library graph, so the cache is what keeps this linear-ish.
  const sources = new Map();
  const readSource = async (file) => {
    if (!sources.has(file)) {
      let content = null;
      try {
        content = await readFile(path.join(rootDir, file), 'utf8');
      } catch {
        content = null;
      }
      sources.set(file, content);
    }
    return sources.get(file);
  };
  const resolveFile = async (file) => {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = file + suffix;
      if (await readSource(candidate) !== null) return candidate;
    }
    return null;
  };
  const covers = {};
  for (const testFile of [...discovered].sort()) {
    const visited = new Set([testFile]);
    const queue = [testFile];
    while (queue.length > 0) {
      const current = queue.shift();
      const source = await readSource(current);
      if (source === null) continue;
      for (const specifier of extractLocalSpecifiers(source, current)) {
        const resolved = await resolveFile(specifier);
        if (resolved === null || visited.has(resolved)) continue;
        visited.add(resolved);
        queue.push(resolved);
      }
    }
    // The test file is only a traversal root, never an attribution.
    visited.delete(testFile);
    covers[testFile] = [...visited].sort();
  }
  return covers;
}
