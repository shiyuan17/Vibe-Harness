#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runMicroCheck } from '../lib/micro-runner.mjs';
import { gitFingerprint } from '../lib/git-fingerprint.mjs';
import {
  verificationChanges,
  verificationCheckEvidence,
  verificationContextEnvironment,
  verificationCwd,
} from '../lib/verification-plan.mjs';
import {
  attestCompletionProvenance,
  findVerificationReceipt,
  prepareVerificationReceiptStore,
  recordFinalVerification,
  storeVerificationReceipt,
  verificationCacheContext,
} from '../lib/verification-receipt.mjs';
import { completionReceipt, overrideWarnings, resolveDelivery, validateCompletion } from '../lib/delivery.mjs';
import { readMergeEvidence, validateMergeEvidence } from '../lib/merge-evidence.mjs';
import { releaseServiceTeardown, serviceReport, teardownServices } from '../lib/services.mjs';
import {
  parseWorktreeList,
  pathKey,
  resolveWorktreeRoot,
  summarizeWorktreeAudit,
  validateWorktrees,
} from '../lib/worktree-audit.mjs';
import {
  ensureRealDirectory,
  expandMirrors,
  linkDirectory,
  linkOrCopyMirrors,
  removeMirrorLinks,
  worktreeMirrorEvidence,
} from '../lib/worktree-mirrors.mjs';
import {
  allocatePortBlock,
  collectWorktreePortEvidence,
  DEFAULT_PORT_BLOCK_SIZE,
  DEFAULT_PORT_ENV_FILE,
  inferPortPlan,
  isPortVariable,
  PORT_LOCK_RELATIVE_PATH,
  PORT_REGISTRY_RELATIVE_PATH,
  portsForBlock,
  readPortRegistry,
  renderWorktreeEnv,
  validatePortRegistry,
} from '../lib/worktree-ports.mjs';

import { boundedOutput, normalizePath, redactText, summary } from '../lib/cli-output.mjs';
import { CHECK_ORDER, CONFIG_FILE, PASS_STATUSES, SCHEMA_VERSION, assertSafeCommand, changesReport, delay, envReport, isInsidePath, normalizeSlashes, packageManager, parseArgs, probeExecutable, projectContext, readJsonIfExists, readProjectConfig, runFile, runGit, safeRealpath } from '../lib/cli-runtime.mjs';
import { TASK_UNIT_FAILURE_STATUSES, findReusableVerification, planDependentUnits, planUnitGraph, readTaskAnchor, taskAnchorRelativePath, taskCheckpointReport, taskPlanCheckReport, taskReport, validateTaskId, verificationCommandSet } from '../lib/task-command.mjs';
import { VERIFY_ENGINE, VERIFY_SCHEMA_VERSION, configuredChecks, displayCommand, executeCommand, manualCommand, parseVerifyScope, parseVerifyTier, resolveReceiptTier, resolveReviewedChecks, resolveVerifyTierPlan, timeoutValue, verificationAcceptance, verificationReview } from '../lib/verification-plan-support.mjs';

// The entry file keeps its published surface across the split: host adapters and
// tests import `runCommand`, `main` and these helpers from this path, so the
// moved declarations are re-exported instead of duplicated.
export { assertSafeCommand };

// A peer `worktree land` holds the shared lock across its merge, verification
// and cleanup, so the wait budget is sized for a full landing instead of a
// filesystem round trip: a second land retries until this deadline and only
// then reports LAND_LOCK_TIMEOUT. The parent-owned environment knob can only
// shorten it, which is how tests hold the lock on purpose.
const LAND_LOCK_TIMEOUT_MS = 180_000;
const LAND_LOCK_RETRY_MS = 50;
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
async function verifyProject(projectDir, args, { planOnly = false } = {}) {
  const startedAt = new Date().toISOString();
  if (args.micro !== undefined) {
    if (args.tier || args.only || args.async || args.reuse || args.allowManual) {
      return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'blocked', code: 'MICRO_EXCLUSIVE', error: '--micro cannot be combined with --tier, --only, --async, --reuse, or --allow-manual.', checks: {} };
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
  const only = args.only;
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
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
  if (reviewedChecks.blocked) {
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'failed', error: reviewedChecks.blocked, checks: {} };
  }
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
    return { schemaVersion: VERIFY_SCHEMA_VERSION, engine: VERIFY_ENGINE, command: 'verify', status: 'queued', tier, scope, scopeConfidence: scope === 'full' ? 'complete' : 'unknown', riskLevel: null, impactGroups: [], queue };
  }
  const before = planOnly ? null : await gitFingerprint(projectDir);
  const receiptPlan = { ...changeScope, selectedChecks: tierPlan.selectedChecks, deferredChecks: tierPlan.deferredChecks, tier: tierPlan.tier, scope };
  const cacheContext = planOnly ? null : await verificationCacheContext(projectDir, receiptPlan, before);
  const cached = !planOnly && args.reuse ? await findVerificationReceipt(projectDir, cacheContext) : null;
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
        checks: reusedChecks, selectedChecks: selectedNames, deferredChecks: tierPlan.deferredChecks, nextTier: tierPlan.nextTier,
        selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
        minimumTier: null,
        selectedMicroChecks: [], deferredMicroChecks: [], estimatedCostMs: estimateSelectedCost(selectedNames),
        cache: { status: 'hit', reason: cached.reason }, environment: { mode: environmentMode, status: 'reused' },
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
          }),
          acceptance: verificationAcceptance({
            review: verificationReview({
              changedPaths: changeScope.changedPaths,
              selectedNames,
              reviewed: reviewedChecks.ids,
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
  if (!planOnly) await storeVerificationReceipt(projectDir, cacheContext, { status: 'running' });
  let selectedCount = 0;
  let stopped = false;
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
    try {
      result = await executeCommand(executableCommand, cwd.absolute, timeoutMs, projectDir, verificationContextEnvironment({ ...changeScope, scope }));
    } catch (error) {
      result = { status: 'blocked', code: 'UNSAFE_COMMAND', exitCode: null, stderr: boundedOutput(error.message, projectDir) };
    }
    checks[name] = {
      status: result.status,
      code: result.code,
      command: displayCommand(command, projectDir),
      cwd: cwd.relative,
      exitCode: result.exitCode,
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(result.status === 'passed' ? verificationCheckEvidence(result.stdout, result.stderr) : {}),
    };
    stopped = checks[name].status === 'failed';
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
      environment: { mode: environmentMode, status: environmentStatus },
    };
  }
  // `blocked` (unsafe/manual/missing executable) is a distinct terminal
  // status: it means the check never produced evidence, which is a different
  // statement than a check that ran and failed.
  const failed = Object.values(checks).some((item) => item.status === 'failed');
  const blocked = Object.values(checks).some((item) => item.status === 'blocked');
  const executed = selectedNames.filter((name) => checks[name]?.status === 'passed');
  const checksNotRun = executed.length < selectedNames.length;
    // Writing the receipt is itself a write to the workspace — the first one
    // creates the project's `.vibe-harness` directory and moves the repository
    // root's timestamps — so the store is created before the snapshot the receipt
    // publishes, and only for the run that is about to store one: a run that
    // stores nothing leaves no store behind.
    const willStore = !failed && !blocked && !checksNotRun && executed.length > 0;
    if (willStore) await prepareVerificationReceiptStore(projectDir).catch(() => false);
    const after = await gitFingerprint(projectDir);
    const afterContext = await verificationCacheContext(projectDir, receiptPlan, after);
    const inputsStable = cacheContext.key === afterContext.key;
    const stable = before.fingerprint !== null && after.fingerprint !== null
      ? before.fingerprint === after.fingerprint
      : null;
  const finalStatus = failed || stable === false || !inputsStable ? 'failed' : blocked ? 'blocked' : executed.length === 0 ? 'unverified' : 'passed';
  const review = verificationReview({
    changedPaths: changeScope.changedPaths,
    selectedNames,
    checks,
    reviewed: reviewedChecks.ids,
  });
  const snapshotComparison = stable === null ? 'unknown' : stable ? 'match' : 'changed';
  const verificationStatus = stable === false || !inputsStable
    ? 'workspace_changed'
    : failed
      ? 'checks_failed'
      : blocked
        ? 'checks_blocked'
        : checksNotRun
          ? 'checks_not_run'
          : 'verified';
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
    nextTier: tierPlan.nextTier,
    status: finalStatus,
    skippedChecks: selectedNames.filter((name) => checks[name]?.status === 'not_selected').map((name) => ({ id: name, reason: checks[name].reason })),
    ...changeScope,
    timeoutMs,
    checks,
    selectedChecks: selectedNames,
    selectionReasonsByCheck: tierPlan.selectionReasonsByCheck,
    minimumTier: null,
    selectedMicroChecks: [],
    deferredMicroChecks: [],
    estimatedCostMs: estimateSelectedCost(selectedNames),
    cache: { status: args.reuse ? 'miss' : 'not_requested', reason: cached?.reason ?? cacheContext?.reason, stored: false },
    environment: { mode: environmentMode, status: environmentStatus },
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
  report.cache.stored = await storeVerificationReceipt(projectDir, cacheContext, {
    ...report.verification, status: executed.length === selectedNames.length ? report.status : 'unverified',
    // The per-check commands this run reported, so the acceptance entries a
    // completion receipt cites can be checked against them instead of being
    // taken on the receipt's word.
  }, {
    checks: Object.entries(report.checks ?? {}).map(([id, check]) => ({ id, command: check?.command })),
  }).catch(() => false);
  return report;
}
// --- worktree / slice / patch (P0) -----------------------------------------
//
// These commands replace the throwaway scripts an agent used to write into the
// project itself: `git worktree add` plus a hand-built `node_modules` junction
// per worktree, and inline `node -e` snippets that sliced or rewrote files.
// Every command is read-only unless `--write` is passed; nothing here removes a
// branch, and `worktree cleanup` refuses while a branch has not landed.

const IGNORED_SCAN_DIRECTORIES = new Set([
  '.agents', '.git', '.turbo', '.vibe-harness', 'build', 'coverage', 'dist', 'node_modules', 'out', 'target',
]);
function safeWorktreeFile(root, relative, label) {
  const target = path.resolve(root, relative);
  const canonicalRoot = safeRealpath(root);
  if (!canonicalRoot || !isInsidePath(target, root)) {
    throw new Error(`${label} must stay inside its worktree`);
  }
  let existing = target;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      existing = path.dirname(existing);
    }
  }
  const canonicalExisting = safeRealpath(existing);
  if (!canonicalExisting || (pathKey(canonicalExisting) !== pathKey(canonicalRoot)
    && !isInsidePath(canonicalExisting, canonicalRoot))) {
    throw new Error(`${label} must stay inside its worktree`);
  }
  return target;
}
function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_SCAN_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
function workspacePatterns(packageJson) {
  const raw = packageJson?.workspaces;
  const patterns = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
  return patterns.filter((item) => typeof item === 'string' && item.trim() !== '');
}
function expandWorkspacePattern(rootDir, pattern) {
  const normalized = normalizeSlashes(pattern).replace(/^\.\//u, '');
  if (normalized.endsWith('/**')) {
    const base = path.resolve(rootDir, normalized.slice(0, -3));
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      for (const name of listDirectories(dir)) {
        const next = path.join(dir, name);
        if (isNestedCheckout(next)) continue;
        found.push(next);
        walk(next, depth + 1);
      }
    };
    walk(base, 0);
    return found;
  }
  if (normalized.endsWith('/*')) {
    const base = path.resolve(rootDir, normalized.slice(0, -2));
    return listDirectories(base)
      .map((name) => path.join(base, name))
      .filter((dir) => !isNestedCheckout(dir));
  }
  return [path.resolve(rootDir, normalized)];
}
/**
 * A directory that owns its own `.git` entry is a separate checkout: a linked
 * worktree, a submodule, or a vendored clone. Its workspace topology belongs to
 * that checkout, so scanning it would report the same package name several
 * times and point a link at another worktree's copy.
 */
function isNestedCheckout(dir) {
  return existsSync(path.join(dir, '.git'));
}
function readPackageJsonSync(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}
/**
 * Discover workspace roots and the local packages they declare.
 *
 * A dependency root is a directory that owns a hoisted `node_modules` and a
 * `workspaces` declaration. The local packages are the workspace packages
 * inside it: those must resolve to the worktree's own sources, because Node
 * follows a shared junction back to the main checkout and would otherwise hand
 * a worktree the main checkout's copy.
 */
