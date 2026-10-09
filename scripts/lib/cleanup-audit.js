// Deterministic stale-asset scanning for `vibe-harness audit --kind cleanup`.
//
// The scanner is strictly read-only: it enumerates the project's non-ignored
// files, extracts cross-file references, and reports findings as audit
// evidence. It never deletes, rewrites, or formats anything. Deletion is a
// separate, explicitly confirmed step performed by the `stale-cleanup` Skill.
//
// Findings are split by confidence. Deterministic findings (missing reference,
// catalog orphan, drift against a tracked index) are backed by an authoritative
// source in the same run. Candidate findings (unreferenced file, unreferenced
// export) are heuristics: dynamic imports, reflection, and external consumers
// can all make a live file look unused, so they stay `info` and require human
// or agent verification before any cleanup.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectEvalSyncPlan } from './eval-projection.js';
import { pathExists } from './manifest.js';
import { auditMemory } from './memory-audit.js';
import { checkSelfInstallConformance } from './self-install-check.js';

const execFileAsync = promisify(execFile);

// Directories that never hold project-owned stale assets: VCS internals,
// installed dependencies, and generated build output. `.agents` mirrors the
// pack sources and is checked through install-state conformance instead.
const IGNORED_DIRECTORY_SEGMENTS = new Set([
  '.gaia', '.git', '.github', '.husky', '.idea', '.next', '.nuxt', '.pnpm-store', '.svn',
  '.turbo', '.vscode', '.vibe-harness', '.yarn', 'build', 'coverage', 'dist', 'node_modules',
  'out', 'target', 'vendor',
]);

// Documentation roots owned by this repository. Other trees are checked
// through their own index (for example `.agents/` through install-state), so a
// general walk here stays generic across target projects.
const GOVERNED_DOC_PREFIXES = ['docs/'];

// Metadata written by codebase-memory-mcp next to its compressed graph.
const INDEX_ARTIFACT_PATH = '.codebase-memory/artifact.json';

// Asset trees where an unreferenced file is a plausible leftover rather than a
// normal module that some entry point imports.
const ASSET_PREFIXES = [
  'assets/', 'docs/', 'evals/', 'examples/', 'fixtures/', 'manifests/', 'prompts/',
  'resources/', 'roles/', 'schemas/', 'scripts/', 'skills/', 'templates/',
];

// Files that are reachable by convention rather than by an explicit reference.
const CONVENTIONAL_ENTRY_NAME = /^(?:index|main|cli|entry|mod)\.[A-Za-z0-9]+$/u;
const CONVENTIONAL_ENTRY_BASENAMES = new Set([
  'agents.md', 'changelog.md', 'code_of_conduct.md', 'contributing.md', 'license', 'license.md',
  'package.json', 'readme.md', 'skill.md', 'tsconfig.json',
]);

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsonc', '.jsx', '.md', '.mjs', '.mts', '.ps1',
  '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml',
]);

// Reference targets that are a documentation convention rather than a project
// asset: research archives, skill-injected reference trees, and self-contained
// example fixtures.
const SKIPPED_REFERENCE_PREFIXES = [
  'example/', 'examples/', 'fixtures/', 'harness-evals/', 'repos/',
];

// Paths quoted inside test code are fixture data, not live project references.
const TEST_DATA_PREFIXES = ['tests/', 'test/', '__tests__/'];

const FIXTURE_MARKER = /(?:[Ff]ixture|FIXTURE|[Ee]xpect|EXPECT|[Ee]xample(?:Path|File|Asset)?)/u;

// Roots whose contents are historical or already covered by another check:
// changelogs, audit reports, and reference inventories describe the project at a
// point in time, `docs/archive/` keeps superseded records, and `.agents/` is
// runtime installation state owned by install conformance. Treating any of them
// as live references would report the archive itself as a stale reference set.
const SKIPPED_REFERENCE_SOURCES = ['.agents/', 'audit-reports/', 'CHANGELOG.md', 'docs/archive/', 'docs/inventory/'];

