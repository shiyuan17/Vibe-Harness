#!/usr/bin/env node
// Test-case ledger for this repository (docs/rules/test-rules.md §用例约定).
//
// `sync` walks the five layer directories, reads the declared `test(...)` names
// in declaration order and rewrites tests/cases.json. `check` re-validates the
// ledger structure and, when runtime enumeration is supplied, compares it with
// what node:test actually reported. The ledger is a repository-local practice:
// `tests/` is not part of the published pack, so nothing here leaks into
// installed projects.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateJsonAgainstSchema } from './lib/manifest.js';
import { onDiskTestFiles, TEST_LAYERS } from './lib/test-enumeration.js';

export const LEDGER_PATH = 'tests/cases.json';
export const LEDGER_SCHEMA_PATH = 'tests/cases.schema.json';

export const LAYER_PREFIXES = { unit: 'U', component: 'C', integration: 'I', e2e: 'E', matrix: 'M' };
export const RISK_LEVELS = ['low', 'standard', 'high'];
export const STATUSES = ['active', 'quarantined', 'retired'];
export const SOURCES = ['migration', 'declared'];

const LAYER_ORDER = TEST_LAYERS.map((item) => item.layer);
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;

function toPosix(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function unescapeLiteral(raw) {
  return raw.replace(/\\(.)/gu, (match, character) => ({
    n: '\n',
    r: '\r',
    t: '\t',
  }[character] ?? character));
}

/**
 * Read the declared `test('<name>', ...)` names of a test file in declaration
 * order. Only literal names are ledger-able; a computed name is reported so the
 * author can switch to a literal instead of silently losing the case.
 *
 * @param {string} source test file contents
 * @returns {{ names: string[], unsupported: number[] }}
 */
export function scanDeclarations(source) {
  const names = [];
  const unsupported = [];
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^[ \t]*test\(\s*(.)/u.exec(lines[index]);
    if (!match) continue;
    const quote = match[1];
    if (!['\'', '"', '`'].includes(quote)) {
      unsupported.push(index + 1);
      continue;
    }
    let cursor = match[0].length;
    let text = '';
    let closed = false;
    for (let line = index; line < lines.length && !closed; line += 1) {
      const chunk = lines[line];
      while (cursor < chunk.length) {
        const character = chunk[cursor];
        if (character === '\\') {
          const next = chunk[cursor + 1] ?? '';
          text += unescapeLiteral(`\\${next}`);
          cursor += 2;
          continue;
        }
        if (character === quote) {
          closed = true;
          break;
        }
        text += character;
        cursor += 1;
      }
      if (!closed && line < lines.length - 1) {
        text += '\n';
        cursor = 0;
      }
    }
    if (closed) names.push(text);
  }
  return { names, unsupported };
}

function layerOf(file) {
  const layer = LAYER_ORDER.find((name) => file.startsWith(`tests/${name}/`));
  return layer ?? null;
}

function stemOf(file) {
  return path.basename(file, '.test.js');
}

function idFor(layer, file, ordinal) {
  return [LAYER_PREFIXES[layer], stemOf(file), String(ordinal).padStart(3, '0')].join('-');
}

function identityOf(entry) {
  return `${toPosix(entry.file)}\0${entry.name}`;
}

const PLACEHOLDER_PATTERN = /\$\{[^}]*\}/gu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Build the matcher for a parameterized (table-driven) declaration name.
 *
 * Such a declaration carries `${...}` placeholders in its literal name and
 * expands into one runtime case per table row. The ledger keeps one entry per
 * declaration, so the runtime comparison matches the concrete names against
 * those placeholders instead of demanding a literal equality.
 *
 * @param {string} name declared or ledgered case name
 * @returns {RegExp|null} matcher for the expanded names, or null when literal
 */
export function nameMatcher(name) {
  const parts = String(name ?? '').split(PLACEHOLDER_PATTERN);
  if (parts.length === 1) return null;
  return new RegExp(`^${parts.map((part) => escapeRegExp(part)).join('[\\s\\S]*')}$`, 'u');
}