function discoverWorkspaceTopology(projectDir) {
  const candidates = [];
  const visit = (dir, depth) => {
    const packageJson = readPackageJsonSync(dir);
    if (workspacePatterns(packageJson).length > 0) candidates.push({ dir, packageJson });
    if (depth >= 2) return;
    for (const name of listDirectories(dir)) {
      const next = path.join(dir, name);
      if (isNestedCheckout(next)) continue;
      visit(next, depth + 1);
    }
  };
  visit(projectDir, 0);

  const roots = [];
  const packages = [];
  for (const candidate of candidates) {
    const relativeRoot = normalizeSlashes(path.relative(projectDir, candidate.dir)) || '.';
    roots.push({ dir: relativeRoot, abs: candidate.dir });
    const seen = new Set();
    for (const pattern of workspacePatterns(candidate.packageJson)) {
      for (const dir of expandWorkspacePattern(candidate.dir, pattern)) {
        const key = pathKey(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        const manifest = readPackageJsonSync(dir);
        if (typeof manifest?.name !== 'string' || manifest.name.trim() === '') continue;
        packages.push({
          abs: dir,
          dir: normalizeSlashes(path.relative(projectDir, dir)),
          name: manifest.name.trim(),
          root: relativeRoot,
        });
      }
    }
  }
  return { packages, roots };
}
function readWorktreeConfig(config) {
  const raw = config?.worktree;
  if (raw === undefined) return { value: {}, error: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, error: 'worktree must be an object.' };
  }
  const value = {};
  for (const key of ['root', 'baseRef']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') return { value: {}, error: `worktree.${key} must be a non-empty string.` };
    value[key] = raw[key].trim();
  }
  for (const key of ['dependencyRoots', 'localPackages']) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== 'string' || item.trim() === '')) {
      return { value: {}, error: `worktree.${key} must be an array of non-empty strings.` };
    }
    value[key] = raw[key].map((item) => item.trim());
  }
  // `mirrors` projects the ignored governance surface (`.agents`, `.codex`,
  // `.host-config`, `.codegraph`) into every worktree. A declared path must be
  // project-relative and may use at most one whole-segment `*` wildcard.
  if (raw.mirrors !== undefined) {
    if (!Array.isArray(raw.mirrors)) {
      return { value: {}, error: 'worktree.mirrors must be an array of project-relative paths.' };
    }
    const mirrors = [];
    for (const item of raw.mirrors) {
      if (typeof item !== 'string' || item.trim() === '') {
        return { value: {}, error: 'worktree.mirrors must be an array of non-empty project-relative paths.' };
      }
      const normalized = normalizeSlashes(item.trim()).replace(/^\.\//u, '');
      const segments = normalized.split('/');
      const wildcards = segments.filter((segment) => segment.includes('*'));
      if (segments.length === 0 || segments.some((segment) => segment === '')
        || path.isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized) || normalized.startsWith('/')
        || segments.includes('..')
        || wildcards.length > 1 || (wildcards.length === 1 && wildcards[0] !== '*')) {
        return { value: {}, error: `worktree.mirrors entry ${item} must be a project-relative path (at most one whole-segment "*" wildcard, no absolute path or "..").` };
      }
      mirrors.push(normalized);
    }
    value.mirrors = mirrors;
  }
  // `ports` and `provision` are fail-closed: a declared but malformed block
  // stops the plan instead of silently falling back to an inferred default,
  // because a wrong block silently hands two worktrees the same dev-server port.
  if (raw.ports !== undefined) {
    if (!raw.ports || typeof raw.ports !== 'object' || Array.isArray(raw.ports)) {
      return { value: {}, error: 'worktree.ports must be an object.' };
    }
    const ports = {};
    if (raw.ports.base !== undefined) {
      if (!Number.isInteger(raw.ports.base) || raw.ports.base < 1 || raw.ports.base > 65_535) {
        return { value: {}, error: 'worktree.ports.base must be an integer between 1 and 65535.' };
      }
      ports.base = raw.ports.base;
    }
    if (raw.ports.blockSize !== undefined) {
      if (!Number.isInteger(raw.ports.blockSize) || raw.ports.blockSize < 1 || raw.ports.blockSize > 1_000) {
        return { value: {}, error: 'worktree.ports.blockSize must be an integer between 1 and 1000.' };
      }
      ports.blockSize = raw.ports.blockSize;
    }
    if (raw.ports.variables !== undefined) {
      if (!Array.isArray(raw.ports.variables)
        || raw.ports.variables.some((item) => typeof item !== 'string' || !isPortVariable(item.trim()))) {
        return { value: {}, error: 'worktree.ports.variables must be an array of port variable names such as PORT or WEB_PORT.' };
      }
      ports.variables = raw.ports.variables.map((item) => item.trim());
    }
    if (raw.ports.envFile !== undefined) {
      if (typeof raw.ports.envFile !== 'string' || raw.ports.envFile.trim() === '' || path.isAbsolute(raw.ports.envFile)) {
        return { value: {}, error: 'worktree.ports.envFile must be a non-empty project-relative path.' };
      }
      ports.envFile = normalizeSlashes(raw.ports.envFile.trim());
    }
    value.ports = ports;
  }
  if (raw.provision !== undefined) {
    if (!raw.provision || typeof raw.provision !== 'object' || Array.isArray(raw.provision)) {
      return { value: {}, error: 'worktree.provision must be an object.' };
    }
    const provision = {};
    if (raw.provision.setupCommands !== undefined) {
      if (!Array.isArray(raw.provision.setupCommands)
        || raw.provision.setupCommands.some((item) => typeof item !== 'string' || item.trim() === '')) {
        return { value: {}, error: 'worktree.provision.setupCommands must be an array of non-empty command strings.' };
      }
      provision.setupCommands = raw.provision.setupCommands.map((item) => item.trim());
    }
    if (raw.provision.envFiles !== undefined) {
      if (!Array.isArray(raw.provision.envFiles)
        || raw.provision.envFiles.some((item) => typeof item !== 'string' || item.trim() === '' || path.isAbsolute(item))) {
        return { value: {}, error: 'worktree.provision.envFiles must be an array of project-relative paths.' };
      }
      provision.envFiles = raw.provision.envFiles.map((item) => normalizeSlashes(item.trim()));
    }
    value.provision = provision;
  }
  return { value, error: null };
}
function resolveWorktreeSettings(projectDir, projectConfig, args) {
  const parsed = readWorktreeConfig(projectConfig);
  if (parsed.error) return { error: parsed.error };
  const configured = parsed.value;
  const discovered = discoverWorkspaceTopology(projectDir);
  const dependencyRoots = (configured.dependencyRoots ?? discovered.roots.map((root) => root.dir))
    .filter((dir) => dir !== '.');
  const wanted = configured.localPackages ? new Set(configured.localPackages) : null;
  const localPackages = discovered.packages.filter((item) => wanted === null || wanted.has(item.name));
  const unknown = wanted === null ? [] : [...wanted].filter((name) => !localPackages.some((item) => item.name === name));
  const ports = configured.ports ?? {};
  const provision = configured.provision ?? {};
  const portPlan = inferPortPlan(projectDir, {
    configuredBase: ports.base ?? null,
    declaredVariables: ports.variables ?? [],
    provisionEnvFiles: provision.envFiles ?? [],
  });
  return {
    baseRef: args.baseRef ?? configured.baseRef ?? 'origin/develop',
    configuredRoot: args.root ?? configured.root ?? null,
    dependencyRoots,
    localPackages,
    // `mirrors` is optional for backward compatibility: an old config that
    // predates the key resolves to an empty projection, exactly today's
    // behaviour, with no diagnostics.
    mirrors: configured.mirrors ?? [],
    ports: {
      base: portPlan.base,
      blockSize: ports.blockSize ?? DEFAULT_PORT_BLOCK_SIZE,
      envFile: ports.envFile ?? DEFAULT_PORT_ENV_FILE,
      files: portPlan.files,
      variables: portPlan.variables,
    },
    provision: {
      envFiles: provision.envFiles ?? [],
      setupCommands: provision.setupCommands ?? [],
    },
    projectDir,
    root: resolveWorktreeRoot(projectDir, args.root ?? configured.root),
    unknownLocalPackages: unknown,
    // Every discovered workspace package, so `link-package-roots` can project
    // the per-package `node_modules` of an isolated layout.
    workspacePackages: discovered.packages,
  };
}
async function worktreeEntries(projectDir) {
  const top = await runGit(['rev-parse', '--show-toplevel'], projectDir);
  if (!top.ok) return { entries: [], repositoryRoot: null, reason: 'not-a-git-worktree' };
  const listing = await runFile('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: projectDir, timeoutMs: 15_000 });
  if (!listing.ok) return { entries: [], repositoryRoot: normalizePath(top.stdout.trim()), reason: 'worktree-list-failed' };
  return { entries: parseWorktreeList(listing.stdout), repositoryRoot: normalizePath(top.stdout.trim()), reason: null };
}
async function worktreeDirtyMap(entries) {
  const dirty = new Map();
  for (const entry of entries) {
    if (!entry.path || !existsSync(entry.path)) continue;
    const status = await runGit(['status', '--porcelain=v1'], entry.path);
    dirty.set(pathKey(entry.path), status.ok ? status.stdout.trim() !== '' : null);
  }
  return dirty;
}
async function resolveWorktreeIntegration(projectDir, entries, baseRef) {
  const map = new Map();
  const probe = await runGit(['rev-parse', '--verify', '--quiet', baseRef], projectDir);
  if (!probe.ok) return { baseRefResolved: false, map };
  for (const entry of entries) {
    if (entry.primary || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    if (!head.ok) continue;
    const mergeBase = await runGit(['merge-base', entry.branch, baseRef], projectDir);
    const ancestor = await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), baseRef], projectDir);
    map.set(entry.branch, {
      integrated: ancestor.ok,
      mergeBaseSha: mergeBase.ok ? mergeBase.stdout.trim() : null,
      targetRef: baseRef,
    });
  }
  return { baseRefResolved: true, map };
}
function packagesForRoot(settings, root) {
  // A package belongs to a dependency root either because its own `workspaces`
  // declaration discovered it there, or because the configured root contains
  // its directory. The second form lets a project name a dependency root that
  // is declared by a parent manifest.
  return settings.localPackages.filter((item) => item.root === root
    || (normalizeSlashes(root) !== '.' && isInsidePath(item.abs, path.resolve(settings.projectDir, root))));
}
// Content-addressed dependency stores that must travel with an overlay: bun
// (`bun install` writes `.bun`) and pnpm (`.pnpm`) resolve packages through
// these point directories, so skipping them leaves a worktree unable to run
// vitest/tsc. Build caches (`.cache`, `.vite`, `.vite-temp`) stay skipped
// because they are regenerated and must never be shared between worktrees.
const OVERLAY_POINT_ENTRIES = new Set(['.bin', '.bun', '.pnpm']);
/** Link one overlay entry (top-level, or under a scope) from its source. */
function linkOverlayEntry({ localPackages, mainModules, name, scope = null, worktreeModules, worktreePath }) {
  const target = scope === null ? path.join(worktreeModules, name) : path.join(worktreeModules, scope, name);
  if (existsSync(target)) rmSync(target, { force: true, recursive: true });
  const fullName = scope === null ? name : `${scope}/${name}`;
  const local = localPackages.find((item) => item.name === fullName);
  if (local) {
    linkDirectory(path.join(worktreePath, local.dir), target);
    return;
  }
  linkDirectory(scope === null ? path.join(mainModules, name) : path.join(mainModules, scope, name), target);
}
/**
 * Overlay one `node_modules` directory against the main checkout.
 *
 * Third-party entries link back to the main checkout, while every local package
 * resolves to the worktree's own sources — Node follows a shared junction, so a
 * local package must never resolve through the main checkout's copy.
 */
function overlayModulesDirectory({ localPackages, mainModules, worktreeModules, worktreePath }) {
  ensureRealDirectory(worktreeModules);
  const localScopes = new Set(localPackages.filter((item) => item.name.startsWith('@')).map((item) => item.name.split('/')[0]));
  for (const entry of listDirectories(mainModules).concat(listFilesOf(mainModules))) {
    if (entry.startsWith('.') && !OVERLAY_POINT_ENTRIES.has(entry)) continue;
    if (localScopes.has(entry)) continue;
    linkOverlayEntry({ localPackages, mainModules, name: entry, worktreeModules, worktreePath });
  }
  for (const scope of localScopes) {
    const scopeDir = path.join(worktreeModules, scope);
    mkdirSync(scopeDir, { recursive: true });
    for (const entry of listDirectories(path.join(mainModules, scope))) {
      linkOverlayEntry({ localPackages, mainModules, name: entry, scope, worktreeModules, worktreePath });
    }
    for (const local of localPackages.filter((item) => item.name.startsWith(`${scope}/`))) {
      const target = path.join(scopeDir, local.name.slice(scope.length + 1));
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      linkDirectory(path.join(worktreePath, local.dir), target);
    }
  }
}
/** Link one dependency root of a worktree against the main checkout. */
function linkDependencyRoot(projectDir, worktreePath, settings, root) {
  const mainModules = path.join(projectDir, root, 'node_modules');
  const worktreeModules = path.join(worktreePath, root, 'node_modules');
  const localPackages = packagesForRoot(settings, root);
  if (!existsSync(mainModules)) return { action: 'skipped', reason: `${root}/node_modules is absent in the main checkout`, root };
  if (localPackages.length === 0) {
    if (existsSync(worktreeModules)) rmSync(worktreeModules, { force: true, recursive: true });
    linkDirectory(mainModules, worktreeModules);
    return { action: 'linked', mode: 'directory', root };
  }
  overlayModulesDirectory({ localPackages, mainModules, worktreeModules, worktreePath });
  return { action: 'linked', localPackages: localPackages.map((item) => item.name), mode: 'overlay', root };
}
/**
 * Overlay the isolated `node_modules` of one workspace package.
 *
 * An isolated layout (pnpm, bun's isolated linker) installs a package's own
 * dependencies next to that package instead of only at the hoisted root, so
 * linking just `root/node_modules` leaves `apps/*`, `packages/**`,
 * `internal/**` and `scripts/*` unable to resolve. A package without its own
 * `node_modules` produces no entry.
 */
function linkPackageRoot(projectDir, worktreePath, settings, pkg) {
  const mainModules = path.join(projectDir, pkg.dir, 'node_modules');
  if (!existsSync(mainModules)) return null;
  const worktreeModules = path.join(worktreePath, pkg.dir, 'node_modules');
  overlayModulesDirectory({
    localPackages: settings.localPackages,
    mainModules,
    worktreeModules,
    worktreePath,
  });
  return { dir: pkg.dir, package: pkg.name, status: 'linked' };
}
/** Project the per-package `node_modules` overlays of every workspace package. */
function linkPackageRoots(projectDir, worktreePath, settings) {
  const results = [];
  for (const pkg of settings.workspacePackages ?? []) {
    const result = linkPackageRoot(projectDir, worktreePath, settings, pkg);
    if (result) results.push(result);
  }
  return results;
}
function listFilesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
/**
 * Remove the dependency links a bootstrap created inside one worktree.
 *
 * `git worktree remove` does not follow a junction, so it deletes the tracked
 * files and then stops, leaving the worktree directory behind. Removing the
 * link directories first lets Git finish the job. Node's recursive removal
 * unlinks a reparse point instead of descending into it, so the main checkout's
 * `node_modules` is never touched.
 */
function removeDependencyLinks(worktreePath, settings) {
  const removed = [];
  for (const root of settings.dependencyRoots) {
    const modules = path.join(worktreePath, root, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!lstatSync(modules).isDirectory()) continue;
    rmSync(modules, { force: true, recursive: true });
    removed.push(`${root}/node_modules`);
  }
  // The isolated per-package overlays of `linkPackageRoots` are the same kind of
  // bootstrap artifact and hold junctions into the main checkout, so they are
  // removed with the roots; leaving them behind is what makes `git worktree
  // remove` stop half way on Windows.
  for (const pkg of settings.workspacePackages ?? []) {
    const modules = path.join(worktreePath, pkg.dir, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!(lstatSync(modules).isDirectory() || lstatSync(modules).isSymbolicLink())) continue;
    rmSync(modules, { force: true, recursive: true });
    removed.push(`${pkg.dir}/node_modules`);
  }
  return removed;
}
/**
 * Remove every link a bootstrap created inside one worktree.
 *
 * The dependency links plus the mirrored governance directories must be gone
 * before `git worktree remove`; a directory junction left in place can make the
 * removal reach the main checkout's `.agents`. Copied files and real
 * directories are left for Git so checkout content is never deleted here.
 */
