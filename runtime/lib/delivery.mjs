export const deliveryProfiles = Object.freeze({
  'managed-mr': { merge: 'squash', cleanup: 'evidence-compatible', requireReceipt: true },
  'local-land': { merge: 'no-ff', cleanup: 'ancestor', requireReceipt: true },
  'inspect-only': { write: false, requireReceipt: false },
});

const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateDeliveryConfig(config) {
  if (config.delivery !== undefined) {
    const delivery = config.delivery;
    if (!object(delivery) || !object(delivery.profiles) || !nonempty(delivery.default)
      || !Object.hasOwn(delivery.profiles, delivery.default)) throw new Error('delivery.default must reference a declared profile');
    for (const [name, profile] of Object.entries(delivery.profiles)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || !object(profile)
        || typeof profile.requireReceipt !== 'boolean'
        || (profile.write !== undefined && typeof profile.write !== 'boolean')
        || (profile.write !== false && (!['squash', 'no-ff'].includes(profile.merge)
          || !['ancestor', 'evidence-compatible'].includes(profile.cleanup)))
        || (profile.merge === 'squash' && profile.cleanup !== 'evidence-compatible')
        || (profile.write !== false && profile.requireReceipt !== true)) throw new Error(`Invalid delivery profile: ${name}`);
    }
  }
  const services = config.worktree?.provision?.services;
  if (services !== undefined) {
    if (!Array.isArray(services)) throw new Error('worktree.provision.services must be an array');
    const ids = new Set();
    for (const service of services) {
      if (!object(service) || !/^[a-z][a-z0-9-]{0,63}$/u.test(service.id)
        || ids.has(service.id) || !nonempty(service.command)
        || !nonempty(service.cwd) || /^(?:[/\\]|[A-Za-z]:)|(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(service.cwd)
        || !nonempty(service.healthcheck) || typeof service.stopOnTeardown !== 'boolean') throw new Error('Invalid or duplicate managed service');
      const url = new URL(service.healthcheck.replaceAll('${PORT}', '12345'));
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) throw new Error('Service healthcheck must use loopback HTTP without credentials');
      ids.add(service.id);
    }
  }
  const exceptions = config.projectRules?.exceptions;
  if (exceptions !== undefined && !Array.isArray(exceptions)) throw new Error('projectRules.exceptions must be an array');
  const ids = new Set();
  for (const item of exceptions ?? []) {
    if (!object(item) || !nonempty(item.id) || ids.has(item.id)) throw new Error('Invalid or duplicate governance exception');
    ids.add(item.id);
    for (const key of ['owner', 'approvedAt', 'expiresAt', 'reviewCadence', 'rollbackCondition', 'successMetric']) {
      if (item[key] !== undefined && !nonempty(item[key])) throw new Error(`Invalid exception ${key}`);
    }
  }
}

export function resolveDelivery(config, requested) {
  validateDeliveryConfig(config);
  const name = requested ?? config.delivery?.default;
  if (!name) return { profile: 'legacy', requireReceipt: false, warnings: [{ code: 'DELIVERY_LEGACY', message: 'Legacy delivery; declare delivery.default to enable structured completion receipts.' }] };
  const profiles = config.delivery?.profiles ?? {};
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : requested && Object.hasOwn(deliveryProfiles, name) ? deliveryProfiles[name] : null;
  if (!profile || !nonempty(name)) throw new Error(`Unknown delivery profile: ${String(name)}`);
  return { ...profile, profile: name, warnings: [] };
}

export function overrideWarnings(config, now = Date.now()) {
  return (config.projectRules?.exceptions ?? []).flatMap((item) => {
    const required = ['owner', 'approvedAt', 'expiresAt', 'reviewCadence', 'rollbackCondition', 'successMetric'];
    const missing = required.filter((key) => !nonempty(item[key]));
    const approved = Date.parse(item.approvedAt);
    const expires = Date.parse(item.expiresAt);
    const stale = missing.length > 0 || !Number.isFinite(approved) || !Number.isFinite(expires)
      || approved > now || expires <= now || expires <= approved;
    return stale ? [{ code: 'GOVERNANCE_OVERRIDE_STALE', id: item.id, status: 'stale', missing,
      message: 'Exception requires owner reconfirmation; it is not automatically renewed or removed.' }] : [];
  });
}

