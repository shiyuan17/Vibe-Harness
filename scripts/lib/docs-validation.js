import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import {
  assertPortableRelativePath,
  pathExists,
  readJson,
  validateJsonAgainstSchema,
} from './manifest.js';

const historicalStatuses = new Set(['completed', 'superseded']);
const relativeTimePattern = /(?:今天|昨天|刚刚|最近|上周|\btoday\b|\byesterday\b|\brecently\b)/iu;
const openItemPattern = /(?:待办|未决|暂缓|搁置|待评估|仍未|观察期再评估|TODO)/iu;
const datePattern = /\b(\d{4}-\d{2}-\d{2})\b/gu;
const legacyBrandPattern = /LoopEngine|loopengine|LOOPENGINE/u;
const legacyBrandFullyAllowedPrefixes = [
  'audit-reports/',
  'docs/archive/',
  'tests/',
];
const legacyBrandFullyAllowedFiles = new Set([
  'docs/catalog.json',
  'docs/migration-guide.md',
  'scripts/lib/docs-validation.js',
  'scripts/lib/project-layout.js',
  // .gitignore legitimately ignores leftover legacy state directories; this is
  // compatibility bookkeeping, not a brand reference.
  '.gitignore',
]);
const repositoryScanExcludedDirectories = new Set([
  '.agents',
  '.codebase-memory',
  '.codegraph',
  '.codex',
  '.cognis',
  '.cursor',
  '.git',
  '.githooks',
  '.loopengine',
  '.zcode',
  'coverage',
  'dist',
  'node_modules',
  'output',
  'tmp',
]);

