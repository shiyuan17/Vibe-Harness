// One machine-local lease for heavy verification.
//
// A deep or backend-wide run may occupy a machine for tens of minutes. Two of
// them can mutate the same dependency roots, caches and service ports at once,
// and the second run then produces failures that describe contention rather
// than the code. The lock lives in the Git common directory so every worktree
// of one repository shares it. A lease is only reclaimed after its owner has
// exited or its heartbeat has expired: an unreadable or young record is treated
// as held, never as an invitation to run concurrently.
import { execFile } from 'node:child_process';
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const VERIFICATION_LOCK_NAME = 'vibe-harness-deep-verify.lock';
export const DEFAULT_VERIFICATION_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;

async function commonDirectory(projectDir) {
  try {
    const { stdout } = await execute('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const relative = stdout.trim();
    return relative ? path.resolve(projectDir, relative) : null;
  } catch {
    return null;
  }
}

async function insideGitWorktree(projectDir) {
  try {
    const { stdout } = await execute('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

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

function readLease(lockPath) {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    const heartbeat = Date.parse(record?.heartbeatAt ?? record?.startedAt ?? '');
    const leaseMs = Number.isInteger(record?.leaseMs) && record.leaseMs > 0
      ? record.leaseMs : DEFAULT_VERIFICATION_LEASE_MS;
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
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // A vanished lock will be retried by the caller.
    }
    return {
      record: null,
      pid: null,
      expired: ageMs > DEFAULT_VERIFICATION_LEASE_MS,
      alive: false,
      stale: ageMs > DEFAULT_VERIFICATION_LEASE_MS,
    };
  }
}

/** Read the current lease without mutating it. */
export async function verificationLockStatus(projectDir) {
  const common = await commonDirectory(projectDir);
  if (!common) return { ok: false, reason: 'git-common-dir-unavailable', path: null, held: false };
  const lockPath = path.join(common, VERIFICATION_LOCK_NAME);
  try {
    statSync(lockPath);
  } catch {
    return { ok: true, path: lockPath, held: false, stale: false, holder: null };
  }
  const lease = readLease(lockPath);
  return {
    ok: true,
    path: lockPath,
    held: !lease.stale,
    stale: lease.stale,
    holder: lease.record ? {
      pid: lease.record.pid ?? null,
      startedAt: lease.record.startedAt ?? null,
      heartbeatAt: lease.record.heartbeatAt ?? null,
      hostname: lease.record.hostname ?? null,
    } : null,
  };
}

function writeLease(lockPath, record) {
  const temporary = `${lockPath}.${record.nonce}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, lockPath);
}

/**
 * Acquire the heavy-verification lease.
 *
 * @returns {Promise<{ok: boolean, path: string|null, holder?: object|null, reason?: string, release?: () => void}>}
 */
export async function acquireVerificationLock(projectDir, {
  leaseMs = DEFAULT_VERIFICATION_LEASE_MS,
  heartbeatMs = Math.min(DEFAULT_HEARTBEAT_MS, Math.max(1_000, Math.floor(leaseMs / 3))),
} = {}) {
  const common = await commonDirectory(projectDir);
  if (!common) {
    // A project without Git has no shared worktrees or common directory to
    // coordinate. It cannot contend with another checkout of the same
    // repository, so the lease is intentionally a no-op. A Git worktree whose
    // common directory cannot be resolved still fails closed.
    if (!(await insideGitWorktree(projectDir))) {
      return { ok: true, skipped: true, path: null, reason: 'not-a-git-worktree' };
    }
    return { ok: false, path: null, reason: 'git-common-dir-unavailable' };
  }
  const lockPath = path.join(common, VERIFICATION_LOCK_NAME);
  const nonce = randomUUID();
  const now = new Date();
  const record = {
    schemaVersion: 1,
    nonce,
    pid: process.pid,
    hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? null,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseMs,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = openSync(lockPath, 'wx');
      try {
        writeFileSync(handle, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      } finally {
        closeSync(handle);
      }
      let released = false;
      const timer = setInterval(() => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (current?.nonce !== nonce) return;
          writeLease(lockPath, { ...record, heartbeatAt: new Date().toISOString() });
        } catch {
          // A failed heartbeat shortens the lease; it never releases it early.
        }
      }, heartbeatMs);
      timer.unref?.();
      const release = () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (current?.nonce === nonce) rmSync(lockPath, { force: true });
        } catch {
          // The lease will expire on its own if it cannot be removed.
        }
      };
      return { ok: true, path: lockPath, release };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, path: lockPath, reason: `verification-lock-unavailable:${error?.code ?? 'unknown'}` };
      }
      const lease = readLease(lockPath);
      if (!lease.stale) {
        return {
          ok: false,
          path: lockPath,
          reason: 'verification-lock-held',
          holder: lease.record ? {
            pid: lease.record.pid ?? null,
            startedAt: lease.record.startedAt ?? null,
            heartbeatAt: lease.record.heartbeatAt ?? null,
          } : null,
        };
      }
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Another contender may have replaced it; the next attempt re-reads it.
      }
    }
  }
  return { ok: false, path: lockPath, reason: 'verification-lock-contended' };
}
