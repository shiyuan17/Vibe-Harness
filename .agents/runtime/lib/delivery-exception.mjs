import { verify, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isProtectedDeliveryRef } from './git-delivery-target.mjs';

const START = 'Vibe-Harness-Exception: v1';
const END = 'Vibe-Harness-Exception-End';
const authenticated = new WeakSet();
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const checkId = /^[a-z][a-z0-9._-]{0,80}$/u;
const hard = /(?:secret|credential|safety|security|red.?zone|conflict|ownership|permission|push.?target|integrity)/iu;
export function parseDeliveryException(message) {
  if (!message.includes(START)) return null;
  if (message.split(START).length !== 2 || message.split(END).length !== 2) throw new Error('DELIVERY_EXCEPTION_INVALID');
  let record;
  try { record = JSON.parse(message.split(START)[1].split(END)[0]); } catch { throw new Error('DELIVERY_EXCEPTION_INVALID'); }
  const keys = ['checks', 'tree', 'targetRef', 'reason', 'authorization', 'residualRisk', 'affectedCommit'];
  if (!record || typeof record !== 'object' || Object.keys(record).some((key) => !keys.includes(key))
    || !oid.test(record.tree ?? '') || !/^refs\/heads\/.+$/u.test(record.targetRef ?? '')
    || isProtectedDeliveryRef(record.targetRef)
    || !/^refs\/heads\/(?:develop|(?:codex|feature|feat|fix|bugfix|hotfix)\/.+)$/u.test(record.targetRef)
    || !Array.isArray(record.checks) || !record.checks.length
    || new Set(record.checks.map((item) => item?.id)).size !== record.checks.length
    || record.checks.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
      || !checkId.test(item.id ?? '') || hard.test(item.id)
      || !['failed', 'blocked', 'unverified'].includes(item.status)
      || Object.keys(item).some((key) => !['id', 'status'].includes(key)))
    || ['reason', 'authorization', 'residualRisk'].some((key) => typeof record[key] !== 'string'
      || !record[key].trim() || record[key].length > 500
      || /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|-----BEGIN|\bsk-[A-Za-z0-9]{16})/u.test(record[key]))
    || record.affectedCommit !== undefined && !oid.test(record.affectedCommit)) throw new Error('DELIVERY_EXCEPTION_INVALID');
  return record;
}
export function deliveryExceptionMessage(record) {
  const result = `${START}\n${JSON.stringify(record, null, 2)}\n${END}`;
  parseDeliveryException(result);
  return result;
}

/** Local Git text is NOT authorization. Only the separately trusted host may
 * sign this payload. No env/CLI switch can register a key or mark a grant valid.
 * The system trust store is provisioned by the host, never by the installer.
 */
export async function trustedDeliveryKeys() {
  const file = process.platform === 'win32'
    ? 'C:/ProgramData/Vibe-Harness/host-delivery-keys.json' : '/etc/vibe-harness/host-delivery-keys.json';
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.schemaVersion === 1 && value.keys && typeof value.keys === 'object' ? value.keys : {};
  } catch { return {}; }
}
/** @param {{tree?: string, ref?: string, affectedCommit?: string}} context */
export function authenticateDeliveryException(record, signed, keys, context = {}) {
  const { tree, ref, affectedCommit } = context;
  try {
    parseDeliveryException(deliveryExceptionMessage(record));
    const payload = signed?.payload;
    if (!payload || payload.purpose !== 'vibe-harness.split-push-exception/v1'
      || payload.tree !== tree || record.tree !== tree || payload.ref !== ref || record.targetRef !== ref
      || payload.affectedCommit !== affectedCommit || record.affectedCommit !== affectedCommit
      || JSON.stringify(payload.checks) !== JSON.stringify(record.checks)
      || payload.authorization !== record.authorization
      || payload.reason !== record.reason || payload.residualRisk !== record.residualRisk
      || !keys[signed.keyId] || typeof signed.signature !== 'string') return null;
    const key = createPublicKey(keys[signed.keyId]);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    if (!verify(null, Buffer.from(JSON.stringify(payload)), key,
      Buffer.from(signed.signature, 'base64'))) return null;
    const grant = Object.freeze({ ...record, checks: Object.freeze(record.checks.map((item) => Object.freeze({ ...item }))) });
    authenticated.add(grant);
    return grant;
  } catch { return null; }
}
export function qualityExceptionFor(grants, id) {
  if (hard.test(id)) return null;
  for (const grant of grants ?? []) {
    if (!authenticated.has(grant)) continue;
    const entry = grant.checks.find((item) => item.id === id);
    if (entry) return { ...entry, reason: grant.reason, residualRisk: grant.residualRisk };
  }
  return null;
}
export async function authorizeDeliveryException(message, context) {
  const record = parseDeliveryException(message);
  if (!record) return null;
  const keys = await trustedDeliveryKeys();
  if (!Object.keys(keys).length) throw new Error('DELIVERY_EXCEPTION_HOST_UNAVAILABLE: no trusted host signing capability; Git text and Agent JSON are not authorization. Only exception-dependent delivery is blocked.');
  let signed;
  try { signed = JSON.parse(process.env.VIBE_HARNESS_DELIVERY_AUTHORIZATION ?? 'null'); } catch { /* invalid grant */ }
  const grant = authenticateDeliveryException(record, signed, keys, context);
  if (!grant) throw new Error('DELIVERY_EXCEPTION_UNAUTHORIZED: host grant does not cover this tree, ref and checks.');
  return grant;
}
