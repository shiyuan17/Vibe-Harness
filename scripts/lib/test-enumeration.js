import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const TEST_SCRIPT_KEYS = ['test:unit', 'test:eval', 'test:integration'];
const TEST_FILE_PATTERN = /^tests\/[\w.-]+\.test\.js$/u;

function registeredTestFiles(script) {
  return script.split(/\s+/u).filter((token) => TEST_FILE_PATTERN.test(token));
}

// The three test lists in package.json are hand-maintained on purpose: each
// list pins its own concurrency and timeout, and node:test glob execution
// would silently reorder that contract. The cost is that a new test file is
// invisible until someone remembers to register it — this guard makes the
// forget fail loudly instead of shipping an unexecuted test.
export async function checkTestEnumeration(rootDir) {
  const findings = [];
  const { scripts } = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const registered = new Map();
  for (const key of TEST_SCRIPT_KEYS) {
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
    }
  }
  const onDisk = (await readdir(path.join(rootDir, 'tests'), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.test\.js$/u.test(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  for (const file of onDisk) {
    if (!registered.has(file)) {
      findings.push({
        kind: 'unregistered-test-file',
        file,
        hint: `add it to one of ${TEST_SCRIPT_KEYS.join(', ')} in package.json`,
      });
    }
  }
  for (const file of [...registered.keys()].sort()) {
    if (!onDisk.includes(file)) {
      findings.push({ kind: 'stale-test-registration', file });
    }
  }
  return {
    counts: { onDisk: onDisk.length, registered: registered.size, scripts: TEST_SCRIPT_KEYS.length },
    findings,
    status: findings.length === 0 ? 'clean' : 'drift',
  };
}