// Patterns without a literal target: placeholders, globs, and documentation
// conventions such as `docs/adr/ADR-0000-*.md`.
const UNRESOLVED_REFERENCE = /[*?<>{}]|YYYY|\bADR-\d{3,4}-/u;

// Only paths under a known project root are treated as repo references. A bare
// token such as `src/app.ts` in prose belongs to another project or an example,
// so reporting it as a missing project file would be a false positive.
const PROJECT_REFERENCE_PREFIX = /^(?:adapters|docs|evals|examples|manifests|memory|roles|runtime|schemas|scripts|skills|templates|tests|\.github)\//u;

// Evaluation fixtures and the eval harness intentionally describe paths that do
// not exist in this repository.
const SKIPPED_REFERENCE_OWNERS = /^(?:harness-evals\/|evals\/)/u;

// Files whose entire job is to declare paths that are planned, projected, or
// generated rather than existing: install maps, baseline seeds, and the
// documentation catalog. Treating their entries as live references would report
// every projected target as a stale reference.
const PATH_DECLARING_FILES = new Set([
  'adapters/install-map.json',
  'docs/catalog.json',
  'docs/adr/catalog.json',
  'manifests/adapters.json',
  'vibe-harness.config.json',
]);
const PATH_DECLARING_SUFFIX = /(?:baseline|install-map|install-planner)\.(?:json|mjs|js)$/u;

// Dependency trees are never project references.
const DEPENDENCY_PATH = /(?:^|\/)node_modules\//u;

// Eval reference files are produced by `vibe-harness eval reference --write`, so
// a reference path that has not been generated yet is a pending artifact rather
// than a stale one.
const GENERATED_REFERENCE_PREFIXES = ['evals/references/'];