function removeWorktreeLinks(projectDir, worktreePath, settings) {
  return [
    ...removeDependencyLinks(worktreePath, settings),
    ...removeMirrorLinks(projectDir, worktreePath, settings.mirrors ?? []),
  ];
}
/** Filesystem evidence for the dependency links of every worktree. */
function worktreeDependencyEvidence(projectDir, entries, settings) {
  const evidence = new Map();
  for (const entry of entries) {
    if (entry.primary || !entry.path || !existsSync(entry.path)) continue;
    const facts = [];
    for (const root of settings.dependencyRoots) {
      const mainModules = path.join(projectDir, root, 'node_modules');
      const worktreeModules = path.join(entry.path, root, 'node_modules');
      if (!existsSync(worktreeModules)) {
        facts.push({ dependencyRoot: root, status: 'missing' });
        continue;
      }
      const localPackages = packagesForRoot(settings, root);
      if (localPackages.length === 0) {
        const resolved = safeRealpath(worktreeModules);
        if (resolved === null || pathKey(resolved) !== pathKey(mainModules)) {
          facts.push({ dependencyRoot: root, resolved, status: 'stale' });
        }
        continue;
      }
      for (const local of localPackages) {
        const linkPath = path.join(worktreeModules, local.name);
        if (!existsSync(linkPath)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, status: 'missing' });
          continue;
        }
        const resolved = safeRealpath(linkPath);
        if (resolved === null || !isInsidePath(resolved, entry.path)) {
          facts.push({ dependencyRoot: root, localPackage: local.name, resolved, status: 'stale' });
        }
      }
    }
    if (facts.length > 0) evidence.set(pathKey(entry.path), facts);
  }
  return evidence;
}
const PORT_LOCK_TIMEOUT_MS = 5_000;
const PORT_LOCK_RETRY_MS = 50;
/**
 * Red-zone membership for a project-relative path.
 *
 * docs/rules/governance-core.md makes red-zone writes an explicit confirmation,
 * and `hooks.redZonePaths` is the only declaration that decides membership.
 */