function normalize(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function markdownWithoutCode(content) {
  return content
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '')
    .replace(/`[^`\r\n]*`/gu, '');
}

function isInside(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectMarkdown(directory, rootDir, results = []) {
  if (!(await pathExists(directory))) return results;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(fullPath, rootDir, results);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(normalize(path.relative(rootDir, fullPath)));
    }
  }
  return results;
}

async function collectRepositoryFiles(directory, rootDir, results = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && repositoryScanExcludedDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectRepositoryFiles(fullPath, rootDir, results);
    else if (entry.isFile()) results.push(normalize(path.relative(rootDir, fullPath)));
  }
  return results;
}

function legacyBrandFullyAllowed(file) {
  return legacyBrandFullyAllowedFiles.has(file)
    || legacyBrandFullyAllowedPrefixes.some((prefix) => file.startsWith(prefix));
}

function legacyLineAllowed(file, line, lineIndex, lines) {
  if (file !== 'CHANGELOG.md') return false;
  if (file === 'CHANGELOG.md') {
    const historicalStart = lines.findIndex((candidate) => /^## \d+\.\d+\.\d+/u.test(candidate));
    if (historicalStart >= 0 && lineIndex >= historicalStart) return true;
  }
  return false;
}

export async function validateLegacyBrandUsage({ rootDir }) {
  const errors = [];
  for (const file of await collectRepositoryFiles(rootDir, rootDir)) {
    if (legacyBrandFullyAllowed(file)) continue;
    const content = (await readFile(path.join(rootDir, file))).toString('utf8');
    const lines = content.split(/\r?\n/u);
    const invalidContent = lines.some((line, lineIndex) => (
      legacyBrandPattern.test(line) && !legacyLineAllowed(file, line, lineIndex, lines)
    ));
    if ((legacyBrandPattern.test(file) && !legacyBrandFullyAllowed(file)) || invalidContent) {
      errors.push(`${file} contains legacy product identity outside the compatibility allowlist`);
    }
  }
  return errors.sort();
}

export async function collectGovernedPaths(rootDir) {
  const rootFiles = (await readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  return [...rootFiles, ...await collectMarkdown(path.join(rootDir, 'docs'), rootDir)].sort();
}

function extractLocalLinks(content) {
  const links = [];
  const markdown = markdownWithoutCode(content);
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu,
    /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const raw = (match[1] ?? match[2] ?? '').trim();
      if (
        !raw
        || raw.startsWith('#')
        || raw.startsWith('/')
        || raw.startsWith('//')
        || /^[a-z][a-z0-9+.-]*:/iu.test(raw)
      ) continue;
      const target = raw.split('#', 1)[0];
      if (target) links.push(target);
    }
  }
  return links;
}

function undefinedReferenceErrors(content, file) {
  const markdown = markdownWithoutCode(content);
  const normalizeLabel = (label) => label.trim().replace(/\s+/gu, ' ').toLowerCase();
  const definitions = new Set(
    [...markdown.matchAll(/^\s*\[([^\]]+)\]:\s*(?:<[^>]+>|[^\s]+)/gmu)]
      .map((match) => normalizeLabel(match[1])),
  );
  const errors = [];
  for (const match of markdown.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/gu)) {
    const label = normalizeLabel(match[2] || match[1]);
    if (!definitions.has(label)) errors.push(`${file} has undefined reference: ${label}`);
  }
  return errors;
}

function resolveLocalLink({ file, rootDir, target }) {
  const source = path.join(rootDir, file);
  return path.resolve(path.dirname(source), target);
}

function staleOpenItemErrors(content, file, today) {
  const errors = [];
  const todayText = today.toISOString().slice(0, 10);
  let openBlock = null;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      openBlock = null;
      continue;
    }
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    const checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]/u);
    if (checkbox) {
      if (checkbox[1] !== ' ') {
        if (openBlock?.kind === 'checkbox' && indent <= openBlock.indent) openBlock = null;
        continue;
      }
      openBlock = { indent, kind: 'checkbox' };
    } else if (openItemPattern.test(line)) {
      openBlock = { indent, kind: 'marker' };
    } else if (/^\s*[-*+]\s+/u.test(line) && openBlock?.kind === 'checkbox' && indent <= openBlock.indent) {
      openBlock = null;
    }
    if (!openBlock) continue;
    datePattern.lastIndex = 0;
    for (const match of line.matchAll(datePattern)) {
      if (match[1] < todayText) {
        errors.push(`${file}:${index + 1} contains stale open item dated ${match[1]}`);
      }
    }
  }
  return errors;
}

function logicalCognisCommands(content) {
  const lines = content.split(/\r?\n/u);
  const commands = [];
  const hasContinuation = (line) => {
    if (/\\\s*$/u.test(line)) return true;
    if (!/`\s*$/u.test(line)) return false;
    return (line.match(/`/gu)?.length ?? 0) % 2 === 1;
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('pnpm cognis ')) continue;
    let command = lines[index].trim();
    while (hasContinuation(command) && index + 1 < lines.length) {
      command = `${command.replace(/(?:\\|`)\s*$/u, '').trim()} ${lines[index + 1].trim()}`;
      index += 1;
    }
    commands.push(command);
  }
  return commands;
}

export async function validateCurrentDocumentContent({
  content,
  enforceCurrent = true,
  file,
  rootDir,
  today = new Date(),
}) {
  const errors = [];
  for (const target of extractLocalLinks(content)) {
    const resolved = resolveLocalLink({ file, rootDir, target });
    if (!isInside(rootDir, resolved) || !(await pathExists(resolved))) {
      errors.push(`${file} has broken relative link: ${target}`);
    }
  }
  errors.push(...undefinedReferenceErrors(content, file));

  if (!enforceCurrent) return errors;

  for (const command of logicalCognisCommands(content)) {
    if (command.includes('--project') && command.includes('--apply')) {
      errors.push(`${file} mixes --project with legacy --apply`);
    }
  }
  errors.push(...duplicateReadmeCommandErrors(content, file));
  if (relativeTimePattern.test(content)) errors.push(`${file} contains relative time wording`);
  if (content.includes('九阶段')) errors.push(`${file} contains superseded nine-stage governance wording`);
  if (!file.startsWith('docs/inventory/')) errors.push(...staleOpenItemErrors(content, file, today));
  return errors;
}

function commandExamples(content) {
  return logicalCognisCommands(content).map((command) => {
    const start = command.indexOf('pnpm cognis ');
    return command.slice(start).replace(/\s+/gu, ' ').trim();
  });
}

function duplicateReadmeCommandErrors(content, file) {
  if (!/(?:^|\/)README(?:\.[^/]+)?\.md$/u.test(file)) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const command of commandExamples(content)) {
    if (seen.has(command)) duplicates.add(command);
    else seen.add(command);
  }
  return [...duplicates]
    .sort()
    .map((command) => `${file} contains duplicate Cognis command: ${command}`);
}

function jsonExamples(content, label, errors) {
  const examples = [];
  for (const match of content.matchAll(/```json\r?\n([\s\S]*?)```/gu)) {
    try {
      examples.push(JSON.parse(match[1]));
    } catch (error) {
      errors.push(`${label} contains invalid JSON example: ${error.message}`);
    }
  }
  return examples;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateReadmeParity(english, chinese) {
  const errors = [];
  if (JSON.stringify(commandExamples(english)) !== JSON.stringify(commandExamples(chinese))) {
    errors.push('README command examples differ between English and Chinese');
  }
  const englishJson = jsonExamples(english, 'README.md', errors);
  const chineseJson = jsonExamples(chinese, 'README.zh-CN.md', errors);
  if (stableJson(englishJson) !== stableJson(chineseJson)) {
    errors.push('README JSON examples differ between English and Chinese');
  }
  return errors;
}

function validateCatalogRelationships(catalog) {
  const errors = [];
  const itemsByPath = new Map();
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  for (const item of items) {
    const relativePath = normalize(item.path ?? '');
    if (itemsByPath.has(relativePath)) errors.push(`duplicate documentation path: ${relativePath}`);
    else itemsByPath.set(relativePath, item);

    if (historicalStatuses.has(item.status) && !relativePath.startsWith('docs/archive/')) {
      errors.push(`${relativePath} with status ${item.status} must be under docs/archive`);
    }
    if (
      relativePath.startsWith('docs/archive/')
      && relativePath !== 'docs/archive/README.md'
      && !historicalStatuses.has(item.status)
    ) {
      errors.push(`${relativePath} archived document must use completed or superseded status`);
    }
    if (item.status === 'superseded' && !item.supersededBy) {
      errors.push(`${relativePath} with status superseded requires supersededBy`);
    }
    if (item.status !== 'superseded' && item.supersededBy) {
      errors.push(`${relativePath} may only declare supersededBy when status is superseded`);
    }
  }

  for (const item of items) {
    if (!item.supersededBy) continue;
    const replacement = itemsByPath.get(normalize(item.supersededBy));
    if (!replacement || historicalStatuses.has(replacement.status)) {
      errors.push(`${item.path} supersededBy must reference a current catalog item: ${item.supersededBy}`);
    }
  }
  return { errors, itemsByPath };
}

function validateCatalogCoverage(catalogPaths, governedPaths) {
  const errors = [];
  const catalogSet = new Set(catalogPaths);
  const governedSet = new Set(governedPaths);
  for (const file of governedSet) {
    if (!catalogSet.has(file)) errors.push(`governed documentation is missing from catalog: ${file}`);
  }
  for (const file of catalogSet) {
    if (!governedSet.has(file)) errors.push(`catalog path is not governed documentation: ${file}`);
  }
  return errors;
}

async function validateIndexes(rootDir, itemsByPath) {
  const errors = [];
  const docsIndex = await readFile(path.join(rootDir, 'docs/README.md'), 'utf8');
  const docsTargets = new Set(extractLocalLinks(docsIndex).map((target) => normalize(path.relative(
    rootDir,
    resolveLocalLink({ file: 'docs/README.md', rootDir, target }),
  ))));
  for (const item of itemsByPath.values()) {
    if (!item.path.startsWith('docs/') || item.path === 'docs/README.md' || item.path.startsWith('docs/archive/')) continue;
    if (!docsTargets.has(item.path)) errors.push(`docs/README.md does not index ${item.path}`);
  }

  const archiveIndex = await readFile(path.join(rootDir, 'docs/archive/README.md'), 'utf8');
  const archiveTargets = new Set(extractLocalLinks(archiveIndex).map((target) => normalize(path.relative(
    rootDir,
    resolveLocalLink({ file: 'docs/archive/README.md', rootDir, target }),
  ))));
  for (const item of itemsByPath.values()) {
    if (!item.path.startsWith('docs/archive/') || item.path === 'docs/archive/README.md') continue;
    if (!archiveTargets.has(item.path)) errors.push(`docs/archive/README.md does not index ${item.path}`);
  }
  return errors;
}

async function validateSourceMapping(rootDir) {
  const errors = [];
  const file = 'docs/inventory/source-rules-mapping.md';
  const content = await readFile(path.join(rootDir, file), 'utf8');
  const references = [...content.matchAll(/`((?:rules|templates|skills|runtime|adapters|manifests|schemas)\/[^`、]+)`/gu)]
    .map((match) => match[1])
    .filter((candidate) => !candidate.includes('*'));
  for (const reference of new Set(references)) {
    if (!(await pathExists(path.join(rootDir, reference)))) {
      errors.push(`${file} references missing current asset: ${reference}`);
    }
  }
  return errors;
}

function expectedStatusMarker(item) {
  if (item.status === 'implemented') return /状态：Implemented/u;
  if (item.status === 'superseded') return /状态：Superseded/u;
  if (item.status === 'completed') return /(?:状态|Status)[:：]\s*Completed/iu;
  return null;
}

async function validateDocumentationUnchecked({ catalog, rootDir, today = new Date() }) {
  const errors = [];
  const warnings = [];
  const loadedCatalog = catalog ?? await readJson(path.join(rootDir, 'docs/catalog.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/docs-catalog.schema.json'));
  errors.push(...validateJsonAgainstSchema(loadedCatalog, schema, 'docs catalog'));

  const catalogItems = Array.isArray(loadedCatalog?.items) ? loadedCatalog.items : [];
  const { errors: relationshipErrors, itemsByPath } = validateCatalogRelationships({ items: catalogItems });
  errors.push(...relationshipErrors);
  const governedPaths = await collectGovernedPaths(rootDir);
  const catalogPaths = catalogItems.map((item) => normalize(item.path ?? '')).sort();
  errors.push(...validateCatalogCoverage(catalogPaths, governedPaths));

  for (const item of catalogItems) {
    const relativePath = normalize(item.path ?? '');
    try {
      assertPortableRelativePath(relativePath, 'documentation path');
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const fullPath = path.join(rootDir, relativePath);
    if (!(await pathExists(fullPath))) continue;
    const content = await readFile(fullPath, 'utf8');
    const enforceCurrent = !historicalStatuses.has(item.status);
    errors.push(...await validateCurrentDocumentContent({ content, enforceCurrent, file: relativePath, rootDir, today }));

    const marker = expectedStatusMarker(item);
    if (marker && !marker.test(content)) errors.push(`${relativePath} does not declare ${item.status} status`);
    const lines = content.split(/\r?\n/u).length;
    if (relativePath.startsWith('docs/') && lines > 1500) errors.push(`${relativePath} exceeds 1500 line documentation budget`);

    if (enforceCurrent && item.kind !== 'index') {
      for (const target of extractLocalLinks(content)) {
        const resolved = normalize(path.relative(rootDir, resolveLocalLink({ file: relativePath, rootDir, target })));
        if (resolved.startsWith('docs/archive/')) {
          errors.push(`${relativePath} references archived documentation as a current source: ${resolved}`);
        }
      }
    }
  }

  const agents = await readFile(path.join(rootDir, 'AGENTS.md'), 'utf8');
  const agentLines = agents.split(/\r?\n/u).length;
  const agentBytes = Buffer.byteLength(agents);
  if (agentLines > 300) errors.push(`AGENTS.md exceeds 300 line budget: ${agentLines}`);
  else if (agentLines >= 210) warnings.push(`AGENTS.md has reached 70% of its 300 line budget: ${agentLines}`);
  if (agentBytes > 15 * 1024) errors.push(`AGENTS.md exceeds 15 KiB budget: ${agentBytes} bytes`);
  else if (agentBytes >= 0.7 * 15 * 1024) warnings.push(`AGENTS.md has reached 70% of its 15 KiB budget: ${agentBytes} bytes`);

  if (await pathExists(path.join(rootDir, 'docs/README.md')) && await pathExists(path.join(rootDir, 'docs/archive/README.md'))) {
    errors.push(...await validateIndexes(rootDir, itemsByPath));
  }
  if (await pathExists(path.join(rootDir, 'docs/inventory/source-rules-mapping.md'))) {
    errors.push(...await validateSourceMapping(rootDir));
  }
  errors.push(...await validateLegacyBrandUsage({ rootDir }));

  const [english, chinese, gitignore] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
    readFile(path.join(rootDir, '.gitignore'), 'utf8'),
  ]);
  errors.push(...validateReadmeParity(english, chinese));
  if (!/^\.cognis\/$/mu.test(gitignore)) errors.push('.gitignore must ignore .cognis/');

  return {
    counts: { cataloged: catalogPaths.length, governed: governedPaths.length },
    errors: [...new Set(errors)].sort(),
    ok: errors.length === 0,
    warnings: [...new Set(warnings)].sort(),
  };
}

export async function validateDocumentation(options) {
  try {
    return await validateDocumentationUnchecked(options);
  } catch (error) {
    return {
      counts: { cataloged: 0, governed: 0 },
      errors: [`documentation validation failed: ${error instanceof Error ? error.message : String(error)}`],
      ok: false,
      warnings: [],
    };
  }
}