function indexNames(list) {
  const byFile = new Map();
  for (const item of list) {
    const file = toPosix(item?.file ?? '');
    let bucket = byFile.get(file);
    if (!bucket) {
      bucket = { exact: new Set(), names: [], patterns: [] };
      byFile.set(file, bucket);
    }
    const name = String(item?.name ?? '');
    bucket.exact.add(name);
    bucket.names.push(name);
    const matcher = nameMatcher(name);
    if (matcher) bucket.patterns.push(matcher);
  }
  return byFile;
}

function isCovered(index, item) {
  const bucket = index.get(toPosix(item?.file ?? ''));
  if (!bucket) return false;
  const name = String(item?.name ?? '');
  if (bucket.exact.has(name)) return true;
  if (bucket.patterns.some((matcher) => matcher.test(name))) return true;
  // Reverse direction: a placeholder entry is covered when some concrete name
  // on the other side expands from it.
  const matcher = nameMatcher(name);
  return matcher ? bucket.names.some((candidate) => matcher.test(candidate)) : false;
}

/**
 * Enumerate the cases declared by the layer test files on disk.
 *
 * @param {string} rootDir repository root
 * @param {{layer?: string}} [options]
 */
export async function enumerateDeclaredCases(rootDir, { layer } = {}) {
  const { onDisk } = await onDiskTestFiles(rootDir);
  const declared = [];
  const problems = [];
  const files = onDisk
    .filter((file) => (layer ? file.startsWith(`tests/${layer}/`) : true))
    .sort((left, right) => {
      const leftLayer = LAYER_ORDER.indexOf(layerOf(left));
      const rightLayer = LAYER_ORDER.indexOf(layerOf(right));
      if (leftLayer !== rightLayer) return leftLayer - rightLayer;
      return left.localeCompare(right);
    });
  for (const file of files) {
    const fileLayer = layerOf(file);
    if (!fileLayer) {
      problems.push({ code: 'catalog-unknown-layer', file });
      continue;
    }
    const source = await readFile(path.join(rootDir, file), 'utf8');
    const { names, unsupported } = scanDeclarations(source);
    for (const line of unsupported) problems.push({ code: 'catalog-dynamic-name', file, line });
    names.forEach((name, index) => {
      declared.push({
        file,
        id: idFor(fileLayer, file, index + 1),
        layer: fileLayer,
        name,
        ordinal: index + 1,
        stem: stemOf(file),
      });
    });
  }
  return { declared, problems };
}

/**
 * Merge the declared cases into a ledger.
 *
 * The ID is derived from the file and the declaration ordinal, so it always
 * matches what `check` recomputes: renaming a case keeps its ID, and inserting
 * one in the middle shifts the ordinals below it and therefore their IDs. The
 * metadata that describes the case rather than its position (`legacy`, `risk`,
 * `addedAt`, ...) travels with the case name, so a newly inserted case stays a
 * declared case instead of inheriting the migration flag of the case it
 * displaced.
 *
 * @param {{file: string, id: string, layer: string, name: string, ordinal: number}[]} declared
 * @param {{addedAt?: string, ledgerSeed?: boolean, previous?: any[]}} [options]
 */
export function buildLedger(declared, { addedAt, ledgerSeed = false, previous = [] } = {}) {
  const previousByKey = new Map();
  for (const entry of previous) previousByKey.set(identityOf(entry), entry);
  const entries = declared.map((entry) => {
    const prior = previousByKey.get(identityOf(entry));
    return {
      ...(prior ?? {}),
      id: entry.id,
      layer: entry.layer,
      file: entry.file,
      ordinal: entry.ordinal,
      name: entry.name,
      legacy: prior?.legacy ?? ledgerSeed,
      risk: prior?.risk ?? 'standard',
      owner: prior?.owner ?? 'maintainers',
      source: prior?.source ?? (ledgerSeed ? 'migration' : 'declared'),
      status: prior?.status ?? 'active',
      addedAt: prior?.addedAt ?? addedAt,
      ...(prior?.techDebtId ? { techDebtId: prior.techDebtId } : {}),
    };
  });
  entries.sort((left, right) => {
    const leftLayer = LAYER_ORDER.indexOf(left.layer);
    const rightLayer = LAYER_ORDER.indexOf(right.layer);
    if (leftLayer !== rightLayer) return leftLayer - rightLayer;
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    return left.ordinal - right.ordinal;
  });
  return entries;
}

