// Documentation projection sync.
//
// docs-validation.js and adr-validation.js define the documentation contract:
// every governed path is cataloged, docs/schemas/ mirrors schemas/, the indexes
// link every cataloged document, and the ADR catalog plus DECISIONS.md index
// every ADR. This module makes the deterministic part of that contract
// reproducible. It is additive by design: existing catalog entries and index
// lines are never rewritten, and anything that needs an owner decision
// (removed documents, unclassified kinds, unplaceable index links) is reported
// as a manual action instead of being guessed.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ADR_FILE_PATTERN } from './adr-validation.js';
import { collectGovernedPaths, extractLocalLinks } from './docs-validation.js';
import { pathExists, readJson } from './manifest.js';

export const CATALOG_PATH = 'docs/catalog.json';
export const ADR_CATALOG_PATH = 'docs/adr/catalog.json';
export const DECISIONS_PATH = 'docs/memory/DECISIONS.md';
export const PRIMARY_INDEX = 'docs/README.md';
export const ARCHIVE_INDEX = 'docs/archive/README.md';

const ADR_DIRECTORY = 'docs/adr';
const SCHEMA_SOURCE_DIRECTORY = 'schemas';
const SCHEMA_DOCS_DIRECTORY = 'docs/schemas';

/**
 * @typedef {object} DocumentClassification
 * @property {string} kind
 * @property {string} status
 * @property {string} language
 * @property {string[]} audiences
 */

/** @param {string} kind @param {string} status @param {string} language @param {string[]} audiences @returns {DocumentClassification} */
function classify(kind, status, language, audiences) {
  return { kind, status, language, audiences };
}

// Classification table for governed documentation. Every entry states the
// owner-visible meaning of a path family; a path that matches nothing stays
// unclassified so the generator reports it instead of inventing metadata.
const EXACT_CLASSIFICATIONS = new Map([
  ['AGENTS.md', classify('agent-rules', 'current', 'zh-CN', ['agent'])],
  ['CONTRIBUTING.md', classify('contributor-guide', 'current', 'zh-CN', ['contributor', 'agent'])],
  ['README.md', classify('user-guide', 'current', 'zh-CN', ['user'])],
  ['README.en.md', classify('user-guide', 'current', 'en', ['user'])],
  ['CHANGELOG.md', classify('changelog', 'current', 'zh-CN', ['user', 'maintainer'])],
  [PRIMARY_INDEX, classify('index', 'current', 'zh-CN', ['user', 'contributor', 'maintainer', 'auditor'])],
  [ARCHIVE_INDEX, classify('index', 'reference', 'zh-CN', ['auditor'])],
  ['docs/adr/README.md', classify('index', 'current', 'zh-CN', ['contributor', 'maintainer', 'auditor'])],
  [ADR_CATALOG_PATH, classify('index', 'current', 'en', ['contributor', 'maintainer', 'auditor'])],
  ['docs/architecture.md', classify('architecture', 'current', 'zh-CN', ['maintainer', 'contributor'])],
  ['docs/audits.md', classify('operations', 'current', 'zh-CN', ['maintainer', 'contributor'])],
  ['docs/evals.md', classify('operations', 'current', 'zh-CN', ['maintainer', 'contributor'])],
  ['docs/github-delivery.md', classify('operations', 'current', 'zh-CN', ['maintainer', 'contributor'])],
  ['docs/hooks.md', classify('operations', 'current', 'zh-CN', ['maintainer', 'contributor'])],
  ['docs/roles.md', classify('user-guide', 'current', 'zh-CN', ['user', 'contributor', 'maintainer'])],
  ['docs/migration-guide.md', classify('migration', 'current', 'zh-CN', ['user', 'maintainer'])],
  ['templates/adr/adr-template.md', classify('plan', 'current', 'bilingual', ['contributor', 'maintainer'])],
]);

