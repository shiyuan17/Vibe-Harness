// Compatibility surface for callers that still ask for a heavy-verification
// lease. Heavy verification now travels through the repository delivery FIFO,
// so VERIFICATION_LOCK_NAME remains published for migration/diagnostic use
// while new acquisitions create delivery queue tickets instead.
import {
  acquireDeliveryTurn,
  deliveryQueueTimeoutMs,
  inspectDeliveryQueue,
  releaseDeliveryTurn,
} from './worktree-delivery-queue.mjs';

export const VERIFICATION_LOCK_NAME = 'vibe-harness-deep-verify.lock';
export const DEFAULT_VERIFICATION_LEASE_MS = 10 * 60 * 1000;

/** Read the repository queue without acquiring it. */
export async function verificationLockStatus(projectDir) {
  const queue = await inspectDeliveryQueue(projectDir);
  if (!queue.ok) {
    return {
      ok: false,
      reason: queue.error ?? queue.code,
      path: queue.root ?? null,
      held: false,
      stale: false,
      holder: null,
    };
  }
  const running = queue.active.find((ticket) => ticket.state === 'running') ?? null;
  return {
    ok: true,
    path: queue.root,
    held: Boolean(running),
    stale: queue.stale.length > 0,
    holder: running?.owner ?? null,
    queue,
  };
}

/**
 * Acquire the repository FIFO for heavy verification. The returned shape stays
 * compatible with the former exclusive lease, but concurrent contenders wait
 * for their turn instead of failing immediately.
 *
 * @returns {Promise<{ok: boolean, path: string|null, holder?: object|null, reason?: string, release?: () => Promise<boolean>, queue?: object}>}
 */
export async function acquireVerificationLock(projectDir, {
  timeoutMs = deliveryQueueTimeoutMs(),
  onProgress = null,
} = {}) {
  const handle = await acquireDeliveryTurn(projectDir, {
    operation: 'verify',
    timeoutMs,
    onProgress,
  });
  if (!handle.ok) {
    return {
      ok: false,
      path: null,
      reason: handle.code ?? 'verification-lock-unavailable',
      holder: handle.queue?.owner ?? null,
      queue: handle.queue ?? null,
    };
  }
  return {
    ok: true,
    skipped: handle.skipped === true,
    path: null,
    ticketId: handle.ticket?.id ?? null,
    report: handle.report,
    queue: handle.report,
    release: async (status = 'completed') => {
      const released = await releaseDeliveryTurn(handle, status);
      if (released) {
        handle.report.state = status;
        handle.report.owner = null;
      }
      return released;
    },
  };
}
