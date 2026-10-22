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
  const existing = readLease(lockPath);
  if (existing.stale === false) {
    // Lease is still held.
    return {
      held: false,
      reason: `lock held by pid ${existing.pid}`,
    };
  }
  try {
    const record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseMs,
    };
    const handle = openSync(lockPath, 'w');
    writeSync(handle, `${JSON.stringify(record, null, 2)}\n`);
    closeSync(handle);
    return { held: true, record };
  } catch (error) {
    return {
      held: false,
      reason: error.message,
    };
  }
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
 *
 * The retry interval grows exponentially (capped at `maxRetryMs`) so that many
 * concurrent waiters on the same lock do not busy-poll in lockstep. The initial
 * `retryMs` is still used for the first probe so single-waiter latency stays low.
 */
export async function acquireLeaseWithRetry(lockPath, {
  timeoutMs = 180_000,
  retryMs = 50,
  maxRetryMs = 2_000,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let currentRetryMs = retryMs;
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
    await delay(currentRetryMs);
    // Exponential backoff capped at maxRetryMs: N concurrent landers on the
    // same target ref no longer all poll every 50ms, which both wastes cycles
    // and amplifies contention on the lock file itself.
    currentRetryMs = Math.min(Math.ceil(currentRetryMs * 1.5), maxRetryMs);
  }
}