const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(\s*<?([^)>\s]+)/gu;
const PATH_TOKEN_PATTERN = /(?:^|[\s("'`])((?:\.{0,2}\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/gu;
const FENCE_PATTERN = /^\s*(?:```|~~~)/u;
const MARKDOWN_EXTENSIONS = new Set(['.md']);

const NOT_SHIPPED_EXTENSIONS = new Set([
  '.db', '.eot', '.exe', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.map', '.mp4', '.pdf', '.png',
  '.svg', '.tar', '.tgz', '.ttf', '.webp', '.woff', '.woff2', '.zip',
]);

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.vue']);
const EXPORT_PATTERN = /^export\s+(?:(?:abstract\s+)?class|const|enum|function|interface|let|type|var)\s+([A-Za-z_$][\w$]*)/gmu;
const EXPORT_LIST_PATTERN = /^export\s*\{([^}]*)\}/gmu;
const EXPORT_ALIAS_PATTERN = /^export\s*\{[^}]*\bas\s+([A-Za-z_$][\w$]*)/gmu;
const EXPORTED_NAMES_SKIP = new Set(['default']);
const MIN_IDENTIFIER_LENGTH = 6;

const DURABLE_MEMORY_REVIEW_DAYS = 180;
const STALE_DATE_PATTERN = /(?:lastVerified|lastValidated|lastUpdated|reviewBy|最后验证|最后更新|复核日期)[^\S\r\n]*[:：][^\S\r\n]*(\d{4}-\d{2}-\d{2})/giu;

function item(code, severity, message, relativePath) {
  return {
    code,
    severity,
    message,
    ...(relativePath ? { path: String(relativePath).replaceAll('\\', '/') } : {}),
  };
}

function normalize(relativePath) {
  return String(relativePath).replaceAll('\\', '/');
}

function reportStatus(evidence) {
  if (evidence.some((entry) => entry.severity === 'error')) return 'degraded';
  if (evidence.some((entry) => entry.severity === 'warning')) return 'warning';
  return 'healthy';
}

function textExtensionOf(relativePath) {
  return path.posix.extname(relativePath).toLowerCase();
}

function isIgnoredDirectory(relativePath) {
  return normalize(relativePath).split('/').some((segment) => IGNORED_DIRECTORY_SEGMENTS.has(segment));
}

function conventionalEntry(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return CONVENTIONAL_ENTRY_BASENAMES.has(basename) || CONVENTIONAL_ENTRY_NAME.test(basename);
}

function isAssetPath(relativePath) {
  if (!conventionalEntry(relativePath)) {
    for (const prefix of ASSET_PREFIXES) {
      if (relativePath.startsWith(prefix)) return true;
    }
  }
  return relativePath.endsWith('.template.md') || relativePath.endsWith('.template.json');
}

function isCandidateExport(name) {
  return name.length >= MIN_IDENTIFIER_LENGTH && !EXPORTED_NAMES_SKIP.has(name);
}

function exportedNames(content) {
  const names = new Set();
  for (const match of content.matchAll(EXPORT_PATTERN)) names.add(match[1]);
  for (const match of content.matchAll(EXPORT_LIST_PATTERN)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  for (const match of content.matchAll(EXPORT_ALIAS_PATTERN)) names.add(match[1]);
  return [...names];
}

/**
 * Enumerate visible project files through Git so `.gitignore` stays the single
 * source of truth. `--cached --others --exclude-standard` deliberately includes
 * untracked-but-not-ignored files, which is what a cleanup review needs: a
 * freshly written leftover file is not committed yet. Repositories without Git
 * or without a commit yet fall back to tracked entries plus the same enumeration.
 *
 * @param {{targetDir: string}} options
 */
async function listProjectFiles({ targetDir }) {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: targetDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    const seen = new Set();
    return stdout
      .split('\0')
      .map((entry) => normalize(entry.trim()))
      .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
      .filter((entry) => !isIgnoredDirectory(entry))
      .sort();
  } catch {
    return null;
  }
}

async function readTextFiles({ rootDir, files }) {
  const contents = new Map();
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(textExtensionOf(file))) continue;
    try {
      contents.set(file, await readFile(path.join(rootDir, file), 'utf8'));
    } catch {
      // Unreadable or vanishing files are not a cleanup finding; the install
      // and validation surfaces own file-integrity errors.
    }
  }
  return contents;
}

function referenceKindOf(file, { docsCatalogPaths }) {
  if (docsCatalogPaths.has(file)) return 'documentation';
  if (file.startsWith('.agents/')) return 'installed-surface';
  if (file.startsWith('runtime/') || SOURCE_EXTENSIONS.has(textExtensionOf(file))) return 'code';
  return 'asset';
}

function findUnreferencedCandidates({ contents, docsCatalogPaths, files }) {
  const evidence = [];
  const searchable = [...contents.entries()];
  for (const file of files) {
    if (!isAssetPath(file)) continue;
    // Module graphs reference each other by relative specifier, so the full
    // repo-relative path is rarely what appears in the importing file. Matching
    // the basename keeps ESM/CJS imports discoverable while still flagging
    // assets that nothing in the project names at all.
    const basename = path.posix.basename(file);
    const referenced = searchable.some(([candidate, content]) => (
      candidate !== file && (content.includes(file) || content.includes(basename))
    ));
    if (!referenced) evidence.push(item(
      'CLEANUP_UNREFERENCED_FILE',
      'info',
      `No project file references this ${referenceKindOf(file, { docsCatalogPaths })}; verify dynamic use before removing.`,
      file,
    ));
  }
  return evidence;
}

function findOrphanEvalMirrors(plan) {
  return plan.manualActions
    .filter((action) => action.code === 'EVAL_TARGET_ORPHAN')
    .map((action) => item('CLEANUP_ORPHAN_ASSET', 'warning', action.message, action.path));
}

function findSelfInstallOrphans(conformance) {
  return (conformance.orphanedStateTargets ?? [])
    .map((target) => item(
      'CLEANUP_INDEX_STALE',
      'warning',
      'install-state still registers a managed file that no longer exists.',
      target,
    ));
}

/**
 * Read the revision a local code index was built from. The artifact lives in the
 * ignored `.codebase-memory/` directory, which is why this reads it directly
 * instead of walking the scan surface: an index registry is metadata about the
 * project, not a project asset that could itself go stale.
 *
 * @param {{targetDir: string}} options
 */
async function currentCommit({ targetDir }) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: targetDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check the code index. A present artifact makes freshness deterministic: it
 * records the commit and time of the indexing run, so drift is measurable
 * without the MCP server. The semantic queries themselves (`list_projects`,
 * `index_status`) are not reachable from the CLI, so a missing or unreadable
 * artifact is reported as a missing capability rather than as a stale index.
 */
async function findIndexEvidence({ now, targetDir }) {
  const artifactPath = path.join(targetDir, INDEX_ARTIFACT_PATH);
  if (!await pathExists(artifactPath)) {
    return [item(
      'CLEANUP_INDEX_UNAVAILABLE',
      'warning',
      'No code index artifact was found; index freshness needs the codebase-memory-mcp tools (list_projects, index_status).',
    )];
  }
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  } catch {
    return [item(
      'CLEANUP_INDEX_UNAVAILABLE',
      'warning',
      'The code index artifact could not be read; index freshness is unknown.',
      INDEX_ARTIFACT_PATH,
    )];
  }
  const evidence = [];
  const indexedCommit = typeof artifact?.commit === 'string' ? artifact.commit : '';
  const head = await currentCommit({ targetDir });
  if (indexedCommit && head && !head.startsWith(indexedCommit) && !indexedCommit.startsWith(head)) {
    evidence.push(item(
      'CLEANUP_INDEX_STALE',
      'warning',
      `Code index was built at commit ${indexedCommit.slice(0, 12)} but HEAD is ${head.slice(0, 12)}.`,
      INDEX_ARTIFACT_PATH,
    ));
  }
  const indexedAt = Date.parse(String(artifact?.indexed_at ?? ''));
  if (Number.isFinite(indexedAt) && indexedAt < now.getTime() - DURABLE_MEMORY_REVIEW_DAYS * 86400000) {
    evidence.push(item(
      'CLEANUP_INDEX_STALE',
      'info',
      `Code index is older than ${DURABLE_MEMORY_REVIEW_DAYS} days.`,
      INDEX_ARTIFACT_PATH,
    ));
  }
  return evidence;
}

function findStaleMemoryReferences(report) {
  return (report.evidence ?? [])
    .filter((entry) => entry.code === 'MEMORY_REFERENCE_MISSING' && entry.path)
    .map((entry) => item(
      'CLEANUP_REFERENCE_MISSING',
      'warning',
      `Memory references a missing file (${entry.code}): ${entry.message}`,
      entry.path,
    ));
}

function findUnusedExports({ contents, files }) {
  const evidence = [];
  const searchable = [...contents.entries()];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(textExtensionOf(file))) continue;
    const content = contents.get(file);
    if (!content) continue;
    const names = exportedNames(content);
    if (names.length === 0) continue;
    for (const name of names) {
      if (!isCandidateExport(name)) continue;
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u');
      const used = searchable.some(([candidate, other]) => candidate !== file && pattern.test(other));
      if (!used) evidence.push(item(
        'CLEANUP_UNUSED_EXPORT',
        'info',
        `No other project file mentions this export; verify external consumers before removing.`,
        `${file}#${name}`,
      ));
    }
  }
  return evidence;
}

