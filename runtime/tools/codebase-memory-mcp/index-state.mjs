/**
 * Freshness stamp for the codebase-memory graph.
 *
 * `index_status` reports the live repository HEAD, not the indexed snapshot, so
 * `status: ready` cannot answer "is this graph current?". The runtime wrapper
 * records the HEAD (and indexing facts) it observed when an index run
 * succeeded, and the project command compares that stamp with the current HEAD.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { codebaseMemoryIndexStatePath } from './cache-path.mjs';

export const INDEX_STATE_SCHEMA_VERSION = 1;
export const INDEX_STATES = ['fresh', 'stale', 'missing'];

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {any} value @returns {Record<string, any> | null} */
export function normalizeIndexState(value) {
  if (!value || typeof value !== 'object') return null;
  const project = optionalString(value.project);
  const rootPath = optionalString(value.rootPath);
  const headSha = optionalString(value.headSha);
  const indexedAt = optionalString(value.indexedAt);
  if (!project || !rootPath || !headSha || !indexedAt) return null;
  return {
    branch: optionalString(value.branch),
    cacheDir: optionalString(value.cacheDir),
    edges: optionalInteger(value.edges),
    headSha,
    indexedAt,
    mode: optionalString(value.mode),
    nodes: optionalInteger(value.nodes),
    project,
    recordedAt: optionalString(value.recordedAt) ?? indexedAt,
    rootPath,
    runtimeVersion: optionalString(value.runtimeVersion),
    schemaVersion: INDEX_STATE_SCHEMA_VERSION,
    source: optionalString(value.source),
  };
}

/** @param {string} filePath @returns {Promise<Record<string, any> | null>} */
export async function readIndexState(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return normalizeIndexState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {Record<string, any>} state
 * @returns {Promise<string>}
 */
export async function writeIndexState(filePath, state) {
  await writeFile(filePath, `${JSON.stringify({ ...state, schemaVersion: INDEX_STATE_SCHEMA_VERSION }, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * Compare a stamp with the current repository facts.
 *
 * @param {Record<string, any> | null} state
 * @param {{ headSha?: string | null, rootPath?: string | null }} facts
 * @returns {{ state: 'fresh' | 'stale' | 'missing', reason: string, details?: Record<string, any> }}
 */
export function evaluateIndexFreshness(state, facts = {}) {
  if (!state) return { reason: 'no-index-state', state: 'missing' };
  const currentHead = optionalString(facts.headSha);
  if (!currentHead) return { reason: 'current-head-unknown', state: 'stale', details: { indexedHeadSha: state.headSha } };
  if (state.headSha !== currentHead) {
    return {
      details: { currentHeadSha: currentHead, indexedHeadSha: state.headSha },
      reason: 'head-sha-changed',
      state: 'stale',
    };
  }
  return { details: { headSha: currentHead }, reason: 'head-sha-match', state: 'fresh' };
}

/**
 * Project-relative description used by status output and diagnostics. Derived
 * from the absolute path helper so the reported location cannot drift from the
 * file the wrapper actually writes.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function indexStateRelativePath(projectRoot) {
  return path.relative(path.resolve(projectRoot), codebaseMemoryIndexStatePath(projectRoot));
}