export function completionReceipt(report, delivery, { rollback = 'Restore the pre-task state using the recorded source fingerprint; no merge was performed.' } = {}) {
  const selected = report.selectedChecks ?? Object.keys(report.checks ?? {});
  const acceptance = selected.map((value) => {
    const id = typeof value === 'string' ? value : value.id ?? value.name;
    const check = report.checks?.[id] ?? {};
    const status = check.status === 'reused' && report.verification?.snapshotComparison === 'match'
      ? 'passed' : ['passed', 'failed', 'blocked'].includes(check.status) ? check.status : 'unverified';
    return { id, status, command: check.command ?? null, scope: report.scope ?? 'layer',
      ...(status !== 'passed' ? { reason: check.code ?? check.reason ?? check.status ?? 'not run' } : {}) };
  });
  const deferred = (report.deferredChecks ?? []).map((check) => check.id ?? check.name ?? check);
  return {
    delivery: { profile: delivery.profile, stage: 'verify' },
    status: ['passed', 'failed', 'blocked'].includes(report.status) ? report.status : report.status === 'reused' ? 'passed' : 'unverified',
    acceptance,
    unverified: [...acceptance.filter((item) => item.status !== 'passed').map((item) => item.id), ...deferred],
    remainingRisks: deferred.length ? ['Deferred checks do not support integration or release completion.'] : [],
    rollback,
    source: { head: report.verification?.after?.head ?? null, fingerprint: report.verification?.fingerprint ?? null },
    target: { head: report.verification?.before?.head ?? null },
    verification: report.verification ?? null,
  };
}

export function validateCompletion(receipt, delivery, current = null) {
  const errors = [];
  if (!object(receipt)) errors.push('completion receipt is missing');
  else {
    if (receipt.delivery?.profile !== delivery.profile || receipt.delivery?.stage !== 'complete') errors.push('delivery profile/stage mismatch');
    if (receipt.status !== 'passed') errors.push('completion status is not passed');
    if (!Array.isArray(receipt.acceptance) || !receipt.acceptance.length) errors.push('acceptance is missing');
    const ids = new Set();
    for (const item of Array.isArray(receipt.acceptance) ? receipt.acceptance : []) {
      if (!nonempty(item?.id) || ids.has(item?.id) || item?.status !== 'passed'
        || !(nonempty(item?.command) || nonempty(item?.criterion)) || !nonempty(item?.scope)) errors.push('acceptance must contain unique passed checks with command/criterion and scope');
      ids.add(item?.id);
    }
    if (!Array.isArray(receipt.unverified) || receipt.unverified.length) errors.push('unverified items remain or are missing');
    if (!Array.isArray(receipt.remainingRisks)) errors.push('remainingRisks is missing');
    if (!nonempty(receipt.rollback)) errors.push('rollback is missing');
    if (!(nonempty(receipt.source?.head) || nonempty(receipt.source?.fingerprint))
      || !(nonempty(receipt.target?.head) || nonempty(receipt.target?.fingerprint))) errors.push('source/target identity is missing');
    const verification = receipt.verification;
    if (!verification?.id || !Number.isFinite(Date.parse(verification.finishedAt))
      || Date.parse(verification.finishedAt) > Date.now() || verification.snapshotComparison !== 'match'
      || !['verified', 'passed', 'completed'].includes(verification.status)
      || !nonempty(verification.fingerprint)) errors.push('current verification evidence is missing');
    if (current && (receipt.source?.head !== current.snapshot.head
      || verification?.fingerprint !== current.fingerprint || !current.fingerprint)) errors.push('verification fingerprint is stale');
    if (current && (!current.writeFingerprint || verification?.writeFingerprint !== current.writeFingerprint
      || Date.parse(verification?.finishedAt) < current.latestWriteAt)) errors.push('new writes invalidate completion evidence');
  }
  return { status: errors.length && delivery.requireReceipt ? 'blocked' : 'passed', errors,
    warnings: errors.length && !delivery.requireReceipt ? [{ code: 'DELIVERY_RECEIPT_LEGACY', message: errors.join('; ') }] : [] };
}
