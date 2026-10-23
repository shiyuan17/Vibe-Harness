import { randomUUID } from 'node:crypto';

export const CLAIM_ERROR_CODES = Object.freeze([
  'CLAIM_CAPABILITY_UNAVAILABLE',
  'CLAIM_CONFLICT',
  'LEASE_EXPIRED',
  'FENCING_MISMATCH',
  'HANDOFF_CAS_CONFLICT',
]);

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const utcTimestampPattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

function claimError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !utcTimestampPattern.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value.slice(0, 10);
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
  if (!uuidV4Pattern.test(request.claimId)) throw new TypeError('claimId must be UUID v4');
  if (!isUtcTimestamp(request.leaseExpiresAt)) throw new TypeError('leaseExpiresAt must be an RFC3339 UTC timestamp');
}

function assertClaimIdentity(current, claimId, fencingToken) {
  if (typeof claimId !== 'string' || !uuidV4Pattern.test(claimId)) {
    throw new TypeError('claimId must be UUID v4');
  }
  if (typeof fencingToken !== 'string' || fencingToken.trim() === '') {
    throw new TypeError('fencingToken is required');
  }
  if (!current || current.claimId !== claimId) {
    throw claimError('HANDOFF_CAS_CONFLICT', 'claimId does not match the active claim');
  }
  if (current.fencingToken !== fencingToken) {
    throw claimError('FENCING_MISMATCH', 'fencing token does not match the active claim');
  }
}

/** @param {any} options */
export function createClaimRequest({
  issueId,
  executionId = randomUUID(),
  claimId = randomUUID(),
  idempotencyKey = randomUUID(),
  leaseExpiresAt,
  fencingToken,
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
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid date');
  }
  const nowMs = now.getTime();
  // A lease that cannot be parsed is not "still active": `Date.parse` returns
  // NaN and every comparison against it is false, so an unreadable lease would
  // fall through to `claimable` and silently replace an unreconciled claim.
  // Both an expired and an unreadable lease have to be reconciled explicitly.
  const currentLeaseExpiresAt = currentClaim ? Date.parse(currentClaim.leaseExpiresAt) : Number.NaN;
  if (currentClaim && (!isUtcTimestamp(currentClaim.leaseExpiresAt) || currentLeaseExpiresAt <= nowMs)) {
    throw claimError('LEASE_EXPIRED', 'expired or unreadable claim requires explicit reconciliation; it cannot be replaced automatically');
  }
  if (Date.parse(request.leaseExpiresAt) <= nowMs) {
    throw new TypeError('leaseExpiresAt must be in the future');
  }
  if (currentClaim
    && currentClaim.issueId === request.issueId
    && currentClaim.idempotencyKey === request.idempotencyKey) {
    const sameRequest = Object.keys(request).every((field) => currentClaim[field] === request[field]);
    if (!sameRequest) {
      throw claimError('CLAIM_CONFLICT', 'idempotency key was reused with different claim contents');
    }
    return { status: 'idempotent', claim: currentClaim };
  }
  if (currentClaim) {
    throw claimError('CLAIM_CONFLICT', `Issue ${request.issueId} already has an active claim`);
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
  assertClaimIdentity(current, request?.claimId, fencingToken);
  return { status: 'released', claim: null };
}

/** @param {any} current @param {any} request @param {any} options */
export function renewClaim(current, { claimId, fencingToken, leaseExpiresAt }, { now = new Date() } = {}) {
  assertClaimIdentity(current, claimId, fencingToken);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid date');
  }
  const nowMs = now.getTime();
  const currentLeaseExpiresAt = Date.parse(current.leaseExpiresAt);
  if (!isUtcTimestamp(current.leaseExpiresAt) || currentLeaseExpiresAt <= nowMs) {
    throw claimError('LEASE_EXPIRED', 'expired or unreadable claim must be reconciled before renewal');
  }
  if (!isUtcTimestamp(leaseExpiresAt) || Date.parse(leaseExpiresAt) <= nowMs) {
    throw new TypeError('renewed leaseExpiresAt must be in the future');
  }
  return { status: 'renewed', claim: { ...current, leaseExpiresAt } };
}

/**
 * Verify a Claim against the host's authoritative, persistent provider.
 * The provider is an injected host capability, never a user/Issue/CLI payload.
 * A structurally valid Linear comment is not evidence of this lookup.
 * @param {any} receipt
 * @param {{name:string, capabilities:{atomicClaim:boolean,fencing:boolean}, readClaim:Function}} provider
 * @param {{idempotencyKey?:string, now?:Date}} options
 */
export async function verifyProviderClaim(receipt, provider, { idempotencyKey, now = new Date() } = {}) {
  assertAtomicCapability(provider?.capabilities);
  if (typeof provider?.readClaim !== 'function' || typeof provider.name !== 'string'
    || provider.name !== receipt?.claimProvider) {
    throw claimError('CLAIM_CAPABILITY_UNAVAILABLE', 'an authoritative host Claim provider is required');
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw claimError('CLAIM_CAPABILITY_UNAVAILABLE', 'host idempotency key is required');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid date');
  if (!isUtcTimestamp(receipt?.leaseExpiresAt) || Date.parse(receipt.leaseExpiresAt) <= now.getTime()) {
    throw claimError('LEASE_EXPIRED', 'Claim lease is expired or invalid');
  }
  const current = await provider.readClaim({
    issueId: receipt.dagNodeIssue,
    claimId: receipt.claimId,
    idempotencyKey,
  });
  if (!current || current.claimId !== receipt.claimId || current.issueId !== receipt.dagNodeIssue
    || current.executionId !== receipt.executionId || current.idempotencyKey !== idempotencyKey) {
    throw claimError('CLAIM_CONFLICT', 'no matching authoritative Claim record');
  }
  if (receipt.source === 'authorized-auto-claim' && current.grantId !== receipt.grantId) {
    throw claimError('CLAIM_CONFLICT', 'provider Grant reference does not match Receipt');
  }
  if (current.fencingToken !== receipt.fencingToken) {
    throw claimError('FENCING_MISMATCH', 'provider fencing token does not match Receipt');
  }
  if (current.leaseExpiresAt !== receipt.leaseExpiresAt) {
    throw claimError('CLAIM_CONFLICT', 'provider lease does not match Receipt');
  }
  return current;
}
