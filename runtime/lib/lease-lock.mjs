// Shared lease-lock implementation for exclusive resource acquisition.
//
// Both land lock and port registry lock use the same PID + heartbeat + grace
// window pattern: a process holds a lease by writing its PID and heartbeat,
// and a second process may reclaim the lease once the holder has exited or
// its heartbeat has expired past the grace window.
//
// This module extracts the pattern so both locks share the same implementation.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
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
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    const heartbeat = Date.parse(record?.heartbeatAt ?? record?.startedAt ?? '');
    const leaseMs = Number.isInteger(record?.leaseMs) && record.leaseMs > 0
      ? record.leaseMs : DEFAULT_LEASE_MS;
    const expired = !Number.isFinite(heartbeat) || Date.now() - heartbeat > leaseMs;
    const alive = processAlive(record?.pid);
    return {
      record,
      pid: record?.pid ?? null,
      expired,
      alive,
      stale: expired || !alive,
    };
  } catch {
    // Unreadable or missing file is treated as stale (no holder).
    return {
      record: null,
      pid: null,
      expired: false,
      alive: false,
      stale: true,
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
        return { held: false, reason: removeError.message };
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
  for (;;) {
    const result = acquireLease(lockPath, { leaseMs });
    if (result.held) {
      return { ok: true, record: result.record };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        code: 'LEASE_TIMEOUT',
        error: `lock held after ${timeoutMs}ms`,
      };
    }
    await delay(retryMs);
  }
}
