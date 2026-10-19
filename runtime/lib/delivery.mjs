export const deliveryProfiles = Object.freeze({
  'managed-mr': { merge: 'squash', cleanup: 'evidence-compatible', requireReceipt: true, reviewPolicy: 'required' },
  'local-land': { merge: 'no-ff', cleanup: 'ancestor', requireReceipt: true, reviewPolicy: 'required' },
  'inspect-only': { write: false, requireReceipt: false },
});

const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isReviewRequired({ reviewPolicy = 'required', targetBranch = null } = {}) {
  return !(reviewPolicy === 'none' && targetBranch === 'develop');
}

export function validateDeliveryConfig(config) {
  if (config.delivery !== undefined) {
    const delivery = config.delivery;
    if (!object(delivery) || !object(delivery.profiles) || !nonempty(delivery.default)
      || !Object.hasOwn(delivery.profiles, delivery.default)) throw new Error('delivery.default must reference a declared profile');
    for (const [name, profile] of Object.entries(delivery.profiles)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || !object(profile)
        || typeof profile.requireReceipt !== 'boolean'
        || (profile.reviewPolicy !== undefined && !['required', 'none'].includes(profile.reviewPolicy))
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
      // The probe has to hit this service's allocated port: a fixed port, or a
      // placeholder used only in the path or query, would let an unrelated
      // server that already listens there satisfy the health check.
      if (!service.healthcheck.includes('${PORT}')) {
        throw new Error('Service healthcheck must target the allocated ${PORT}');
      }
      const url = new URL(service.healthcheck.replaceAll('${PORT}', '12345'));
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) throw new Error('Service healthcheck must use loopback HTTP without credentials');
      if (url.port !== '12345') throw new Error('Service healthcheck must place ${PORT} in the URL port');
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
  if (!name) return { profile: 'legacy', requireReceipt: false, reviewPolicy: 'required', warnings: [{ code: 'DELIVERY_LEGACY', message: 'Legacy delivery; declare delivery.default to enable structured completion receipts.' }] };
  const profiles = config.delivery?.profiles ?? {};
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : requested && Object.hasOwn(deliveryProfiles, name) ? deliveryProfiles[name] : null;
  if (!profile || !nonempty(name)) throw new Error(`Unknown delivery profile: ${String(name)}`);
  return { reviewPolicy: 'required', ...profile, profile: name, warnings: [] };
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

export function completionReceipt(report, delivery, {
  rollback = 'Restore the pre-task state using the recorded source fingerprint; no merge was performed.',
  targetBranch = null,
} = {}) {
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
  const acceptanceEvidence = report.verification?.acceptance ?? null;
  const acceptanceBlocked = !acceptanceEvidence || acceptanceEvidence.status !== 'accepted';
  // `verify` emits a completion *draft* (delivery.stage stays `verify`): the
  // caller still has to add the acceptance evidence only it can attest — a
  // relevance review, a browser or database check — before `validateCompletion`
  // will accept a `complete` receipt. A draft whose evidence was simply not
  // supplied is therefore `unverified`; `blocked` is reserved for evidence that
  // contradicts completion (a failed check, or a workspace that changed under
  // passing checks and so cannot be attributed the results). Both states fail
  // closed — `validateCompletion` accepts only `passed` — while the top-level
  // CLI verdict (see `verify` in scripts/vibe-harness.js) turns only the
  // refuting state into `invalid`, so an ordinary partial run is not reported
  // as a failed delivery.
  const absentEvidenceReasons = new Set(['DEFERRED_CHECKS', 'NO_REVIEWED_RELEVANT_CHECK']);
  // `snapshotComparison` is `match`/`changed`/`unknown`/`unavailable`; there is
  // no bare `mismatch` value to compare against. A `changed` workspace is what
  // refutes attribution — the run cannot claim the results it reported — while
  // `unknown`/`unavailable` only mean the comparison could not be made at all.
  // Folding both into absent evidence would leave the `blocked` branch below
  // unreachable and report a workspace that changed under passing checks as
  // merely unverified, so `verify` would still exit ok.
  const unobservableWorkspace = acceptanceEvidence?.reasonCode === 'FINAL_SNAPSHOT_MISMATCH'
    && ['unknown', 'unavailable'].includes(report.verification?.snapshotComparison);
  const evidenceAbsent = acceptanceBlocked
    && (absentEvidenceReasons.has(acceptanceEvidence?.reasonCode) || unobservableWorkspace);
  const review = report.verification?.review ?? null;
  const unverified = [
    ...acceptance.filter((item) => item.status !== 'passed').map((item) => item.id),
    ...deferred,
    ...(acceptanceBlocked ? [`review:${acceptanceEvidence?.reasonCode ?? 'NO_ACCEPTANCE_EVIDENCE'}`] : []),
  ];
  return {
    delivery: { profile: delivery.profile, stage: 'verify', targetBranch },
    status: acceptanceBlocked
      ? evidenceAbsent ? 'unverified' : 'blocked'
      : ['passed', 'failed', 'blocked'].includes(report.status) ? report.status : report.status === 'reused' ? 'passed' : 'unverified',
    acceptance,
    unverified,
    remainingRisks: deferred.length ? ['Deferred checks do not support integration or release completion.'] : [],
    rollback,
    source: { head: report.verification?.after?.head ?? null, fingerprint: report.verification?.fingerprint ?? null },
    target: { head: report.verification?.before?.head ?? null },
    verification: report.verification ?? null,
    ...(review ? { review } : {}),
    ...(acceptanceEvidence ? { verificationAcceptance: acceptanceEvidence } : {}),
  };
}

export function validateCompletion(receipt, delivery, current = null, { provenance = null, targetBranch = null } = {}) {
  const errors = [];
  if (!object(receipt)) errors.push('completion receipt is missing');
  else {
    // `--receipt` loads caller-supplied JSON, so self-consistency alone is not
    // evidence: a handcrafted receipt can copy the current head, content and
    // write fingerprints from a real run and then assert accepted acceptance
    // for checks that never ran. The cited verification therefore also has to
    // resolve to the tool's own durable record
    // (`attestCompletionProvenance`); a missing attestation fails closed
    // because the default is "not attested".
    if (provenance?.ok !== true) {
      errors.push(`completion receipt provenance is unverified (${provenance?.reason ?? 'not attested'})`);
    }
    if (receipt.delivery?.profile !== delivery.profile || receipt.delivery?.stage !== 'complete') errors.push('delivery profile/stage mismatch');
    if ((receipt.delivery?.targetBranch ?? null) !== (targetBranch ?? null)) errors.push('delivery target branch mismatch');
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
    // `--receipt` loads caller-supplied JSON, so the acceptance payload is only
    // evidence while it is internally consistent with the verification it
    // cites: it must name the selected checks, overlap the reviewed set, and
    // carry the same fingerprint. A self-asserted `status: 'accepted'` on its
    // own would let a handcrafted receipt claim a review that never happened.
    const acceptance = verification?.acceptance;
    const acceptanceIds = [...ids];
    if (!acceptance || acceptance.status !== 'accepted') {
      errors.push('reviewed relevant check and final acceptance evidence are missing');
    } else {
      const selectedIds = Array.isArray(acceptance.selectedCheckIds) ? acceptance.selectedCheckIds : [];
      const reviewedIds = Array.isArray(verification.review?.reviewedCheckIds) ? verification.review.reviewedCheckIds : [];
      if (selectedIds.length === 0) errors.push('acceptance evidence does not name the selected checks');
      const uniqueSelectedIds = [...new Set(selectedIds)];
      if (uniqueSelectedIds.length !== selectedIds.length) errors.push('acceptance evidence repeats a selected check');
      const outside = acceptanceIds.filter((id) => !selectedIds.includes(id));
      if (outside.length > 0) errors.push(`acceptance entries are not part of the selected checks: ${outside.join(', ')}`);
      // Every selected check has to carry its own acceptance entry: an
      // acceptance that cites only the passing ones would hide a failed or
      // unverified selection behind a plausible subset.
      const omitted = uniqueSelectedIds.filter((id) => !acceptanceIds.includes(id));
      if (omitted.length > 0) errors.push(`selected checks are missing acceptance entries: ${omitted.join(', ')}`);
      const reviewNotRequired = verification.review?.status === 'not_required'
        && verification.review?.reviewPolicy === 'none'
        && verification.review?.targetBranch === 'develop'
        && targetBranch === 'develop'
        && delivery.reviewPolicy === 'none';
      if (!reviewNotRequired && (verification.review?.status !== 'relevant'
        || !reviewedIds.some((id) => acceptanceIds.includes(id)))) {
        errors.push('acceptance evidence does not cite a reviewed relevant check');
      }
      // A subset test in one direction still lets a receipt name extra checks
      // it never accepted, or accept a check it never reviewed: the reviewed set
      // has to live inside the selection, and the acceptance has to cover it.
      const outsideReview = reviewedIds.filter((id) => !selectedIds.includes(id));
      if (outsideReview.length > 0) errors.push(`reviewed checks are not part of the selected checks: ${outsideReview.join(', ')}`);
      const uncovered = [...new Set(reviewedIds)].filter((id) => !acceptanceIds.includes(id));
      if (uncovered.length > 0) errors.push(`acceptance entries do not cover the reviewed checks: ${uncovered.join(', ')}`);
      const reviewSelected = Array.isArray(verification.review?.selectedCheckIds) ? verification.review.selectedCheckIds : [];
      if (reviewSelected.length > 0
        && JSON.stringify([...reviewSelected].sort()) !== JSON.stringify([...selectedIds].sort())) {
        errors.push('review and acceptance evidence disagree about the selected checks');
      }
      if (!nonempty(acceptance.finalFingerprint) || acceptance.finalFingerprint !== verification.fingerprint) {
        errors.push('acceptance evidence does not match the verification fingerprint');
      }
    }
    if (current && (receipt.source?.head !== current.snapshot.head
      || verification?.fingerprint !== current.fingerprint || !current.fingerprint)) errors.push('verification fingerprint is stale');
    if (current && (!current.writeFingerprint || verification?.writeFingerprint !== current.writeFingerprint
      || Date.parse(verification?.finishedAt) < current.latestWriteAt)) errors.push('new writes invalidate completion evidence');
  }
  return { status: errors.length && delivery.requireReceipt ? 'blocked' : 'passed', errors,
    warnings: errors.length && !delivery.requireReceipt ? [{ code: 'DELIVERY_RECEIPT_LEGACY', message: errors.join('; ') }] : [] };
}
