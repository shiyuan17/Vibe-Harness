// ADR scaffolding.
//
// Creating an ADR is a mechanical sequence: pick the next identifier, render
// templates/adr/adr-template.md with validated front matter, then let
// docs-projection.js add the ADR catalog, catalog and index entries. The
// template file stays the single source for the required section skeleton.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ADR_FILE_PATTERN } from './adr-validation.js';
import { pathExists, readJson } from './manifest.js';

export const ADR_TEMPLATE_PATH = 'templates/adr/adr-template.md';
export const ADR_DIRECTORY = 'docs/adr';
export const DEFAULT_ADR_STATUS = 'proposed';
export const ADR_STATUSES = ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'];

const FRONT_MATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u;
const TITLE_PATTERN = /^#\s+.*$/mu;

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function formatArray(items) {
  return `[${items.join(', ')}]`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Turn a title into an ADR filename slug; non-ASCII titles yield an empty slug. */
export function slugifyAdrTitle(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export async function listAdrIds(rootDir) {
  const adrDir = path.join(rootDir, ADR_DIRECTORY);
  if (!(await pathExists(adrDir))) return [];
  const ids = [];
  for (const entry of await readdir(adrDir, { withFileTypes: true })) {
    const match = entry.isFile() ? entry.name.match(ADR_FILE_PATTERN) : null;
    if (match) ids.push(Number.parseInt(match[1], 10));
  }
  return ids.sort((left, right) => left - right);
}

export async function nextAdrId(rootDir) {
  const ids = await listAdrIds(rootDir);
  const next = ids.length === 0 ? 1 : ids[ids.length - 1] + 1;
  return `ADR-${String(next).padStart(4, '0')}`;
}

/**
 * Render a new ADR document from the repository template.
 *
 * @param {{template: string, id: string, title: string, status: string, date: string, reviewDate?: string|null, owner: string, decisionMakers?: string[], consulted?: string[], informed?: string[], supersedes?: string[]}} input
 */
export function renderAdrDocument(input) {
  const supersedes = normalizeArray(input.supersedes);
  const frontMatter = [
    '---',
    `id: ${input.id}`,
    `title: ${input.title}`,
    `status: ${input.status}`,
    `date: ${input.date}`,
    ...(input.reviewDate ? [`review-date: ${input.reviewDate}`] : []),
    `owner: ${input.owner}`,
    `decision-makers: ${formatArray(normalizeArray(input.decisionMakers).length > 0 ? normalizeArray(input.decisionMakers) : [input.owner])}`,
    `consulted: ${formatArray(normalizeArray(input.consulted))}`,
    `informed: ${formatArray(normalizeArray(input.informed))}`,
    `supersedes: ${formatArray(supersedes)}`,
    'superseded-by: null',
    '---',
  ].join('\n');
  const body = input.template.replace(FRONT_MATTER_PATTERN, `${frontMatter}\n`);
  return body.replace(TITLE_PATTERN, `# ${input.title}`);
}

/**
 * Validate the scaffold request and resolve the file it would create.
 *
 * @param {{rootDir: string, title?: string, slug?: string, status?: string, date?: string, reviewDate?: string|null, owner?: string, decisionMakers?: string[], consulted?: string[], informed?: string[], supersedes?: string[], language?: string, now?: Date}} options
 */
export async function buildAdrPlan(options) {
  const errors = [];
  const title = String(options.title ?? '').trim();
  const owner = String(options.owner ?? '').trim();
  const status = options.status ?? DEFAULT_ADR_STATUS;
  const date = options.date ?? todayUtc(options.now);
  const slug = options.slug ? String(options.slug).trim() : slugifyAdrTitle(title);

  if (!title) errors.push('--title is required');
  if (!owner) errors.push('--owner is required');
  if (!ADR_STATUSES.includes(status)) errors.push(`--status must be one of ${ADR_STATUSES.join(', ')}`);
  if (!isValidDate(date)) errors.push('--date must be a valid YYYY-MM-DD date');
  if (options.reviewDate && !isValidDate(options.reviewDate)) errors.push('--review-date must be a valid YYYY-MM-DD date');
  if (!slug) errors.push('--slug is required when the title has no ASCII characters to derive one from');
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) errors.push('--slug must use lowercase letters, digits and single hyphens');

  const id = await nextAdrId(options.rootDir);
  const relativePath = `${ADR_DIRECTORY}/${id}-${slug}.md`;
  const templatePath = path.join(options.rootDir, ADR_TEMPLATE_PATH);
  if (!(await pathExists(templatePath))) errors.push(`${ADR_TEMPLATE_PATH} is missing`);
  if (errors.length > 0) return { errors, id, relativePath };

  const config = await readJson(path.join(options.rootDir, 'vibe-harness.config.json')).catch(() => null);
  const language = options.language ?? (typeof config?.language === 'string' && config.language ? config.language : 'zh-CN');
  const template = await readFile(templatePath, 'utf8');
  const content = renderAdrDocument({
    consulted: options.consulted,
    date,
    decisionMakers: options.decisionMakers,
    id,
    informed: options.informed,
    owner,
    reviewDate: options.reviewDate ?? null,
    status,
    supersedes: options.supersedes,
    template,
    title,
  });
  return {
    catalogEntry: { kind: 'architecture', status: 'current', language, audiences: ['contributor', 'maintainer', 'auditor'] },
    content,
    errors: [],
    id,
    language,
    relativePath,
    status,
    title,
  };
}

/** Create the ADR file without overwriting an existing document. */
export async function writeAdrDocument(rootDir, relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  await writeFile(fullPath, content, { encoding: 'utf8', flag: 'wx' });
  return fullPath;
}
