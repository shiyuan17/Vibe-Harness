// Shared lease-lock implementation for exclusive resource acquisition.
//
// Both land lock and port registry lock use the same PID + heartbeat + grace
// window pattern: a process holds a lease by writing its PID and heartbeat,
// and a second process may reclaim the lease once the holder has exited or
// its heartbeat has expired past the grace window.
//
// This module extracts the pattern so both locks share the same implementation.

import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { delay } from './cli-runtime.mjs';

export const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 minutes for land lock
export const DEFAULT_HEARTBEAT_MS = 30 * 1000; // 30 seconds
export const DEFAULT_GRACE_MS = 5_000; // 5 seconds after expiry before reclaim

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves a live process we are not allowed to signal.
    return error?.code === 'EPERM';
  }
}

/**
 * Read a lease file and determine if it is still held.
 *
 * Returns { record, pid, expired, alive, stale } where stale indicates
 * the lease can be reclaimed (process dead or heartbeat expired).
 */
export function readLease(lockPath) {
  try {
    const contents = readFileSync(lockPath, 'utf8');
    let record;
    let legacy = false;
    try {
      record = JSON.parse(contents);
    } catch {
      const match = /^(\d+)\r?\n([^\r\n]+)\r?\n?$/u.exec(contents);
      const pid = match ? Number(match[1]) : NaN;
      const timestamp = match?.[2] ?? '';
      if (!Number.isSafeInteger(pid) || !Number.isFinite(Date.parse(timestamp))) throw new Error('invalid legacy lock');
      record = { pid, startedAt: timestamp, heartbeatAt: timestamp };
      legacy = true;
    }
    const heartbeat = Date.parse(record?.heartbeatAt ?? record?.startedAt ?? '');
    const leaseMs = Number.isInteger(record?.leaseMs) && record.leaseMs > 0
      ? record.leaseMs : DEFAULT_LEASE_MS;
    const expired = !Number.isFinite(heartbeat) || Date.now() - heartbeat > leaseMs;
    const alive = processAlive(record?.pid);
    const activeLandPath = /^vibe-harness-land-(?:[0-9a-f]{12}|candidate-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/iu
      .test(basename(lockPath));
    return {
      record,
      pid: record?.pid ?? null,
      expired,
      alive,
      // The old worktree-wide format had no lease. The SHA-1 compatibility and
      // candidate activity paths also protect operations spanning runtimes or
      // long verification, so a live PID must retain those locks.
      stale: !alive || (!legacy && !activeLandPath && expired),
    };
  } catch {
    // A peer can observe the exclusive file between creation and its first
    // write, or while a heartbeat rewrites it. Do not reclaim a fresh partial
    // record; a genuinely abandoned malformed file is reclaimable after the
    // short grace window. A missing file remains immediately reclaimable.
    let stale = true;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > DEFAULT_GRACE_MS;
    } catch (error) {
      // Only absence is safe to reclaim; permission failures are uncertain.
      stale = error?.code === 'ENOENT';
    }
    return {
      record: null,
      pid: null,
      expired: false,
      alive: false,
      stale,
    };
  }
}

/**
 * Acquire a lease with PID + heartbeat tracking.
 *
 * Returns { held: true, record } on success, or { held: false, reason } if
 * the lease is already held or cannot be created.
 */
export function acquireLease(lockPath, { leaseMs = DEFAULT_LEASE_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs,
    };
    try {
      const handle = openSync(lockPath, 'wx');
      writeSync(handle, `${JSON.stringify(record, null, 2)}\n`);
      closeSync(handle);
      return { held: true, record };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return {
          held: false,
          code: 'LEASE_UNAVAILABLE',
          reason: error.message,
        };
      }
      const existing = readLease(lockPath);
      if (!existing.stale) {
        return {
          held: false,
          reason: `lock held by pid ${existing.pid}`,
        };
      }
      // Reclaim only an expired or dead holder's lock, then retry exclusive
      // creation. The `wx` open remains the acquisition decision, so two
      // reclaimers cannot both believe they hold the lease.
      try {
        rmSync(lockPath, { force: true });
      } catch (removeError) {
        return { held: false, code: 'LEASE_UNAVAILABLE', reason: removeError.message };
      }
    }
  }
  return { held: false, reason: 'lock changed while acquiring' };
}

/**
 * Update the heartbeat of an already-held lease.
 *
 * Returns true on success, false if the lease is no longer held or cannot
 * be updated.
 */
export function updateHeartbeat(lockPath) {
  try {
    const existing = readLease(lockPath);
    if (existing.pid !== process.pid) {
      return false;
    }
    const record = {
      ...existing.record,
      heartbeatAt: new Date().toISOString(),
    };
    const handle = openSync(lockPath, 'w');
    writeSync(handle, `${JSON.stringify(record, null, 2)}\n`);
    closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a held lease alive until the returned handle is stopped.
 *
 * `lost` becomes true when the file is missing, unreadable, or no longer
 * belongs to this process; callers should stop before starting another
 * destructive step after that point.
 */
export function startLeaseHeartbeat(lockPath, { heartbeatMs = DEFAULT_HEARTBEAT_MS } = {}) {
  const intervalMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0
    ? Math.max(1, Math.floor(heartbeatMs))
    : DEFAULT_HEARTBEAT_MS;
  let lost = false;
  const timer = setInterval(() => {
    if (!updateHeartbeat(lockPath)) {
      lost = true;
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return {
    get lost() {
      return lost;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Release a lease.
 *
 * Removes the lock file if this process holds it.
 */
export function releaseLease(lockPath) {
  try {
    const existing = readLease(lockPath);
    if (existing.pid === process.pid) {
      rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    // Ignore errors on release.
  }
  return false;
}

/**
 * Acquire a lease with retries until deadline or success.
 *
 * Similar to the withLock pattern but returns early on success rather than
 * running an action callback.
 */
export async function acquireLeaseWithRetry(lockPath, { timeoutMs = 180_000, retryMs = 50, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let currentRetryMs = retryMs;
  for (;;) {
    const result = acquireLease(lockPath, { leaseMs });
    if (result.held) {
      return { ok: true, record: result.record };
    }
    if (result.code === 'LEASE_UNAVAILABLE') {
      return { ok: false, code: result.code, error: result.reason };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        code: 'LEASE_TIMEOUT',
        error: `lock held after ${timeoutMs}ms`,
      };
    }
    await delay(currentRetryMs);
    currentRetryMs = Math.min(Math.ceil(currentRetryMs * 1.5), 2_000);
  }
}