function stableStringify(value, indent = 2) {
  return `${JSON.stringify(value, null, indent)}\n`;
}

export function ledgerDocument(entries) {
  return { schemaVersion: 1, layers: LAYER_ORDER, cases: entries };
}

/**
 * Validate the ledger shape and its cross-references. `observed` is the runtime
 * enumeration produced by scripts/lib/test-case-reporter.mjs.
 *
 * @param {{ledger?: any, schema?: any, declared?: any[]|null, observed?: any[]|null, observedLayers?: string[]|null, strict?: boolean}} [options]
 */
export async function checkLedger({
  ledger, schema, declared = null, observed = null, observedLayers = null, strict = false,
} = {}) {
  const errors = [];
  const warnings = [];
  const push = (code, detail) => errors.push({ code, ...detail });
  const warn = (code, detail) => warnings.push({ code, ...detail });

  for (const error of validateJsonAgainstSchema(ledger, schema, 'tests/cases.json') ?? []) {
    push('ledger-schema-error', { detail: error });
  }
  const entries = Array.isArray(ledger?.cases) ? ledger.cases : [];

  const seenIds = new Set();
  const seenKeys = new Set();
  for (const entry of entries) {
    const id = String(entry?.id ?? '');
    if (seenIds.has(id)) push('ledger-duplicate-id', { id });
    seenIds.add(id);

    const file = toPosix(entry?.file ?? '');
    const key = identityOf(entry);
    if (seenKeys.has(key)) push('ledger-duplicate-entry', { file, name: entry?.name });
    seenKeys.add(key);

    const layer = layerOf(file);
    if (!layer) {
      push('ledger-unknown-layer', { file, id });
    } else if (layer !== entry?.layer) {
      push('ledger-layer-mismatch', { actual: layer, declared: entry?.layer, file, id });
    } else if (id !== idFor(layer, file, entry?.ordinal)) {
      push('ledger-id-mismatch', { expected: idFor(layer, file, entry?.ordinal), id });
    }

    if (entry?.status === 'quarantined' && !entry?.techDebtId) {
      push('ledger-quarantine-without-tech-debt', { id });
    }
    if (entry?.legacy === false && !CJK_PATTERN.test(String(entry?.name ?? ''))) {
      warn('ledger-name-language', { id, name: entry?.name });
    }
  }

  // Two independent truth sources share the same problem codes: the declared
  // cases on disk (`pnpm check`, no test run) and the runtime enumeration of a
  // real `node --test` invocation (full gate). Table-driven declarations expand
  // to many runtime cases, so a placeholder name in the ledger covers every
  // concrete name it matches.
  const ledgerNames = indexNames(entries);
  for (const [kind, source] of [['declared', declared], ['observed', observed]]) {
    if (!Array.isArray(source)) continue;
    const sourceNames = indexNames(source);
    // A partial runtime comparison (for example only the L1/L2 layers of the
    // fast gate) must not report the layers it never ran as stale.
    const scope = kind === 'observed' && Array.isArray(observedLayers) ? new Set(observedLayers) : null;
    for (const item of source) {
      if (!isCovered(ledgerNames, item)) {
        push('ledger-missing-entry', { file: toPosix(item.file), name: item.name, via: kind });
      }
    }
    for (const item of entries) {
      if (scope && !scope.has(layerOf(toPosix(item.file)))) continue;
      if (!isCovered(sourceNames, item)) {
        push('ledger-stale-entry', { file: toPosix(item.file), name: item.name, via: kind });
      }
    }
  }

  if (strict) {
    errors.push(...warnings.splice(0, warnings.length).map((item) => ({ ...item, code: item.code, strict: true })));
  }
  return { errors, warnings, status: errors.length === 0 ? 'clean' : 'drift' };
}

async function readLedger(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, LEDGER_PATH), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readObserved(rootDir, files) {
  const cases = [];
  for (const file of files) {
    const document = JSON.parse(await readFile(path.resolve(rootDir, file), 'utf8'));
    for (const entry of document.cases ?? []) cases.push(entry);
  }
  return cases;
}