const PREFIX_CLASSIFICATIONS = [
  { entry: classify('agent-rules', 'current', 'zh-CN', ['agent', 'contributor', 'maintainer']), pattern: /^docs\/rules\/[^/]+\.md$/u },
  { entry: classify('spec', 'implemented', 'zh-CN', ['maintainer', 'auditor']), pattern: /^docs\/specs\/[^/]+\.md$/u },
  { entry: classify('inventory', 'reference', 'zh-CN', ['auditor', 'maintainer']), pattern: /^docs\/inventory\/[^/]+\.md$/u },
  { entry: classify('operations', 'current', 'zh-CN', ['maintainer', 'agent']), pattern: /^docs\/memory\/[^/]+\.md$/u },
  { entry: classify('plan', 'current', 'zh-CN', ['agent', 'maintainer']), pattern: /^docs\/templates\/[^/]+\.md$/u },
  { entry: classify('spec', 'current', 'en', ['contributor', 'maintainer', 'auditor']), pattern: /^docs\/schemas\/[^/]+\.json$/u },
  { entry: classify('spec', 'current', 'en', ['contributor', 'maintainer']), pattern: /^schemas\/[^/]+\.json$/u },
];

// ADRs carry an owner-chosen language and lifecycle status, so they are only
// classified through an explicit override (adr:new supplies one) or a human
// catalog edit.
export const ADR_PATH_PATTERN = /^docs\/adr\/ADR-\d{4}-[^/]+\.md$/u;

/**
 * Classify a governed documentation path.
 *
 * @param {string} relativePath
 * @returns {DocumentClassification|null}
 */
export function classifyGovernedPath(relativePath) {
  const normalized = normalize(relativePath);
  if (ADR_PATH_PATTERN.test(normalized)) return null;
  const exact = EXACT_CLASSIFICATIONS.get(normalized);
  if (exact) return { ...exact, audiences: [...exact.audiences] };
  for (const rule of PREFIX_CLASSIFICATIONS) {
    if (rule.pattern.test(normalized)) return { ...rule.entry, audiences: [...rule.entry.audiences] };
  }
  return null;
}

