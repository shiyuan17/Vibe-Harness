import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { delay } from './cli-runtime.mjs';
import {
  acquireLeaseWithRetry,
  DEFAULT_GRACE_MS,
  readLease,
  releaseLease,
} from './lease-lock.mjs';

const execute = promisify(execFile);

export const DELIVERY_QUEUE_DIR = 'vibe-harness-delivery-queue';
export const DELIVERY_QUEUE_STATES = Object.freeze(['queued', 'running', 'completed', 'cancelled', 'expired']);
// Only `publish` takes a repository FIFO turn, and only for its seconds-scale
// finalize section; every other delivery subcommand runs entirely outside the
// queue, so no other operation may enqueue a ticket.
export const DELIVERY_QUEUE_OPERATIONS = Object.freeze(['publish']);
export const DEFAULT_DELIVERY_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;
const QUEUE_MUTEX_TIMEOUT_MS = 15_000;
const QUEUE_MUTEX_RETRY_MS = 25;
const QUEUE_TICKET_LEASE_MS = 60_000;
const QUEUE_TICKET_HEARTBEAT_MS = 15_000;
const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;
const TICKET_PATTERN = /^(\d{12})-([0-9a-f-]{36})\.json$/iu;

function queueTimeoutFromEnv(env = process.env) {
  for (const name of ['VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS', 'VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS']) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return DEFAULT_DELIVERY_QUEUE_TIMEOUT_MS;
}

async function commonDirectory(projectDir) {
  try {
    const { stdout } = await execute('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    const value = stdout.trim();
    if (!value) return null;
    return path.resolve(projectDir, value);
  } catch {
    return null;
  }
}

async function insideGitWorktree(projectDir) {
  try {
    const { stdout } = await execute('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function deliveryQueueLayout(projectDir) {
  const common = await commonDirectory(projectDir);
  if (!common) {
    if (!(await insideGitWorktree(projectDir))) return { ok: false, skipped: true, reason: 'not-a-git-worktree' };
    return { ok: false, reason: 'git-common-dir-unavailable' };
  }
  const root = path.join(common, DELIVERY_QUEUE_DIR);
  return {
    ok: true,
    commonDir: common,
    root,
    mutexPath: path.join(root, 'queue.lock'),
    sequencePath: path.join(root, 'next-sequence.json'),
  };
}

function ensureLayout(layout) {
  mkdirSync(layout.root, { recursive: true });
}

function atomicJsonWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, file);
}

function ticketFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TICKET_PATTERN.test(entry.name))
    .map((entry) => {
      const match = TICKET_PATTERN.exec(entry.name);
      return { file: path.join(root, entry.name), sequence: Number(match[1]), id: match[2] };
    })
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function readTicket(item) {
  try {
    const ticket = JSON.parse(readFileSync(item.file, 'utf8'));
    if (ticket?.schemaVersion !== 1 || ticket.id !== item.id || ticket.sequence !== item.sequence
      || !DELIVERY_QUEUE_STATES.includes(ticket.state)) return null;
    return { ...ticket, file: item.file };
  } catch {
    return null;
  }
}

function ticketFreshness(ticket) {
  const lease = readLease(ticket.file);
  const stateActive = ['queued', 'running'].includes(ticket.state);
  let malformedStale = false;
  if (lease.record === null) {
    try {
      malformedStale = Date.now() - statSync(ticket.file).mtimeMs > DEFAULT_GRACE_MS;
    } catch {
      malformedStale = true;
    }
  }
  return {
    alive: lease.alive,
    expired: lease.expired,
    stale: stateActive && (lease.stale || malformedStale),
  };
}

function publicTicket(ticket, position = null, ahead = null) {
  return {
    id: ticket.id,
    sequence: ticket.sequence,
    operation: ticket.operation,
    batchId: ticket.batchId ?? null,
    state: ticket.state,
    requestedAt: ticket.requestedAt,
    startedAt: ticket.startedAt ?? null,
    heartbeatAt: ticket.heartbeatAt,
    stale: ticket.stale === true,
    position,
    ahead,
    owner: ticket.state === 'running' ? {
      pid: ticket.pid,
      hostname: ticket.hostname ?? null,
      operation: ticket.operation,
      batchId: ticket.batchId ?? null,
      startedAt: ticket.startedAt ?? null,
    } : null,
  };
}

