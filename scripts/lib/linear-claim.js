import { randomUUID } from 'node:crypto';

export const CLAIM_ERROR_CODES = Object.freeze([
  'CLAIM_CAPABILITY_UNAVAILABLE',
  'CLAIM_CONFLICT',
  'LEASE_EXPIRED',
  'FENCING_MISMATCH',
  'HANDOFF_CAS_CONFLICT',
]);

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function claimError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertAtomicCapability(capabilities) {
  if (capabilities?.atomicClaim !== true || capabilities?.fencing !== true) {
    throw claimError(
      'CLAIM_CAPABILITY_UNAVAILABLE',
      'provider must support atomic claim and fencing; local locks are not a substitute',
    );
  }
}

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('claim request is required');
  for (const field of ['issueId', 'executionId', 'claimId', 'idempotencyKey', 'leaseExpiresAt', 'fencingToken']) {
    if (typeof request[field] !== 'string' || request[field].trim() === '') {
      throw new TypeError(`claim request ${field} is required`);
    }
  }
  if (!uuidV4Pattern.test(request.executionId)) throw new TypeError('executionId must be UUID v4');
  if (!Number.isFinite(Date.parse(request.leaseExpiresAt))) throw new TypeError('leaseExpiresAt must be an RFC3339 timestamp');
}

/** @param {any} options */
export function createClaimRequest({
  issueId,
  executionId = randomUUID(),
  claimId = randomUUID(),
  idempotencyKey = randomUUID(),
  leaseExpiresAt,
  fencingToken = randomUUID(),
} = {}) {
  const request = { issueId, executionId, claimId, idempotencyKey, leaseExpiresAt, fencingToken };
  assertRequest(request);
  return request;
}

/**
 * Deterministic provider-side claim state transition.
 *
 * The caller persists the returned `claim` atomically with a provider CAS.
 * This helper intentionally keeps no process-global lock.
 */
/** @param {any} current @param {any} request @param {any} options */
export function atomicClaim(current, request, {
  capabilities,
  now = new Date(),
} = {}) {
  assertAtomicCapability(capabilities);
  assertRequest(request);
  const currentClaim = current ?? null;
  if (currentClaim && Date.parse(currentClaim.leaseExpiresAt) <= now.getTime()) {
    throw claimError('LEASE_EXPIRED', 'expired claim requires explicit reconciliation; it cannot be replaced automatically');
  }
  if (currentClaim
    && currentClaim.issueId === request.issueId
    && currentClaim.idempotencyKey === request.idempotencyKey) {
    return { status: 'idempotent', claim: currentClaim };
  }
  if (currentClaim && Date.parse(currentClaim.leaseExpiresAt) > now.getTime()) {
    throw claimError('CLAIM_CONFLICT', `Issue ${request.issueId} already has an active claim`);
  }
  if (currentClaim && currentClaim.fencingToken === request.fencingToken) {
    throw claimError('FENCING_MISMATCH', 'a new claim must use a fresh fencing token');
  }
  return {
    status: 'claimed',
    claim: {
      ...request,
      claimedAt: now.toISOString(),
    },
  };
}

/** @param {any} current @param {any} request @param {any} options */
export function releaseClaim(current, request, { fencingToken } = {}) {
  if (!current) return { status: 'released', claim: null };
  if (current.claimId !== request.claimId) {
    throw claimError('HANDOFF_CAS_CONFLICT', 'claimId does not match the active claim');
  }
  if (fencingToken !== current.fencingToken) {
    throw claimError('FENCING_MISMATCH', 'fencing token does not match the active claim');
  }
  return { status: 'released', claim: null };
}

/** @param {any} current @param {any} request @param {any} options */
export function renewClaim(current, { claimId, fencingToken, leaseExpiresAt }, { now = new Date() } = {}) {
  if (!current || current.claimId !== claimId) {
    throw claimError('HANDOFF_CAS_CONFLICT', 'claimId does not match the active claim');
  }
  if (current.fencingToken !== fencingToken) {
    throw claimError('FENCING_MISMATCH', 'fencing token does not match the active claim');
  }
  if (Date.parse(current.leaseExpiresAt) <= now.getTime()) {
    throw claimError('LEASE_EXPIRED', 'claim lease has expired and must be re-claimed');
  }
  if (!Number.isFinite(Date.parse(leaseExpiresAt)) || Date.parse(leaseExpiresAt) <= now.getTime()) {
    throw new TypeError('renewed leaseExpiresAt must be in the future');
  }
  return { status: 'renewed', claim: { ...current, leaseExpiresAt } };
}