function isRedZonePath(relativePath, patterns) {
  const candidate = normalizeSlashes(relativePath).replace(/^\.\//u, '').toLowerCase();
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const directory = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const body = directory.replace(/\/+$/u, '').toLowerCase().replace(/^\.\//u, '');
    if (body === '') continue;
    if (candidate === body || candidate.startsWith(`${body}/`)) return true;
    if (!body.includes('/') && path.basename(candidate) === body) return true;
  }
  return false;
}
/** Exclusive lock file around every registry read/modify/write. */
async function withPortRegistryLock(projectDir, action, { timeoutMs = PORT_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = path.join(projectDir, PORT_LOCK_RELATIVE_PATH);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
      closeSync(handle);
      held = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') return { error: `cannot create ${PORT_LOCK_RELATIVE_PATH}: ${error.code ?? error.message}` };
      if (Date.now() >= deadline) {
        return {
          code: 'WORKTREE_PORT_LOCK_TIMEOUT',
          error: `${PORT_LOCK_RELATIVE_PATH} is held by another process after ${timeoutMs}ms; the lock is never removed automatically`,
        };
      }
      await delay(PORT_LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    if (held) {
      try {
        rmSync(lockPath, { force: true });
      } catch { /* the lock is advisory; a failed unlink is reported by the next bootstrap */ }
    }
  }
}
function writePortRegistry(projectDir, registry) {
  const file = path.join(projectDir, PORT_REGISTRY_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const entries = [...registry.entries].sort((left, right) => left.block - right.block || left.id.localeCompare(right.id));
  writeFileSync(file, `${JSON.stringify({ ...registry, entries }, null, 2)}\n`, 'utf8');
}
/**
 * Allocate or reuse the worktree's port block from the main checkout registry.
 *
 * The registry is the fact source: a conflict between two entries fails closed
 * instead of silently handing the second worktree a used port.
 */
function planPortAssignment(projectDir, settings, { branch, id, path: worktreePath }) {
  const info = readPortRegistry(projectDir);
  if (info.error) {
    return { code: info.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${info.error}` };
  }
  const registry = info.registry ?? {
    schemaVersion: 1,
    base: settings.ports.base,
    blockSize: settings.ports.blockSize,
    entries: [],
    variables: settings.ports.variables,
  };
  const validated = validatePortRegistry(registry);
  if (!validated.ok) {
    return { code: validated.code ?? 'WORKTREE_PORT_REGISTRY_INVALID', error: `${info.path}: ${validated.error}` };
  }
  const block = allocatePortBlock(registry, { id });
  const ports = portsForBlock(registry.base, registry.blockSize, block, registry.variables);
  const existing = registry.entries.find((entry) => entry.id === id);
  return {
    block,
    envFile: settings.ports.envFile,
    ports,
    registry: {
      ...registry,
      entries: [
        ...registry.entries.filter((entry) => entry.id !== id),
        { block, branch, id, path: normalizeSlashes(worktreePath), ports, updatedAt: new Date().toISOString() },
      ],
    },
    registryDiffers: !existing
      ? registry.base !== settings.ports.base || registry.blockSize !== settings.ports.blockSize
      : false,
    reused: Boolean(existing),
  };
}
function releasePortRegistryEntry(projectDir, id) {
  return withPortRegistryLock(projectDir, async () => {
    const info = readPortRegistry(projectDir);
    if (!info.registry) return { released: false, reason: info.error ?? 'no registry' };
    const entries = info.registry.entries.filter((entry) => entry.id !== id);
    if (entries.length === info.registry.entries.length) return { released: false, reason: 'no entry' };
    writePortRegistry(projectDir, { ...info.registry, entries });
    return { released: true };
  });
}
function parseWorktreeTask(value) {
  const parts = String(value).split(':');
  const [id, branch, ...rest] = parts;
  if (!id || id.trim() === '') throw new Error(`--task ${value} has no identifier`);
  return {
    branch: branch === undefined || branch === '' ? null : branch,
    id: id.trim(),
    path: rest.length > 0 ? rest.join(':') : null,
  };
}
async function worktreeListReport(projectDir) {
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'unavailable', error: reason, worktrees: [] };
  return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'list', status: 'ready', repositoryRoot, worktrees: entries };
}
async function worktreeCheckReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'failed', error: settings.error };
  const { entries, reason, repositoryRoot } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'check', status: 'unavailable', error: reason };
  const dirty = await worktreeDirtyMap(entries);
  const { baseRefResolved, map } = await resolveWorktreeIntegration(projectDir, entries, settings.baseRef);
  const tasks = args.task.map(parseWorktreeTask).map((task) => ({
    ...task,
    path: task.path ?? path.join(settings.root, task.id),
  }));
  const collected = collectWorktreePortEvidence({
    entries,
    projectDir,
    registryInfo: readPortRegistry(projectDir),
    settings: {
      dependencyRoots: settings.dependencyRoots,
      envFile: settings.ports.envFile,
      envFiles: settings.provision.envFiles,
    },
  });
  // The audit counts severity in one place, so the caller flattens the
  // per-worktree facts into the same problem list the other codes use.
  const portFacts = {
    flat: [...collected.registryProblems, ...[...collected.evidence.values()].flat()],
    summary: collected.summary,
  };
  const audit = validateWorktrees(entries, {
    baseRef: settings.baseRef,
    branchPrefix: args.branchPrefix ?? null,
    configuredRoot: settings.root,
    dependencyEvidence: worktreeDependencyEvidence(projectDir, entries, settings),
    dirty,
    integration: map,
    integrationAll: true,
    mirrorEvidence: worktreeMirrorEvidence(projectDir, entries, settings.mirrors),
    portProblems: portFacts.flat,
    portSummary: portFacts.summary,
    repositoryRoot,
    tasks,
  });
  if (!baseRefResolved) {
    audit.problems.push({
      code: 'WORKTREE_BASE_REF_UNRESOLVED',
      message: `worktree.baseRef ${settings.baseRef} does not resolve in ${repositoryRoot}; merge-back facts were skipped`,
      severity: 'warning',
    });
    audit.warningCount += 1;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'check',
    status: audit.ok && !(args.strict && audit.warningCount > 0) ? 'passed' : 'failed',
    audit,
    localPackages: settings.localPackages.map((item) => item.name),
    portRegistry: {
      base: settings.ports.base,
      blockSize: settings.ports.blockSize,
      envFile: settings.ports.envFile,
      exists: readPortRegistry(projectDir).exists,
      path: PORT_REGISTRY_RELATIVE_PATH,
      variables: settings.ports.variables,
    },
    summary: summarizeWorktreeAudit(audit),
    unknownLocalPackages: settings.unknownLocalPackages,
  };
}
/**
 * Six-step bootstrap plan: worktree add, dependency links, port allocation plus
 * env file, declared env files, declared setup commands, toolchain probe.
 *
 * The plan is produced without touching the disk so `--dry-run` and `--write`
 * describe the same steps; only the apply path performs them.
 */
function worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, { confirmRedZone = false, existingEntry = null } = {}) {
  const worktreePath = task.path ?? path.join(settings.root, task.id);
  // A re-bootstrap of an existing worktree keeps that worktree's real branch in
  // the receipt and the port registry instead of the convention default.
  const branch = task.branch ?? existingEntry?.branch ?? `feat/${task.id}-worktree`;
  const redZonePatterns = readWorktreeRedZone(projectDir);
  const missingRoots = settings.dependencyRoots
    .filter((root) => !existsSync(path.join(projectDir, root, 'node_modules')));
  const setupCommands = settings.provision.setupCommands;
  const writeTargets = [settings.ports.envFile, ...settings.provision.envFiles];
  const redZoneTargets = writeTargets.filter((file) => isRedZonePath(file, redZonePatterns));
  const blocked = [];
  if (missingRoots.length > 0 && setupCommands.length === 0) {
    blocked.push({
      code: 'WORKTREE_MAIN_DEPENDENCIES_MISSING',
      message: `${missingRoots.map((root) => `${root === '.' ? '' : `${root}/`}node_modules`).join(', ')} is absent in the main checkout; run the project's install command there first (or declare worktree.provision.setupCommands so the worktree installs its own dependencies)`,
    });
  }
  if (redZoneTargets.length > 0 && !confirmRedZone) {
    blocked.push({
      code: 'WORKTREE_RED_ZONE_CONFIRMATION_REQUIRED',
      message: `${redZoneTargets.join(', ')} is a red-zone path (hooks.redZonePaths); pass --confirm-red-zone to write it`,
    });
  }
  const steps = [{
    branch,
    command: `git -C ${normalizeSlashes(repositoryRoot)} worktree add ${normalizeSlashes(worktreePath)} -b ${branch} ${settings.baseRef}`,
    kind: existingEntry ? 'reuse-worktree' : 'git-worktree-add',
    path: normalizeSlashes(worktreePath),
  }];
  // A worktree that installs its own dependencies must do that before the links
  // overlay the main checkout, otherwise the setup command deletes the links.
  if (missingRoots.length > 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  for (const root of settings.dependencyRoots) {
    const localPackages = packagesForRoot(settings, root);
    steps.push({
      kind: 'link-dependencies',
      localPackages: localPackages.map((item) => item.name),
      mode: localPackages.length > 0 ? 'overlay' : 'directory',
      root,
    });
  }
  // Isolated layouts keep a per-package `node_modules` next to each workspace
  // package; that overlay is projected in its own step so the receipt shows
  // which packages were covered.
  steps.push({
    kind: 'link-package-roots',
    packages: (settings.workspacePackages ?? [])
      .filter((pkg) => existsSync(path.join(projectDir, pkg.dir, 'node_modules')))
      .map((pkg) => pkg.name),
  });
  // The governance surface (`worktree.mirrors`) is projected before the port
  // and env files so a declared mirror that also holds a copied file (for
  // example `opencode.json`) is in place ahead of the env materialization.
  steps.push({
    kind: 'mirror-governance',
    mirrors: expandMirrors(projectDir, settings.mirrors),
  });
  const assignment = planPortAssignment(projectDir, settings, { branch, id: task.id, path: worktreePath });
  if (assignment.error) {
    blocked.push({ code: assignment.code, message: assignment.error });
  } else {
    steps.push({
      block: assignment.block,
      envFile: assignment.envFile,
      kind: 'allocate-ports',
      ports: assignment.ports,
      registry: PORT_REGISTRY_RELATIVE_PATH,
      reused: assignment.reused,
    });
  }
  steps.push({
    files: settings.provision.envFiles,
    kind: 'materialize-env-files',
    redZone: redZoneTargets,
  });
  if (missingRoots.length === 0) {
    for (const command of setupCommands) steps.push({ command, kind: 'setup-command' });
  }
  steps.push({
    kind: 'probe-toolchain',
    programs: [...new Set(['git', 'node', projectPackageManager(projectDir) ?? 'pnpm'])],
  });
  return {
    blocked,
    branch,
    missingDependencyRoots: missingRoots,
    ports: assignment.error ? null : assignment.ports,
    steps,
    worktreePath,
  };
}
function readWorktreeRedZone(projectDir) {
  try {
    const config = JSON.parse(readFileSync(path.join(projectDir, CONFIG_FILE), 'utf8'));
    return Array.isArray(config?.hooks?.redZonePaths) ? config.hooks.redZonePaths : [];
  } catch {
    return [];
  }
}
function projectPackageManager(projectDir) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    return packageManager(packageJson, projectDir);
  } catch {
    return null;
  }
}
/** True when one declared mirror projects `relative` (exact, directory or wildcard). */
function mirrorsCover(projectDir, mirrors, relative) {
  const target = normalizeSlashes(relative).replace(/^\.\//u, '');
  for (const mirror of expandMirrors(projectDir, mirrors)) {
    if (target === mirror || target.startsWith(`${mirror}/`)) return true;
    if (mirror.includes('*')) {
      const pattern = new RegExp(
        `^${mirror.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`,
        'u',
      );
      if (pattern.test(target)) return true;
    }
  }
  return false;
}
/**
 * Warnings a bootstrap receipt carries about the projected surface.
 *
 * The host trust record is keyed by the hook definition's absolute path, so a
 * worktree that mirrors `.codex/hooks.json` needs its own `/hooks` authorization
 * even though the file is shared. Vibe-Harness never writes host config; it
 * only surfaces the actionable reminder.
 */
function worktreeBootstrapWarnings(projectDir, settings) {
  const warnings = [];
  if (mirrorsCover(projectDir, settings.mirrors, '.codex/hooks.json')) warnings.push('WORKTREE_HOOK_TRUST_REQUIRED');
  return warnings;
}
/** Run the declared setup commands inside the new worktree. */
async function runSetupCommands(commands, worktreePath, projectDir, timeoutMs) {
  const results = [];
  for (const command of commands) {
    let tokens;
    try {
      tokens = assertSafeCommand(command);
    } catch (error) {
      return { error: `${command}: ${error.message}`, results, step: { command, kind: 'setup-command', status: 'blocked' } };
    }
    // `--write` is the explicit authorization for this command list; credentials
    // never travel with it, and the receipt carries a redacted tail only.
    const result = await executeCommand(command, worktreePath, timeoutMs);
    results.push({ command, exitCode: result.exitCode, status: result.status, ...(result.code ? { code: result.code } : {}) });
    if (result.status !== 'passed') {
      return {
        error: `${command} ${result.code ?? 'failed'}${result.stderr ? `: ${result.stderr}` : ''}`,
        results,
        step: { command, code: result.code ?? 'COMMAND_FAILED', kind: 'setup-command', status: 'failed' },
      };
    }
  }
  return { error: null, results, step: null };
}
async function worktreeBootstrapReport(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'failed', error: 'bootstrap needs at least one --task <name>[:<branch>[:<path>]]' };
  }
  const { entries, repositoryRoot, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'bootstrap', status: 'unavailable', error: reason };
  const timeoutMs = timeoutValue(args.timeout ?? config.verification?.timeoutMs);
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const existing = entries.find((entry) => !entry.primary
      && entry.path
      && pathKey(entry.path) === pathKey(task.path ?? path.join(settings.root, task.id)));
    const plan = worktreeBootstrapPlan(projectDir, settings, task, repositoryRoot, {
      confirmRedZone: Boolean(args.confirmRedZone),
      existingEntry: existing ?? null,
    });
    if (args.write && isInsidePath(plan.worktreePath, repositoryRoot)) {
      results.push({ ...plan, error: `${normalizeSlashes(plan.worktreePath)} is inside the repository; use worktree.root outside the project`, status: 'failed' });
      continue;
    }
    const blockedError = plan.blocked[0];
    if (blockedError) {
      results.push({ ...plan, code: blockedError.code, error: blockedError.message, status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ ...plan, ports: plan.ports, status: 'planned' });
      continue;
    }
    if (!existing) {
      const added = await runGit(['worktree', 'add', plan.worktreePath, '-b', plan.branch, settings.baseRef], projectDir);
      if (!added.ok) {
        results.push({ ...plan, error: boundedOutput(added.stderr || added.error?.message || 'git worktree add failed', projectDir), status: 'failed' });
        continue;
      }
    }
    try {
      // A worktree that has to install its own dependencies runs the declared
      // setup commands before the links are overlaid on top of them.
      const setupFirst = plan.missingDependencyRoots.length > 0;
      let setup = { error: null, results: [], step: null };
      if (setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }
      const links = settings.dependencyRoots.map((root) => linkDependencyRoot(projectDir, plan.worktreePath, settings, root));
      const stale = [];
      for (const root of settings.dependencyRoots) {
        for (const local of packagesForRoot(settings, root)) {
          const linkPath = path.join(plan.worktreePath, root, 'node_modules', local.name);
          const resolved = safeRealpath(linkPath);
          if (resolved === null || !isInsidePath(resolved, plan.worktreePath)) stale.push(local.name);
        }
      }
      if (stale.length > 0) throw new Error(`local packages did not resolve inside the worktree: ${stale.join(', ')}`);

      // The isolated per-package overlays and the governance mirrors come
      // before the port/env writes, so a mirrored surface that also carries a
      // copied env file is in place when the env materialization runs.
      const packageRoots = linkPackageRoots(projectDir, plan.worktreePath, settings);
      const mirrors = linkOrCopyMirrors(projectDir, plan.worktreePath, settings.mirrors);

      // The registry entry is written inside the lock so two concurrent
      // bootstraps can never pick the same block.
      const allocation = await withPortRegistryLock(projectDir, async () => {
        const assignment = planPortAssignment(projectDir, settings, { branch: plan.branch, id: task.id, path: plan.worktreePath });
        if (assignment.error) return { error: assignment.error, code: assignment.code };
        const envPath = safeWorktreeFile(plan.worktreePath, assignment.envFile, 'worktree.ports.envFile');
        writePortRegistry(projectDir, assignment.registry);
        mkdirSync(path.dirname(envPath), { recursive: true });
        writeFileSync(envPath, renderWorktreeEnv({ block: assignment.block, id: task.id, ports: assignment.ports }), 'utf8');
        return { block: assignment.block, envFile: assignment.envFile, ports: assignment.ports, reused: assignment.reused };
      });
      if (allocation.error) throw Object.assign(new Error(allocation.error), { code: allocation.code });

      const envFiles = [];
      for (const file of settings.provision.envFiles) {
        const source = safeWorktreeFile(projectDir, file, 'worktree.provision.envFiles source');
        const target = safeWorktreeFile(plan.worktreePath, file, 'worktree.provision.envFiles target');
        if (existsSync(target)) {
          envFiles.push({ file, status: 'present' });
          continue;
        }
        if (!existsSync(source)) {
          envFiles.push({ file, reason: 'absent in the main checkout', status: 'skipped' });
          continue;
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
        envFiles.push({ file, status: 'materialized' });
      }

      if (!setupFirst) {
        setup = await runSetupCommands(settings.provision.setupCommands, plan.worktreePath, projectDir, timeoutMs);
        if (setup.error) throw Object.assign(new Error(setup.error), { code: setup.step?.code ?? 'SETUP_COMMAND_FAILED' });
      }

      const toolchain = {};
      for (const program of plan.steps.find((step) => step.kind === 'probe-toolchain').programs) {
        toolchain[program] = await probeExecutable(program, plan.worktreePath);
      }
      results.push({
        ...plan,
        allocation,
        envFiles,
        links,
        mirrors,
        packageRoots,
        setupCommands: setup.results,
        status: 'passed',
        toolchain,
        warnings: worktreeBootstrapWarnings(projectDir, settings),
      });
    } catch (error) {
      let branchDeleted = false;
      let released = { released: false };
      if (!existing) {
        // A directory junction left in the failed worktree could make the
        // forced removal descend into the main checkout, so the links are torn
        // down first exactly as the cleanup and land paths do.
        removeWorktreeLinks(projectDir, plan.worktreePath, settings);
        await runGit(['worktree', 'remove', '--force', plan.worktreePath], projectDir);
        await runGit(['worktree', 'prune'], projectDir);
        const branchHead = await runGit(['rev-parse', `refs/heads/${plan.branch}`], projectDir);
        const baseHead = await runGit(['rev-parse', settings.baseRef], projectDir);
        const untouched = branchHead.ok && baseHead.ok && branchHead.stdout.trim() === baseHead.stdout.trim();
        branchDeleted = untouched
          && (await runGit(['branch', '--delete', '--force', plan.branch], projectDir)).ok;
        released = await releasePortRegistryEntry(projectDir, task.id);
      }
      results.push({
        ...plan,
        branchDeleted,
        code: error.code ?? 'BOOTSTRAP_FAILED',
        error: boundedOutput(error.message, projectDir),
        released: released.released === true,
        status: 'failed',
        rolledBack: !existing,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'bootstrap',
    status: results.every((item) => !['failed', 'blocked'].includes(item.status)) ? (args.write ? 'passed' : 'planned') : 'failed',
    ports: settings.ports,
    results,
    write: Boolean(args.write),
  };
}
async function worktreeCleanupReport(projectDir, args) {
  if (args.write && !args.cleanupLocked) {
    return withWorktreeLandLock(projectDir, () => worktreeCleanupReport(projectDir, { ...args, cleanupLocked: true }));
  }
  const config = await readProjectConfig(projectDir);
  const delivery = resolveDelivery(config, args.delivery);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: settings.error };
  if (args.task.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'failed', error: 'cleanup needs at least one --task <name>' };
  }
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'cleanup', status: 'unavailable', error: reason };
  const results = [];
  for (const raw of args.task) {
    const task = parseWorktreeTask(raw);
    const entry = entries.find((item) => !item.primary && item.path
      && (pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
        || (task.branch !== null && item.branch === task.branch)
        || path.basename(item.path) === task.id));
    if (!entry) {
      results.push({ error: `no worktree matches task ${task.id}`, id: task.id, status: 'failed' });
      continue;
    }
    if (entry.detached || typeof entry.branch !== 'string' || entry.branch === '') {
      results.push({ branch: entry.branch, error: `${entry.path} has no named branch; a detached worktree cannot be proven merged`, id: task.id, path: normalizeSlashes(entry.path), status: 'failed' });
      continue;
    }
    const head = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    const ancestor = head.ok ? await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), settings.baseRef], projectDir) : { ok: false };
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    const blocked = [];
    let mergeEvidence = null;
    let receipt = null;
    if (delivery.requireReceipt) {
      try {
        receipt = args.receipt ? JSON.parse(await readFile(path.resolve(projectDir, args.receipt), 'utf8')) : null;
        // `--receipt` is caller-supplied JSON, so the gate also has to resolve
        // the cited verification against the record this tool wrote: a
        // self-consistent receipt can otherwise assert acceptance for checks
        // that never ran.
        const gate = validateCompletion(receipt, delivery, await gitFingerprint(entry.path),
          { provenance: await attestCompletionProvenance(entry.path, receipt) });
        if (gate.status !== 'passed') blocked.push(...gate.errors);
        const target = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
        if (!target.ok || receipt?.target?.head !== target.stdout.trim()) blocked.push('completion receipt target is stale');
      } catch { blocked.push('completion receipt could not be read'); }
    }
    if (!ancestor.ok && delivery.cleanup === 'evidence-compatible') {
      try {
        const evidence = await readMergeEvidence(projectDir, { file: args['merge-evidence'] ? path.resolve(projectDir, args['merge-evidence']) : null, mr: args.mr });
        mergeEvidence = await validateMergeEvidence(projectDir, entry.path, args.mr ? { ...evidence, taskId: task.id } : evidence,
          { taskId: task.id, sourceHead: head.stdout?.trim(), targetRef: settings.baseRef, delivery, receipt });
        if (mergeEvidence.status !== 'passed') blocked.push(mergeEvidence.reason);
      } catch { blocked.push('Merge evidence unavailable; cannot prove GitLab MR merged'); }
    } else if (!ancestor.ok) blocked.push(`branch ${entry.branch} is not merged into ${settings.baseRef}`);
    if (!dirty.ok) blocked.push('the worktree status could not be read');
    if (dirty.ok && dirty.stdout.trim() !== '') blocked.push('the worktree has uncommitted changes');
    if (blocked.length > 0) {
      results.push({ blockers: blocked, branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'blocked' });
      continue;
    }
    if (!args.write) {
      results.push({ branch: entry.branch, id: task.id, path: normalizeSlashes(entry.path), status: 'planned' });
      continue;
    }
    const confirmedHead = await runGit(['rev-parse', 'HEAD'], entry.path);
    const confirmedDirty = await runGit(['status', '--porcelain=v1'], entry.path);
    const confirmedTarget = await runGit(['rev-parse', settings.baseRef], projectDir);
    if (!confirmedHead.ok || confirmedHead.stdout.trim() !== head.stdout.trim() || !confirmedDirty.ok || confirmedDirty.stdout.trim()
      || !confirmedTarget.ok || (mergeEvidence && confirmedTarget.stdout.trim() !== mergeEvidence.evidence.targetAfter)
      || (!mergeEvidence && !(await runGit(['merge-base', '--is-ancestor', head.stdout.trim(), settings.baseRef], projectDir)).ok)) {
      results.push({ id: task.id, status: 'blocked', blockers: ['Worktree or target changed before cleanup'] });
      continue;
    }
    // Teardown is best effort: an unprovable teardown is reported on the result
    // below instead of keeping a merged worktree in place. The marker it writes
    // is released by whichever path ends this item, so `service start` is only
    // held back while the worktree is actually about to be removed.
    const services = await teardownServices(projectDir, entry.path);
    if (delivery.requireReceipt) {
      const finalReceipt = validateCompletion(receipt, delivery, await gitFingerprint(entry.path),
        { provenance: await attestCompletionProvenance(entry.path, receipt) });
      const finalTarget = await runGit(['rev-parse', '--verify', settings.baseRef], projectDir);
      if (finalReceipt.status !== 'passed' || !finalTarget.ok || finalTarget.stdout.trim() !== receipt.target.head) {
        // The evidence changed while the services were being torn down, so the
        // worktree survives; releasing the marker is what lets its owner start
        // services again instead of being locked out of a worktree that is
        // still there.
        releaseServiceTeardown(projectDir, entry.path);
        results.push({ id: task.id, status: 'blocked', blockers: ['Evidence changed during service teardown'] });
        continue;
      }
    }
    const removedLinks = removeWorktreeLinks(projectDir, entry.path, settings);
    const removed = await runGit(['worktree', 'remove', entry.path], projectDir);
    if (!removed.ok) {
      releaseServiceTeardown(projectDir, entry.path);
      results.push({ branch: entry.branch, error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir), id: task.id, path: normalizeSlashes(entry.path), removedLinks, ...(services.status !== 'passed' ? { services } : {}), status: 'failed' });
      continue;
    }
    await runGit(['worktree', 'prune'], projectDir);
    releaseServiceTeardown(projectDir, entry.path);
    // The block is released inside the same lock that hands it out; the branch
    // itself is still never deleted here.
    const released = await releasePortRegistryEntry(projectDir, task.id);
    results.push({
      branch: entry.branch,
      id: task.id,
      path: normalizeSlashes(entry.path),
      portBlockReleased: released.released === true,
      remainingDirectory: existsSync(entry.path),
      removedLinks,
      ...(services.status !== 'passed' ? { services } : {}),
      status: 'passed',
    });
  }
  const failed = results.some((item) => item.status === 'failed' || item.status === 'blocked');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'cleanup',
    status: failed ? (delivery.profile !== 'legacy' && results.some((item) => item.status === 'blocked') ? 'blocked' : 'failed') : args.write ? 'passed' : 'planned',
    results,
    write: Boolean(args.write),
  };
}
/**
 * Land a finished worktree back onto the primary checkout's current branch
 * (docs/rules/git-rules.md §Worktree): merge --no-ff, run the verify gate,
 * optionally push, then remove the worktree and — only after a successful
 * push — delete its branch. Every step re-checks its evidence, so a failed
 * run is safe to retry: an already-merged branch skips the candidate merge,
 * and a run interrupted after the push retries with just cleanup and delete.
 * Without --write the report is the ordered plan; without --push the branch
 * survives with a suggested command instead of being deleted.
 */