function activeTickets(root) {
  const active = [];
  const stale = [];
  for (const item of ticketFiles(root)) {
    const ticket = readTicket(item);
    if (!ticket || !['queued', 'running'].includes(ticket.state)) continue;
    const freshness = ticketFreshness(ticket);
    if (freshness.stale) stale.push(ticket);
    else active.push(ticket);
  }
  return { active, stale };
}

async function withQueueMutex(layout, action) {
  ensureLayout(layout);
  const acquired = await acquireLeaseWithRetry(layout.mutexPath, {
    timeoutMs: QUEUE_MUTEX_TIMEOUT_MS,
    retryMs: QUEUE_MUTEX_RETRY_MS,
    leaseMs: 30_000,
  });
  if (!acquired.ok) return { ok: false, code: 'DELIVERY_QUEUE_MUTEX_UNAVAILABLE', error: acquired.error ?? acquired.code };
  try {
    return { ok: true, value: await action() };
  } finally {
    releaseLease(layout.mutexPath);
  }
}

function nextSequence(layout) {
  let current = 0;
  try {
    const value = JSON.parse(readFileSync(layout.sequencePath, 'utf8'));
    if (Number.isSafeInteger(value?.sequence) && value.sequence >= 0) current = value.sequence;
  } catch {
    for (const item of ticketFiles(layout.root)) current = Math.max(current, item.sequence);
  }
  const sequence = current + 1;
  atomicJsonWrite(layout.sequencePath, { schemaVersion: 1, sequence });
  return sequence;
}

export async function enqueueDelivery(projectDir, {
  operation,
  batchId = null,
  metadata = {},
} = {}) {
  if (!DELIVERY_QUEUE_OPERATIONS.includes(operation)) {
    return { ok: false, code: 'DELIVERY_QUEUE_OPERATION_INVALID', error: `invalid delivery operation: ${operation}` };
  }
  const layout = await deliveryQueueLayout(projectDir);
  if (!layout.ok && layout.skipped) {
    return {
      ok: true,
      skipped: true,
      ticket: null,
      release: () => false,
      report: { state: 'skipped', ticketId: null, position: 0, ahead: 0, waitedMs: 0, owner: null },
    };
  }
  if (!layout.ok) return { ok: false, code: 'DELIVERY_QUEUE_UNAVAILABLE', error: layout.reason };
  const result = await withQueueMutex(layout, () => {
    for (const stale of activeTickets(layout.root).stale) {
      atomicJsonWrite(stale.file, { ...stale, state: 'expired', expiredAt: new Date().toISOString(), file: undefined });
    }
    const sequence = nextSequence(layout);
    const id = randomUUID();
    const now = new Date().toISOString();
    const ticket = {
      schemaVersion: 1,
      id,
      sequence,
      operation,
      batchId,
      state: 'queued',
      requestedAt: now,
      startedAt: null,
      heartbeatAt: now,
      leaseMs: QUEUE_TICKET_LEASE_MS,
      pid: process.pid,
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? null,
      metadata,
    };
    const file = path.join(layout.root, `${String(sequence).padStart(12, '0')}-${id}.json`);
    atomicJsonWrite(file, ticket);
    return { ticket: { ...ticket, file }, file };
  });
  if (!result.ok) return result;
  return { ok: true, ...result.value };
}

