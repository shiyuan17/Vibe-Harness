const SAFE_ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;

function ownerKey(owner) {
  return owner.kind + ':' + owner.id;
}

function uniqueOwners(owners) {
  const seen = new Set();
  return owners.filter((owner) => {
    const key = ownerKey(owner);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function semanticId(value, label) {
  if (typeof value !== 'string' || value.length > 128 || !SAFE_ID.test(value)) {
    throw new Error(label + ' must be a privacy-safe semantic id');
  }
  return value;
}

function observedBoundary(finalChangeValidation, workflowEvents, exitCode) {
  if (finalChangeValidation.status === 'verified') return 'validated-handoff';
  if (workflowEvents.some((event) => event.kind === 'handoff')) return 'handoff';
  if (exitCode !== 0) return 'blocked';
  return 'execution-end';
}

function boundaryReached(expected, observed) {
  if (expected === 'execution-end') return true;
  if (expected === 'handoff') return observed === 'handoff' || observed === 'validated-handoff';
  return expected === observed;
}

function validationStatus(finalChangeValidation, hiddenTests, exitCode) {
  if (exitCode !== 0 || hiddenTests.failed > 0) return 'failed';
  if (finalChangeValidation.status === 'verified') return 'passed';
  if (finalChangeValidation.status === 'not-applicable' && hiddenTests.total > 0) return 'passed';
  return 'not-observed';
}

function ownerSelected(commands, owner) {
  const expected = owner.kind === 'skill'
    ? '.agents/skills/' + owner.id + '/skill.md'
    : 'docs/rules/' + owner.id + '.md';
  return commands.some((command) => command.toLowerCase().replaceAll('\\', '/').includes(expected));
}

function invocationEvidence(messages, candidates) {
  const invoked = new Set();
  let noMatchConfirmed = false;
  const marker = /\[VIBE_HARNESS_KNOWLEDGE:(owner-invoked):(rule|skill):([a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*)\]/gu;
  for (const message of messages) {
    for (const match of message.matchAll(marker)) {
      const key = match[2] + ':' + match[3];
      if (candidates.some((owner) => ownerKey(owner) === key)) invoked.add(key);
    }
    if (message.includes('[VIBE_HARNESS_KNOWLEDGE:coverage-no-match]')) noMatchConfirmed = true;
  }
  return { invoked, noMatchConfirmed };
}

export function knowledgeCoverageEpisode(input) {
  const config = input.config;
  if (!config) return null;
  const requestRoot = semanticId(config.requestRoot, 'requestRoot');
  const episodeRef = semanticId(input.episodeRef, 'episodeRef');
  const candidates = uniqueOwners(config.candidateOwners.map((owner) => ({
    id: semanticId(owner.id, 'owner id'),
    kind: owner.kind,
  })));
  const invocation = invocationEvidence(input.messages, candidates);
  const ownerEvents = candidates.map((owner) => {
    const key = ownerKey(owner);
    const status = invocation.invoked.has(key) ? 'invoked'
      : ownerSelected(input.commands, owner) ? 'selected' : 'not-observed';
    return { type: 'owner', id: owner.id, kind: owner.kind, status };
  });
  const validation = validationStatus(input.finalChangeValidation, input.hiddenTests, input.exitCode);
  const observed = observedBoundary(input.finalChangeValidation, input.workflowEvents, input.exitCode);
  const stopReached = boundaryReached(config.stopBoundary, observed);
  const covered = ownerEvents.some((event) => event.status === 'invoked')
    && validation === 'passed' && stopReached;
  return {
    schemaVersion: 1,
    episodeRef,
    requestRoot,
    inventoryComplete: config.inventoryComplete,
    events: [
      { type: 'request-root', id: requestRoot },
      ...ownerEvents,
      { type: 'validation', status: validation },
      { type: 'stop-boundary', expected: config.stopBoundary, observed, reached: stopReached },
    ],
    matchStatus: covered ? 'covered' : invocation.noMatchConfirmed ? 'no-match-confirmed' : 'not-observed',
    state: covered ? 'covered' : 'needs-more-evidence',
    promotionStatus: covered ? 'blocked-existing-owner' : 'blocked-insufficient-evidence',
  };
}

export function taskEpisode(input) {
  const demand = input.demand;
  if (!demand) return null;
  const taskFamily = semanticId(demand.taskFamily, 'taskFamily');
  const owner = {
    kind: demand.expectedOwner.kind,
    id: semanticId(demand.expectedOwner.id, 'owner id'),
  };
  const selected = owner.kind === 'rule' || owner.kind === 'skill'
    ? ownerSelected(input.commands, owner) : owner.kind === 'builtin';
  const invocation = invocationEvidence(input.messages, [owner]);
  const observed = invocation.invoked.has(ownerKey(owner))
    || ((owner.kind === 'rule' || owner.kind === 'skill') && selected);
  const validationStatus = input.finalChangeValidation.status;
  const handoff = input.workflowEvents.some((event) => event.kind === 'handoff');
  const lastHandoff = [...input.workflowEvents].reverse().find((event) => event.kind === 'handoff');
  const handoffContract = lastHandoff?.structuredCompletion !== undefined ? lastHandoff : null;
  const structuredHandoffComplete = !handoff || Boolean(handoffContract && (
    handoffContract.structuredCompletion
    && handoffContract.completionStatus === 'complete'
    && handoffContract.completionAccepted
    && (validationStatus === 'not-applicable' || input.finalChangeValidation.relevanceReviewed === true)
    && handoffContract.unresolvedDeclared
    && handoffContract.unresolvedOwners === handoffContract.unresolvedCount
  ));
  const stopBoundary = input.exitCode !== 0 ? 'blocked'
    : validationStatus === 'verified' && structuredHandoffComplete ? 'verified-handoff'
      : validationStatus === 'handoff-unbound' || handoff ? 'handoff-unbound'
        : validationStatus === 'not-applicable' ? 'not-applicable' : 'failed';
  const outcome = input.degraded ? 'degraded'
    : input.exitCode === 0 && input.hiddenTests.failed === 0 && structuredHandoffComplete
      && ['verified', 'not-applicable'].includes(validationStatus)
      ? 'passed' : 'failed';
  const episode = {
    taskFamily,
    owner: {
      ...owner,
      evidenceState: observed ? 'observed' : selected ? 'resolved-active'
        : owner.kind === 'none' ? 'declared' : 'resolved-active',
    },
    validationStatus,
    stopBoundary,
    outcome,
  };
  if (handoffContract) {
    episode.structuredCompletion = handoffContract.structuredCompletion
      && handoffContract.completionStatus === 'complete' && handoffContract.completionAccepted;
    episode.reviewedCheck = handoffContract.reviewedCheck;
    episode.unresolvedOwners = handoffContract.unresolvedOwners === handoffContract.unresolvedCount;
  }
  return episode;
}

export function lifecycleDecision({ goalStatus = 'active', hasNewInput = false, continuationRequested = false, terminalConditionReached = false, approvalPending = false, workspaceDrift = false, unownedHead = false, blockerCount = 0 }) {
  if (goalStatus === 'complete' || terminalConditionReached) return { action: 'stop', reason: 'terminal-condition' };
  if (approvalPending) return { action: 'stop', reason: 'approval-pending' };
  if (workspaceDrift || unownedHead) return { action: 'stop', reason: workspaceDrift ? 'workspace-drift' : 'unowned-head' };
  if (blockerCount >= 3) return { action: 'stop', reason: 'repeated-blocker' };
  if (!hasNewInput) return { action: 'stop', reason: 'no-new-input' };
  return { action: 'continue', reason: continuationRequested ? 'explicit-continuation' : 'new-input' };
}

export function completionClaimStatus(acceptance = []) {
  const items = acceptance.map((item) => ({
    id: item.id,
    status: ['passed', 'failed', 'blocked', 'unverified'].includes(item.status) ? item.status : 'unverified',
  }));
  const complete = items.length > 0 && items.every((item) => item.status === 'passed');
  return { complete, items };
}

export function reconcileKnowledgeCoverageEpisodes(episodes) {
  const available = episodes.filter(Boolean);
  if (available.length === 0) return null;
  const requestRoot = available[0].requestRoot;
  const comparable = available.filter((episode) => episode.requestRoot === requestRoot);
  const distinctEpisodeCount = new Set(comparable.map((episode) => episode.episodeRef)).size;
  const coveredOwners = uniqueOwners(comparable.flatMap((episode) => episode.events
    .filter((event) => event.type === 'owner' && event.status === 'invoked')
    .map((event) => ({ id: event.id, kind: event.kind }))));
  const covered = comparable.some((episode) => episode.state === 'covered');
  const confirmedUncovered = !covered && distinctEpisodeCount >= 2
    && comparable.every((episode) => episode.inventoryComplete && episode.matchStatus === 'no-match-confirmed');
  return {
    requestRoot,
    distinctEpisodeCount,
    minimumComparableEpisodes: 2,
    coveredOwners,
    state: covered ? 'covered' : confirmedUncovered ? 'confirmed-uncovered' : 'needs-more-evidence',
    promotionStatus: covered ? 'blocked-existing-owner'
      : confirmedUncovered ? 'eligible-for-owner-review' : 'blocked-insufficient-evidence',
  };
}
