// node:test custom reporter that writes the observed case list of one test
// layer to a side-channel file (`--test-reporter` + `--test-reporter-destination`).
//
// The ledger in tests/cases.json is only as good as the enumeration it is
// compared against, so the comparison must come from the real runner instead of
// a second static parse: one `node --test` invocation feeds both the normal
// report and this file. See docs/rules/test-rules.md §用例约定.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Transform } from 'node:stream';

// `--test-reporter-destination` opens its file immediately, and the default
// artifact directory is inside the gitignored `.vibe-harness/` tree, so a fresh
// clone has to have it created before the stream is opened. Doing it here keeps
// the package.json test scripts declarative (`--test-reporter=<module>`).
export const OBSERVED_CASES_DIRECTORY = '.vibe-harness/observed-tests';

mkdirSync(path.join(process.cwd(), OBSERVED_CASES_DIRECTORY), { recursive: true });

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

/**
 * Reduce a `test:pass` / `test:fail` event to a ledger-comparable case record.
 *
 * The runner emits an event for the test file itself, using the file path as
 * its name; only `nesting === 0` leaf tests with a `.test.js` file belong in the
 * ledger.
 */
function observedCase(type, data, cwd) {
  if (type !== 'test:pass' && type !== 'test:fail') return null;
  if (!data || data.details?.type !== 'test' || data.nesting !== 0) return null;
  if (typeof data.file !== 'string' || typeof data.name !== 'string') return null;
  const file = toPosix(path.relative(cwd, data.file));
  if (!file.endsWith('.test.js')) return null;
  if (toPosix(data.name) === file || toPosix(data.name).endsWith('.test.js')) return null;
  return { file, name: data.name };
}

export default class TestCaseReporter extends Transform {
  #cases = [];
  #seen = new Set();

  constructor(options = {}) {
    super({ ...options, objectMode: true });
  }

  _transform(chunk, encoding, callback) {
    const entry = observedCase(chunk?.type, chunk?.data, process.cwd());
    if (entry) {
      const key = `${entry.file}\0${entry.name}`;
      if (!this.#seen.has(key)) {
        this.#seen.add(key);
        this.#cases.push(entry);
      }
    }
    callback();
  }

  _flush(callback) {
    const cases = [...this.#cases].sort((left, right) => (
      left.file === right.file ? left.name.localeCompare(right.name) : left.file.localeCompare(right.file)
    ));
    this.push(`${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`);
    callback();
  }
}
