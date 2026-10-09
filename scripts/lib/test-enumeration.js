import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Tests are organised in five layers (docs/rules/test-rules.md §测试分层). Each
// layer owns exactly one package.json script and one directory, so the layer,
// the run boundary and the on-disk location stay mechanically checkable.
export const TEST_LAYERS = [
  { layer: 'unit', script: 'test:unit' },
  { layer: 'component', script: 'test:component' },
  { layer: 'integration', script: 'test:integration' },
  { layer: 'e2e', script: 'test:e2e' },
  { layer: 'matrix', script: 'test:matrix' },
];

export const TEST_HELPERS_DIRECTORY = 'helpers';

// Exported for the coverage map and the focused runner: both must recognise a
// test-file token by exactly the same shape the enumeration guard uses.
export const TEST_FILE_PATTERN = /^tests\/([\w.-]+)\/[\w.-]+\.test\.js$/u;

function registeredTestFiles(script) {
  return script.split(/\s+/u).filter((token) => TEST_FILE_PATTERN.test(token));
}

// The test lists in package.json are hand-maintained on purpose: each
// list pins its own concurrency and timeout, and node:test glob execution
// would silently reorder that contract. The cost is that a new test file is
// invisible until someone remembers to register it — this guard makes the
// forget fail loudly instead of shipping an unexecuted test.
export async function checkTestEnumeration(rootDir) {
  const findings = [];
  const { scripts } = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const registered = new Map();
  for (const { layer, script: key } of TEST_LAYERS) {
    const script = scripts[key];
    if (typeof script !== 'string') {
      findings.push({ kind: 'missing-test-script', script: key });
      continue;
    }
    for (const file of registeredTestFiles(script)) {
      const owner = registered.get(file);
      if (owner) {
        findings.push({ kind: 'duplicate-registration', file, scripts: [owner, key] });
      } else {
        registered.set(file, key);
      }
      const fileLayer = TEST_FILE_PATTERN.exec(file)[1];
      if (fileLayer !== layer) {
        findings.push({ kind: 'layer-mismatch', actualLayer: fileLayer, expectedLayer: layer, file, script: key });
      }
    }
  }
  const { stray, onDisk } = await onDiskTestFiles(rootDir);
  for (const file of stray) {
    findings.push({
      hint: `move it into one of tests/${TEST_LAYERS.map((item) => item.layer).join(', tests/')} and register it in that layer script`,
      kind: 'stray-test-file',
      file,
    });
  }
  for (const file of onDisk) {
    if (!registered.has(file)) {
      findings.push({
        kind: 'unregistered-test-file',
        file,
        hint: `add it to the ${TEST_FILE_PATTERN.exec(file)[1]} layer script in package.json`,
      });
    }
  }
  for (const file of [...registered.keys()].sort()) {
    if (!onDisk.includes(file)) {
      findings.push({ kind: 'stale-test-registration', file });
    }
  }
  return {
    counts: { onDisk: onDisk.length, registered: registered.size, scripts: TEST_LAYERS.length, stray: stray.length },
    findings,
    status: findings.length === 0 ? 'clean' : 'drift',
  };
}

/**
 * List test files per layer directory plus any test file left outside a layer.
 *
 * @param {string} rootDir repository root
 */
export async function onDiskTestFiles(rootDir) {
  const entries = await readdir(path.join(rootDir, 'tests'), { withFileTypes: true });
  const stray = entries
    .filter((entry) => entry.isFile() && /\.test\.js$/u.test(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const onDisk = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === TEST_HELPERS_DIRECTORY) continue;
    const files = await readdir(path.join(rootDir, 'tests', entry.name), { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.test.js')) onDisk.push(`tests/${entry.name}/${file.name}`);
    }
  }
  return { onDisk: onDisk.sort(), stray };
}
