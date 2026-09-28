// Eval projection sync.
//
// adapters/install-map.json is the single truth for which eval assets project
// into the self-installed .agents/ tree. A shipped projection must stay
// byte-identical modulo line endings, which pack-validation.js enforces for the
// installed surface; this module makes regenerating that mirror a command
// instead of a manual copy.
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, readJson } from './manifest.js';

const SOURCE_PREFIX = 'evals/';
const TARGET_PREFIX = '.agents/evals/';

function normalize(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

async function walkFiles(directory, rootDir, results = []) {
  if (!(await pathExists(directory))) return results;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, rootDir, results);
    else if (entry.isFile()) results.push(normalize(path.relative(rootDir, fullPath)));
  }
  return results;
}

export async function collectEvalProjectionEntries(rootDir) {
  const installMap = await readJson(path.join(rootDir, 'adapters/install-map.json'));
  const entries = Array.isArray(installMap?.entries) ? installMap.entries : [];
  return entries.filter((entry) => (
    typeof entry?.source === 'string' && typeof entry?.target === 'string'
    && normalize(entry.source).startsWith(SOURCE_PREFIX)
    && normalize(entry.target).startsWith(TARGET_PREFIX)
  ));
}

/**
 * Compare the eval projection targets with their sources without writing.
 *
 * @param {{rootDir: string}} options
 */
export async function collectEvalSyncPlan({ rootDir }) {
  const entries = await collectEvalProjectionEntries(rootDir);
  const drift = [];
  const missingSource = [];
  for (const entry of entries) {
    const source = normalize(entry.source);
    const target = normalize(entry.target);
    if (!(await pathExists(path.join(rootDir, source)))) {
      missingSource.push({ source, target });
      continue;
    }
    if (!(await pathExists(path.join(rootDir, target)))) {
      drift.push({ source, target, reason: 'missing-target' });
      continue;
    }
    const sourceContent = normalizeLineEndings(await readFile(path.join(rootDir, source), 'utf8'));
    const targetContent = normalizeLineEndings(await readFile(path.join(rootDir, target), 'utf8'));
    if (sourceContent !== targetContent) drift.push({ source, target, reason: 'content-drift' });
  }

  const projectedTargets = new Set(entries.map((entry) => normalize(entry.target)));
  const orphans = (await walkFiles(path.join(rootDir, TARGET_PREFIX), rootDir))
    .filter((file) => !projectedTargets.has(file));

  const manualActions = [
    ...missingSource.map((item) => ({ code: 'EVAL_SOURCE_MISSING', message: `install map source is missing: ${item.source}`, path: item.source })),
    ...orphans.map((file) => ({ code: 'EVAL_TARGET_ORPHAN', message: `installed eval mirror has no install-map entry: ${file}`, path: file })),
  ].sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));

  return {
    drift: drift.sort((left, right) => left.target.localeCompare(right.target)),
    manualActions,
    ok: drift.length === 0 && manualActions.length === 0,
    projectedCount: entries.length,
  };
}

/**
 * Copy drifted projections from their sources.
 *
 * @param {{rootDir: string, plan: Awaited<ReturnType<typeof collectEvalSyncPlan>>}} options
 */
export async function applyEvalSync({ rootDir, plan }) {
  const written = [];
  for (const item of plan.drift) {
    const target = path.join(rootDir, item.target);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(rootDir, item.source), target);
    written.push(item.target);
  }
  return written;
}

/**
 * Check or repair the eval projection mirror.
 *
 * @param {{rootDir: string, write?: boolean}} options
 */
export async function runEvalSync({ rootDir, write = false }) {
  const initial = await collectEvalSyncPlan({ rootDir });
  const written = write ? await applyEvalSync({ rootDir, plan: initial }) : [];
  const plan = write ? await collectEvalSyncPlan({ rootDir }) : initial;
  return { plan, written };
}
