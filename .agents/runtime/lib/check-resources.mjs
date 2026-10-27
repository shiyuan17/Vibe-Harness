import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { delay, runGit } from './cli-runtime.mjs';

export function normalizeCheckResources(values = []) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/u.test(value))) {
    throw new Error('Check resources must be bounded, named resource identifiers.');
  }
  return [...new Set(values)].sort();
}

/** Named locks protect only one check. Live holders never lose ownership by TTL. */
export async function acquireCheckResources(projectDir, values, { timeoutMs = 120000 } = {}) {
  const names = normalizeCheckResources(values);
  if (!names.length) return { ok: true, waitMs: 0, release() {} };
  const common = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!common.ok) return { ok: false, code: 'CHECK_RESOURCE_STORE_UNAVAILABLE' };
  const root = path.join(path.resolve(projectDir, common.stdout.trim()), 'vibe-harness-check-resources');
  mkdirSync(root, { recursive: true });
  const held = [];
  const token = randomUUID();
  const started = Date.now();
  const release = ({ retain = false } = {}) => {
    if (retain) return;
    for (const file of held.reverse()) {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file);
      } catch { /* Unknown ownership is never removed. */ }
    }
    held.length = 0;
  };
  try {
    for (const name of names) {
      const file = path.join(root, `${createHash('sha256').update(name).digest('hex')}.json`);
      while (true) {
        try {
          writeFileSync(file, JSON.stringify({ token, pid: process.pid, hostname: hostname(), name, phase: 'reserved', startedAt: new Date().toISOString() }),
            { flag: 'wx', mode: 0o600 });
          held.push(file);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try {
            const observed = readFileSync(file, 'utf8');
            const owner = JSON.parse(observed);
            if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); }
              catch (probe) {
                // A dead runner can leave descendants using the resource.
                // Only a reservation that never started a command is reclaimable.
                if (probe.code === 'ESRCH' && owner.phase === 'reserved'
                  && readFileSync(file, 'utf8') === observed) unlinkSync(file);
              }
            }
          } catch { /* A partial record or inaccessible process retains its lock. */ }
          if (Date.now() - started >= timeoutMs) {
            release();
            return { ok: false, code: 'CHECK_RESOURCE_BUSY', resource: name, waitMs: Date.now() - started };
          }
          await delay(50);
        }
      }
    }
    const begin = () => {
      for (const file of held) {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        if (record.token !== token) throw new Error('Resource lock ownership changed');
        writeFileSync(file, JSON.stringify({ ...record, phase: 'running' }));
      }
    };
    return { ok: true, waitMs: Date.now() - started, begin, release };
  } catch (error) {
    release();
    return { ok: false, code: 'CHECK_RESOURCE_UNAVAILABLE', error: error.message };
  }
}