function printUsage() {
  console.log('Usage: node scripts/tests-catalog.js <sync|check> [options]');
  console.log();
  console.log('  sync  [--layer <l>] [--write] [--json]   Regenerate tests/cases.json from declared cases.');
  console.log('  check [--observed <file>]... [--strict] [--json]');
  console.log('        Validate the ledger structure and compare with runtime enumeration.');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options = { json: false, layers: [], observed: [], strict: false, write: false };
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--write') options.write = true;
    else if (token === '--strict') options.strict = true;
    else if (token === '--json') options.json = true;
    else if (token === '--layer') options.layers.push(args.shift());
    else if (token === '--observed') options.observed.push(args.shift());
    else {
      console.error(`tests-catalog: unknown argument: ${token}`);
      printUsage();
      process.exit(1);
    }
  }
  if (!command || !['sync', 'check'].includes(command)) {
    printUsage();
    process.exit(command ? 1 : 0);
  }
  for (const layer of options.layers) {
    if (!LAYER_ORDER.includes(layer)) {
      console.error(`tests-catalog: unknown layer: ${layer}`);
      process.exit(1);
    }
  }
  const rootDir = process.cwd();
  const schema = JSON.parse(await readFile(path.join(rootDir, LEDGER_SCHEMA_PATH), 'utf8'));

  if (command === 'sync') {
    const previous = (await readLedger(rootDir))?.cases ?? [];
    const ledgerSeed = previous.length === 0;
    const { declared, problems } = await enumerateDeclaredCases(rootDir, { layer: options.layers[0] });
    const scope = options.layers.length > 0
      ? previous.filter((entry) => !options.layers.includes(layerOf(toPosix(entry.file))))
      : [];
    const entries = buildLedger(declared, { addedAt: today(), ledgerSeed, previous });
    const merged = [...entries, ...scope].sort((left, right) => {
      const leftLayer = LAYER_ORDER.indexOf(left.layer);
      const rightLayer = LAYER_ORDER.indexOf(right.layer);
      if (leftLayer !== rightLayer) return leftLayer - rightLayer;
      if (left.file !== right.file) return left.file.localeCompare(right.file);
      return left.ordinal - right.ordinal;
    });
    const document = ledgerDocument(merged);
    const added = merged.filter((entry) => !previous.some((item) => identityOf(item) === identityOf(entry)));
    const removed = previous.filter((entry) => !merged.some((item) => identityOf(item) === identityOf(entry)));
    if (options.write) {
      await writeFile(path.join(rootDir, LEDGER_PATH), stableStringify(document), 'utf8');
    }
    const report = {
      command: 'sync',
      cases: merged.length,
      added: added.length,
      removed: removed.length,
      problems,
      removedDetail: removed.map((entry) => ({ file: entry.file, name: entry.name })),
      wrote: options.write,
    };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`tests-catalog sync: ${merged.length} case(s), +${added.length} -${removed.length}${options.write ? '' : ' (dry-run, pass --write)'}`);
      for (const problem of problems) console.log(`  ${problem.code} ${problem.file}${problem.line ? `:${problem.line}` : ''}`);
      for (const entry of removed) console.log(`  removed ${entry.layer} ${entry.file} — ${entry.name}`);
    }
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  const ledger = await readLedger(rootDir);
  if (!ledger) {
    console.error(`tests-catalog: ${LEDGER_PATH} is missing; run "pnpm tests:catalog sync --write".`);
    process.exit(1);
  }
  const { declared, problems } = await enumerateDeclaredCases(rootDir);
  const observed = options.observed.length > 0 ? await readObserved(rootDir, options.observed) : null;
  const observedLayers = observed
    ? [...new Set(observed.map((entry) => layerOf(toPosix(entry.file))).filter(Boolean))]
    : null;
  const result = await checkLedger({
    declared, ledger, observed, observedLayers, schema, strict: options.strict,
  });
  const report = {
    command: 'check',
    cases: ledger.cases.length,
    declared: declared.length,
    observed: observed?.length ?? null,
    problems,
    ...result,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`tests-catalog check: ${ledger.cases.length} ledger case(s), ${declared.length} declared case(s), ${observed?.length ?? 0} observed case(s), ${result.status}`);
    for (const error of result.errors) console.log(`  error ${error.code} ${JSON.stringify(error)}`);
    for (const warning of result.warnings) console.log(`  warning ${warning.code} ${JSON.stringify(warning)}`);
  }
  if (result.errors.length > 0 || problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