// Branches a direct local land must never merge into because a server-side
// review or release gate protects them. `develop` is deliberately excluded
// (ADR-0013): the integration branch accepts direct no-ff landings so a task
// branch does not need a round-trip through an MR. The allowlist below records
// that decision explicitly so a later widening of the pattern cannot silently
// re-block it, and `isLandProtectedBranch` keeps the target rejection and the
// tracking-push allowance sourced from the same predicate.
const LAND_PROTECTED_BRANCH_PATTERN = /^(?:main|master|release(?:[-/].+)?)$/iu;
const LAND_PROTECTED_BRANCH_ALLOWLIST = new Set(['develop']);
function isLandProtectedBranch(branch) {
  if (LAND_PROTECTED_BRANCH_ALLOWLIST.has(String(branch ?? '').toLowerCase())) return false;
  return LAND_PROTECTED_BRANCH_PATTERN.test(branch);
}
async function gitCommonDir(projectDir) {
  const result = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!result.ok || result.stdout.trim() === '') return { ok: false, error: boundedOutput(result.stderr || result.error?.message || 'cannot resolve git common dir', projectDir) };
  return { ok: true, path: path.resolve(projectDir, result.stdout.trim()) };
}
/**
 * The wall-clock budget a land waits for a peer's shared lock. Resolved per
 * call so the parent-owned knob also applies to in-process callers; it can only
 * shorten the deadline, never widen it. Exported as the machine-readable
 * contract for that default and clamp.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {number}
 */