function normalize(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

async function readText(rootDir, relativePath) {
  return readFile(path.join(rootDir, relativePath), 'utf8');
}

/** Resolve one index file's relative links to repo-relative paths. */
async function collectIndexedPaths(rootDir, indexFile) {
  if (!(await pathExists(path.join(rootDir, indexFile)))) return null;
  const content = await readText(rootDir, indexFile);
  const indexed = new Set();
  for (const target of extractLocalLinks(content)) {
    const resolved = path.resolve(rootDir, path.dirname(indexFile), target);
    indexed.add(normalize(path.relative(rootDir, resolved)));
  }
  indexed.add(normalize(indexFile));
  return indexed;
}

function indexFor(relativePath) {
  if (relativePath === PRIMARY_INDEX || relativePath === ARCHIVE_INDEX) return null;
  if (relativePath.startsWith('docs/archive/')) return ARCHIVE_INDEX;
  if (relativePath.startsWith('docs/')) return PRIMARY_INDEX;
  return null;
}

/** Read the first level-one heading of a document, falling back to its name. */
async function documentTitle(rootDir, relativePath) {
  if (!relativePath.endsWith('.md')) return path.posix.basename(relativePath);
  const content = await readText(rootDir, relativePath);
  const heading = content.match(/^#\s+(.+)$/mu);
  return heading ? heading[1].trim() : path.posix.basename(relativePath, '.md');
}

/** Collect the index links the contract requires but the index files lack. */
async function collectIndexGaps(rootDir, candidatePaths) {
  const byIndex = new Map([[PRIMARY_INDEX, []], [ARCHIVE_INDEX, []]]);
  const unplaced = [];
  for (const candidate of candidatePaths) {
    const indexFile = indexFor(candidate);
    if (!indexFile) continue;
    const indexed = await collectIndexedPaths(rootDir, indexFile);
    if (!indexed) { unplaced.push({ index: indexFile, path: candidate, reason: 'missing-index-file' }); continue; }
    if (indexed.has(candidate)) continue;
    const target = normalize(path.relative(path.dirname(indexFile), candidate));
    const anchor = await findIndexAnchor(rootDir, indexFile, candidate);
    const gap = { index: indexFile, path: candidate, target, title: await documentTitle(rootDir, candidate) };
    if (anchor < 0) unplaced.push({ ...gap, reason: 'no-same-directory-anchor' });
    else byIndex.get(indexFile).push({ ...gap, anchor });
  }
  return {
    byIndex: [...byIndex.entries()].filter(([, items]) => items.length > 0).map(([index, items]) => ({ index, items })),
    unplaced,
  };
}

// Anchor a new index line after the last existing link to the same directory so
// generated entries land next to their siblings instead of at the file end.
async function findIndexAnchor(rootDir, indexFile, candidatePath) {
  const lines = (await readText(rootDir, indexFile)).split(/\r?\n/u);
  const directory = path.posix.dirname(normalize(candidatePath));
  let anchor = -1;
  for (const [lineIndex, line] of lines.entries()) {
    for (const target of extractLocalLinks(line)) {
      const resolved = normalize(path.relative(rootDir, path.resolve(rootDir, path.dirname(indexFile), target)));
      if (path.posix.dirname(resolved) === directory) anchor = lineIndex;
    }
  }
  return anchor;
}

/** Collect byte-level drift between schemas/ and its docs/schemas/ mirror. */
async function collectSchemaDrift(rootDir) {
  const docsDir = path.join(rootDir, SCHEMA_DOCS_DIRECTORY);
  if (!(await pathExists(docsDir))) return [];
  const drift = [];
  for (const entry of await readdir(docsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = `${SCHEMA_DOCS_DIRECTORY}/${entry.name}`;
    const sourcePath = path.join(rootDir, SCHEMA_SOURCE_DIRECTORY, entry.name);
    if (!(await pathExists(sourcePath))) {
      drift.push({ path: relativePath, reason: 'missing-source' });
      continue;
    }
    const sourceContent = await readFile(sourcePath, 'utf8');
    const docsContent = await readText(rootDir, relativePath);
    if (normalizeLineEndings(sourceContent) !== normalizeLineEndings(docsContent)) {
      drift.push({ path: relativePath, reason: 'content-drift' });
    }
  }
  return drift.sort((left, right) => left.path.localeCompare(right.path));
}

/** List ADR documents and their parsed front matter fields. */
async function readAdrDocuments(rootDir) {
  const adrDir = path.join(rootDir, ADR_DIRECTORY);
  if (!(await pathExists(adrDir))) return [];
  const documents = [];
  for (const entry of await readdir(adrDir, { withFileTypes: true })) {
    if (!entry.isFile() || !ADR_FILE_PATTERN.test(entry.name)) continue;
    const relativePath = `${ADR_DIRECTORY}/${entry.name}`;
    const content = await readText(rootDir, relativePath);
    const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u)?.[1] ?? '';
    const field = (name) => frontMatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'mu'))?.[1]?.trim().replace(/^['"]|['"]$/gu, '') ?? '';
    documents.push({
      id: entry.name.match(ADR_FILE_PATTERN)[1] ? `ADR-${entry.name.match(ADR_FILE_PATTERN)[1]}` : null,
      path: relativePath,
      status: field('status'),
      title: field('title'),
    });
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectAdrCatalogGaps(rootDir) {
  const documents = await readAdrDocuments(rootDir);
  if (documents.length === 0) return { missing: [], stale: [], documents };
  const catalog = await readJson(path.join(rootDir, ADR_CATALOG_PATH)).catch(() => null);
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const catalogIds = new Set(items.map((item) => item?.id));
  const catalogPaths = new Set(items.map((item) => normalize(item?.path)));
  const missing = documents.filter((document) => !catalogIds.has(document.id) || !catalogPaths.has(document.path));
  const knownPaths = new Set(documents.map((document) => document.path));
  const stale = items.filter((item) => !knownPaths.has(normalize(item?.path))).map((item) => normalize(item?.path));
  return { missing, stale, documents };
}

async function collectDecisionGaps(rootDir, summaries, documents) {
  if (documents.length === 0 || !(await pathExists(path.join(rootDir, DECISIONS_PATH)))) return [];
  const content = await readText(rootDir, DECISIONS_PATH);
  return documents
    .filter((document) => !content.includes(document.id))
    .map((document) => ({
      ...document,
      summary: summaries[document.path] ?? document.title,
      target: normalize(path.relative(path.dirname(DECISIONS_PATH), document.path)),
    }));
}

/**
 * Build the documentation sync plan without writing anything.
 *
 * @param {{rootDir: string, catalogOverrides?: Record<string, DocumentClassification>, decisionsSummaries?: Record<string, string>}} options
 */
export async function collectDocSyncPlan({ rootDir, catalogOverrides = {}, decisionsSummaries = {} }) {
  const catalog = await readJson(path.join(rootDir, CATALOG_PATH));
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const catalogedPaths = new Set(items.map((item) => normalize(item?.path)));
  const governedPaths = await collectGovernedPaths(rootDir);
  const governedSet = new Set(governedPaths);

  const catalogMissing = [];
  const catalogUnclassified = [];
  for (const candidate of governedPaths) {
    if (catalogedPaths.has(candidate)) continue;
    const classification = catalogOverrides[candidate] ?? classifyGovernedPath(candidate);
    if (!classification) { catalogUnclassified.push(candidate); continue; }
    catalogMissing.push({ path: candidate, ...classification });
  }

  const catalogDangling = [];
  const catalogUnmanaged = [];
  for (const candidate of catalogedPaths) {
    if (!(await pathExists(path.join(rootDir, candidate)))) catalogDangling.push(candidate);
    else if (!governedSet.has(candidate)) catalogUnmanaged.push(candidate);
  }

  const schemaDrift = await collectSchemaDrift(rootDir);
  const adr = await collectAdrCatalogGaps(rootDir);
  const decisions = await collectDecisionGaps(rootDir, decisionsSummaries, adr.documents);
  // A catalog entry whose file is gone must not gain an index link; the
  // dangling path is reported as a manual action instead.
  const dangling = new Set(catalogDangling);
  const projectable = [
    ...[...catalogedPaths].filter((candidate) => !dangling.has(candidate)),
    ...catalogMissing.map((item) => item.path),
  ];
  const indexMissing = await collectIndexGaps(rootDir, projectable);

  const manualActions = [
    ...catalogDangling.map((file) => ({ code: 'CATALOG_DANGLING_PATH', message: `docs/catalog.json lists a missing file: ${file}`, path: file })),
    ...catalogUnmanaged.map((file) => ({ code: 'CATALOG_UNMANAGED_PATH', message: `docs/catalog.json lists a path that is not governed documentation: ${file}`, path: file })),
    ...catalogUnclassified.map((file) => ({ code: 'GOVERNED_PATH_UNCLASSIFIED', message: `no catalog classification rule for ${file}; add a rule or a manual catalog entry`, path: file })),
    ...schemaDrift.filter((item) => item.reason === 'missing-source').map((item) => ({ code: 'SCHEMA_SOURCE_MISSING', message: `${item.path} has no schemas/ source`, path: item.path })),
    ...indexMissing.unplaced.map((item) => ({ code: 'INDEX_LINK_UNPLACED', message: `${item.index} needs a link to ${item.path} (${item.reason})`, path: item.path })),
  ].sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));

  const fixable = {
    adrCatalog: adr.missing,
    catalog: catalogMissing,
    decisions,
    index: indexMissing.byIndex,
    schemas: schemaDrift.filter((item) => item.reason !== 'missing-source'),
  };
  const fixableCount = adr.missing.length + catalogMissing.length + decisions.length
    + indexMissing.byIndex.reduce((total, group) => total + group.items.length, 0)
    + fixable.schemas.length;

  return { fixable, fixableCount, governedCount: governedPaths.length, manualActions, ok: fixableCount === 0 && manualActions.length === 0 };
}

/** Append JSON objects to an indented `items` array without reformatting the file. */
async function appendCatalogEntries(rootDir, relativePath, entries) {
  if (entries.length === 0) return false;
  const fullPath = path.join(rootDir, relativePath);
  const raw = await readFile(fullPath, 'utf8');
  const parsed = await readJson(fullPath);
  const marker = '\n  ]\n}';
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`${relativePath} must end with an indented items array`);
  const body = entries
    .map((item) => JSON.stringify(item, null, 2).split('\n').map((line) => `    ${line}`).join('\n'))
    .join(',\n');
  const separator = (parsed?.items?.length ?? 0) > 0 ? ',\n' : '\n';
  await writeFile(fullPath, raw.slice(0, markerIndex) + separator + body + raw.slice(markerIndex), 'utf8');
  return true;
}

async function insertIndexLinks(rootDir, group) {
  if (group.items.length === 0) return false;
  const fullPath = path.join(rootDir, group.index);
  const lines = (await readText(rootDir, group.index)).split(/\r?\n/u);
  // Insert from the bottom up so earlier anchors stay valid.
  for (const item of [...group.items].sort((left, right) => right.anchor - left.anchor)) {
    lines.splice(item.anchor + 1, 0, `- [${item.title}](${item.target})`);
  }
  await writeFile(fullPath, lines.join('\n'), 'utf8');
  return true;
}

async function appendDecisionEntries(rootDir, entries) {
  if (entries.length === 0) return false;
  const fullPath = path.join(rootDir, DECISIONS_PATH);
  const lines = (await readText(rootDir, DECISIONS_PATH)).split(/\r?\n/u);
  const anchor = lines.reduce((found, line, index) => (line.trim().startsWith('- **ADR-') ? index : found), -1);
  const rendered = entries.map((item) => `- **${item.id}** ${item.title} - ${item.status} - ${item.summary} - [ADR](${item.target})`);
  if (anchor < 0) lines.push('', ...rendered);
  else lines.splice(anchor + 1, 0, ...rendered);
  await writeFile(fullPath, lines.join('\n'), 'utf8');
  return true;
}

async function copySchemaMirrors(rootDir, drift) {
  let written = false;
  for (const item of drift) {
    const name = path.posix.basename(item.path);
    await writeFile(path.join(rootDir, item.path), await readFile(path.join(rootDir, SCHEMA_SOURCE_DIRECTORY, name)));
    written = true;
  }
  return written;
}

/**
 * Apply the fixable parts of a documentation sync plan.
 *
 * @param {{rootDir: string, plan: Awaited<ReturnType<typeof collectDocSyncPlan>>}} options
 * @returns {Promise<string[]>} repo-relative paths that changed.
 */
export async function applyDocSync({ rootDir, plan }) {
  const written = [];
  for (const group of plan.fixable.index) {
    if (await insertIndexLinks(rootDir, group)) written.push(group.index);
  }
  if (await appendCatalogEntries(rootDir, CATALOG_PATH, plan.fixable.catalog)) written.push(CATALOG_PATH);
  if (await appendCatalogEntries(rootDir, ADR_CATALOG_PATH, plan.fixable.adrCatalog.map((item) => ({ id: item.id, path: item.path })))) written.push(ADR_CATALOG_PATH);
  if (await appendDecisionEntries(rootDir, plan.fixable.decisions)) written.push(DECISIONS_PATH);
  if (await copySchemaMirrors(rootDir, plan.fixable.schemas)) {
    for (const item of plan.fixable.schemas) written.push(item.path);
  }
  return written;
}

// Shared entry point for docs:sync and adr:new. A check run reports the plan;
// a write run applies the fixable part and re-plans so the caller always reads
// the post-write state instead of assuming the write succeeded.
/**
 * @param {{rootDir: string, write?: boolean, catalogOverrides?: Record<string, DocumentClassification>, decisionsSummaries?: Record<string, string>}} options
 */
export async function runDocSync({ rootDir, write = false, catalogOverrides = {}, decisionsSummaries = {} }) {
  const initial = await collectDocSyncPlan({ rootDir, catalogOverrides, decisionsSummaries });
  const written = write ? await applyDocSync({ rootDir, plan: initial }) : [];
  const plan = write ? await collectDocSyncPlan({ rootDir, catalogOverrides, decisionsSummaries }) : initial;
  return { plan, written };
}