function startTicketHeartbeat(ticket) {
  let lost = false;
  const timer = setInterval(() => {
    try {
      const current = JSON.parse(readFileSync(ticket.file, 'utf8'));
      if (current?.id !== ticket.id || !['queued', 'running'].includes(current.state)) {
        lost = true;
        clearInterval(timer);
        return;
      }
      atomicJsonWrite(ticket.file, { ...current, heartbeatAt: new Date().toISOString() });
    } catch {
      lost = true;
      clearInterval(timer);
    }
  }, QUEUE_TICKET_HEARTBEAT_MS);
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

export async function acquireDeliveryTurn(projectDir, {
  operation,
  batchId = null,
  metadata = {},
  timeoutMs = queueTimeoutFromEnv(),
  onProgress = null,
  retryMs = 100,
} = {}) {
  const queued = await enqueueDelivery(projectDir, { operation, batchId, metadata });
  if (!queued.ok) return queued;
  if (queued.skipped) return queued;
  const layout = await deliveryQueueLayout(projectDir);
  if (!layout.ok) {
    return { ok: false, code: 'DELIVERY_QUEUE_UNAVAILABLE', error: layout.reason };
  }
  const ticket = queued.ticket;
  const startedWaitingAt = Date.now();
  const deadline = startedWaitingAt + timeoutMs;
  const heartbeat = startTicketHeartbeat(ticket);
  let lastPosition = null;
  let owned = false;
  const release = async (status = 'completed') => {
    heartbeat.stop();
    if (!['completed', 'cancelled', 'expired'].includes(status)) return false;
    const changed = await withQueueMutex(layout, () => {
      let current;
      try {
        current = JSON.parse(readFileSync(ticket.file, 'utf8'));
      } catch {
        return false;
      }
      if (current?.id !== ticket.id || current.pid !== process.pid) return false;
      atomicJsonWrite(ticket.file, {
        ...current,
        state: status,
        releasedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      });
      return true;
    });
    owned = false;
    const released = changed.ok && changed.value;
    if (released) {
      onProgress?.({
        kind: 'vibe-harness.progress',
        command: operation,
        phase: 'queue-released',
        at: new Date().toISOString(),
        queue: {
          state: status,
          ticketId: ticket.id,
          position: null,
          ahead: null,
          waitedMs: Date.now() - startedWaitingAt,
          owner: null,
        },
      });
    }
    return released;
  };
  try {
    for (;;) {
      if (heartbeat.lost) {
        return {
          ok: false,
          code: 'DELIVERY_QUEUE_LEASE_LOST',
          error: 'delivery queue ticket lease was lost while waiting',
          ticket: publicTicket(ticket),
        };
      }
      const acquired = await withQueueMutex(layout, () => {
        const { active } = activeTickets(layout.root);
        const index = active.findIndex((item) => item.id === ticket.id);
        if (index < 0) return { missing: true };
        const position = index + 1;
        const ahead = index;
        if (index === 0 && active[index].state === 'queued') {
          const running = {
            ...active[index],
            state: 'running',
            startedAt: active[index].startedAt ?? new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
          };
          delete running.file;
          atomicJsonWrite(ticket.file, running);
          return {
            owned: true,
            ticket: running,
            position: 1,
            ahead: 0,
            tickets: active.map((item, offset) => publicTicket(
              item.id === running.id ? { ...item, ...running } : item,
              offset + 1,
              offset,
            )),
          };
        }
        return {
          position,
          ahead,
          tickets: active.map((item, offset) => publicTicket(item, offset + 1, offset)),
        };
      });
      if (!acquired.ok) return acquired;
      const state = acquired.value;
      if (state.missing) {
        return { ok: false, code: 'DELIVERY_QUEUE_TICKET_MISSING', error: 'delivery queue ticket disappeared' };
      }
      const report = {
        state: state.owned ? 'running' : 'queued',
        ticketId: ticket.id,
        position: state.position,
        ahead: state.ahead,
        waitedMs: Date.now() - startedWaitingAt,
        owner: state.owned ? {
          pid: process.pid,
          hostname: ticket.hostname,
          operation,
          batchId,
          startedAt: state.ticket?.startedAt ?? null,
        } : state.tickets?.find((item) => item.state === 'running')?.owner ?? null,
      };
      if (state.owned) {
        owned = true;
        onProgress?.({ kind: 'vibe-harness.progress', command: operation, phase: 'queue-ready', at: new Date().toISOString(), queue: report });
        return {
          ok: true,
          ticket: publicTicket({ ...ticket, ...state.ticket }, 1, 0),
          report,
          release,
          get lost() {
            return heartbeat.lost;
          },
        };
      }
      if (state.position !== lastPosition) {
        lastPosition = state.position;
        onProgress?.({ kind: 'vibe-harness.progress', command: operation, phase: 'queue-wait', at: new Date().toISOString(), queue: report });
      }
      if (Date.now() >= deadline) {
        await release('cancelled');
        return {
          ok: false,
          code: 'WORKTREE_QUEUE_TIMEOUT',
          error: `delivery queue wait exceeded ${timeoutMs}ms`,
          queue: { ...report, waitedMs: Date.now() - startedWaitingAt },
        };
      }
      await delay(Math.max(10, Math.min(retryMs, deadline - Date.now())));
    }
  } catch (error) {
    await release('cancelled').catch(() => false);
    return { ok: false, code: 'DELIVERY_QUEUE_FAILED', error: error.message };
  } finally {
    if (!owned) heartbeat.stop();
  }
}

export async function releaseDeliveryTurn(handle, status = 'completed') {
  if (!handle) return false;
  if (handle.skipped) return true;
  return typeof handle.release === 'function' ? handle.release(status) : false;
}

export async function inspectDeliveryQueue(projectDir, { includeTerminal = true } = {}) {
  const layout = await deliveryQueueLayout(projectDir);
  if (!layout.ok && layout.skipped) return { ok: true, skipped: true, root: null, active: [], tickets: [] };
  if (!layout.ok) return { ok: false, code: 'DELIVERY_QUEUE_UNAVAILABLE', error: layout.reason };
  const records = ticketFiles(layout.root).map(readTicket).filter(Boolean);
  const normalized = records.map((ticket) => {
    const freshness = ticketFreshness(ticket);
    return {
      ...ticket,
      state: freshness.stale ? 'expired' : ticket.state,
      stale: freshness.stale,
    };
  });
  const active = normalized
    .filter((ticket) => ['queued', 'running'].includes(ticket.state))
    .map((ticket, index) => publicTicket(ticket, index + 1, index));
  const tickets = normalized.map((ticket) => publicTicket(ticket));
  return {
    ok: true,
    root: layout.root,
    active,
    tickets: includeTerminal ? tickets : active,
    stale: tickets.filter((ticket) => ticket.stale),
  };
}

export async function reconcileDeliveryQueue(projectDir, {
  write = false,
  retentionMs = QUEUE_RETENTION_MS,
} = {}) {
  const layout = await deliveryQueueLayout(projectDir);
  if (!layout.ok && layout.skipped) return { ok: true, skipped: true, expired: [], removed: [] };
  if (!layout.ok) return { ok: false, code: 'DELIVERY_QUEUE_UNAVAILABLE', error: layout.reason };
  const result = await withQueueMutex(layout, () => {
    const expired = [];
    const removed = [];
    for (const item of ticketFiles(layout.root)) {
      const ticket = readTicket(item);
      if (!ticket) continue;
      if (['queued', 'running'].includes(ticket.state) && ticketFreshness(ticket).stale) {
        const next = { ...ticket, state: 'expired', expiredAt: new Date().toISOString() };
        delete next.file;
        expired.push(publicTicket(next));
        if (write) atomicJsonWrite(item.file, next);
        continue;
      }
      const releasedAt = Date.parse(ticket.releasedAt ?? ticket.expiredAt ?? '');
      if (write && ['completed', 'cancelled', 'expired'].includes(ticket.state)
        && Number.isFinite(releasedAt) && Date.now() - releasedAt > retentionMs) {
        rmSync(item.file, { force: true });
        removed.push(ticket.id);
      }
    }
    return { expired, removed };
  });
  if (!result.ok) return result;
  return { ok: true, ...result.value };
}

export function deliveryQueueTimeoutMs(env = process.env) {
  return queueTimeoutFromEnv(env);
}