export function landLockTimeoutMs(environment = process.env) {
  const override = Number(environment.VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS);
  if (!Number.isFinite(override) || override <= 0) return LAND_LOCK_TIMEOUT_MS;
  return Math.min(LAND_LOCK_TIMEOUT_MS, Math.floor(override));
}
async function withWorktreeLandLock(projectDir, action) {
  const common = await gitCommonDir(projectDir);
  if (!common.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      code: 'LAND_LOCK_UNAVAILABLE',
      blockers: [common.error],
    };
  }
  const lockPath = path.join(common.path, 'vibe-harness-worktree-land.lock');
  const timeoutMs = landLockTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
      closeSync(handle);
      held = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return {
          schemaVersion: SCHEMA_VERSION,
          command: 'worktree',
          subcommand: 'land',
          status: 'blocked',
          code: 'LAND_LOCK_UNAVAILABLE',
          blockers: [`cannot create shared land lock: ${error.code ?? error.message}`],
        };
      }
      if (Date.now() >= deadline) {
        return {
          schemaVersion: SCHEMA_VERSION,
          command: 'worktree',
          subcommand: 'land',
          status: 'blocked',
          code: 'LAND_LOCK_TIMEOUT',
          blockers: [`${normalizeSlashes(lockPath)} is held by another land operation after ${timeoutMs}ms; inspect the owner before removing the lock`],
        };
      }
      await delay(LAND_LOCK_RETRY_MS);
    }
  }
  try {
    return await action();
  } finally {
    if (held) {
      try { rmSync(lockPath, { force: true }); } catch { /* keep the lock for manual recovery if removal is uncertain */ }
    }
  }
}
async function cleanupLandCandidate(projectDir, candidatePath, { abort = false } = {}) {
  if (!candidatePath) return { removed: true, residual: null };
  if (abort) await runGit(['merge', '--abort'], candidatePath);
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, {});
  if (!settings.error) removeWorktreeLinks(projectDir, candidatePath, settings);
  const status = await runGit(['status', '--porcelain=v1'], candidatePath);
  if (!status.ok || status.stdout.trim() !== '') {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: status.ok ? 'candidate worktree is dirty after merge cleanup' : boundedOutput(status.stderr || status.error?.message || 'candidate status failed', projectDir),
    };
  }
  const removed = await runGit(['worktree', 'remove', candidatePath], projectDir);
  if (!removed.ok) {
    return {
      removed: false,
      residual: normalizeSlashes(candidatePath),
      reason: boundedOutput(removed.stderr || removed.error?.message || 'candidate worktree remove failed', projectDir),
    };
  }
  await runGit(['worktree', 'prune'], projectDir);
  releaseServiceTeardown(projectDir, candidatePath);
  return { removed: true, residual: null };
}
async function worktreeLandReport(projectDir, args) {
  const delivery = resolveDelivery(await readProjectConfig(projectDir), args.delivery);
  if (args.write && args.task[0]) {
    const taskId = parseWorktreeTask(args.task[0]).id;
    const anchor = await readTaskAnchor(projectDir, taskId);
    if (anchor.exists) await taskCheckpointReport(projectDir, { ...args, _: ['task', 'checkpoint', taskId], reason: 'pre-delivery' });
  }
  if (delivery.merge === 'squash') {
    const result = await worktreeCleanupReport(projectDir, args);
    return { ...result, subcommand: 'land', delivery: { profile: delivery.profile, stage: 'cleanup' },
      guidance: 'Managed MR landing reads merge evidence only; it never creates a local no-ff merge or pushes.' };
  }
  if (args.write && args.verify === false) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'failed',
      code: 'LAND_VERIFY_REQUIRED',
      error: 'worktree land --write requires verification; use dry-run to inspect a no-verify plan',
    };
  }
  if (!args.write) return worktreeLandReportUnlocked(projectDir, args);
  return withWorktreeLandLock(projectDir, () => worktreeLandReportUnlocked(projectDir, args));
}
async function worktreeLandReportUnlocked(projectDir, args) {
  const failure = (error, code) => ({ schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'failed', ...(code ? { code } : {}), error });
  if (args.push && !args.write) {
    return failure('worktree land --push requires --write: push and branch deletion only run in a real write');
  }
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return failure(settings.error);
  const delivery = resolveDelivery(config, args.delivery);
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'land', status: 'unavailable', error: reason };
  const primary = entries.find((item) => item.primary) ?? null;
  if (!primary?.path) return failure('no primary checkout in the worktree listing; land merges into the primary checkout');
  if (primary.detached || typeof primary.branch !== 'string' || primary.branch === '') {
    return failure(`${normalizeSlashes(primary.path)} is on a detached HEAD; land needs a named target branch`);
  }
  // `git merge` can only merge into the branch the primary checkout has
  // checked out, so --base-ref is an assertion of intent, not a selector:
  // naming a different branch fails instead of switching the user's checkout.
  const targetBranch = args.baseRef ?? primary.branch;
  if (targetBranch !== primary.branch) {
    return failure(`land merges into the primary checkout's current branch ${primary.branch}; check out ${args.baseRef} first or omit --base-ref`);
  }
  if (isLandProtectedBranch(targetBranch)) {
    return failure(`target branch ${targetBranch} is a protected or shared branch; land refuses to merge into it`, 'LAND_TARGET_PROTECTED');
  }
  const registryInfo = readPortRegistry(projectDir);
  const registry = registryInfo.registry ?? null;
  const attributed = entries.filter((item) => !item.primary && !item.prunable && !item.detached && typeof item.branch === 'string' && item.branch !== ''
    && (isInsidePath(item.path, settings.root)
      || (registry?.entries ?? []).some((entry) => entry.id === path.basename(item.path)
        || (entry.path && pathKey(entry.path) === pathKey(item.path))
        || (entry.branch && entry.branch === item.branch))));
  let entry = null;
  if (args.task.length > 1) return failure('worktree land accepts at most one --task');
  if (args.task.length === 1) {
    const task = parseWorktreeTask(args.task[0]);
    entry = attributed.find((item) => pathKey(item.path) === pathKey(task.path ?? path.join(settings.root, task.id))
      || (task.branch !== null && item.branch === task.branch)
      || path.basename(item.path) === task.id) ?? null;
    if (!entry) return failure(`no attributed worktree matches task ${task.id}`);
  } else {
    if (attributed.length === 0) return failure('no attributed worktree to land (bootstrap one first or pass --task <id>)');
    if (attributed.length > 1) {
      return failure(`multiple attributed worktrees (${attributed.map((item) => `${path.basename(item.path)} on ${item.branch}`).join(', ')}); pass --task <id> to choose`);
    }
    entry = attributed[0];
  }
  if (entry.branch === targetBranch) {
    return failure(`the worktree branch ${entry.branch} is the target branch itself`);
  }
  const registryEntry = (registry?.entries ?? []).find((item) => item.id === path.basename(entry.path)
    || (item.path && pathKey(item.path) === pathKey(entry.path))
    || (item.branch && item.branch === entry.branch)) ?? null;
  const taskId = registryEntry?.id ?? path.basename(entry.path);
  const branchHead = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
  if (!branchHead.ok) return failure(`branch ${entry.branch} is not a local ref; land cannot attribute its commits`);
  const branchHeadSha = branchHead.stdout.trim();

  const blockers = [];
  const worktreeStatus = await runGit(['status', '--porcelain=v1'], entry.path);
  if (!worktreeStatus.ok) blockers.push('the worktree status could not be read');
  else if (worktreeStatus.stdout.trim() !== '') blockers.push('the worktree has uncommitted changes');
  const primaryStatus = await runGit(['status', '--porcelain=v1'], primary.path);
  if (!primaryStatus.ok) blockers.push('the primary checkout status could not be read');
  else if (primaryStatus.stdout.trim() !== '') blockers.push('the primary checkout has uncommitted changes');
  // An anchor with unfinished units means the work is not done yet; landing it
  // anyway would merge a half-finished slice into the target branch.
  let anchorInfo = null;
  let unitGate = null;
  try {
    anchorInfo = await readTaskAnchor(projectDir, taskId);
  } catch (error) {
    blockers.push(`task anchor ${taskAnchorRelativePath(taskId)} is unreadable: ${error.message}`);
  }
  if (anchorInfo?.exists && anchorInfo.anchor) {
    let landPlanUnits = [];
    if (typeof anchorInfo.anchor.planFile === 'string') {
      const planCheck = await taskPlanCheckReport(projectDir, taskId);
      if (planCheck.status !== 'passed') blockers.push(`task plan check failed for ${taskId}: ${planCheck.error ?? planCheck.code}`);
      else landPlanUnits = planUnitGraph(planCheck);
    }
    const units = Array.isArray(anchorInfo.anchor.units) ? anchorInfo.anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
    const anchorBlockers = Array.isArray(anchorInfo.anchor.blockers) ? anchorInfo.anchor.blockers.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
    anchorBlockers.forEach((item) => blockers.push(`task anchor ${taskId} has blocker: ${item}`));
    const pending = units.filter((unit) => unit.status !== 'done').map((unit) => unit.id ?? '?');
    if (units.length > 0 && pending.length > 0) blockers.push(`task anchor ${taskId} has units not done (${pending.join(', ')})`);
    // Land reuses the same predecessor judgement the dispatch gate uses: a
    // failed or blocked unit, and everything the plan declares on top of it,
    // is named instead of being folded into "units not done".
    const failedUnits = units.filter((unit) => TASK_UNIT_FAILURE_STATUSES.includes(unit.status)).map((unit) => unit.id ?? '?');
    const waitingUnits = planDependentUnits(landPlanUnits, failedUnits);
    if (failedUnits.length > 0) {
      unitGate = { failed: failedUnits, waiting: waitingUnits };
      blockers.push(`task anchor ${taskId} has failed or blocked units (${failedUnits.join(', ')}); repair and re-verify them before landing${waitingUnits.length > 0 ? ` (dependent units wait: ${waitingUnits.join(', ')})` : ''}`);
    }
  }
  const ancestor = await runGit(['merge-base', '--is-ancestor', branchHeadSha, targetBranch], projectDir);
  const alreadyMerged = ancestor.ok;
  // The verify tier defaults to the quick layer and only escalates when the
  // task anchor itself declares full risk; --tier always wins.
  let tier;
  try {
    tier = parseVerifyTier(args.tier ?? (anchorInfo?.anchor?.riskLevel === 'full' ? 'standard' : undefined));
  } catch (error) {
    return failure(error.message);
  }
  // A completion receipt is only accepted when no declared layer is left
  // deferred, and its acceptance names the checks the caller reviewed as
  // relevant. Both are preflight facts: a landing that cannot produce them is
  // reported here instead of after the merge candidate was built and tested.
  let tierEscalation = null;
  if (delivery.requireReceipt && args.verify !== false) {
    const configured = configuredChecks(config, projectDir);
    if (configured.error) return failure(configured.error);
    const receiptTier = resolveReceiptTier({ commands: configured.commands, config, explicit: args.tier !== undefined, projectDir, tier });
    if (receiptTier.blocked) blockers.push(receiptTier.blocked);
    else tier = receiptTier.tier;
    if (receiptTier.escalatedFrom) tierEscalation = { from: receiptTier.escalatedFrom, to: receiptTier.tier };
    if (receiptTier.selectedNames.length > 0) {
      const reviewed = resolveReviewedChecks(args.reviewed, receiptTier.selectedNames);
      if (reviewed.blocked) blockers.push(reviewed.blocked);
      else if (reviewed.ids.length === 0) {
        blockers.push(`a completion receipt (delivery.${delivery.profile}) requires the explicit relevance review of the checks this change is verified by: pass --reviewed <${receiptTier.selectedNames.join('|')}|all> after reading the changed paths against them`);
      }
    }
  }
  // Push policy mirrors $vb-git-split-push: plain push when an upstream exists;
  // without one the branch may only start tracking when origin is the sole
  // remote and the branch is not protected.
  const upstream = await runGit(['for-each-ref', `refs/heads/${targetBranch}`, '--format=%(upstream:short)'], projectDir);
  const hasUpstream = upstream.ok && upstream.stdout.trim() !== '';
  const remotes = await runGit(['remote'], projectDir);
  const remoteList = remotes.ok ? remotes.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
  const pushCommand = hasUpstream ? 'git push'
    : remoteList.length === 1 && remoteList[0] === 'origin' && !isLandProtectedBranch(targetBranch)
      ? `git push -u origin ${targetBranch}`
      : null;
  if (args.push && pushCommand === null) {
    blockers.push(`branch ${targetBranch} has no upstream and the push policy does not allow setting one (requires a sole origin remote and a non-protected branch)`);
  }

  const baseResult = {
    id: taskId,
    branch: entry.branch,
    path: normalizeSlashes(entry.path),
    alreadyMerged,
    pushed: false,
    branchDeleted: false,
    portBlockReleased: false,
  };
  const stepPlans = [
    { id: 'merge', detail: alreadyMerged ? `already merged into ${targetBranch}; skipped` : `merge ${entry.branch} in an isolated candidate worktree, then fast-forward ${targetBranch}` },
    ...(args.verify === false ? [{ id: 'verify', detail: 'skipped by --no-verify' }] : [{ id: 'verify', detail: `verify --tier ${tier} on the merged result` }]),
    ...(args.push ? [{ id: 'push', detail: pushCommand ?? 'blocked by push policy' }] : [{ id: 'push', detail: `no --push; branch kept, run after landing: git push${hasUpstream ? '' : ` -u origin ${targetBranch}`}` }]),
    { id: 'cleanup', detail: 'remove dependency links, the worktree, then release the port registry entry' },
    ...(args.push ? [{ id: 'delete-branch', detail: `git branch -d ${entry.branch} (only after a successful push)` }] : [{ id: 'delete-branch', detail: `branch ${entry.branch} kept without --push; delete after pushing with: git branch -d ${entry.branch}` }]),
  ];
  if (blockers.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'blocked',
      ...(unitGate ? { code: 'LAND_UNIT_PREDECESSOR_FAILED', unitGate } : {}),
      blockers,
      targetBranch,
      tier,
      ...(tierEscalation ? { tierEscalation } : {}),
      write: Boolean(args.write),
      results: [{ ...baseResult, status: 'blocked', steps: stepPlans.map((step) => ({ ...step, status: 'blocked' })) }],
    };
  }
  if (!args.write) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'worktree',
      subcommand: 'land',
      status: 'planned',
      targetBranch,
      tier,
      ...(tierEscalation ? { tierEscalation } : {}),
      write: false,
      results: [{ ...baseResult, status: 'planned', steps: stepPlans.map((step) => ({ ...step, status: 'planned' })) }],
    };
  }

  const steps = [];
  let failedStep = null;
  let pushed = false;
  const markFailed = (step) => {
    failedStep = step;
    steps.push(step);
  };

  let landReceipt = null;
  // True while the completion receipt returned to the caller is backed by a
  // durable provenance record; a receipt without one is not handed over.
  let provenanceRecorded = true;
  let candidatePath = null;
  let candidateHeadSha = null;
  // The best-effort service teardown outcome, carried on the cleanup step when
  // ownership could not be proven instead of blocking the landing.
  let servicesTeardown = null;
  const targetHead = await runGit(['rev-parse', `refs/heads/${targetBranch}`], primary.path);
  if (!targetHead.ok) {
    markFailed({ id: 'merge', status: 'failed', code: 'LAND_TARGET_HEAD_UNRESOLVED', error: boundedOutput(targetHead.stderr || targetHead.error?.message || 'target branch head could not be resolved', projectDir), detail: `resolve ${targetBranch}` });
  } else {
    const candidateBaseSha = targetHead.stdout.trim();
    candidatePath = path.join(path.dirname(settings.root), `.vibe-harness-land-${taskId}-${randomUUID()}`);
    const added = await runGit(['worktree', 'add', '--detach', candidatePath, candidateBaseSha], projectDir);
    if (!added.ok) {
      markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_CREATE_FAILED', error: boundedOutput(added.stderr || added.error?.message || 'candidate worktree creation failed', projectDir), detail: `git worktree add --detach ${candidatePath} ${candidateBaseSha}` });
    } else {
      try {
        for (const root of settings.dependencyRoots) linkDependencyRoot(projectDir, candidatePath, settings, root);
        // The governance surface is ignored by Git and therefore absent from a
        // fresh candidate worktree, so a verification command that reaches the
        // mirrored toolchain would fail here while passing in the source
        // worktree. The candidate is torn down through `removeWorktreeLinks`,
        // which removes these again before `git worktree remove`.
        if ((settings.mirrors ?? []).length > 0) linkOrCopyMirrors(projectDir, candidatePath, settings.mirrors);
        // The isolated per-package overlays belong to the same resolution
        // surface as the dependency roots: without them a pnpm/Bun isolated
        // layout resolves in the source worktree and fails in the candidate,
        // so `worktree land` would reject a mergeable branch. The cleanup path
        // removes them again through `removeDependencyLinks`.
        linkPackageRoots(projectDir, candidatePath, settings);
        for (const relative of new Set([settings.ports.envFile, ...settings.provision.envFiles])) {
          const source = safeWorktreeFile(entry.path, relative, 'worktree candidate env');
          const target = safeWorktreeFile(candidatePath, relative, 'worktree candidate env');
          if (existsSync(source)) {
            mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(source, target);
          }
        }
      } catch (error) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath);
        markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_SETUP_FAILED', error: error.message, candidatePath: removed.residual, detail: 'prepare isolated candidate dependencies' });
      }
      let candidateMerge = { ok: true };
      if (!failedStep && !alreadyMerged) candidateMerge = await runGit(['merge', '--no-ff', '--no-edit', entry.branch], candidatePath);
      if (!failedStep && !candidateMerge.ok) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath, { abort: true });
        markFailed({
          id: 'merge',
          status: 'failed',
          code: 'LAND_MERGE_CONFLICT',
          error: boundedOutput(candidateMerge.stderr || candidateMerge.error?.message || 'candidate merge failed', projectDir),
          candidatePath: removed.residual,
          detail: `isolated merge ${entry.branch} into ${targetBranch}`,
        });
      } else if (!failedStep) {
        const candidateHead = await runGit(['rev-parse', 'HEAD'], candidatePath);
        if (!candidateHead.ok) {
          const removed = await cleanupLandCandidate(projectDir, candidatePath);
          markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_HEAD_UNRESOLVED', error: boundedOutput(candidateHead.stderr || candidateHead.error?.message || 'candidate HEAD could not be resolved', projectDir), candidatePath: removed.residual, detail: 'resolve candidate HEAD' });
        } else {
          candidateHeadSha = candidateHead.stdout.trim();
          steps.push({ id: 'merge', status: alreadyMerged ? 'skipped' : 'passed', detail: alreadyMerged ? `${entry.branch} is already merged into ${targetBranch}` : `merged ${entry.branch} in isolated candidate worktree` });
          const verify = await verifyProject(candidatePath, { tier, task: [taskId], only: null, reuse: false, allowManual: false, reviewed: args.reviewed });
          if (delivery.requireReceipt) {
            landReceipt = completionReceipt(verify, delivery, { rollback: `git revert -m 1 ${candidateHeadSha}` });
            landReceipt.delivery.stage = 'complete';
            landReceipt.target.head = candidateHeadSha;
          }
          const completionGate = delivery.requireReceipt
            ? validateCompletion(landReceipt, delivery, await gitFingerprint(candidatePath),
              { provenance: await attestCompletionProvenance(candidatePath, landReceipt) })
            : null;
          const verifyOk = PASS_STATUSES.includes(verify.status) && completionGate?.status !== 'blocked';
          const checkLines = Object.entries(verify.checks ?? {})
            .filter(([, item]) => item?.status && item.status !== 'not_configured')
            .map(([name, item]) => `${name}=${item.status}`)
            .join(' ');
          if (verifyOk) {
            steps.push({ id: 'verify', status: 'passed', tier: verify.tier, receipt: verify.verification?.id ?? null, detail: `verify isolated candidate ${verify.status}${checkLines ? ` (${checkLines})` : ''}` });
          } else {
            const removed = await cleanupLandCandidate(projectDir, candidatePath);
            markFailed({ id: 'verify', status: 'failed', code: 'LAND_VERIFY_FAILED', tier: verify.tier, error: verify.error ?? `verify ended ${verify.status}${checkLines ? ` (${checkLines})` : ''}`, candidatePath: removed.residual, detail: `verify --tier ${tier} on isolated candidate` });
          }
        }
      }
    }
  }

  if (!failedStep) {
    const targetNow = await runGit(['rev-parse', `refs/heads/${targetBranch}`], primary.path);
    const sourceNow = await runGit(['rev-parse', `refs/heads/${entry.branch}`], projectDir);
    const primaryNow = await runGit(['status', '--porcelain=v1'], primary.path);
    const primaryBranchNow = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], primary.path);
    const sourceStatusNow = await runGit(['status', '--porcelain=v1'], entry.path);
    const candidateNow = candidatePath ? await runGit(['status', '--porcelain=v1'], candidatePath) : { ok: false };
    const candidateHeadNow = candidatePath ? await runGit(['rev-parse', 'HEAD'], candidatePath) : { ok: false };
    const baselineBlockers = [];
    if (!targetNow.ok || targetNow.stdout.trim() !== targetHead.stdout.trim()) baselineBlockers.push(`target branch ${targetBranch} changed while land was running`);
    if (!sourceNow.ok || sourceNow.stdout.trim() !== branchHeadSha) baselineBlockers.push(`source branch ${entry.branch} changed while land was running`);
    if (!primaryBranchNow.ok || primaryBranchNow.stdout.trim() !== targetBranch) baselineBlockers.push('the primary checkout switched branches while land was running');
    if (!primaryNow.ok || primaryNow.stdout.trim() !== '') baselineBlockers.push('the primary checkout became dirty while land was running');
    if (!sourceStatusNow.ok || sourceStatusNow.stdout.trim() !== '') baselineBlockers.push('the source worktree became dirty while land was running');
    if (!candidateNow.ok || candidateNow.stdout.trim() !== '') baselineBlockers.push('the candidate worktree is not clean after verification');
    if (!candidateHeadNow.ok || candidateHeadNow.stdout.trim() !== candidateHeadSha) baselineBlockers.push('the candidate HEAD changed during verification');
    if (baselineBlockers.length > 0) {
      const removed = await cleanupLandCandidate(projectDir, candidatePath);
      markFailed({ id: 'merge', status: 'blocked', code: 'LAND_BASELINE_CHANGED', blockers: baselineBlockers, candidatePath: removed.residual, detail: 'baseline changed after isolated verification; retry from the current target' });
    } else {
      const finalized = await runGit(['merge', '--ff-only', candidateHeadSha], primary.path);
      if (!finalized.ok) {
        const removed = await cleanupLandCandidate(projectDir, candidatePath);
        markFailed({ id: 'merge', status: 'failed', code: 'LAND_FINALIZE_FAILED', error: boundedOutput(finalized.stderr || finalized.error?.message || 'candidate could not be fast-forwarded into the primary checkout', projectDir), candidatePath: removed.residual, detail: `git merge --ff-only ${candidateHeadSha}` });
      } else {
        const removed = await cleanupLandCandidate(projectDir, candidatePath);
        // The receipt returned by this command describes the primary checkout,
        // but the write evidence it carries was read in the candidate worktree,
        // whose metadata the removal just destroyed. Re-anchoring it to the
        // primary after the fast-forward — and recording that evidence where
        // the receipt will be validated — keeps the command from returning a
        // receipt that its own gate then has to reject as stale.
        if (delivery.requireReceipt && landReceipt?.verification) {
          const finalizedAt = new Date().toISOString();
          const anchored = await gitFingerprint(primary.path);
          landReceipt.verification = {
            ...landReceipt.verification,
            verifiedAt: landReceipt.verification.finishedAt,
            finishedAt: finalizedAt,
            finalizedAt,
            fingerprint: anchored.fingerprint,
            writeFingerprint: anchored.writeFingerprint,
            ...(landReceipt.verification.acceptance
              ? { acceptance: { ...landReceipt.verification.acceptance, finalFingerprint: anchored.fingerprint } }
              : {}),
          };
          landReceipt.source = { ...landReceipt.source, head: candidateHeadSha, fingerprint: anchored.fingerprint };
          const recorded = await recordFinalVerification(primary.path, landReceipt.verification,
            { checks: landReceipt.acceptance });
          // The completion receipt is only valid through this record, so a
          // failure to write it has to stop the landing here: reporting `passed`
          // with a receipt whose provenance can never be attested would hand the
          // caller evidence the tool itself would reject.
          if (!recorded) {
            provenanceRecorded = false;
            if (!failedStep) {
              // The fast-forward already moved the target, so the branch is put
              // back: a blocked result has to leave the target exactly as
              // retryable as it found it, otherwise the next attempt sees an
              // already-landed change with no valid completion evidence. The
              // primary checkout was proven clean and on this branch just above.
              const restored = await runGit(['reset', '--hard', targetHead.stdout.trim()], primary.path);
              markFailed({
                id: 'merge', status: 'blocked',
                code: restored.ok ? 'LAND_PROVENANCE_UNRECORDED' : 'LAND_PROVENANCE_UNRECORDED_AND_UNRESTORED',
                ...(restored.ok ? {} : { error: boundedOutput(restored.stderr || restored.error?.message || 'the target branch could not be restored', projectDir) }),
                detail: restored.ok
                  ? 'record the finalized verification evidence for the primary checkout'
                  : `git reset --hard ${targetHead.stdout.trim()} in ${primary.path}`,
              });
            }
          }
        }
        if (!removed.removed) {
          markFailed({ id: 'merge', status: 'failed', code: 'LAND_CANDIDATE_CLEANUP_FAILED', candidatePath: removed.residual, error: removed.reason, detail: 'remove isolated candidate worktree' });
        } else {
          steps[steps.findIndex((step) => step.id === 'merge')].detail = `candidate verified and fast-forwarded into ${targetBranch}`;
        }
      }
    }
  }

  // Step 3: push (only with --push; a failed push stops the branch delete).
  if (!failedStep && args.push) {
    const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', targetBranch];
    const pushedResult = await runGit(pushArgs, primary.path);
    if (pushedResult.ok) {
      pushed = true;
      steps.push({ id: 'push', status: 'passed', detail: pushCommand });
    } else {
      markFailed({ id: 'push', status: 'failed', code: 'LAND_PUSH_FAILED', error: boundedOutput(pushedResult.stderr || pushedResult.error?.message || 'git push failed', projectDir), detail: pushCommand });
    }
  } else if (!failedStep) {
    steps.push({ id: 'push', status: 'skipped', detail: `no --push; branch kept, run after landing: git push${hasUpstream ? '' : ` -u origin ${targetBranch}`}` });
  }

  // Step 4: cleanup. The worktree removal must precede the branch delete below
  // because a checked-out branch cannot be deleted. Service teardown is best
  // effort rather than a gate: it is still attempted because a stopping service
  // can flush tracked or untracked state into the source worktree, but a
  // teardown that cannot be proven no longer keeps a merged worktree in place —
  // its outcome is reported on the cleanup step instead.
  if (!failedStep) {
    servicesTeardown = await teardownServices(projectDir, entry.path);
    // The completion receipt describes the candidate — not the source — so the
    // source is read again here: the removal below must not delete work that
    // appeared while services were being stopped.
    const sourceAfterTeardown = await runGit(['status', '--porcelain=v1', '--untracked-files=all'], entry.path);
    if (!sourceAfterTeardown.ok || sourceAfterTeardown.stdout.trim() !== '') {
      // The worktree survives the block, so the teardown marker it would keep
      // `service start` out with is released again.
      releaseServiceTeardown(projectDir, entry.path);
      markFailed({
        id: 'services', status: 'blocked', code: 'LAND_SOURCE_WORKTREE_DIRTY',
        error: boundedOutput(sourceAfterTeardown.stderr || sourceAfterTeardown.error?.message || 'the source worktree is not clean after service teardown', projectDir),
        detail: `git status --porcelain=v1 --untracked-files=all in ${entry.path}`,
      });
    }
  }
  if (!failedStep) {
    const removedLinks = removeWorktreeLinks(projectDir, entry.path, settings);
    const removed = await runGit(['worktree', 'remove', entry.path], projectDir);
    if (removed.ok) {
      await runGit(['worktree', 'prune'], projectDir);
      releaseServiceTeardown(projectDir, entry.path);
      const released = await releasePortRegistryEntry(projectDir, taskId);
      steps.push({
        id: 'cleanup',
        status: 'passed',
        removedLinks,
        portBlockReleased: released.released === true,
        detail: `worktree removed; links ${removedLinks.length}`,
        ...(servicesTeardown && servicesTeardown.status !== 'passed' ? { services: servicesTeardown } : {}),
      });
    } else {
      // The worktree survives the failed removal, so it must not stay locked
      // out of `service start` by a teardown marker written for a removal that
      // never happened.
      releaseServiceTeardown(projectDir, entry.path);
      markFailed({ id: 'cleanup', status: 'failed', code: 'LAND_CLEANUP_FAILED', removedLinks, error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir), detail: `git worktree remove ${entry.path}` });
    }
  }

  // Step 5: delete the branch — only after a successful push, and `-d` still
  // refuses a branch that is not fully merged.
  if (!failedStep && args.push && pushed) {
    const stillMerged = await runGit(['merge-base', '--is-ancestor', branchHeadSha, targetBranch], projectDir);
    if (!stillMerged.ok) {
      markFailed({ id: 'delete-branch', status: 'failed', code: 'LAND_BRANCH_NOT_MERGED', error: `branch ${entry.branch} is not merged into ${targetBranch}`, detail: `git branch -d ${entry.branch}` });
    } else {
      const deleted = await runGit(['branch', '--delete', entry.branch], projectDir);
      if (deleted.ok) steps.push({ id: 'delete-branch', status: 'passed', detail: `branch ${entry.branch} deleted` });
      else markFailed({ id: 'delete-branch', status: 'failed', code: 'LAND_BRANCH_DELETE_FAILED', error: boundedOutput(deleted.stderr || deleted.error?.message || 'git branch --delete failed', projectDir), detail: `git branch -d ${entry.branch}` });
    }
  } else if (!failedStep) {
    steps.push({ id: 'delete-branch', status: 'skipped', detail: `branch ${entry.branch} kept without --push; delete after pushing with: git branch -d ${entry.branch}` });
  }

  const stepFailures = steps.filter((step) => step.status === 'failed' || step.status === 'blocked');
  const landStatus = stepFailures.some((step) => step.status === 'blocked') && !stepFailures.some((step) => step.status === 'failed')
    ? 'blocked'
    : stepFailures.length > 0 ? 'failed' : 'passed';
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'land',
    status: landStatus,
    ...(failedStep?.code ? { code: failedStep.code } : {}),
    targetBranch,
    tier,
    ...(tierEscalation ? { tierEscalation } : {}),
    ...(landReceipt && provenanceRecorded ? { completion: landReceipt } : {}),
    write: true,
    results: [{ ...baseResult, pushed, branchDeleted: steps.some((step) => step.id === 'delete-branch' && step.status === 'passed'), portBlockReleased: steps.some((step) => step.id === 'cleanup' && step.status === 'passed' && step.portBlockReleased === true), status: landStatus, steps }],
  };
}
/**
 * Crash recovery for worktree provisioning (docs/rules/git-rules.md §Worktree).
 *
 * A hard kill bypasses the in-process rollback a failed bootstrap runs, so the
 * repository can be left with prunable worktree residue (directory gone, Git
 * metadata and branch binding left), worktrees whose provisioning stopped
 * before the locked registry/env write, zero-commit branches only that residue
 * still references, and registry entries whose worktree no longer exists.
 * Every category is detected from evidence (git listings, the port registry,
 * the filesystem) and nothing is touched without `--write`; a branch is only
 * ever deleted after being proven to sit at the base ref with a clean tree,
 * so no work can be lost.
 */
