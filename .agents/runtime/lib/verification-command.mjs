// The `verify` subcommand and its receipt projection.
//
// `verifyProject` orchestrates one verification run: it resolves the tier plan, binds
// it to a task anchor, executes the selected checks, compares the fingerprint before
// and after, and stores or reuses the receipt the completion claim depends on.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runMicroCheck } from './micro-runner.mjs';
import { gitFingerprint, gitTreeFingerprint } from './git-fingerprint.mjs';
import {
  verificationChanges,
  verificationCheckEvidence,
  verificationContextEnvironment,
  verificationCwd,
} from './verification-plan.mjs';
import {
  findVerificationReceipt,
  findVerificationCheckReceipt,
  prepareVerificationReceiptStore,
  storeVerificationCheckReceipt,
  storeVerificationReceipt,
  verificationCacheContext,
} from './verification-receipt.mjs';
import { acquireVerificationLock } from './verification-lock.mjs';

import { boundedOutput } from './cli-output.mjs';
import { CHECK_ORDER, CONFIG_FILE, assertSafeCommand, probeExecutable, readJsonIfExists } from './cli-runtime.mjs';
import { findReusableVerification, readTaskAnchor, taskPlanCheckReport, validateTaskId, verificationCommandSet } from './task-command.mjs';
import { VERIFY_ENGINE, VERIFY_SCHEMA_VERSION, configuredChecks, displayCommand, executeCommand, manualCommand, parseVerifyScope, parseVerifyTier, resolveReviewedChecks, resolveVerifyTierPlan, timeoutValue, verificationAcceptance, verificationReview } from './verification-plan-support.mjs';

/**
 * The task and plan association a verification receipt carries. A receipt that
 * names the task and the plan revision it verified can be traced back to the
 * plan a reader opens, instead of being a free-floating "tests passed".
 */
