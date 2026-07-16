import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function normalizeStatus(status) {
  if (['ready', 'passed'].includes(status)) return 'ready';
  if (status === 'degraded') return 'degraded';
  if (['invalid', 'failed'].includes(status)) return 'invalid';
  return null;
}

export function assessEvalHealth({ current, enforceInvalid = false, history = [] }) {
  const status = normalizeStatus(current);
  if (!status) return { code: 'EVAL_HEALTH_UNAVAILABLE', consecutiveDegraded: 0, ok: false, status: 'unavailable' };
  if (status === 'ready') return { code: 'EVAL_READY', consecutiveDegraded: 0, ok: true, status };
  if (status === 'invalid') {
    return {
      code: enforceInvalid ? 'EVAL_INVALID' : 'EVAL_INVALID_ADVISORY',
      consecutiveDegraded: 0,
      ok: !enforceInvalid,
      status,
    };
  }
  let consecutiveDegraded = 1;
  for (const previous of history) {
    if (normalizeStatus(previous) !== 'degraded') break;
    consecutiveDegraded += 1;
  }
  return {
    code: consecutiveDegraded >= 3 ? 'EVAL_DEGRADED_STREAK' : 'EVAL_DEGRADED',
    consecutiveDegraded,
    ok: consecutiveDegraded < 3,
    status,
  };
}

async function jsonFiles(directory, output = []) {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await jsonFiles(fullPath, output);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(fullPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

export async function readEvalStatus(directory) {
  const statuses = [];
  for (const file of await jsonFiles(directory)) {
    try {
      const payload = JSON.parse(await readFile(file, 'utf8'));
      const status = normalizeStatus(payload.status);
      if (status) statuses.push(status);
    } catch {}
  }
  if (statuses.includes('invalid')) return 'invalid';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('ready')) return 'ready';
  return null;
}

export async function readEvalHistory(directory) {
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name, 'en', { numeric: true }));
    const statuses = [];
    for (const entry of entries) {
      const status = await readEvalStatus(path.join(directory, entry.name));
      if (status) statuses.push(status);
    }
    return statuses;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