async function worktreeRecoverReport(projectDir, args) {
  if (!args.write) return worktreeRecoverReportUnlocked(projectDir, args);
  const result = await withWorktreeLandLock(projectDir, () => worktreeRecoverReportUnlocked(projectDir, args));
  return result.subcommand === 'land' ? { ...result, subcommand: 'recover' } : result;
}
async function worktreeRecoverReportUnlocked(projectDir, args) {
  const config = await readProjectConfig(projectDir);
  const settings = resolveWorktreeSettings(projectDir, config, args);
  if (settings.error) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'failed', error: settings.error };
  const { entries, reason } = await worktreeEntries(projectDir);
  if (reason) return { schemaVersion: SCHEMA_VERSION, command: 'worktree', subcommand: 'recover', status: 'unavailable', error: reason };
  const registry = readPortRegistry(projectDir).registry ?? null;
  const registryEntryFor = (worktree) => (registry?.entries ?? []).find((item) => item.id === path.basename(worktree.path)
    || (item.path && pathKey(item.path) === pathKey(worktree.path))
    || (item.branch && item.branch === worktree.branch)) ?? null;
  const baseHead = await runGit(['rev-parse', '--verify', '--quiet', settings.baseRef], projectDir);
  const baseSha = baseHead.ok ? baseHead.stdout.trim() : null;
  // Without a resolvable base ref nothing can be proven untouched, so the two
  // categories that delete branches stay empty; `worktree check` is the command
  // that reports WORKTREE_BASE_REF_UNRESOLVED.
  const branchUntouched = async (branch) => {
    if (baseSha === null) return false;
    const head = await runGit(['rev-parse', `refs/heads/${branch}`], projectDir);
    return head.ok && head.stdout.trim() === baseSha;
  };

  const prunable = entries.filter((entry) => !entry.primary && entry.prunable);
  const liveEntries = entries.filter((entry) => !entry.prunable);
  const candidateRoot = path.dirname(settings.root);
  const candidatePattern = /^\.vibe-harness-land-(.+)-([0-9a-f]{8}-[0-9a-f-]{27,})$/iu;
  const candidates = [];
  for (const entry of liveEntries) {
    if (!entry.detached || !entry.path || pathKey(path.dirname(entry.path)) !== pathKey(candidateRoot)) continue;
    const match = candidatePattern.exec(path.basename(entry.path));
    if (!match || !(registry?.entries ?? []).some((item) => item.id === match[1])) continue;
    const state = await runGit(['status', '--porcelain=v1'], entry.path);
    candidates.push({ path: entry.path, id: match[1], clean: state.ok && state.stdout.trim() === '', status: 'planned' });
  }

  // Incomplete worktrees: a bootstrap that died between `git worktree add` and
  // the locked registry/env write leaves a worktree that is clean, still at the
  // base ref, and missing the registry entry or the port env file (a successful
  // bootstrap always writes both). Attribution requires the worktree to sit
  // under the configured root or carry a registry entry, so foreign worktrees
  // are never touched.
  const incomplete = [];
  for (const entry of entries) {
    if (entry.primary || entry.prunable || entry.detached || typeof entry.branch !== 'string' || entry.branch === '') continue;
    const registryEntry = registryEntryFor(entry);
    if (!isInsidePath(entry.path, settings.root) && !registryEntry) continue;
    const envFilePresent = existsSync(path.join(entry.path, settings.ports.envFile));
    if (envFilePresent && registryEntry) continue;
    if (!await branchUntouched(entry.branch)) continue;
    const dirty = await runGit(['status', '--porcelain=v1'], entry.path);
    if (!dirty.ok || dirty.stdout.trim() !== '') continue;
    incomplete.push({
      branch: entry.branch,
      envFilePresent,
      id: registryEntry?.id ?? path.basename(entry.path),
      path: entry.path,
      registryEntryId: registryEntry?.id ?? null,
    });
  }

  // Zero-commit branches nothing checks out, referenced only by residue. The
  // prunable listing is the attribution evidence that the bootstrap created the
  // branch, so this must be detected before prune removes that listing;
  // unreferenced branches are user placeholders and are never deleted. Bindings
  // that only a prunable listing still holds are freed by the prune below, so
  // those branches are cleanup candidates here; every other binding (primary,
  // live or incomplete worktree) keeps its branch out of cleanup.
  const checkedOut = new Set(entries
    .filter((entry) => !entry.prunable && typeof entry.branch === 'string' && entry.branch !== '')
    .map((entry) => entry.branch));
  const branchListing = await runGit(['for-each-ref', 'refs/heads', '--format=%(refname:short)'], projectDir);
  const orphanedBranches = [];
  if (branchListing.ok) {
    for (const branch of branchListing.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      if (checkedOut.has(branch) || branch === settings.baseRef) continue;
      if (!await branchUntouched(branch)) continue;
      const evidence = (registry?.entries ?? []).some((item) => item.branch === branch) ? 'registry'
        : prunable.some((item) => item.branch === branch) ? 'prunable'
        : null;
      if (evidence === null) continue;
      orphanedBranches.push({ branch, evidence });
    }
  }

  // Registry entries no surviving worktree claims. A prunable worktree is
  // already gone from the filesystem, so its entry only leaks the port block;
  // an entry matched by an incomplete worktree is released by that worktree's
  // own rollback instead.
  const orphanedRegistry = [];
  for (const item of registry?.entries ?? []) {
    const claimed = liveEntries.some((entry) => !entry.primary && (
      item.id === path.basename(entry.path)
      || (item.path && pathKey(item.path) === pathKey(entry.path))
      || (item.branch && item.branch === entry.branch)
    ));
    if (!claimed) orphanedRegistry.push({ id: item.id, path: item.path ?? null });
  }

  // Apply: incomplete worktrees first (each removal is its own rollback), then
  // one prune for the residue, then branch deletes (prune is what frees the
  // bindings the prunable listing held), then registry releases.
  const results = [];
  const candidateResults = [];
  for (const item of candidates) {
    if (!item.clean) {
      candidateResults.push({ ...item, status: 'blocked', reason: 'candidate is dirty; inspect it before manual cleanup' });
      continue;
    }
    if (!args.write) {
      candidateResults.push(item);
      continue;
    }
    const removed = await cleanupLandCandidate(projectDir, item.path);
    candidateResults.push(removed.removed
      ? { ...item, status: 'passed' }
      : { ...item, status: 'failed', code: 'WORKTREE_RECOVER_CANDIDATE_FAILED', error: removed.reason });
  }
  for (const item of incomplete) {
    if (!args.write) {
      results.push({ ...item, status: 'planned' });
      continue;
    }
    // A teardown that cannot be proven is reported on the item and does not
    // keep crash residue in place: `recover` only ever removes worktrees whose
    // provisioning never completed.
    const services = await teardownServices(projectDir, item.path);
    const removedLinks = removeWorktreeLinks(projectDir, item.path, settings);
    const removed = await runGit(['worktree', 'remove', '--force', item.path], projectDir);
    if (!removed.ok) {
      results.push({
        ...item,
        code: 'WORKTREE_RECOVER_REMOVE_FAILED',
        error: boundedOutput(removed.stderr || removed.error?.message || 'git worktree remove failed', projectDir),
        removedLinks,
        ...(services.status !== 'passed' ? { services } : {}),
        status: 'failed',
      });
      continue;
    }
    releaseServiceTeardown(projectDir, item.path);
    const branchDeleted = (await runGit(['branch', '--delete', '--force', item.branch], projectDir)).ok;
    const released = item.registryEntryId !== null
      ? await releasePortRegistryEntry(projectDir, item.registryEntryId)
      : { released: false };
    const errors = [];
    if (!branchDeleted) errors.push(`branch ${item.branch} could not be deleted`);
    if (item.registryEntryId !== null && released.released !== true) errors.push(`registry entry ${item.registryEntryId} not released`);
    results.push({
      ...item,
      ...(errors.length > 0 ? { code: 'WORKTREE_RECOVER_PARTIAL', error: errors.join('; ') } : {}),
      branchDeleted,
      portBlockReleased: released.released === true,
      removedLinks,
      ...(services.status !== 'passed' ? { services } : {}),
      status: errors.length === 0 ? 'passed' : 'failed',
    });
  }

  let pruned = null;
  if (args.write && (prunable.length > 0 || incomplete.length > 0)) {
    pruned = (await runGit(['worktree', 'prune'], projectDir)).ok;
  }

  const branchResults = [];
  for (const item of orphanedBranches) {
    if (!args.write) {
      branchResults.push({ ...item, status: 'planned' });
      continue;
    }
    const deleted = await runGit(['branch', '--delete', '--force', item.branch], projectDir);
    branchResults.push(deleted.ok
      ? { ...item, status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_BRANCH_FAILED',
        error: boundedOutput(deleted.stderr || deleted.error?.message || 'git branch --delete failed', projectDir),
        status: 'failed',
      });
  }

  const registryResults = [];
  for (const item of orphanedRegistry) {
    if (!args.write) {
      registryResults.push({ ...item, status: 'planned' });
      continue;
    }
    const services = item.path ? await teardownServices(projectDir, item.path) : { status: 'passed' };
    // The teardown writes its worktree marker even without a registry entry, and
    // this branch never removes the worktree afterwards, so the marker has to be
    // released here or a later service start in the same path stays blocked.
    if (item.path) releaseServiceTeardown(projectDir, item.path);
    const released = await releasePortRegistryEntry(projectDir, item.id);
    registryResults.push(released.released === true
      ? { ...item, ...(services.status !== 'passed' ? { services } : {}), status: 'passed' }
      : {
        ...item,
        code: 'WORKTREE_RECOVER_RELEASE_FAILED',
        error: released.reason ?? released.error ?? 'registry entry not released',
        ...(services.status !== 'passed' ? { services } : {}),
        status: 'failed',
      });
  }

  const failed = [...results, ...candidateResults, ...branchResults, ...registryResults].some((item) => item.status === 'failed' || item.status === 'blocked')
    || (args.write && prunable.length > 0 && pruned !== true);
  const summary = [
    `status: ${failed ? 'failed' : args.write ? 'passed' : 'planned'} (write: ${Boolean(args.write)})`,
    `prunable residue: ${prunable.length}${prunable.length > 0 ? ` (${prunable.map((item) => item.path).join(', ')})` : ''}`,
    ...candidateResults.map((item) => `land candidate: ${item.path} ${item.status}${item.reason ? ` (${item.reason})` : ''}`),
    ...results.map((item) => `incomplete: ${item.path} branch ${item.branch} ${item.status}`),
    ...branchResults.map((item) => `branch: ${item.branch} ${item.status}${item.evidence ? ` [${item.evidence}]` : ''}${item.error ? ` (${item.error})` : ''}`),
    ...registryResults.map((item) => `registry entry: ${item.id} ${item.status}`),
  ].join('\n');
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'worktree',
    subcommand: 'recover',
    status: failed ? 'failed' : args.write ? 'passed' : 'planned',
    baseRef: settings.baseRef,
    candidates: candidateResults,
    orphanedBranches: branchResults,
    orphanedRegistry: registryResults,
    prunable: prunable.map((item) => ({
      branch: item.branch,
      path: item.path,
      reason: typeof item.prunable === 'string' ? item.prunable : 'worktree directory missing',
    })),
    pruned: args.write ? pruned : null,
    results,
    summary,
    write: Boolean(args.write),
  };
}
async function worktreeReport(projectDir, args) {
  const subcommand = args._[1] ?? 'check';
  if (subcommand === 'list') return worktreeListReport(projectDir);
  if (subcommand === 'check') return worktreeCheckReport(projectDir, args);
  if (subcommand === 'bootstrap') return worktreeBootstrapReport(projectDir, args);
  if (subcommand === 'land') return worktreeLandReport(projectDir, args);
  if (subcommand === 'cleanup') return worktreeCleanupReport(projectDir, args);
  if (subcommand === 'recover') return worktreeRecoverReport(projectDir, args);
  throw new Error(`Unknown worktree subcommand: ${subcommand} (expected list, check, bootstrap, land, cleanup or recover)`);
}
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
function splitLines(text) {
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (hadTrailingNewline) lines.pop();
  return { hadTrailingNewline, lines };
}
async function sliceReport(projectDir, args) {
  if (!args.file) return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: 'slice needs --file <path>' };
  const file = path.resolve(projectDir, args.file);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `cannot read ${normalizePath(args.file)}: ${error.code ?? error.message}` };
  }
  const { lines } = splitLines(raw);
  const from = args.from ?? 1;
  const to = args.to ?? lines.length;
  if (!Number.isInteger(from) || from < 1 || to < from || from > lines.length + 1) {
    return { schemaVersion: SCHEMA_VERSION, command: 'slice', status: 'failed', error: `range ${from}-${to} is outside 1-${lines.length}` };
  }
  const numbered = args.numbers !== false;
  const width = String(Math.min(to, lines.length)).length;
  const selected = [];
  for (let index = from; index <= Math.min(to, lines.length); index += 1) {
    const line = lines[index - 1];
    selected.push(numbered ? `${String(index).padStart(width, ' ')} | ${line}` : line);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'slice',
    status: 'ready',
    eol: detectEol(raw) === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(path.relative(projectDir, file) || args.file),
    from,
    lines: selected,
    numbered,
    text: selected.join('\n'),
    to: Math.min(to, lines.length),
    totalLines: lines.length,
  };
}
function applyPatchOps(lines, ops, specDir) {
  const applied = [];
  let current = [...lines];
  let previousStart = Number.POSITIVE_INFINITY;
  for (const [index, op] of ops.entries()) {
    if (!op || typeof op !== 'object') throw Object.assign(new Error(`op[${index}] must be an object`), { code: 'PATCH_OP_INVALID' });
    if (op.kind === 'range') {
      const start = op.startLine;
      const end = op.endLine;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw Object.assign(new Error(`op[${index}] range ${String(start)}-${String(end)} is invalid`), { code: 'PATCH_OP_INVALID' });
      }
      if (start > previousStart) {
        throw Object.assign(new Error(`op[${index}] starts at line ${start} after a later op; list range ops from the highest line number down`), { code: 'PATCH_OP_ORDER_INVALID' });
      }
      previousStart = start;
      const first = current[start - 1];
      const last = current[end - 1];
      if (first === undefined || last === undefined) {
        throw Object.assign(new Error(`op[${index}] range ${start}-${end} is outside the file (${current.length} lines)`), { code: 'PATCH_RANGE_OUT_OF_BOUNDS' });
      }
      if (typeof op.expectStart !== 'string' || !first.includes(op.expectStart)) {
        throw Object.assign(new Error(`op[${index}] start guard failed at line ${start}: ${JSON.stringify(first.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.expectEnd !== 'string' || !last.includes(op.expectEnd)) {
        throw Object.assign(new Error(`op[${index}] end guard failed at line ${end}: ${JSON.stringify(last.slice(0, 120))}`), { code: 'PATCH_GUARD_FAILED' });
      }
      if (typeof op.replaceFrom !== 'string' || op.replaceFrom === '') {
        throw Object.assign(new Error(`op[${index}] needs replaceFrom pointing at a fragment file`), { code: 'PATCH_OP_INVALID' });
      }
      const fragmentPath = path.resolve(specDir, op.replaceFrom);
      let fragmentRaw;
      try {
        fragmentRaw = readFileSync(fragmentPath, 'utf8');
      } catch (error) {
        throw Object.assign(new Error(`op[${index}] cannot read ${op.replaceFrom}: ${error.code ?? error.message}`), { code: 'PATCH_FRAGMENT_UNREADABLE' });
      }
      const { lines: fragment } = splitLines(fragmentRaw);
      current = [...current.slice(0, start - 1), ...fragment, ...current.slice(end)];
      applied.push({ index, kind: 'range', replacedLines: end - start + 1, startLine: start, endLine: end, replacementLines: fragment.length, status: 'applied' });
      continue;
    }
    if (op.kind === 'sequence') {
      const match = Array.isArray(op.match) ? op.match : null;
      const replace = Array.isArray(op.replace) ? op.replace : null;
      if (!match || match.length === 0 || !replace) {
        throw Object.assign(new Error(`op[${index}] needs match and replace line arrays`), { code: 'PATCH_OP_INVALID' });
      }
      const hits = [];
      for (let at = 0; at + match.length <= current.length; at += 1) {
        if (match.every((line, offset) => current[at + offset] === line)) hits.push(at);
      }
      if (hits.length !== 1) {
        throw Object.assign(new Error(`op[${index}] match occurs ${hits.length} times (expected exactly 1)`), { code: 'PATCH_MATCH_NOT_UNIQUE' });
      }
      current = [...current.slice(0, hits[0]), ...replace, ...current.slice(hits[0] + match.length)];
      applied.push({ index, kind: 'sequence', matchLines: match.length, replacementLines: replace.length, startLine: hits[0] + 1, status: 'applied' });
      continue;
    }
    throw Object.assign(new Error(`op[${index}] kind must be "range" or "sequence"`), { code: 'PATCH_OP_INVALID' });
  }
  return { applied, lines: current };
}
async function patchReport(projectDir, args) {
  if (!args.spec) return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'patch needs --spec <spec.json>' };
  const specPath = path.resolve(projectDir, args.spec);
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read spec: ${error.message}` };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.file !== 'string' || !Array.isArray(spec.ops) || spec.ops.length === 0) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: 'spec must be { "file": "<path>", "ops": [ ... ] } with at least one op' };
  }
  const specDir = path.dirname(specPath);
  const target = path.resolve(specDir, spec.file);
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot read ${normalizePath(spec.file)}: ${error.code ?? error.message}` };
  }
  const eol = detectEol(raw);
  const { hadTrailingNewline, lines } = splitLines(raw);
  let result;
  try {
    result = applyPatchOps(lines, spec.ops, specDir);
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'failed',
      code: error.code ?? 'PATCH_FAILED',
      error: boundedOutput(error.message, projectDir),
      file: normalizePath(spec.file),
      write: Boolean(args.write),
      written: false,
    };
  }
  const nextText = result.lines.join(eol) + (hadTrailingNewline ? eol : '');
  if (!args.write) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'patch',
      status: 'planned',
      dryRun: true,
      eol: eol === '\r\n' ? 'crlf' : 'lf',
      file: normalizePath(spec.file),
      ops: result.applied,
      write: false,
      written: false,
    };
  }
  try {
    writeFileSync(target, nextText);
  } catch (error) {
    return { schemaVersion: SCHEMA_VERSION, command: 'patch', status: 'failed', error: `cannot write ${normalizePath(spec.file)}: ${error.code ?? error.message}`, file: normalizePath(spec.file), written: false };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'patch',
    status: 'passed',
    eol: eol === '\r\n' ? 'crlf' : 'lf',
    file: normalizePath(spec.file),
    linesAfter: result.lines.length,
    linesBefore: lines.length,
    ops: result.applied,
    write: true,
    written: true,
  };
}
export async function runCommand(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const command = args.help ? 'help' : (args._[0] ?? 'help');
  if (args.output && !['json', 'summary'].includes(args.output)) throw new Error(`Unknown output format: ${args.output}`);
  // Windows exposes aliases for the same directory: 8.3 short names
  // (`RUNNER~1`), junctions and symlinked checkouts. The typed path and the
  // real path then differ as strings, so every derived path (worktree targets,
  // registry entries, env files) and every containment comparison has to start
  // from the canonical directory instead of the alias the caller typed.
  const requestedProjectDir = path.resolve(cwd, args.project ?? '.');
  const projectDir = safeRealpath(requestedProjectDir) ?? requestedProjectDir;
  const config = command === 'help' ? {} : await readProjectConfig(projectDir);
  const delivery = resolveDelivery(config, args.delivery);
  if (delivery.write === false && (args.write || args.push || (command === 'verify' && !args.plan) || ['patch'].includes(command))) {
    return { args, report: { command, status: 'blocked', code: 'DELIVERY_INSPECT_ONLY', error: 'inspect-only cannot execute commands or write' }, exitCode: 1 };
  }
  if (command === 'verify' && !args.plan && args.task[0]) {
    try {
      const anchor = await readTaskAnchor(projectDir, args.task[0]);
      if (anchor.exists) await taskCheckpointReport(projectDir, { ...args, _: ['task', 'checkpoint', args.task[0]], reason: 'pre-verify', write: true });
    } catch (error) {
      if (error.code !== 'VIBE_HARNESS_INVALID_TASK_ID') throw error;
    }
  }
  let report;
  if (command === 'env') report = await envReport(projectDir);
  else if (command === 'context') report = { schemaVersion: SCHEMA_VERSION, command, status: 'ready', ...(await projectContext(projectDir)) };
  else if (command === 'changes') report = await changesReport(projectDir, args);
  else if (command === 'verify') report = await verifyProject(projectDir, args, { planOnly: args.plan });
  else if (command === 'worktree') report = await worktreeReport(projectDir, args);
  else if (command === 'slice') report = await sliceReport(projectDir, args);
  else if (command === 'patch') report = await patchReport(projectDir, args);
  else if (command === 'task') report = await taskReport(projectDir, args);
  else if (command === 'runtime' && args._[1] === 'service') report = await serviceReport(projectDir, args, assertSafeCommand);
  else if (command === 'help') report = {
    schemaVersion: SCHEMA_VERSION,
    command,
    status: 'ready',
    usage: 'run.mjs <env|context|changes|verify|worktree|slice|patch|task> [--project <path>] [--json]（--project 缺省为当前目录）',
    delivery: '--delivery managed-mr|local-land|inspect-only overrides delivery.default. managed-mr land/cleanup requires --receipt <file> and --merge-evidence <file> or --mr <iid> when source is not an ancestor.',
    services: 'run.mjs runtime service <start|status|stop> --project <path> [--service <id>] [--port <number>] [--write]; only registered supervisor-owned processes can be stopped.',
    checkpoint: 'task checkpoint <id> --reason <text> [--write]; task event <id> --reason pre-compaction|resume|continue|pre-delivery|pre-verify [--write]. Host lifecycle events need an actual host bridge; events are not inferred from tool calls.',
    worktree: 'run.mjs worktree <list|check|bootstrap|land|cleanup|recover> --project <path>: bootstrap, land, cleanup and recover stay dry-run until --write; bootstrap allocates the next port block from .vibe-harness/worktree-ports.json, materializes worktree.provision.envFiles and runs worktree.provision.setupCommands (a red-zone target also needs --confirm-red-zone); land serializes writes through a shared Git common-dir lock, merges the attributed worktree in an isolated candidate (--no-ff), verifies it (quick tier by default, standard when the task anchor declares riskLevel full), then fast-forwards the primary checkout only when its baseline is unchanged; --write --no-verify is rejected; with --push it also pushes the target branch (upstream, else -u origin when origin is the sole remote) and deletes the worktree branch only after the push succeeds; cleanup refuses branches not merged into worktree.baseRef; recover reclaims clean attributed candidate residue and bootstrap crash residue but never deletes a branch that moved past the base ref',
    task: 'run.mjs task <init|update|status|list|plan-check|plan-sync|check|freeze-tests|rebaseline-tests> [task-id] --project <path>: anchors live in .vibe-harness/tasks/<task-id>.json and managed plans live in docs/plans/*.md; init accepts --plan-file, plan-check detects drift, plan-sync requires --reason, check gates readiness (check --unit <id> --dispatch answers whether the unit may be handed out now), freeze-tests requires a failed verification and --test-path, and rebaseline-tests additionally requires a protected approval receipt. Write commands stay dry-run until --write.',
    reuse: 'run.mjs verify --project <path> [--task <task-id>] --reuse: returns status "reused" only for explicitly deterministic checks with matching input fingerprints in the ignored receipt store; task anchors are optional and receipts of an older schema are not reused',
    verify: 'run.mjs verify --project <path> [--tier quick|standard|deep] [--scope affected|layer|full] [--async --tier deep] [--only lint,typecheck,test,eval] [--reviewed <check ids|all>] [--plan] or --micro <declared-id> [--plan]: Micro is explicit and never replaces unit/integration evidence; --micro is exclusive with tier, only, async, reuse and manual. --reviewed is the explicit relevance review of the selected checks and is the only evidence that makes a passed check count as reviewed.',
  };
  else throw new Error(`Unknown command: ${command}`);
  if (command !== 'help') {
    report.delivery ??= { profile: delivery.profile, stage: command };
    report.warnings = [...(report.warnings ?? []), ...delivery.warnings, ...overrideWarnings(config)];
    if (command === 'verify' && delivery.requireReceipt) report.completion = completionReceipt(report, delivery);
  }
  const exitCode = PASS_STATUSES.includes(report.status) || (report.status === 'unverified' && report.noChanges === true) ? 0 : 1;
  return { args, report, exitCode };
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runCommand(argv);
    const output = result.args.output ?? (result.args.json ? 'json' : 'summary');
    process.stdout.write(output === 'summary' ? `${summary(result.report)}\n` : `${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const report = { schemaVersion: SCHEMA_VERSION, command: 'error', status: 'failed', error: redactText(error.message, process.cwd()) };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  }
}
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : null;
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (entryPath && pathToFileURL(entryPath).href === pathToFileURL(modulePath).href) {
  await main();
}