function referenceCandidates(relativePath, content) {
  if (SKIPPED_REFERENCE_SOURCES.some((prefix) => relativePath.startsWith(prefix))) return new Map();
  if (SKIPPED_REFERENCE_OWNERS.test(relativePath)) return new Map();
  if (PATH_DECLARING_FILES.has(relativePath) || PATH_DECLARING_SUFFIX.test(relativePath)) return new Map();
  const markdown = MARKDOWN_EXTENSIONS.has(textExtensionOf(relativePath));
  const tokens = new Map();
  let inFence = false;
  for (const line of content.split(/\r?\n/u)) {
    // A fenced block shows what a configuration, layout, or command looks like.
    // The paths inside it describe other projects or examples, not this one.
    if (markdown && FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Only test code carries fixture data; production sources legitimately read
    // the same path shapes from strings and templates.
    if (relativePath.startsWith('tests/') && FIXTURE_MARKER.test(line)) continue;
    for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
      if (!match[1].includes('://')) tokens.set(match[1], true);
    }
    for (const match of line.matchAll(PATH_TOKEN_PATTERN)) {
      if (!tokens.has(match[1])) tokens.set(match[1], false);
    }
  }
  const base = path.posix.dirname(relativePath);
  const resolved = new Map();
  for (const [token, linked] of tokens) {
    // Interpolated specifiers are built at runtime, so the literal prefix is not
    // a path this repository is expected to contain.
    if (token.includes('${')) continue;
    // Keep the leading `./` until after the relative-path decision: stripping it
    // here would turn an import specifier into a repo-root shape and silently
    // reclassify it.
    const cleaned = token.replace(/[.,;:]+$/u, '');
    if (!cleaned || cleaned.includes('://') || UNRESOLVED_REFERENCE.test(cleaned)) continue;
    const withoutFragment = cleaned.split('#')[0].split('?')[0];
    if (!withoutFragment) continue;
    // Import specifiers and relative markdown links are written relative to the
    // file that contains them, so resolve both shapes against the owner's
    // directory instead of assuming a repo-root path.
    const relativeToOwner = path.posix.normalize(path.posix.join(base, withoutFragment));
    const target = withoutFragment.startsWith('.')
      ? relativeToOwner
      : normalize(withoutFragment).replace(/^\.\//u, '');
    if (!PROJECT_REFERENCE_PREFIX.test(target)) continue;
    const directory = path.posix.dirname(target);
    if (directory === '.') continue;
    if (DEPENDENCY_PATH.test(target)) continue;
    // A markdown link without a leading `./` is ambiguous: it resolves against
    // the linking document, but authors also write repository-root paths. Keep
    // the root reading as the reported target and the document-relative reading
    // as an accepted alternative, so neither convention becomes a false alarm.
    if (linked && relativeToOwner !== target) {
      resolved.set(target, [relativeToOwner]);
      continue;
    }
    resolved.set(target, []);
  }
  return resolved;
}

async function findMissingReferences({ rootDir, contents, files }) {
  const known = new Set(files);
  const candidates = new Map();
  // Test files are excluded as reference owners: they create temporary
  // directory layouts, assert on expected paths, and seed fixtures, so almost
  // every path they mention is intentionally absent from the checkout. Live
  // project references are the ones a production source or document points at.
  for (const [file, content] of contents) {
    if (file.startsWith('docs/schemas/') || file.includes('.generated.')) continue;
    if (TEST_DATA_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    for (const [target, alternates] of referenceCandidates(file, content)) {
      candidates.set(target, [...new Set([...(candidates.get(target) ?? []), ...alternates])]);
    }
  }

  const directoryExists = new Map();
  const missing = [];
  for (const [target, alternates] of candidates) {
    if (!target || target.startsWith('..')) continue;
    if (SKIPPED_REFERENCE_PREFIXES.some((prefix) => target.startsWith(prefix))) continue;
    if (GENERATED_REFERENCE_PREFIXES.some((prefix) => target.startsWith(prefix))) continue;
    if (TEST_DATA_PREFIXES.some((prefix) => target.startsWith(prefix))) continue;
    if (NOT_SHIPPED_EXTENSIONS.has(textExtensionOf(target))) continue;
    if (known.has(target)) continue;
    const directory = path.posix.dirname(target);
    if (!directoryExists.has(directory)) {
      directoryExists.set(directory, await pathExists(path.join(rootDir, directory)));
    }
    if (!directoryExists.get(directory)) continue;
    if (await pathExists(path.join(rootDir, target))) continue;
    if (await anyAlternateExists({ alternates, known, rootDir })) continue;
    missing.push(target);
  }

  return missing.sort().map((target) => item(
    'CLEANUP_REFERENCE_MISSING',
    'error',
    'A project file references a path that does not exist.',
    target,
  ));
}

async function anyAlternateExists({ alternates, known, rootDir }) {
  for (const alternate of alternates) {
    if (!alternate || alternate.startsWith('..')) continue;
    if (known.has(alternate)) return true;
    if (await pathExists(path.join(rootDir, alternate))) return true;
  }
  return false;
}

function findStaleDocumentation({ contents, files, now }) {
  const evidence = [];
  const cutoff = now.getTime() - DURABLE_MEMORY_REVIEW_DAYS * 86400000;
  for (const file of files) {
    if (!GOVERNED_DOC_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    const content = contents.get(file);
    if (!content) continue;
    const dates = [...content.matchAll(STALE_DATE_PATTERN)].map((match) => match[1]).filter(Boolean);
    if (dates.length === 0) continue;
    const newest = dates
      .map((value) => new Date(`${value}T00:00:00.000Z`).getTime())
      .filter((value) => !Number.isNaN(value))
      .sort((left, right) => right - left)[0];
    if (newest && newest < cutoff) {
      evidence.push(item(
        'CLEANUP_DOC_STALE',
        'info',
        `Documentation verification date is older than ${DURABLE_MEMORY_REVIEW_DAYS} days.`,
        file,
      ));
    }
  }
  return evidence;
}

export function mapCatalogEvidence(documentation) {
  const evidence = [];
  for (const message of documentation.errors ?? []) {
    if (message.startsWith('catalog documentation does not exist: ')) {
      evidence.push(item(
        'CLEANUP_DOC_ORPHAN',
        'warning',
        message,
        message.slice('catalog documentation does not exist: '.length),
      ));
      continue;
    }
    if (message.startsWith('governed documentation is missing from catalog: ')) {
      evidence.push(item(
        'CLEANUP_DOC_UNCATALOGED',
        'warning',
        message,
        message.slice('governed documentation is missing from catalog: '.length),
      ));
      continue;
    }
    if (message.includes('references missing current asset: ')) {
      const target = message.split('references missing current asset: ').pop();
      evidence.push(item('CLEANUP_REFERENCE_MISSING', 'warning', message, target));
      continue;
    }
    evidence.push(item('CLEANUP_INDEX_STALE', 'warning', message));
  }
  return evidence;
}

function emptyInventory() {
  return {
    assetsScanned: 0,
    documentsScanned: 0,
    filesScanned: 0,
    memoryFilesScanned: 0,
    referenceSourcesScanned: 0,
    sourceFilesScanned: 0,
  };
}

/**
 * Scan a project for stale assets and return audit evidence.
 *
 * @param {{now?: Date, rootDir: string, targetDir: string}} options
 */
export async function auditCleanup({ now = new Date(), rootDir, targetDir }) {
  const files = await listProjectFiles({ targetDir });
  if (files === null) {
    return {
      status: 'degraded',
      evidence: [item(
        'CLEANUP_ENUMERATION_UNAVAILABLE',
        'error',
        'Project files could not be enumerated; Git is required to respect .gitignore during cleanup audits.',
      )],
      details: { inventory: emptyInventory(), confirmedFindings: 0, candidateFindings: 0 },
    };
  }

  const contents = await readTextFiles({ rootDir: targetDir, files });
  const referenceSources = [...contents.keys()];
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(textExtensionOf(file)));
  const assetFiles = files.filter((file) => isAssetPath(file));
  const docFiles = files.filter((file) => GOVERNED_DOC_PREFIXES.some((prefix) => file.startsWith(prefix)));

  const docsCatalogPaths = new Set();
  const catalogPath = path.join(targetDir, 'docs/catalog.json');
  if (await pathExists(catalogPath)) {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      for (const entry of catalog?.items ?? []) {
        if (typeof entry?.path === 'string') docsCatalogPaths.add(normalize(entry.path));
      }
    } catch {
      // A malformed catalog is reported by documentation validation below.
    }
  }

  const [documentation, memory, evalPlan, conformance] = await Promise.all([
    loadDocumentation({ rootDir: targetDir, now }),
    auditMemory({ now, targetDir }),
    loadEvalPlan({ rootDir: targetDir }),
    loadConformance({ rootDir, targetDir }),
  ]);

  const confirmed = [
    ...await findMissingReferences({ rootDir: targetDir, contents, files }),
    ...await findIndexEvidence({ now, targetDir }),
    ...mapCatalogEvidence(documentation),
    ...findStaleMemoryReferences(memory),
    ...(evalPlan ? findOrphanEvalMirrors(evalPlan) : []),
    ...((evalPlan?.drift ?? []).map((entry) => item(
      'CLEANUP_INDEX_STALE',
      'warning',
      `Eval mirror drifted from its source (${entry.reason}).`,
      entry.target,
    ))),
    ...(conformance?.skipped ? [] : findSelfInstallOrphans(conformance ?? {})),
  ];
  const candidates = [
    ...findUnreferencedCandidates({ contents, docsCatalogPaths, files }),
    ...findUnusedExports({ contents, files }),
    ...findStaleDocumentation({ contents, files, now }),
  ];

  const evidence = [...confirmed, ...candidates]
    .sort((left, right) => left.code.localeCompare(right.code) || (left.path ?? '').localeCompare(right.path ?? ''));

  return {
    status: reportStatus(evidence),
    evidence,
    details: {
      candidateFindings: candidates.length,
      confirmedFindings: confirmed.length,
      filesScanned: files.length,
      inventory: {
        assetsScanned: assetFiles.length,
        documentsScanned: docFiles.length,
        filesScanned: files.length,
        memoryFilesScanned: memory.details?.filesChecked ?? 0,
        referenceSourcesScanned: referenceSources.length,
        sourceFilesScanned: sourceFiles.length,
      },
      skipped: [
        'codebase-memory-mcp semantic queries (list_projects, index_status): not reachable from the CLI; the scanner checks the on-disk index artifact instead.',
        'manifest to source integrity: owned by `vibe-harness validate`, not by cleanup scanning.',
      ],
    },
  };
}

async function loadDocumentation({ rootDir, now }) {
  // Documentation conformance only applies to projects that carry the
  // documentation catalog surface. A project without it is not a cleanup
  // failure, so the scan reports that the check was skipped instead of
  // degrading the whole report.
  const ready = (await pathExists(path.join(rootDir, 'docs/catalog.json')))
    && (await pathExists(path.join(rootDir, 'schemas/docs-catalog.schema.json')));
  if (!ready) return { counts: {}, errors: [], ok: true, skipped: true, warnings: [] };
  const { validateDocumentation } = await import('./docs-validation.js');
  return validateDocumentation({ rootDir, today: now });
}

async function loadEvalPlan({ rootDir }) {
  try {
    return await collectEvalSyncPlan({ rootDir });
  } catch {
    return null;
  }
}

async function loadConformance({ rootDir, targetDir }) {
  try {
    return await checkSelfInstallConformance(rootDir, { targetDir });
  } catch {
    return null;
  }
}