async function verificationTaskBinding(projectDir, taskId) {
  let read;
  try {
    read = await readTaskAnchor(projectDir, taskId);
  } catch {
    return null;
  }
  if (!read.exists) return null;
  const anchor = read.anchor;
  return {
    id: taskId,
    stage: typeof anchor.stage === 'string' ? anchor.stage : null,
    planFile: typeof anchor.planFile === 'string' ? anchor.planFile : null,
    planRevision: typeof anchor.planRevision === 'string' ? anchor.planRevision : null,
    planDigest: typeof anchor.planDigest === 'string' ? anchor.planDigest : null,
  };
}
export function verificationProgress(args, phase, detail = {}) {
  args.onProgress?.({ kind: 'vibe-harness.progress', command: 'verify', phase,
    at: new Date().toISOString(), ...detail });
}
export async function verifyProject(projectDir, args, { planOnly = false, deliveryQueue = null } = {}) {
  args = { reuse: args.micro === undefined && !args.noReuse, ...args };
  const startedAt = new Date().toISOString();
  if (args.micro !== undefined) {
    if (args.tier || args.only || args.async || args.reuse || args.allowManual || args.noReuse) {
      return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', code: 'MICRO_EXCLUSIVE', error: '--micro cannot be combined with --tier, --only, --async, --reuse, --no-reuse, or --allow-manual.', checks: {} };
    }
    const configInfo = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
    if (configInfo.error) return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', error: configInfo.error, checks: {} };
    const config = configInfo.value ?? {};
    let scope;
    try { scope = parseVerifyScope(args.scope ?? config.verification?.defaultScope); }
    catch (error) { return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', error: error.message, checks: {} }; }
    const micro = await runMicroCheck(projectDir, config.validationCommands?.micro, args.micro, {
      planOnly,
      scope,
      snapshot: () => gitFingerprint(projectDir),
    });
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      engine: VERIFY_ENGINE,
      command: 'verify',
      tier: 'quick',
      scope,
      scopeConfidence: 'unknown',
      minimumTier: 'unit',
      riskLevel: null,
      impactGroups: [],
      selectedMicroChecks: [args.micro],
      selectedChecks: [],
      deferredChecks: [],
      deferredMicroChecks: [],
      nextTier: 'standard',
      status: micro.status,
      checks: { [args.micro]: micro },
      cache: { status: 'not_requested' },
      environment: { mode: 'cold', status: 'cold' },
      snapshotComparison: micro.snapshotComparison ?? 'unknown',
    };
  }
  if (args.task?.[0]) {
    try { validateTaskId(args.task[0]); }
    catch (error) {
      return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', code: error.code, error: error.message, checks: {} };
    }
  }
  const taskIdCandidate = args.task?.[0] ?? null;
  let taskBinding = null;
  if (taskIdCandidate) {
    const planCheck = await taskPlanCheckReport(projectDir, taskIdCandidate);
    if (planCheck.status !== 'passed' && planCheck.code !== 'VIBE_HARNESS_TASK_ANCHOR_MISSING') {
      return {
        schemaVersion: VERIFY_SCHEMA_VERSION,
        engine: VERIFY_ENGINE,
        command: 'verify',
        status: 'blocked',
        code: planCheck.code ?? 'VIBE_HARNESS_PLAN_CHECK_FAILED',
        error: planCheck.error ?? 'task plan check failed',
        checks: {},
      };
    }
    taskBinding = await verificationTaskBinding(projectDir, taskIdCandidate);
  }
  const configInfo = await readJsonIfExists(path.join(projectDir, CONFIG_FILE));
  if (configInfo.error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', error: configInfo.error, checks: {} };
  }
  const config = configInfo.value && typeof configInfo.value === 'object' ? configInfo.value : {};
  const configured = configuredChecks(config);
  if (args.reuse && args.noReuse) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', code: 'REUSE_FLAGS_CONFLICT', error: '--reuse and --no-reuse cannot be combined.', checks: {} };
  }
  const only = args.only;
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
  const budgetMs = Number.isInteger(config.verification?.budgetMs) && config.verification.budgetMs > 0
    ? config.verification.budgetMs : null;
  let scope;
  try {
    scope = parseVerifyScope(args.scope ?? config.verification?.defaultScope);
  } catch (error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: error.message, checks: {} };
  }
  const requestedEnvironmentMode = config?.verification?.environment?.mode ?? 'cold';
  const environmentFallback = config?.verification?.environment?.fallback ?? 'blocked';
  const warmProvider = config?.verification?.environment;
  const warmConfigured = warmProvider?.provider && warmProvider?.start && warmProvider?.health && warmProvider?.stop;
  const environmentMode = requestedEnvironmentMode === 'warm' && environmentFallback === 'cold' ? 'cold' : requestedEnvironmentMode;
  const environmentStatus = requestedEnvironmentMode === 'warm' && environmentMode === 'cold' ? 'fallback-cold' : requestedEnvironmentMode === 'warm' ? 'configured' : 'cold';
  if (requestedEnvironmentMode === 'warm' && environmentMode === 'warm' && !warmConfigured) {
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      engine: VERIFY_ENGINE,
      command: 'verify',
      status: 'blocked',
      scope,
      scopeConfidence: scope === 'full' ? 'complete' : 'unknown',
      environment: { mode: 'warm', status: 'blocked', reason: 'No warm provider is configured.' },
      checks: {},
      error: 'Warm verification requested but no provider is configured.',
    };
  }
  const declaredChecks = new Map(
    (Array.isArray(config?.validationCommands?.checks) ? config.validationCommands.checks : [])
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => [item.id, item]),
  );
  const estimateSelectedCost = (names) => {
    const durations = names.map((name) => declaredChecks.get(name)?.estimatedDurationMs);
    return durations.every((value) => Number.isInteger(value))
      ? durations.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const checks = {};
  let tier;
  try {
    tier = parseVerifyTier(args.tier);
  } catch (error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: error.message, checks: {} };
  }
  if (configured.error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: configured.error, checks: {} };
  }
  if (only && only.length === 0) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: '--only requires at least one check.', checks: {} };
  }
  let tierPlan;
  let changeScope;
  try {
    changeScope = verificationChanges(projectDir, { paths: args.paths, base: args.base });
    tierPlan = resolveVerifyTierPlan({
      commands: configured.commands,
      config,
      tier,
      only,
      projectDir,
      explicit: args.tier !== undefined,
    });
  } catch (error) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: error.message, checks: {} };
  }
  const checkOrder = [...new Set([...tierPlan.allChecks.map((check) => check.id), ...CHECK_ORDER])];
  const checkMetadata = new Map(tierPlan.allChecks.map((check) => [check.id, check]));
  for (const check of tierPlan.allChecks) configured.commands[check.id] = check.command;
  const selectedNames = tierPlan.selectedNames;
  const deferredNames = new Set(tierPlan.deferredChecks.map((item) => item.name));
  // `--reviewed` is the explicit relevance review; without it the report can
  // only say `unreviewed` and the acceptance evidence stays blocked.
  const reviewedChecks = resolveReviewedChecks(args.reviewed, selectedNames);
  const reviewWarnings = reviewedChecks.warnings.map((message) => ({
    code: 'VERIFY_REVIEW_METADATA_IGNORED',
    message,
  }));
  if (scope === 'affected' && changeScope.selectionMode === 'changed' && changeScope.changedPaths.length === 0) {
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify',
      status: planOnly ? 'planned' : 'unverified', noChanges: true, scope, ...changeScope,
      tier: tierPlan.tier, checks: {}, selectedChecks: [], skippedChecks: tierPlan.selectedChecks.map((check) => ({ id: check.id, reason: 'empty-change-scope' })),
      deferredChecks: [], nextTier: null, cache: { status: 'not_requested' },
    };
  }
  if (args.async && !planOnly) {
    if (tier !== 'deep') {
      return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: '--async requires --tier deep.', checks: {} };
    }
    const queueId = randomUUID();
    const queueDir = path.join(projectDir, '.vibe-harness', 'verification', 'queue');
    mkdirSync(queueDir, { recursive: true });
    const queueSnapshot = await gitFingerprint(projectDir);
    const commandSet = selectedNames.map((name) => configured.commands[name]).filter(Boolean);
    const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const createdAt = new Date();
    const queue = {
      schemaVersion: 1,
      id: queueId,
      status: 'queued',
      tier,
      scope,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 86_400_000).toISOString(),
      commitSha: queueSnapshot.head ?? null,
      worktreeFingerprint: queueSnapshot.fingerprint ?? null,
      planFingerprint: fingerprint({ tier, scope, selectedNames, deferredNames: [...deferredNames] }),
      commandSetFingerprint: fingerprint(commandSet),
      commandSet,
      stateMachine: ['queued', 'running', 'passed', 'failed', 'blocked', 'stale'],
    };
    writeFileSync(path.join(queueDir, `${queueId}.json`), JSON.stringify(queue, null, 2) + '\n', 'utf8');
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'queued',
      code: 'VERIFICATION_QUEUED_NO_LOCAL_CONSUMER', guidance: 'Queued is not completion; a separately configured CI consumer must claim and report this id.',
      tier, scope, scopeConfidence: scope === 'full' ? 'complete' : 'unknown', riskLevel: null, impactGroups: [], queue };
  }
  const before = planOnly ? null : await gitFingerprint(projectDir);
  const receiptPlan = { ...changeScope, selectedChecks: tierPlan.selectedChecks, deferredChecks: tierPlan.deferredChecks, tier: tierPlan.tier, scope };
  const cacheContext = planOnly ? null : await verificationCacheContext(projectDir, receiptPlan, before);
  const cacheLookupStartedAt = Date.now();
  const wholeRunCache = !planOnly && args.reuse && cacheContext?.mode !== 'tree-content';
  const cached = wholeRunCache ? await findVerificationReceipt(projectDir, cacheContext) : null;
  const cacheLookupMs = Date.now() - cacheLookupStartedAt;
  if (cached?.receipt) {
    const confirmedContext = await verificationCacheContext(projectDir, receiptPlan);
    const confirmed = confirmedContext.snapshot;
    if (confirmedContext.key === cacheContext.key) {
      const commandSet = verificationCommandSet(configured.commands, selectedNames, projectDir, Object.fromEntries(checkMetadata));
      const anchor = taskIdCandidate ? await findReusableVerification(projectDir, taskIdCandidate, {
        fingerprint: before.fingerprint, commandSet,
      }) : null;
      const reusedChecks = Object.fromEntries(checkOrder.map((name) => [name, {
        status: selectedNames.includes(name) ? 'reused' : deferredNames.has(name) ? 'deferred' : configured.commands[name] ? 'not_selected' : 'not_configured',
        ...(configured.commands[name] ? { command: displayCommand(configured.commands[name], projectDir), cwd: checkMetadata.get(name)?.cwd ?? '.' } : {}),
      }]));
      return {
        schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'reused',
        tier: tierPlan.tier, scope, ...changeScope, scopeConfidence: scope === 'full' ? 'complete' : 'unknown',
        checks: reusedChecks, selectedChecks: selectedNames, deferredChecks: tierPlan.deferredChecks,
        warnings: reviewWarnings,
        subsumedChecks: tierPlan.subsumedChecks ?? [], nextTier: tierPlan.nextTier,
        selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
        minimumTier: null,
        selectedMicroChecks: [], deferredMicroChecks: [], estimatedCostMs: estimateSelectedCost(selectedNames),
        cache: { status: 'hit', reason: cached.reason, lookupMs: cacheLookupMs }, environment: { mode: environmentMode, status: 'reused' },
        reused: {
          id: cached.receipt.id, finishedAt: cached.receipt.finishedAt, fingerprint: before.fingerprint,
          command: commandSet, beforeHead: before.snapshot.head, afterHead: confirmed.snapshot.head,
          ...(anchor?.verification.id === cached.receipt.id ? { taskId: anchor.taskId, unitId: anchor.unitId } : {}),
        },
        verification: {
          ...cached.receipt,
          schemaVersion: 3,
          engine: VERIFY_ENGINE,
          before: before.snapshot,
          after: confirmed.snapshot,
          stable: true,
          snapshotComparison: 'match',
          review: verificationReview({
            changedPaths: changeScope.changedPaths,
            selectedNames,
            reviewed: reviewedChecks.ids,
            reviewPolicy: args.reviewPolicy,
            targetBranch: args.targetBranch,
          }),
          acceptance: verificationAcceptance({
            review: verificationReview({
              changedPaths: changeScope.changedPaths,
              selectedNames,
              reviewed: reviewedChecks.ids,
              reviewPolicy: args.reviewPolicy,
              targetBranch: args.targetBranch,
            }),
            status: 'reused',
            snapshotComparison: 'match',
            fingerprint: before.fingerprint,
            selectedNames,
            deferredCount: tierPlan.deferredChecks.length,
          }),
        },
      };
    }
  }
  const checkCache = new Map();
  if (!planOnly && args.reuse && cacheContext?.mode === 'tree-content') {
    for (const check of cacheContext.perCheck ?? []) {
      if (!selectedNames.includes(check.id)) continue;
      checkCache.set(check.id, await findVerificationCheckReceipt(projectDir, check, {
        ttlMs: config.verification?.reuse?.ttlMs,
      }));
    }
  }
  const selectedPlanChecks = tierPlan.selectedChecks ?? [];
  const heavyWork = tier === 'deep' || selectedPlanChecks.some((check) => check.resourceClass === 'repo-heavy'
    || check.costTier === 'deep'
    || /(?:^|\s)(?:mvn|mvnw|gradle|gradlew)(?:\s|$)/iu.test(check.command ?? ''));
  let verificationLease = null;
  if (!planOnly && heavyWork && selectedNames.some((name) => checkCache.get(name)?.status !== 'hit')) {
    if (deliveryQueue?.report) {
      verificationLease = { ok: true, borrowed: true, queue: deliveryQueue.report };
    } else {
      verificationProgress(args, 'queue-wait', { tier: tierPlan.tier });
      verificationLease = await acquireVerificationLock(projectDir, {
        onProgress: (event) => args.onProgress?.(event),
      });
    }
    if (!verificationLease.ok) {
      verificationProgress(args, 'queue-blocked', { reason: verificationLease.reason });
      return {
        schemaVersion: VERIFY_SCHEMA_VERSION,
        engine: VERIFY_ENGINE,
        command: 'verify',
        tier: tierPlan.tier,
        scope,
        status: 'blocked',
        code: verificationLease.reason === 'WORKTREE_QUEUE_TIMEOUT' ? 'WORKTREE_QUEUE_TIMEOUT' : 'VERIFICATION_QUEUE_UNAVAILABLE',
        error: `repository verification queue is unavailable (${verificationLease.reason})`,
        queue: verificationLease.queue ?? null,
        checks: {},
      };
    }
  }
  try {
  verificationProgress(args, 'plan', { tier: tierPlan.tier, selected: selectedNames, deferredCount: tierPlan.deferredChecks.length, cacheLookupMs });
  if (!planOnly) await storeVerificationReceipt(projectDir, cacheContext, { status: 'running' });
  let selectedCount = 0;
  let stopped = false;
  let reusedCount = 0;
  let treeChangedDuringRun = false;
  let budgetStartedAt = null;
  let budgetDeadline = null;
  let budgetExhausted = false;
  for (const name of checkOrder) {
    const command = configured.commands[name];
    if (!command) {
      checks[name] = { status: 'not_configured' };
      continue;
    }
    if (!selectedNames.includes(name)) {
      checks[name] = deferredNames.has(name)
        ? { status: 'deferred', tier: tierPlan.slotTiers[name], command: displayCommand(command, projectDir) }
        : { status: 'not_selected', command: displayCommand(command, projectDir) };
      continue;
    }
    selectedCount += 1;
    if (stopped) {
      checks[name] = { status: 'not_run', command: displayCommand(command, projectDir), reason: 'previous-check-failed' };
      continue;
    }
    const cachedCheck = treeChangedDuringRun ? null : checkCache.get(name);
    if (cachedCheck?.status === 'hit') {
      checks[name] = {
        status: 'reused',
        command: displayCommand(command, projectDir),
        cwd: checkMetadata.get(name)?.cwd ?? '.',
        cache: { status: 'hit', reason: cachedCheck.reason },
        finishedAt: cachedCheck.receipt.finishedAt,
      };
      reusedCount += 1;
      verificationProgress(args, 'check-reused', { check: name });
      continue;
    }
    const manual = manualCommand(command);
    const executableCommand = manual ?? command;
    let tokens;
    try {
      tokens = assertSafeCommand(executableCommand);
    } catch (error) {
      checks[name] = { status: 'blocked', code: error.code ?? 'UNSAFE_COMMAND', command: displayCommand(command, projectDir) };
      continue;
    }
    if (manual && !args.allowManual) {
      checks[name] = { status: 'blocked', code: 'MANUAL_REQUIRES_ALLOW', command: displayCommand(command, projectDir) };
      continue;
    }
    const cwd = verificationCwd(projectDir, checkMetadata.get(name)?.cwd);
    if (!await probeExecutable(tokens[0] === 'node' ? process.execPath : tokens[0], cwd.absolute)) {
      checks[name] = { status: 'blocked', code: 'MISSING_EXECUTABLE', command: displayCommand(command, projectDir) };
      continue;
    }
    if (planOnly) {
      checks[name] = { status: 'planned', command: displayCommand(command, projectDir), cwd: cwd.relative };
      continue;
    }
    let result;
    const checkStartedAt = Date.now();
    if (budgetMs !== null && budgetDeadline === null) {
      budgetStartedAt = Date.now();
      budgetDeadline = budgetStartedAt + budgetMs;
    }
    const remainingBudgetMs = budgetDeadline === null ? null : budgetDeadline - Date.now();
    if (remainingBudgetMs !== null && remainingBudgetMs <= 0) {
      checks[name] = {
        status: 'blocked',
        code: 'VERIFICATION_BUDGET_EXHAUSTED',
        command: displayCommand(command, projectDir),
        cwd: cwd.relative,
        budgetMs,
        elapsedMs: Date.now() - budgetStartedAt,
      };
      budgetExhausted = true;
      stopped = true;
      continue;
    }
    const effectiveTimeoutMs = remainingBudgetMs === null ? timeoutMs : Math.max(1, Math.min(timeoutMs, remainingBudgetMs));
    verificationProgress(args, 'check-start', { check: name, timeoutMs: effectiveTimeoutMs, ...(budgetMs === null ? {} : { budgetMs }) });
    const heartbeat = args.onProgress ? setInterval(() => verificationProgress(args, 'heartbeat', {
      check: name, elapsedMs: Date.now() - checkStartedAt, timeoutMs,
    }), 30_000) : null;
    heartbeat?.unref();
    try {
      result = await executeCommand(executableCommand, cwd.absolute, effectiveTimeoutMs, projectDir, verificationContextEnvironment({ ...changeScope, scope }));
    } catch (error) {
      result = { status: 'blocked', code: 'UNSAFE_COMMAND', exitCode: null, stderr: boundedOutput(error.message, projectDir) };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    const durationMs = Date.now() - checkStartedAt;
    verificationProgress(args, 'check-end', { check: name, status: result.status, durationMs, exitCode: result.exitCode });
    checks[name] = {
      status: result.status,
      code: result.code,
      command: displayCommand(command, projectDir),
      cwd: cwd.relative,
      exitCode: result.exitCode,
      durationMs,
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(result.status === 'passed' ? verificationCheckEvidence(result.stdout, result.stderr) : {}),
    };
    stopped = ['failed', 'blocked'].includes(checks[name].status);
    if (budgetDeadline !== null && Date.now() >= budgetDeadline) {
      budgetExhausted = true;
      stopped = true;
    }
    if (!stopped && cacheContext.mode === 'tree-content') {
      const currentTree = await gitTreeFingerprint(projectDir);
      if (currentTree !== cacheContext.treeContentFingerprint) treeChangedDuringRun = true;
    }
  }
  for (const name of CHECK_ORDER) {
    if (only) break;
    if (checks[name]?.status !== 'not_selected') continue;
    const alias = selectedNames.find((id) => configured.commands[id] === configured.commands[name] && (checks[id]?.cwd ?? '.') === '.');
    if (alias && ['passed', 'failed', 'blocked'].includes(checks[alias].status)) {
      checks[name] = { ...checks[alias], aliasOf: alias };
    }
  }
  if (selectedCount === 0) {
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      engine: VERIFY_ENGINE,
      command: 'verify',
      tier: tierPlan.tier,
      scope,
      scopeConfidence: scope === 'full' ? 'complete' : 'unknown',
      riskLevel: null,
      impactGroups: [],
      deferredChecks: tierPlan.deferredChecks,
      subsumedChecks: tierPlan.subsumedChecks ?? [],
      nextTier: tierPlan.nextTier,
      status: 'unverified',
      checks,
      selectedChecks: selectedNames,
      selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
      minimumTier: null,
      selectedMicroChecks: [],
      deferredMicroChecks: [],
      estimatedCostMs: estimateSelectedCost(selectedNames),
      cache: { status: args.reuse ? 'miss' : 'not_requested' },
      environment: { mode: environmentMode, status: environmentStatus },
      error: 'No configured checks selected.',
    };
  }
  if (planOnly) {
    return {
      schemaVersion: VERIFY_SCHEMA_VERSION,
      engine: VERIFY_ENGINE,
      command: 'verify',
      tier: tierPlan.tier,
      scope,
      scopeConfidence: scope === 'full' ? 'complete' : 'unknown',
      riskLevel: null,
      impactGroups: [],
      deferredChecks: tierPlan.deferredChecks,
      subsumedChecks: tierPlan.subsumedChecks ?? [],
      nextTier: tierPlan.nextTier,
      status: Object.values(checks).some((check) => check.status === 'blocked') ? 'blocked' : 'planned',
      ...changeScope,
      timeoutMs,
      checks,
      selectedChecks: selectedNames,
      selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
      minimumTier: null,
      selectedMicroChecks: [],
      deferredMicroChecks: [],
      estimatedCostMs: estimateSelectedCost(selectedNames),
      cache: { status: 'not_requested' },
      warnings: reviewWarnings,
      environment: { mode: environmentMode, status: environmentStatus },
    };
  }
  // `blocked` (unsafe/manual/missing executable) is a distinct terminal
  // status: it means the check never produced evidence, which is a different
  // statement than a check that ran and failed.
  const failed = Object.values(checks).some((item) => item.status === 'failed');
  const blocked = Object.values(checks).some((item) => item.status === 'blocked');
  const executed = selectedNames.filter((name) => checks[name]?.status === 'passed');
  const reused = selectedNames.filter((name) => checks[name]?.status === 'reused');
  const completed = [...executed, ...reused];
  const checksNotRun = completed.length < selectedNames.length;
    // Writing the receipt is itself a write to the workspace — the first one
    // creates the project's `.vibe-harness` directory and moves the repository
    // root's timestamps — so the store is created before the snapshot the receipt
    // publishes, and only for the run that is about to store one: a run that
    // stores nothing leaves no store behind.
    const willStore = !failed && !blocked && !checksNotRun && completed.length > 0;
    if (willStore) await prepareVerificationReceiptStore(projectDir).catch(() => false);
    const after = await gitFingerprint(projectDir);
    const afterContext = await verificationCacheContext(projectDir, receiptPlan, after);
    const inputsStable = cacheContext.key === afterContext.key;
    const stable = before.fingerprint !== null && after.fingerprint !== null
      ? before.fingerprint === after.fingerprint
      : null;
  const finalStatus = stable === false || !inputsStable
    ? 'stale'
    : failed
      ? 'failed'
    : blocked
      ? 'blocked'
      : completed.length === 0
        ? 'unverified'
        : reused.length === selectedNames.length ? 'reused' : 'passed';
  const review = verificationReview({
    changedPaths: changeScope.changedPaths,
    selectedNames,
    checks,
    reviewed: reviewedChecks.ids,
    reviewPolicy: args.reviewPolicy,
    targetBranch: args.targetBranch,
  });
  const snapshotComparison = stable === null ? 'unknown' : stable ? 'match' : 'changed';
  const verificationStatus = stable === false || !inputsStable
    ? 'stale'
    : failed
      ? 'checks_failed'
      : blocked
        ? 'checks_blocked'
        : checksNotRun
          ? 'checks_not_run'
          : 'verified';
  // Each check owns its cache record. A later non-deterministic check that
  // fails or misses must not discard a deterministic check that already passed
  // on this exact tree, so the store gate is the workspace evidence (stable
  // tree and inputs), not the aggregate run status. A check whose own identity
  // changed between the start and end of the run is still skipped.
  const checkReceipts = [];
  if (stable === true && inputsStable && !treeChangedDuringRun) {
    for (const name of executed) {
      const checkContext = (cacheContext.perCheck ?? []).find((check) => check.id === name);
      const afterCheckContext = (afterContext.perCheck ?? []).find((check) => check.id === name);
      if (!checkContext) continue;
      if (!checkContext.available || afterCheckContext?.key !== checkContext.key) {
        checkReceipts.push({
          id: name,
          stored: false,
          reason: afterCheckContext?.key !== checkContext.key ? 'check-inputs-changed' : checkContext.reason,
        });
        continue;
      }
      checkReceipts.push({
        id: name,
        stored: await storeVerificationCheckReceipt(projectDir, checkContext,
          { finishedAt: new Date().toISOString() }).catch(() => false),
      });
    }
  }
  const cacheStatus = args.reuse
    ? reused.length === selectedNames.length ? 'hit' : reused.length > 0 ? 'partial' : 'miss'
    : 'not_requested';
  const checkCacheReport = Object.fromEntries((cacheContext.perCheck ?? []).map((check) => {
    const cachedCheck = checkCache.get(check.id);
    return [check.id, {
      status: !args.reuse ? 'not_requested'
        : cachedCheck?.status === 'hit' ? 'hit'
          : cachedCheck?.status === 'miss' ? 'miss'
            : check.available ? 'not_looked_up' : 'not_cacheable',
      reason: cachedCheck?.reason ?? check.reason ?? null,
      scope: check.cacheScope,
    }];
  }));
  // In tree-content mode every selected check is looked up independently, so
  // the aggregate reason must describe the actual per-check outcome rather than
  // claiming the whole plan was non-deterministic when only one check missed.
  const treeContentReason = () => {
    if (!args.reuse) return null;
    if (cacheStatus === 'hit') return 'all-selected-checks-hit';
    if (cacheStatus === 'partial') return 'some-selected-checks-hit';
    return Object.values(checkCacheReport).find((item) => item.status !== 'hit')?.reason
      ?? 'no-matching-check-receipt';
  };
  const report = {
    schemaVersion: VERIFY_SCHEMA_VERSION,
    engine: VERIFY_ENGINE,
    command: 'verify',
    tier: tierPlan.tier,
    scope,
    scopeConfidence: scope === 'full' ? 'complete' : 'unknown',
    riskLevel: null,
    impactGroups: [],
    deferredChecks: tierPlan.deferredChecks,
    subsumedChecks: tierPlan.subsumedChecks ?? [],
    nextTier: tierPlan.nextTier,
    status: finalStatus,
    skippedChecks: selectedNames.filter((name) => checks[name]?.status === 'not_selected').map((name) => ({ id: name, reason: checks[name].reason })),
    ...changeScope,
    timeoutMs,
    budgetMs,
    budget: budgetMs === null ? null : {
      configuredMs: budgetMs,
      elapsedMs: budgetStartedAt === null ? 0 : Math.max(0, Math.min(budgetMs, Date.now() - budgetStartedAt)),
      exhausted: budgetExhausted,
      notRunChecks: Object.entries(checks)
        .filter(([, check]) => check?.code === 'VERIFICATION_BUDGET_EXHAUSTED' || check?.reason === 'previous-check-failed')
        .map(([id]) => id),
    },
    checks,
    selectedChecks: selectedNames,
    selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
    minimumTier: null,
    selectedMicroChecks: [],
    deferredMicroChecks: [],
    estimatedCostMs: estimateSelectedCost(selectedNames),
    cache: {
      status: cacheStatus,
      reason: cacheContext?.mode === 'tree-content'
        ? treeContentReason() : cached?.reason ?? cacheContext?.reason,
      stored: false,
      lookupMs: cacheLookupMs,
      ...(cacheContext?.mode === 'tree-content' ? { checks: checkCacheReport } : {}),
      checkReceipts,
    },
    warnings: reviewWarnings,
    environment: { mode: environmentMode, status: environmentStatus },
    queue: verificationLease?.queue ?? null,
    verification: {
      schemaVersion: 3,
      engine: VERIFY_ENGINE,
      startedAt,
      ...cacheContext.fingerprints,
      before: before.snapshot,
      after: after.snapshot,
      stable,
      inputsStable,
      snapshotComparison,
      status: verificationStatus,
      // Receipt identity: governance-core.md references these fields when a
      // delivery cites `vibe-harness verify --project`.
      id: randomUUID(),
      finishedAt: new Date().toISOString(),
      fingerprint: after.fingerprint,
      // The write evidence a completion receipt is validated against is the
      // final one: `cacheContext.fingerprints` above carries the state the
      // checks started from, which any check that writes (even without changing
      // content) would leave stale before the receipt is ever consumed.
      writeFingerprint: after.writeFingerprint ?? null,
      review,
      acceptance: verificationAcceptance({
        review,
        status: verificationStatus,
        snapshotComparison,
        inputsStable,
        fingerprint: after.fingerprint,
        selectedNames,
        deferredCount: tierPlan.deferredChecks.length,
      }),
      ...(taskBinding ? { task: taskBinding } : {}),
    },
  };
  const receiptStatus = stable === false || !inputsStable
    ? 'stale'
    : failed
      ? 'failed'
      : blocked
        ? 'blocked'
        : completed.length === selectedNames.length && ['passed', 'reused'].includes(report.status) ? 'passed' : 'unverified';
  report.cache.stored = await storeVerificationReceipt(projectDir, cacheContext, {
    ...report.verification,
    status: receiptStatus,
    // The per-check commands this run reported, so the acceptance entries a
    // completion receipt cites can be checked against them instead of being
    // taken on the receipt's word.
  }, {
    checks: Object.entries(report.checks ?? {}).map(([id, check]) => ({ id, command: check?.command })),
  }).catch(() => false);
  verificationProgress(args, 'complete', { status: report.status, tier: report.tier, selectedCount: selectedNames.length,
    deferredCount: tierPlan.deferredChecks.length });
  return report;
  } finally {
    if (!verificationLease?.borrowed) await verificationLease?.release?.();
  }
}
