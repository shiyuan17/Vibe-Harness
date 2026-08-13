import path from 'node:path';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { pathExists, readJson, validateJsonAgainstSchema } from './manifest.js';

const ADR_FILE_PATTERN = /^ADR-(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ID_PATTERN = /^ADR-\d{4}$/u;
const STATUSES = new Set(['proposed', 'accepted', 'rejected', 'deprecated', 'superseded']);
const git = promisify(execFile);

function isValidDate(value) {
  if (!DATE_PATTERN.test(value ?? '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
  return trimmed.replace(/^['"]|['"]$/gu, '');
}

function parseFrontMatter(content, file) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
  if (!match) return { error: file + ' is missing YAML front matter', metadata: null, body: content };
  const metadata = {};
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1) return { error: file + ' has malformed front matter', metadata: null, body: content };
    metadata[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }
  return { error: null, metadata, body: content.slice(match[0].length) };
}

function requiredSectionErrors(body, file, status) {
  const required = ['Context and Problem Statement', 'Decision Drivers', 'Considered Options', 'Decision Outcome', 'Consequences', 'Confirmation', 'Review Trigger', 'More Information'];
  const errors = required.filter((heading) => !body.split(/\r?\n/u).some((line) => line.trim() === '## ' + heading)).map((heading) => file + ' is missing required section: ' + heading);
  const lines = body.split(/\r?\n/u);
  const hasContent = (heading) => {
    const index = lines.findIndex((line) => line.trim() === '## ' + heading);
    if (index < 0) return false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^## /u.test(lines[cursor].trim())) break;
      if (lines[cursor].trim()) return true;
    }
    return false;
  };
  if (status === 'accepted') {
    for (const heading of ['Decision Outcome', 'Consequences', 'Confirmation']) if (!hasContent(heading)) errors.push(file + ' accepted ADR must contain content in ' + heading);
  }
  if (status === 'rejected' && (!lines.some((line) => line.trim() === '## Rejection Reason') || !hasContent('Rejection Reason'))) errors.push(file + ' rejected ADR must include a non-empty Rejection Reason section');
  return errors;
}

function normalizeArray(value) { return Array.isArray(value) ? value : []; }

export function validateHistoricalAdr(previous, current, file) {
  if (!previous.metadata || !current.metadata) return [];
  if (!['accepted', 'rejected'].includes(previous.metadata.status)) return [];
  if (![previous.metadata.status, 'deprecated', 'superseded'].includes(current.metadata.status)) {
    return [file + ' must not move an accepted or rejected ADR back to an active lifecycle state'];
  }
  const previousCore = { ...previous.metadata };
  const currentCore = { ...current.metadata };
  for (const key of ['status', 'superseded-by']) {
    delete previousCore[key];
    delete currentCore[key];
  }
  if (JSON.stringify(previousCore) !== JSON.stringify(currentCore) || previous.body !== current.body) {
    return [file + ' must not rewrite the core content of an accepted or rejected ADR'];
  }
  return [];
}

async function readHeadAdr(rootDir, file) {
  try {
    return (await git('git', ['show', 'HEAD:' + file], { cwd: rootDir, windowsHide: true })).stdout;
  } catch {
    return null;
  }
}

export function parseAdrDocument(content, file = 'ADR') {
  const parsed = parseFrontMatter(content, file);
  if (parsed.error) return { errors: [parsed.error], metadata: null, body: parsed.body };
  const errors = [];
  const metadata = parsed.metadata;
  if (!ID_PATTERN.test(metadata.id ?? '')) errors.push(file + '.id must match ADR-0000');
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) errors.push(file + '.title is required');
  if (!STATUSES.has(metadata.status)) errors.push(file + '.status is invalid');
  if (!isValidDate(metadata.date)) errors.push(file + '.date must be a valid YYYY-MM-DD date');
  if (metadata['review-date'] !== undefined && !isValidDate(metadata['review-date'])) errors.push(file + '.review-date must be a valid YYYY-MM-DD date');
  if (typeof metadata.owner !== 'string' || !metadata.owner.trim()) errors.push(file + '.owner is required');
  for (const key of ['decision-makers', 'consulted', 'informed', 'supersedes']) if (!Array.isArray(metadata[key])) errors.push(file + '.' + key + ' must be an array');
  if (metadata['superseded-by'] !== null && metadata['superseded-by'] !== undefined && !ID_PATTERN.test(metadata['superseded-by'])) errors.push(file + '.superseded-by must be null or an ADR ID');
  errors.push(...requiredSectionErrors(parsed.body, file, metadata.status));
  return { errors, metadata, body: parsed.body };
}

export async function validateAdrDirectory(rootDir) {
  const errors = [];
  const adrDir = path.join(rootDir, 'docs/adr');
  if (!(await pathExists(adrDir))) return errors;
  const schema = await readJson(path.join(rootDir, 'schemas/adr.schema.json'));
  const entries = await readdir(adrDir, { withFileTypes: true });
  const documents = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === 'README.md' || entry.name === 'catalog.json') continue;
    const match = entry.name.match(ADR_FILE_PATTERN);
    if (!match) { errors.push('docs/adr/' + entry.name + ' must use ADR-0000-short-title.md naming'); continue; }
    const file = 'docs/adr/' + entry.name;
    const parsed = parseAdrDocument(await readFile(path.join(adrDir, entry.name), 'utf8'), file);
    errors.push(...parsed.errors);
    if (!parsed.metadata) continue;
    const headContent = await readHeadAdr(rootDir, file);
    if (headContent !== null) errors.push(...validateHistoricalAdr(parseAdrDocument(headContent, file), parsed, file));
    errors.push(...validateJsonAgainstSchema(parsed.metadata, schema, file));
    if (parsed.metadata.id !== 'ADR-' + match[1]) errors.push(file + '.id must match its filename');
    if (documents.some((document) => document.metadata.id === parsed.metadata.id)) errors.push('duplicate ADR id: ' + parsed.metadata.id);
    documents.push({ file, metadata: parsed.metadata });
  }
  const catalog = await readJson(path.join(adrDir, 'catalog.json'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items)) errors.push('docs/adr/catalog.json must contain schemaVersion 1 and an items array');
  const catalogIds = new Set();
  for (const item of catalog.items ?? []) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.path !== 'string') { errors.push('docs/adr/catalog.json items require id and path'); continue; }
    if (catalogIds.has(item.id)) errors.push('docs/adr/catalog.json contains duplicate ADR id: ' + item.id);
    if ((catalog.items ?? []).filter((candidate) => candidate?.path === item.path).length > 1) errors.push('docs/adr/catalog.json contains duplicate ADR path: ' + item.path);
    catalogIds.add(item.id);
    if (!documents.some((document) => document.metadata.id === item.id && document.file === item.path)) errors.push('docs/adr/catalog.json item does not match an ADR file: ' + item.id);
  }
  for (const document of documents) if (!catalogIds.has(document.metadata.id)) errors.push('docs/adr/catalog.json is missing ' + document.metadata.id);
  const byId = new Map(documents.map((document) => [document.metadata.id, document]));
  for (const document of documents) {
    const { metadata, file } = document;
    for (const referenced of normalizeArray(metadata.supersedes)) {
      if (!byId.has(referenced)) errors.push(file + '.supersedes references missing ADR: ' + referenced);
      else if (byId.get(referenced).metadata['superseded-by'] !== metadata.id) errors.push(file + ' must be the superseded-by target of ' + referenced);
    }
    if (metadata['superseded-by'] !== null && metadata['superseded-by'] !== undefined) {
      const replacement = byId.get(metadata['superseded-by']);
      if (!replacement) errors.push(file + '.superseded-by references missing ADR: ' + metadata['superseded-by']);
      else if (!normalizeArray(replacement.metadata.supersedes).includes(metadata.id)) errors.push(file + '.superseded-by must be listed in ' + metadata['superseded-by'] + '.supersedes');
    }
    if (metadata.status === 'superseded' && !metadata['superseded-by']) errors.push(file + ' with status superseded requires superseded-by');
  }
  const durableMemoryPath = path.join(rootDir, 'docs/memory/DECISIONS.md');
  if (await pathExists(durableMemoryPath) && documents.length > 0) {
    const durableMemory = await readFile(durableMemoryPath, 'utf8');
    const indexLines = durableMemory.split(/\r?\n/u).filter((line) => line.trim().startsWith('- '));
    for (const document of documents) if (!indexLines.some((line) => line.includes(document.metadata.id))) errors.push('docs/memory/DECISIONS.md is missing ' + document.metadata.id);
  }
  return [...new Set(errors)].sort();
}
