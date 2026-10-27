// Task anchors: plan synchronisation, unit state and recovery checkpoints.
//
// Task state is the long-task contract: the managed plan in `docs/plans/` is parsed
// here, the anchor in `.vibe-harness/tasks/` is validated and written here, and the
// checkpoint/event/recovery records that survive a context loss are produced here.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { gitFingerprint } from './git-fingerprint.mjs';
import { parseLinearPlanBlock } from './linear-planning.mjs';

import { boundedOutput, normalizePath } from './cli-output.mjs';
import { PASS_STATUSES, SCHEMA_VERSION, normalizeSlashes, readProjectConfig, runGit, safeRealpath, stableStringify } from './cli-runtime.mjs';
import { configuredChecks, displayCommand } from './verification-plan-support.mjs';
import { batchPredecessorSatisfied, bindLocalCompletion, localCompletionValid, parentBatchContract, parentBatchPublication, parentBatchWorkspace, sameParentBatch } from './parent-batch.mjs';

// --- task anchors ------------------------------------------------------------
//
// `task` persists one JSON anchor per long-running task under
// `.vibe-harness/tasks/` so a compacted or resumed session can recover from
// the anchor plus the current diff without re-reading rule bodies or the full
// report. init and update stay read-only until --write; status and list never
// write. A damaged anchor is rejected, never silently rebuilt.

const TASK_SCHEMA_VERSION = 2;
const TASKS_RELATIVE_DIR = '.vibe-harness/tasks';
const PLAN_RELATIVE_DIR = 'docs/plans';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const TASK_STAGES = ['review', 'plan', 'implement', 'verify'];
// `failed` is the state that stops a plan: a unit whose focused verification
// went red cannot be skipped over, and every declared dependent of it must wait
// until the failure is repaired and re-verified.
const TASK_UNIT_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'failed'];
export const TASK_UNIT_FAILURE_STATUSES = ['failed', 'blocked'];
const TASK_RISK_LEVELS = ['quick', 'light', 'full'];
const DEFAULT_TASK_RISK_LEVEL = 'light';
const INITIAL_TASK_STAGE = 'plan';
/** @type {Array<[string, RegExp]>} */
const PLAN_REQUIRED_SECTIONS = [
  ['goal', /(?:^|\n)\s*(?:#{1,6}\s*)?(?:目标|goal|purpose\s*\/\s*big\s*picture)\s*:?\s*$/imu],
  ['non-goals', /(?:^|\n)\s*(?:#{1,6}\s*)?(?:非目标|non-goals?)\s*:?\s*$/imu],
  ['plan', /(?:^|\n)\s*(?:#{1,6}\s*)?(?:实施顺序|实施计划|plan\s+of\s+work|concrete\s+steps)\s*:?\s*$/imu],
  ['acceptance', /(?:^|\n)\s*(?:#{1,6}\s*)?(?:验收(?:方式|测试与完成标准)?|validation\s+and\s+acceptance)\s*:?\s*$/imu],
];
export function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId) || WINDOWS_RESERVED_NAMES.test(taskId)) {
    throw Object.assign(
      new Error(`Invalid task id ${JSON.stringify(String(taskId))}: expected 1-64 characters from [A-Za-z0-9._-], starting alphanumeric, and not a reserved device name`),
      { code: 'VIBE_HARNESS_INVALID_TASK_ID' },
    );
  }
  return taskId;
}
function taskAnchorPath(projectDir, taskId) {
  return path.join(projectDir, TASKS_RELATIVE_DIR, `${taskId}.json`);
}
export function taskAnchorRelativePath(taskId) {
  return `${TASKS_RELATIVE_DIR}/${taskId}.json`;
}
function planRelativePath(projectDir, value) {
  const candidate = path.resolve(projectDir, String(value));
  const relative = path.relative(path.resolve(projectDir), candidate).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`plan file must stay inside ${PLAN_RELATIVE_DIR}`), { code: 'VIBE_HARNESS_PLAN_OUTSIDE_PROJECT' });
  }
  if (!relative.startsWith(`${PLAN_RELATIVE_DIR}/`) || !relative.toLowerCase().endsWith('.md')) {
    throw Object.assign(new Error(`plan file must be a Markdown file under ${PLAN_RELATIVE_DIR}`), { code: 'VIBE_HARNESS_PLAN_PATH_INVALID' });
  }
  return { absolute: candidate, relative };
}
async function readManagedPlan(projectDir, value) {
  const location = planRelativePath(projectDir, value);
  let resolvedPath;
  let content;
  try {
    resolvedPath = await realpath(location.absolute);
    const actualRelative = path.relative(path.resolve(projectDir), resolvedPath).replaceAll('\\', '/');
    if (!actualRelative.startsWith(`${PLAN_RELATIVE_DIR}/`) || !actualRelative.toLowerCase().endsWith('.md')) {
      throw Object.assign(new Error(`plan file resolves outside ${PLAN_RELATIVE_DIR}`), { code: 'VIBE_HARNESS_PLAN_SYMLINK_ESCAPE' });
    }
    content = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error?.code === 'VIBE_HARNESS_PLAN_SYMLINK_ESCAPE') throw error;
    throw Object.assign(
      new Error(`cannot read ${location.relative}: ${error.code ?? error.message}`),
      { code: 'VIBE_HARNESS_PLAN_UNREADABLE' },
    );
  }
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  const missing = PLAN_REQUIRED_SECTIONS
    .filter(([, pattern]) => !pattern.test(content))
    .map(([id]) => id);
  return {
    content,
    digest,
    missing,
    path: location.relative,
    revision: digest.slice(0, 12),
  };
}
/**
 * Machine-readable execution block. A `plan-units` fence lists what may change
 * (`allowedScope`), what must never change (`protectedAssets`) and, per unit,
 * its own files, its predecessors and the acceptance IDs that prove it. The
 * prose sections stay authoritative for *why* a change happens; this block is
 * the contract a fresh engineer or a dispatch CLI checks without session
 * history.
 */
const PLAN_UNIT_BLOCK_PATTERN = /```(?:json[ \t]+)?plan-units[ \t]*\r?\n([\s\S]*?)```/u;
function normalizePlanPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
}
/**
 * Scope entry match. `dir/**` covers the directory itself and everything below
 * it; any other entry is an exact path. Comparison is case-insensitive because
 * the same tree is used from Windows and POSIX hosts.
 */
function scopeMatches(pattern, candidate) {
  const normalized = normalizePlanPath(pattern);
  const target = normalizePlanPath(candidate);
  if (normalized === '' || normalized === '**') return true;
  if (normalized.endsWith('/**')) {
    const base = normalized.slice(0, -3);
    return target === base || target.startsWith(`${base}/`);
  }
  return target === normalized;
}
function scopeIntersects(left, right) {
  const first = normalizePlanPath(left);
  const second = normalizePlanPath(right);
  if (first === '' || second === '') return false;
  if (first.endsWith('/**')) {
    const base = first.slice(0, -3);
    return second === base || second.startsWith(`${base}/`) || base.startsWith(`${second}/`);
  }
  if (second.endsWith('/**')) return scopeIntersects(second, first);
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}
/** Acceptance IDs are the first column of the acceptance section's table. */
function planAcceptanceIds(content) {
  const section = /(?:^|\n)#{1,6}[ \t]*(?:验收(?:方式|测试与完成标准)?|validation and acceptance)[^\n]*\n([\s\S]*?)(?=\n#{1,6}[ \t]|$)/iu.exec(content);
  const ids = new Set();
  for (const match of (section?.[1] ?? '').matchAll(/^[ \t]*\|[ \t]*([A-Za-z][A-Za-z0-9._-]*)[ \t]*\|/gmu)) {
    if (/^[A-Za-z]+[-_]?\d+$/u.test(match[1])) ids.add(match[1].toUpperCase());
  }
  return ids;
}
function planUnitProblems(block, acceptanceIds) {
  const problems = [];
  const warnings = [];
  const push = (code, message) => problems.push({ code, message });
  const rawUnits = Array.isArray(block?.units) ? block.units : null;
  if (!rawUnits) {
    push('VIBE_HARNESS_PLAN_UNITS_INVALID', 'execution block must declare a "units" array');
    return { problems, units: [], warnings };
  }
  const allowedScope = Array.isArray(block?.allowedScope) ? block.allowedScope : [];
  const protectedAssets = Array.isArray(block?.protectedAssets) ? block.protectedAssets : [];
  if (allowedScope.length === 0) {
    push('VIBE_HARNESS_PLAN_UNITS_INVALID', 'execution block must declare a non-empty "allowedScope"');
  }
  const units = [];
  const seen = new Set();
  for (const raw of rawUnits) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (id === '') {
      push('VIBE_HARNESS_PLAN_UNITS_INVALID', 'every execution unit needs a non-empty "id"');
      continue;
    }
    if (seen.has(id)) {
      push('VIBE_HARNESS_PLAN_UNITS_INVALID', `duplicate execution unit id ${id}`);
      continue;
    }
    seen.add(id);
    const asStrings = (value) => (Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter((entry) => entry !== '') : []);
    units.push({
      acceptance: asStrings(raw?.acceptance).map((entry) => entry.toUpperCase()),
      dependsOn: asStrings(raw?.dependsOn),
      files: asStrings(raw?.files),
      id,
      ...(block?.executionBatch ? { kind: raw?.kind ?? 'write' } : {}),
      ...(block?.executionBatch && raw?.deliveredCommit ? { deliveredCommit: raw.deliveredCommit } : {}),
      // A unit may touch a protected asset only when it repeats that exact
      // asset here, which turns "this step is allowed to write evals/" into a
      // reviewable line instead of an implicit exception.
      protectedGrants: asStrings(raw?.protectedAssets),
    });
  }
  for (const unit of units) {
    if (unit.files.length === 0 && !['read', 'aggregate'].includes(unit.kind)) {
      push('VIBE_HARNESS_PLAN_UNITS_INVALID', `execution unit ${unit.id} must declare at least one file or directory`);
    }
    if (unit.acceptance.length === 0) {
      push('VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND', `execution unit ${unit.id} claims no acceptance id`);
    }
    for (const entry of unit.files) {
      if (allowedScope.length > 0 && !allowedScope.some((pattern) => scopeMatches(pattern, entry))) {
        push('VIBE_HARNESS_PLAN_SCOPE_VIOLATION', `execution unit ${unit.id} writes ${entry}, outside the declared allowedScope`);
      }
      const protectedHit = protectedAssets.find((asset) => scopeIntersects(asset, entry));
      if (protectedHit && !unit.protectedGrants.some((grant) => scopeIntersects(grant, protectedHit))) {
        push('VIBE_HARNESS_PLAN_PROTECTED_ASSET', `execution unit ${unit.id} writes protected asset ${entry} (${protectedHit})`);
      }
    }
    for (const dependency of unit.dependsOn) {
      if (dependency === unit.id) push('VIBE_HARNESS_PLAN_DEPENDENCY_INVALID', `execution unit ${unit.id} depends on itself`);
      else if (!seen.has(dependency) && !block?.executionBatch?.externalDependencies?.some((node) => node.id === dependency)) push('VIBE_HARNESS_PLAN_DEPENDENCY_INVALID', `execution unit ${unit.id} depends on unknown unit ${dependency}`);
    }
    for (const id of unit.acceptance) {
      if (!acceptanceIds.has(id)) {
        push('VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND', `execution unit ${unit.id} references acceptance ${id}, which is missing from the acceptance table`);
      }
    }
  }
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set();
  const settled = new Set();
  const visit = (id, trail) => {
    if (settled.has(id) || !byId.has(id)) return;
    if (visiting.has(id)) {
      push('VIBE_HARNESS_PLAN_DEPENDENCY_INVALID', `dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    settled.add(id);
  };
  for (const unit of units) visit(unit.id, []);
  const claimed = new Set(units.flatMap((unit) => unit.acceptance));
  for (const id of acceptanceIds) {
    if (!claimed.has(id)) {
      warnings.push({ code: 'VIBE_HARNESS_PLAN_ACCEPTANCE_UNCLAIMED', message: `acceptance ${id} is not claimed by any execution unit` });
    }
  }
  return { problems, units, warnings };
}
function planExecutionUnits(content) {
  const match = PLAN_UNIT_BLOCK_PATTERN.exec(content);
  if (!match) {
    return {
      present: false,
      problems: [],
      units: [],
      warnings: [{ code: 'VIBE_HARNESS_PLAN_UNITS_MISSING', message: 'plan has no "plan-units" execution block; unit scope, order and acceptance binding cannot be checked' }],
    };
  }
  let block;
  try {
    block = JSON.parse(match[1]);
  } catch (error) {
    return {
      present: true,
      problems: [{ code: 'VIBE_HARNESS_PLAN_UNITS_INVALID', message: `execution block is not valid JSON: ${error.message}` }],
      units: [],
      warnings: [],
    };
  }
  const validated = planUnitProblems(block, planAcceptanceIds(content));
  const batch = parentBatchContract(block.executionBatch, validated.units);
  return { present: true, problems: [...validated.problems, ...batch.errors.map((message) => ({ code: 'VIBE_HARNESS_PARENT_BATCH_INVALID', message }))],
    units: validated.units, warnings: validated.warnings, executionBatch: batch.batch, batchPresent: block.executionBatch !== undefined };
}
/** The unit graph of the plan's execution block, derived from a plan-check summary. */
export function planUnitGraph(planCheck) {
  const dependencies = planCheck?.units?.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return [];
  return [...Object.entries(dependencies).map(([id, dependsOn]) => ({
    dependsOn: Array.isArray(dependsOn) ? dependsOn.map((entry) => String(entry)) : [],
    id,
  })), ...(planCheck.executionBatch?.externalDependencies ?? [])];
}
/**
 * Direct and transitive predecessors of one plan unit, classified by the
 * anchor's unit status. `failed` and `blocked` are the states that stop a
 * dispatch; every other unfinished status only means "not yet proven done".
 * A predecessor the plan never declared stays `pending` instead of being
 * treated as satisfied.
 * @param {any[]} planUnits
 * @param {any[]} anchorUnits
 * @param {string} unitId
 * @param {(unit: any) => boolean} isVerified
 */
function unitPredecessorState(planUnits, anchorUnits, unitId, isVerified = () => false) {
  const byId = new Map(planUnits.map((unit) => [unit.id, unit]));
  const unitsById = new Map(anchorUnits.map((unit) => [unit.id, unit]));
  const failed = [];
  const blocked = [];
  const unfinished = [];
  const checked = [];
  const seen = new Set();
  const queue = [...(byId.get(unitId)?.dependsOn ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    checked.push(id);
    const predecessor = unitsById.get(id);
    const status = typeof predecessor?.status === 'string' ? predecessor.status : 'pending';
    if (status === 'failed') failed.push({ id, status });
    else if (status === 'blocked') blocked.push({ id, status });
    else if (status !== 'done') unfinished.push({ id, status });
    else if (!isVerified(predecessor)) unfinished.push({ id, status: 'unverified' });
    queue.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return { blocked, checked, failed, unfinished };
}
/** Declared dependents of the given units, so a blocked plan names its nodes. */
export function planDependentUnits(planUnits, unitIds) {
  const waiting = new Set(unitIds);
  return planUnits
    .filter((unit) => unit.dependsOn.some((dependency) => waiting.has(dependency)))
    .map((unit) => unit.id)
    .sort();
}
async function taskPlanCheckCore(projectDir, taskId) {
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('plan-check', error.message, error.code);
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) return taskFailure('plan-check', `no anchor for task ${taskId}: run "task init ${taskId}" first`, 'VIBE_HARNESS_TASK_ANCHOR_MISSING');
  const anchor = read.anchor;
  if (typeof anchor.planFile !== 'string' || anchor.planFile.trim() === '') {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'plan-check',
      taskId,
      status: 'passed',
      managed: false,
      plan: null,
    };
  }
  let plan;
  try {
    plan = await readManagedPlan(projectDir, anchor.planFile);
  } catch (error) {
    return taskFailure('plan-check', error.message, error.code);
  }
  if (plan.missing.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'plan-check',
      taskId,
      status: 'failed',
      code: 'VIBE_HARNESS_PLAN_INVALID',
      error: `plan is missing required sections: ${plan.missing.join(', ')}`,
      plan: { path: plan.path, revision: plan.revision, digest: plan.digest, missing: plan.missing },
    };
  }
  if (anchor.planDigest !== plan.digest) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'plan-check',
      taskId,
      status: 'failed',
      code: 'VIBE_HARNESS_PLAN_DRIFT',
      error: `plan ${plan.path} changed since it was bound; record the reason and run task plan-sync before continuing`,
      plan: { path: plan.path, revision: plan.revision, digest: plan.digest, previousDigest: anchor.planDigest ?? null, missing: [] },
    };
  }
  const units = planExecutionUnits(plan.content);
  if (units.executionBatch && (units.executionBatch.parentId !== taskId
    || !sameParentBatch(anchor.executionBatch, units.executionBatch))
    || anchor.executionBatch && !units.executionBatch) {
    units.problems.push({ code: 'VIBE_HARNESS_PARENT_BATCH_DRIFT', message: 'Parent batch membership or identity changed; confirm the scope then run task plan-sync' });
  }
  const linearPlan = parseLinearPlanBlock(plan.content);
  const linearPlanProblems = linearPlan.errors.map((message) => ({
    code: message.startsWith('VIBE_HARNESS_LINEAR_PLAN_INVALID')
      ? 'VIBE_HARNESS_LINEAR_PLAN_INVALID'
      : 'VIBE_HARNESS_LINEAR_PLAN_CONTRACT_INVALID',
    message,
  }));
  if (!linearPlan.present && /墙钟与 Agent 编排/u.test(plan.content)) {
    linearPlanProblems.push({
      code: 'VIBE_HARNESS_LINEAR_PLAN_MISSING',
      message: 'plan declares wall-clock orchestration but has no linear-plan JSON block',
    });
  }
  const unitSummary = {
    present: units.present,
    count: units.units.length,
    ids: units.units.map((unit) => unit.id),
    // The dependency graph is what makes "a failed unit blocks its dependents"
    // checkable by a reader who never saw the session that wrote the plan.
    dependencies: Object.fromEntries(units.units.map((unit) => [unit.id, unit.dependsOn])),
    warnings: units.warnings,
  };
  // An execution block that contradicts itself is worse than no block: a fresh
  // reader cannot tell which boundary wins, so the plan stops the dispatch.
  if (units.problems.length > 0 || linearPlanProblems.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'plan-check',
      taskId,
      status: 'failed',
      code: units.problems.length > 0 ? 'VIBE_HARNESS_PLAN_UNITS_INVALID' : 'VIBE_HARNESS_LINEAR_PLAN_CONTRACT_INVALID',
      error: [...units.problems, ...linearPlanProblems].map((item) => `${item.code}: ${item.message}`).join('; '),
      problems: [...units.problems, ...linearPlanProblems],
      units: unitSummary,
      linearPlan: {
        present: linearPlan.present,
        warnings: linearPlan.warnings,
      },
      plan: { path: plan.path, revision: plan.revision, digest: plan.digest, missing: [] },
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'plan-check',
    taskId,
    status: 'passed',
    managed: true,
    ...(units.executionBatch ? { executionBatch: units.executionBatch } : {}),
    units: unitSummary,
    linearPlan: {
      present: linearPlan.present,
      warnings: linearPlan.warnings,
    },
    plan: { path: plan.path, revision: plan.revision, digest: plan.digest, missing: [] },
  };
}

function emptyAcceptanceCoverage(unitId, complete, planOnly) {
  return {
    mode: 'advisory',
    phase: planOnly ? 'plan' : complete ? 'completion' : 'task',
    scope: { kind: unitId ? 'unit' : 'task', unitId },
    availability: 'unavailable',
    mappingStatus: 'unknown',
    evidenceStatus: complete ? 'unavailable' : 'not_checked',
    semanticCoverage: 'not_evaluated',
    items: [],
    gaps: [],
  };
}

function acceptanceGap(report, code, message, fields = {}) {
  report.gaps.push({ severity: 'warning', code, message, ...fields });
}

function acceptanceMappingItems(plan, selected, ids, report) {
  for (const id of ids) {
    // The table's third column is command/action, not a new executable input.
    const row = plan.content.split(/\r?\n/u).find((line) =>
      line.trim().startsWith('|') && line.split('|')[1]?.trim().toUpperCase() === id);
    const action = row?.split('|')[3]?.trim().replace(/^`|`$/gu, '') ?? '';
    const commandCriterion = /^(?:node|pnpm|npm|yarn|bun|deno|python3?|pytest|go|cargo|dotnet|mvn|gradle|make|bash|sh|pwsh)(?:\s|$)/u.test(action);
    const unitIds = selected.filter((unit) => unit.acceptance.includes(id)).map((unit) => unit.id);
    report.items.push({ acceptanceId: id, unitIds,
      criterionKind: commandCriterion ? 'command' : 'manual-or-unknown', evidence: [] });
    if (!unitIds.length) acceptanceGap(report, 'ACCEPTANCE_UNCLAIMED',
      'acceptance is not claimed by a declared unit', { acceptanceId: id });
    if (!commandCriterion) acceptanceGap(report, 'ACCEPTANCE_MANUAL_OR_UNKNOWN',
      'criterion cannot be mechanically verified', { acceptanceId: id });
  }
}

function acceptanceUnitEvidence(report, anchor, { taskId, plan, complete, current, config, projectDir }) {
  const anchorUnits = new Map((anchor.units ?? []).map((unit) => [unit.id, unit]));
  for (const item of report.items) for (const unitId of item.unitIds) {
    const actual = anchorUnits.get(unitId);
    const fields = { acceptanceId: item.acceptanceId, unitId };
    if (!actual) acceptanceGap(report, 'ACCEPTANCE_UNIT_MISSING', 'declared unit is absent from the task anchor', fields);
    if (!complete) continue;
    const verification = actual?.verification;
    const valid = Boolean(actual && actual.status === 'done'
      && currentUnitVerification(actual, current.fingerprint, config, projectDir)
      && typeof verification.id === 'string' && verification.id.length > 0
      && Number.isFinite(Date.parse(verification.finishedAt ?? verification.at))
      && (!verification.taskId || verification.taskId === taskId)
      && (!verification.planDigest || verification.planDigest === plan.digest));
    item.evidence.push({
      unitId, verificationId: verification?.id ?? null,
      checkIds: typeof verification?.command === 'string'
        ? verification.command.split('\n').filter(Boolean).map((line) => line.split('=')[0]) : [],
      finishedAt: verification?.finishedAt ?? verification?.at ?? null,
      status: valid ? 'linked' : 'missing-or-stale',
    });
    if (!valid) acceptanceGap(report, 'ACCEPTANCE_EVIDENCE_MISSING_OR_STALE', 'unit has no current completion evidence', fields);
  }
}

function summarizeAcceptanceCoverage(report, complete) {
  const codes = new Set(report.gaps.map((gap) => gap.code));
  const unknownCriteria = codes.has('ACCEPTANCE_MANUAL_OR_UNKNOWN');
  const mappingGaps = codes.has('ACCEPTANCE_UNCLAIMED') || codes.has('ACCEPTANCE_UNIT_MISSING');
  const evidenceGaps = codes.has('ACCEPTANCE_EVIDENCE_MISSING_OR_STALE');
  report.availability = unknownCriteria
    ? report.items.every((item) => item.criterionKind === 'manual-or-unknown') ? 'unavailable' : 'partial'
    : 'available';
  report.mappingStatus = mappingGaps ? 'gaps' : 'complete';
  if (complete) report.evidenceStatus = evidenceGaps || mappingGaps ? 'gaps' : unknownCriteria ? 'unavailable' : 'linked';
  return report;
}

// Advisory projection only: never participates in status, dispatch, receipt
// validation, or exit-code decisions. Legacy/unparseable input stays unknown.
async function acceptanceCoverageReport(projectDir, taskId, { unitId = null, complete = false, planOnly = false } = {}) {
  const report = emptyAcceptanceCoverage(unitId, complete, planOnly);
  const unavailable = (message) => {
    acceptanceGap(report, 'ACCEPTANCE_COVERAGE_UNAVAILABLE', message);
    return report;
  };
  try {
    const read = await readTaskAnchor(projectDir, taskId);
    if (!read.exists || !read.anchor.planFile) {
      return unavailable('no managed plan; requirements cannot be mechanically checked');
    }
    const plan = await readManagedPlan(projectDir, read.anchor.planFile);
    const parsed = planExecutionUnits(plan.content);
    if (plan.digest !== read.anchor.planDigest || plan.missing.length || !parsed.present || parsed.problems.length) {
      return unavailable('plan is stale, invalid, or has no execution block');
    }
    const ids = [...planAcceptanceIds(plan.content)];
    if (!ids.length) {
      return unavailable('no parseable acceptance IDs; manual criteria require human evidence');
    }
    const selected = unitId ? parsed.units.filter((unit) => unit.id === unitId) : parsed.units;
    if (unitId && !selected.length) {
      return unavailable('requested unit is not declared by the plan');
    }
    const targetIds = unitId ? ids.filter((id) => selected.some((unit) => unit.acceptance.includes(id))) : ids;
    acceptanceMappingItems(plan, selected, targetIds, report);
    if (!planOnly) {
      acceptanceUnitEvidence(report, read.anchor, {
        taskId, plan, complete, projectDir,
        current: complete ? await gitFingerprint(projectDir) : null,
        config: complete ? configuredChecks(await readProjectConfig(projectDir), projectDir) : null,
      });
    }
    return summarizeAcceptanceCoverage(report, complete);
  } catch {
    // Optional diagnostics must not turn a legacy success into a new failure.
    // Do not echo arbitrary file content or exception messages into warnings.
    unavailable('coverage inputs could not be read or resolved');
    return { ...report, availability: 'unavailable', mappingStatus: 'unknown',
      evidenceStatus: complete ? 'unavailable' : 'not_checked' };
  }
}

function withAcceptanceCoverage(report, acceptanceCoverage) {
  return { ...report, acceptanceCoverage,
    warnings: [...(report.warnings ?? []).filter((item) => !String(item.code).startsWith('ACCEPTANCE_')),
      ...acceptanceCoverage.gaps] };
}

export async function taskPlanCheckReport(projectDir, taskId) {
  const report = await taskPlanCheckCore(projectDir, taskId);
  return withAcceptanceCoverage(report, await acceptanceCoverageReport(projectDir, taskId, { planOnly: true }));
}
export async function readTaskAnchor(projectDir, taskId) {
  validateTaskId(taskId);
  const filePath = taskAnchorPath(projectDir, taskId);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, anchor: null, filePath };
    throw Object.assign(
      new Error(`cannot read ${taskAnchorRelativePath(taskId)}: ${error.code ?? error.message}`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_UNREADABLE' },
    );
  }
  let anchor;
  try {
    anchor = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(
      new Error(`${taskAnchorRelativePath(taskId)} is not valid JSON: ${error.message}`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_INVALID' },
    );
  }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
    || typeof anchor.taskId !== 'string' || anchor.taskId !== taskId
    || ![1, TASK_SCHEMA_VERSION].includes(anchor.schemaVersion)
    || typeof anchor.title !== 'string' || anchor.title.trim() === ''
    || typeof anchor.goal !== 'string' || anchor.goal.trim() === ''
    || !TASK_STAGES.includes(anchor.stage) || !TASK_RISK_LEVELS.includes(anchor.riskLevel)
    || !['acceptance', 'units', 'decisions', 'blockers', 'failures', 'sessions'].every((field) => Array.isArray(anchor[field]))
    || !(anchor.nextAction === null || typeof anchor.nextAction === 'string')) {
    throw Object.assign(
      new Error(`${taskAnchorRelativePath(taskId)} is not a supported, recoverable task anchor (expected taskId ${JSON.stringify(taskId)} and schemaVersion 1 or ${TASK_SCHEMA_VERSION} with required recovery fields)`),
      { code: 'VIBE_HARNESS_TASK_ANCHOR_INVALID' },
    );
  }
  return { exists: true, anchor, filePath };
}
function writeTaskAnchor(filePath, anchor) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
}
// Idempotency probe: updatedAt and sessions grow with every real write, so
// they are excluded when deciding whether an update changed anything.
function anchorSignature(anchor) {
  const clone = { ...(anchor ?? {}) };
  delete clone.updatedAt;
  delete clone.sessions;
  return stableStringify(clone);
}
function taskFailure(subcommand, message, code) {
  return { schemaVersion: SCHEMA_VERSION, command: 'task', subcommand, status: 'failed', ...(code ? { code } : {}), error: message };
}
function upsertTaskUnit(units, unitId) {
  let unit = units.find((item) => item && item.id === unitId);
  if (!unit) {
    unit = { id: unitId, title: unitId, files: [], status: 'pending', verification: null };
    units.push(unit);
  }
  return unit;
}
function parseVerificationReceipt(value, projectDir) {
  let raw = String(value).trim();
  if (!raw.startsWith('{')) {
    const filePath = path.resolve(projectDir, raw);
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw Object.assign(
        new Error(`cannot read verification receipt ${normalizePath(value)}: ${error.code ?? error.message}`),
        { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_UNREADABLE' },
      );
    }
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(
      new Error(`verification receipt is not valid JSON: ${error.message}`),
      { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID' },
    );
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.command !== 'verify' || !receipt.verification || typeof receipt.verification !== 'object') {
    throw Object.assign(
      new Error('verification receipt must be a verify report (JSON output of run.mjs verify)'),
      { code: 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID' },
    );
  }
  return receipt;
}
function parseJsonArgument(value, projectDir, label) {
  let raw = String(value ?? '').trim();
  if (!raw.startsWith('{')) {
    const filePath = path.resolve(projectDir, raw);
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw Object.assign(new Error(`cannot read ${label} ${normalizePath(value)}: ${error.code ?? error.message}`), {
        code: `VIBE_HARNESS_${label.toUpperCase().replaceAll('-', '_')}_UNREADABLE`,
      });
    }
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`${label} is not valid JSON: ${error.message}`), {
      code: `VIBE_HARNESS_${label.toUpperCase().replaceAll('-', '_')}_INVALID`,
    });
  }
}
function projectRelativePath(projectDir, value) {
  const candidate = path.resolve(projectDir, String(value));
  const relative = path.relative(path.resolve(projectDir), candidate).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`path ${String(value)} must stay inside the project`), { code: 'VIBE_HARNESS_TEST_PATH_OUTSIDE_PROJECT' });
  }
  return relative;
}
// A red light only counts as red-test evidence when a test run failed on its
// own assertions. Lint or typecheck complaints, a missing dependency, a syntax
// error, a timeout and a run that executed zero tests all mean the check never
// reached the behaviour under repair, so they cannot freeze an acceptance asset.
const RED_LIGHT_CHECK_NAMES = ['test', 'eval'];
const NON_RED_SIGNATURES = [
  { code: 'VIBE_HARNESS_RED_EVIDENCE_DEPENDENCY', pattern: /(?:Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package|ENOENT)/u, reason: 'a missing dependency or input file' },
  { code: 'VIBE_HARNESS_RED_EVIDENCE_SYNTAX', pattern: /\bSyntaxError\b/u, reason: 'a syntax error' },
  { code: 'VIBE_HARNESS_RED_EVIDENCE_EMPTY', pattern: /(?:^|\n)\s*# tests 0\b|(?:^|\n)\s*Ran 0 tests\b|no test files found|0 passing/u, reason: 'zero executed tests' },
];
/** True when a failing check's command names the frozen asset it produced red. */
function commandCoversPaths(command, paths) {
  const tokens = String(command ?? '').split(/\s+/u).map((token) => token.replace(/^["']|["']$/gu, ''));
  const targets = tokens.filter((token) => token.includes('/') && !token.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(token));
  // A command without any path argument runs the whole suite, so it covers
  // whatever the suite contains; a command that names targets must cover them.
  if (targets.length === 0) return true;
  return paths.every((frozenPath) => targets.some((target) => {
    const escaped = normalizePlanPath(target).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = escaped.replaceAll('\\*\\*', '.*').replaceAll('\\*', '[^/]*');
    return new RegExp(`^(?:${pattern})(?:/.*)?$`, 'u').test(normalizePlanPath(frozenPath));
  }));
}
/**
 * Extract the red evidence a freeze may cite, or refuse the receipt.
 *
 * A freeze is only as good as the red light behind it, so the receipt must be
 * a failed verification whose failure came from a test-bearing check that
 * covered the frozen paths on a stable workspace.
 */
function redEvidenceFromReceipt(receipt, paths) {
  const entries = receipt.checks && typeof receipt.checks === 'object' && !Array.isArray(receipt.checks) ? Object.entries(receipt.checks) : [];
  const failedEntries = entries.filter(([, item]) => item && typeof item === 'object' && item.status === 'failed');
  if (receipt.status !== 'failed' || failedEntries.length === 0) {
    throw Object.assign(new Error('freeze-tests requires a verification receipt with a real failed check'), {
      code: 'VIBE_HARNESS_RED_EVIDENCE_REQUIRED',
    });
  }
  if (receipt.verification?.stable === false) {
    throw Object.assign(new Error('the receipt ran while the workspace changed (stable=false); re-run verify on a settled tree before freezing tests'), {
      code: 'VIBE_HARNESS_RED_EVIDENCE_UNSTABLE',
    });
  }
  const redEntries = failedEntries.filter(([name]) => RED_LIGHT_CHECK_NAMES.includes(name));
  if (redEntries.length === 0) {
    throw Object.assign(new Error(`freeze-tests needs a failed ${RED_LIGHT_CHECK_NAMES.join(' or ')} check; a failure in ${failedEntries.map(([name]) => name).join(', ')} never exercised the defect`), {
      code: 'VIBE_HARNESS_RED_CHECK_NOT_TEST',
    });
  }
  for (const [name, item] of redEntries) {
    if (['TIMEOUT', 'OUTPUT_LIMIT', 'START_FAILED'].includes(item.code)) {
      throw Object.assign(new Error(`${name} ended with ${item.code}; a timeout or an unrunnable check is not a failing assertion`), {
        code: 'VIBE_HARNESS_RED_EVIDENCE_INVALID',
      });
    }
    if (item.exitCode === 0) {
      throw Object.assign(new Error(`${name} reports status failed with exit code 0; the receipt contradicts itself`), {
        code: 'VIBE_HARNESS_RED_EVIDENCE_INVALID',
      });
    }
    const output = `${item.stdout ?? ''}\n${item.stderr ?? ''}`;
    const signature = NON_RED_SIGNATURES.find((candidate) => candidate.pattern.test(output));
    if (signature) {
      throw Object.assign(new Error(`${name} failed on ${signature.reason}, which is not a failing assertion`), {
        code: signature.code,
      });
    }
  }
  const covering = redEntries.filter(([, item]) => commandCoversPaths(item.command, paths));
  if (covering.length === 0) {
    throw Object.assign(new Error(`the failing check (${redEntries.map(([name, item]) => `${name}=${item.command ?? '?'}`).join(', ')}) does not cover the frozen paths (${paths.join(', ')})`), {
      code: 'VIBE_HARNESS_RED_PATH_UNCOVERED',
    });
  }
  return covering.map(([name, item]) => ({
    name,
    command: typeof item.command === 'string' ? item.command : null,
    exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
  }));
}
function freezeEntryFromReceipt(receipt, paths, { taskId = null } = {}) {
  const redChecks = redEvidenceFromReceipt(receipt, paths);
  const verification = receipt.verification ?? {};
  const binding = verification.task && typeof verification.task === 'object' && !Array.isArray(verification.task) ? verification.task : null;
  if (typeof binding?.id === 'string' && taskId !== null && binding.id !== taskId) {
    throw Object.assign(new Error(`the red receipt was produced for task ${binding.id}, not ${taskId}`), {
      code: 'VIBE_HARNESS_RED_EVIDENCE_TASK_MISMATCH',
    });
  }
  return {
    paths: [...new Set(paths)].sort(),
    redEvidence: {
      id: typeof verification.id === 'string' ? verification.id : null,
      finishedAt: typeof verification.finishedAt === 'string' ? verification.finishedAt : null,
      fingerprint: typeof verification.fingerprint === 'string' ? verification.fingerprint : null,
      status: receipt.status,
      taskId: typeof binding?.id === 'string' ? binding.id : null,
      planDigest: typeof binding?.planDigest === 'string' ? binding.planDigest : null,
      checks: redChecks,
    },
    status: 'frozen',
    frozenAt: new Date().toISOString(),
  };
}
function approvedRebaseline(value, projectDir) {
  const approval = parseJsonArgument(value, projectDir, 'approval');
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)
    || approval.status !== 'approved'
    || approval.source !== 'protected-ci'
    || typeof approval.reviewer !== 'string'
    || typeof approval.protectedCheck !== 'string'
    || approval.protectedCheck.trim() === ''
    || approval.trust !== 'verified'
    || process.env.VIBE_HARNESS_PROTECTED_APPROVAL !== '1') {
    throw Object.assign(new Error('approval must be a host-verified protected-ci receipt; local JSON cannot authorize a test rebaseline'), {
      code: 'VIBE_HARNESS_REBASELINE_APPROVAL_INVALID',
    });
  }
  return {
    source: approval.source,
    protectedCheck: approval.protectedCheck,
    reviewer: approval.reviewer,
    status: approval.status,
    trust: 'verified',
  };
}
// A unit's verification.command records the command SET that produced the
// receipt (`name=command` lines in CHECK_ORDER) so `verify --reuse` can compare
// it against the currently configured selection.
function taskVerificationFromReceipt(receipt) {
  const verification = receipt.verification ?? {};
  const binding = verification.task && typeof verification.task === 'object' && !Array.isArray(verification.task) ? verification.task : null;
  const checks = receipt.checks && typeof receipt.checks === 'object' && !Array.isArray(receipt.checks) ? receipt.checks : {};
  const command = Object.keys(checks)
    .filter((name) => checks[name] && typeof checks[name] === 'object' && ['passed', 'reused'].includes(checks[name].status) && typeof checks[name].command === 'string')
    .map((name) => `${name}=${checks[name].command}${checks[name].cwd && checks[name].cwd !== '.' ? ` [cwd=${checks[name].cwd}]` : ''}`)
    .join('\n');
  return {
    command,
    status: receipt.status === 'reused' ? 'passed' : typeof receipt.status === 'string' ? receipt.status : null,
    exitCode: typeof receipt.status === 'string' && PASS_STATUSES.includes(receipt.status) ? 0 : 1,
    fingerprint: typeof verification.fingerprint === 'string' ? verification.fingerprint : null,
    at: typeof verification.finishedAt === 'string' ? verification.finishedAt : null,
    ...(typeof verification.id === 'string' ? { id: verification.id } : {}),
    ...(typeof verification.finishedAt === 'string' ? { finishedAt: verification.finishedAt } : {}),
    ...(typeof verification.before?.head === 'string' ? { beforeHead: verification.before.head } : {}),
    ...(typeof verification.after?.head === 'string' ? { afterHead: verification.after.head } : {}),
    // The receipt's own task/plan association travels with it, so a reader can
    // tell which task and plan revision the claim was verified against.
    ...(typeof binding?.id === 'string' ? { taskId: binding.id } : {}),
    ...(typeof binding?.planRevision === 'string' ? { planRevision: binding.planRevision } : {}),
    ...(typeof binding?.planDigest === 'string' ? { planDigest: binding.planDigest } : {}),
  };
}
export function verificationCommandSet(commands, selectedNames, projectDir, definitions = {}) {
  return selectedNames
    .filter((name) => typeof commands[name] === 'string')
    .map((name) => `${name}=${displayCommand(commands[name], projectDir)}${definitions[name]?.cwd && definitions[name].cwd !== '.' ? ` [cwd=${definitions[name].cwd}]` : ''}`)
    .join('\n');
}
function currentUnitVerification(unit, fingerprint, configured, projectDir) {
  if (unit?.verification?.status !== 'passed' || !fingerprint || unit.verification.fingerprint !== fingerprint || configured.error) return false;
  const commandLines = unit.verification.command?.split('\n').filter(Boolean) ?? [];
  const names = commandLines.map((line) => line.slice(0, line.indexOf('=')));
  return commandLines.length > 0 && names.every((name) => Object.hasOwn(configured.commands, name))
    && unit.verification.command === verificationCommandSet(configured.commands, names, projectDir, configured.definitions);
}
export async function findReusableVerification(projectDir, taskId, { fingerprint, commandSet }) {
  if (typeof fingerprint !== 'string') return null;
  const taskIds = [];
  // The optional task id is a preference, not a gate: same-tree reuse is
  // keyed by the content fingerprint and command set. Prefer the requested
  // anchor when it exists, then fall back to every readable anchor so a typo,
  // stale id, or anchor-less default invocation does not force another run.
  if (taskId) taskIds.push(taskId);
  let entries = [];
  try {
    entries = await readdir(path.join(projectDir, TASKS_RELATIVE_DIR), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const candidate = entry.name.slice(0, -'.json'.length);
    // Files this CLI could not have written are not anchors; skip them
    // instead of failing an otherwise verifiable tree.
    if (!TASK_ID_PATTERN.test(candidate) || WINDOWS_RESERVED_NAMES.test(candidate)) continue;
    if (!taskIds.includes(candidate)) taskIds.push(candidate);
  }
  let best = null;
  for (const id of taskIds) {
    const read = await readTaskAnchor(projectDir, id);
    if (!read.exists) continue;
    const units = Array.isArray(read.anchor.units) ? read.anchor.units : [];
    for (const unit of units) {
      const verification = unit && typeof unit === 'object' && unit.verification && typeof unit.verification === 'object' ? unit.verification : null;
      if (!verification || verification.status !== 'passed' || verification.fingerprint !== fingerprint) continue;
      if (typeof verification.command !== 'string' || verification.command !== commandSet) continue;
      const at = typeof verification.at === 'string' ? verification.at : '';
      if (!best || at > best.at) best = { taskId: id, unitId: unit.id, verification, at };
    }
  }
  return best;
}
async function taskInitReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('init', 'task init needs a task id: task init <task-id> --title <t> --goal <g>');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('init', error.message, error.code);
  }
  if (args.title === undefined || args.title.trim() === '') return taskFailure('init', 'task init needs --title <text>');
  if (args.goal === undefined || args.goal.trim() === '') return taskFailure('init', 'task init needs --goal <text>');
  const riskLevel = args.riskLevel ?? DEFAULT_TASK_RISK_LEVEL;
  if (!TASK_RISK_LEVELS.includes(riskLevel)) {
    return taskFailure('init', `--risk-level must be one of ${TASK_RISK_LEVELS.join(', ')}`);
  }
  let plan = null;
  if (args.planFile !== undefined) {
    try {
      plan = await readManagedPlan(projectDir, args.planFile);
    } catch (error) {
      return taskFailure('init', error.message, error.code);
    }
    if (plan.missing.length > 0) {
      return taskFailure('init', `plan is missing required sections: ${plan.missing.join(', ')}`, 'VIBE_HARNESS_PLAN_INVALID');
    }
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (read.exists) {
    return taskFailure('init', `anchor for task ${taskId} already exists at ${taskAnchorRelativePath(taskId)}; use "task update ${taskId}" to change it`);
  }
  const now = new Date().toISOString();
  const execution = plan ? planExecutionUnits(plan.content) : null;
  if (execution?.batchPresent && (execution.executionBatch?.parentId !== taskId
    || execution.problems.length)) return taskFailure('init', 'invalid Parent batch or plan execution units', 'VIBE_HARNESS_PARENT_BATCH_INVALID');
  const anchor = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId,
    title: args.title,
    stage: INITIAL_TASK_STAGE,
    riskLevel,
    goal: args.goal,
    acceptance: args.acceptance.filter((item) => item.trim() !== ''),
    ...(plan ? {
      planFile: plan.path,
      planDigest: plan.digest,
      planRevision: plan.revision,
    } : {}),
    units: execution?.executionBatch ? execution.units.map((unit) => ({ ...unit, status: 'pending', verification: null })) : [],
    ...(execution?.executionBatch ? { executionBatch: execution.executionBatch } : {}),
    decisions: [],
    blockers: [],
    failures: [],
    nextAction: null,
    sessions: [{ at: now, action: 'init' }],
    updatedAt: now,
  };
  if (args.write) writeTaskAnchor(read.filePath, anchor);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'init',
    taskId,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    write: Boolean(args.write),
    written: Boolean(args.write),
    path: taskAnchorRelativePath(taskId),
    anchor,
  };
}
async function taskPlanSyncReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) return taskFailure('plan-sync', 'task plan-sync needs a task id: task plan-sync <task-id> --reason <text>');
  if (typeof args.reason !== 'string' || args.reason.trim() === '') return taskFailure('plan-sync', '--reason is required for task plan-sync');
  let read;
  try {
    read = await readTaskAnchor(projectDir, taskId);
  } catch (error) {
    return taskFailure('plan-sync', error.message, error.code);
  }
  if (!read.exists) return taskFailure('plan-sync', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  if (typeof read.anchor.planFile !== 'string') return taskFailure('plan-sync', `task ${taskId} has no bound plan file`, 'VIBE_HARNESS_PLAN_NOT_BOUND');
  let plan;
  try {
    plan = await readManagedPlan(projectDir, read.anchor.planFile);
  } catch (error) {
    return taskFailure('plan-sync', error.message, error.code);
  }
  if (plan.missing.length > 0) return taskFailure('plan-sync', `plan is missing required sections: ${plan.missing.join(', ')}`, 'VIBE_HARNESS_PLAN_INVALID');
  const changed = read.anchor.planDigest !== plan.digest;
  const execution = planExecutionUnits(plan.content);
  if (execution.batchPresent && (execution.problems.length || execution.executionBatch?.parentId !== taskId)) {
    return taskFailure('plan-sync', 'invalid Parent batch or execution units', 'VIBE_HARNESS_PARENT_BATCH_INVALID');
  }
  if (!read.anchor.executionBatch && execution.executionBatch && read.anchor.units.length
    || read.anchor.executionBatch && !execution.executionBatch) {
    return taskFailure('plan-sync', 'running independent and Parent batch plans cannot be migrated automatically', 'VIBE_HARNESS_PARENT_BATCH_MIGRATION');
  }
  const next = {
    ...read.anchor,
    planDigest: plan.digest,
    planRevision: plan.revision,
    decisions: [...(Array.isArray(read.anchor.decisions) ? read.anchor.decisions : []), `plan-sync: ${args.reason.trim()}`],
    ...(execution.executionBatch ? {
      executionBatch: execution.executionBatch,
      units: execution.units.map((unit) => ({ ...read.anchor.units.find((item) => item.id === unit.id), ...unit,
        status: read.anchor.units.find((item) => item.id === unit.id)?.status ?? 'pending' })),
    } : {}),
  };
  if (changed && args.write) {
    const now = new Date().toISOString();
    writeTaskAnchor(read.filePath, {
      ...next,
      updatedAt: now,
      sessions: [...(Array.isArray(read.anchor.sessions) ? read.anchor.sessions : []), { at: now, action: 'plan-sync' }],
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'plan-sync',
    taskId,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    changed,
    write: Boolean(args.write),
    written: changed && Boolean(args.write),
    plan: { path: plan.path, revision: plan.revision, digest: plan.digest },
    reason: args.reason.trim(),
  };
}
/** Shared verifier for task gates, stage/publish preflight and Task DAG CLI. */
export async function taskParentBatchEvidence(projectDir, taskId) {
  const plan = await taskPlanCheckReport(projectDir, taskId);
  const read = await readTaskAnchor(projectDir, taskId);
  const batch = read.anchor?.executionBatch;
  if (plan.status !== 'passed' || !batch) return { ok: false, reason: plan.code ?? 'no-parent-batch', localCompleted: [] };
  const workspace = await parentBatchWorkspace(projectDir, batch);
  const configured = configuredChecks(await readProjectConfig(projectDir), projectDir);
  const completed = await Promise.all(read.anchor.units.map(async (unit) =>
    await localCompletionValid(projectDir, read.anchor, unit, configured) ? unit.id : null));
  const external = batch.externalDependencies.filter((node) => node.result !== 'succeeded');
  const commits = await runGit(['rev-list', '--no-merges', `${batch.baseSha}..HEAD`], projectDir);
  const mapped = new Set(read.anchor.units.filter((unit) => unit.kind === 'write').flatMap((unit) => unit.localCompletion?.commits ?? []));
  const unmappedCommits = commits.ok ? commits.stdout.trim().split(/\r?\n/u).filter((sha) => sha && !mapped.has(sha)) : ['unknown'];
  return { ...batch, ok: workspace.ok && read.anchor.blockers.length === 0,
    reason: !workspace.ok ? workspace.reason : read.anchor.blockers.length ? 'batch-blockers' : null,
    localCompleted: completed.filter(Boolean), head: workspace.head ?? null,
    dependencies: plan.units.dependencies,
    unmappedCommits,
    externalPending: external.map((node) => node.id),
    units: read.anchor.units.map(({ id, kind, files, status }) => ({ id, kind, files, status })),
  };
}
async function taskCheckReport(projectDir, args) {
  const report = await taskCheckCore(projectDir, args);
  return withAcceptanceCoverage(report, await acceptanceCoverageReport(projectDir, args._[2], {
    unitId: args.unit ?? null, complete: Boolean(args.complete),
  }));
}
async function taskCheckCore(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) return taskFailure('check', 'task check needs a task id: task check <task-id> [--unit <unit-id>] [--dispatch] [--complete]');
  const planCheck = await taskPlanCheckReport(projectDir, taskId);
  if (planCheck.status !== 'passed') return { ...planCheck, subcommand: 'check' };
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) return taskFailure('check', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  const units = Array.isArray(read.anchor.units) ? read.anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
  const selected = args.unit ? units.find((unit) => unit.id === args.unit) : null;
  if (args.unit && !selected) return taskFailure('check', `unit ${args.unit} is not present in task ${taskId}`, 'VIBE_HARNESS_TASK_UNIT_MISSING');
  // The plan's execution block is the boundary a fresh reader trusts: a unit it
  // never declared must not be checkable as if it were part of this plan.
  const declaredUnits = Array.isArray(planCheck.units?.ids) ? planCheck.units.ids : [];
  if (args.unit && declaredUnits.length > 0 && !declaredUnits.includes(args.unit)) {
    return taskFailure('check', `unit ${args.unit} is not declared in the plan execution block`, 'VIBE_HARNESS_PLAN_UNIT_UNDECLARED');
  }
  // A failed (or blocked) predecessor stops the dispatch of everything that
  // depends on it: continuing would build on an unverified result. The check is
  // the pre-dispatch gate, so it answers before the work is handed out.
  const planUnits = planUnitGraph(planCheck);
  // Completion evidence is different from the retired Receipt/Claim workflow
  // gate: a unit marked done still has to be backed by a passing verification
  // for the current tree and command set. Only evaluate it for questions that
  // depend on completion so plain status reads stay inexpensive.
  const needsEvidence = Boolean(args.dispatch || args.complete);
  const currentFingerprint = needsEvidence ? (await gitFingerprint(projectDir)).fingerprint : null;
  const configured = needsEvidence ? configuredChecks(await readProjectConfig(projectDir), projectDir) : null;
  const isVerified = (unit) => currentUnitVerification(unit, currentFingerprint, configured, projectDir);
  const batchEvidence = read.anchor.executionBatch ? await taskParentBatchEvidence(projectDir, taskId) : null;
  const effectiveUnits = batchEvidence ? [...units, ...batchEvidence.externalDependencies?.map((node) => ({
    id: node.id, status: node.result === 'succeeded' ? 'done' : node.result,
  })) ?? []] : units;
  const batchVerified = (unit) => batchEvidence?.externalDependencies?.some((node) => node.id === unit.id && node.result === 'succeeded')
    || batchPredecessorSatisfied(batchEvidence, selected?.id, unit.id);
  const predecessors = selected && planUnits.length > 0
    ? unitPredecessorState(planUnits, effectiveUnits, selected.id, batchEvidence ? batchVerified : isVerified)
    : { blocked: [], checked: [], failed: [], unfinished: [] };
  const stopped = [...predecessors.failed, ...predecessors.blocked];
  const describeUnits = (items) => items.map((item) => `${item.id}=${item.status}`).join(', ');
  // `--dispatch` is the pre-dispatch question: may this unit be handed out
  // now? It answers with the predecessor state instead of the unit's own
  // completion, so a parent agent can gate a write dispatch mechanically.
  if (args.dispatch) {
    if (!args.unit) return taskFailure('check', '--dispatch requires --unit <unitId>', 'VIBE_HARNESS_TASK_UNIT_MISSING');
    if (batchEvidence && !batchEvidence.ok) return { ...taskFailure('check', batchEvidence.reason, 'VIBE_HARNESS_PARENT_BATCH_NOT_READY'), batchEvidence };
    let conflicts = [];
    if (typeof planCheck.plan?.path === 'string') {
      const plan = await readManagedPlan(projectDir, planCheck.plan.path);
      const declared = planExecutionUnits(plan.content).units;
      const target = declared.find((unit) => unit.id === selected.id);
      if (target) {
        conflicts = declared.filter((unit) => unit.id !== target.id
          && units.some((active) => active.id === unit.id && active.status === 'in_progress')
          && (batchEvidence || unit.files.some((file) => target.files.some((other) => scopeIntersects(file, other)))))
          .map((unit) => unit.id);
      }
    }
    const unmet = [...stopped, ...predecessors.unfinished];
    if (batchEvidence && !unmet.length && !conflicts.length) {
      const candidates = units.filter((unit) => ['pending', 'in_progress'].includes(unit.status))
        .filter((unit) => {
          const state = unitPredecessorState(planUnits, effectiveUnits, unit.id,
            (predecessor) => batchEvidence.externalDependencies.some((node) => node.id === predecessor.id && node.result === 'succeeded')
              || batchPredecessorSatisfied(batchEvidence, unit.id, predecessor.id));
          return !state.failed.length && !state.blocked.length && !state.unfinished.length;
        }).map((unit) => unit.id).sort();
      if (selected.status !== 'in_progress' && candidates[0] !== selected.id) {
        return taskFailure('check', `Parent batch executes one member at a time in stable order; next: ${candidates[0] ?? 'none'}`,
          'VIBE_HARNESS_PARENT_BATCH_SINGLE_WRITER');
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'check',
      taskId,
      status: unmet.length > 0 || conflicts.length > 0 ? 'failed' : 'passed',
      ...(unmet.length > 0 || conflicts.length > 0 ? {
        code: stopped.length > 0 ? 'VIBE_HARNESS_UNIT_PREDECESSOR_FAILED' : unmet.length > 0 ? 'VIBE_HARNESS_UNIT_PREDECESSOR_UNMET' : 'VIBE_HARNESS_UNIT_SCOPE_CONFLICT',
        error: `unit ${selected?.id ?? args.unit} is not ready to dispatch: ${stopped.length > 0 ? describeUnits(stopped) : unmet.length > 0 ? describeUnits(predecessors.unfinished) : `overlapping in-progress units: ${conflicts.join(', ')}`}`,
      } : {}),
      dispatch: true,
      readinessScope: 'current predecessors and declared file overlap; resource locks not evaluated',
      conflicts,
      unit: args.unit,
      predecessors,
      plan: planCheck.plan ?? null,
    };
  }
  if (stopped.length > 0) {
    const waiting = planDependentUnits(planUnits, stopped.map((item) => item.id));
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand: 'check',
      taskId,
      status: 'failed',
      code: 'VIBE_HARNESS_UNIT_PREDECESSOR_FAILED',
      error: `unit ${selected.id} depends on ${describeUnits(stopped)}; repair and re-verify the predecessor before dispatching${waiting.length > 0 ? ` (waiting: ${waiting.join(', ')})` : ''}`,
      complete: Boolean(args.complete),
      unit: args.unit ?? null,
      unfinished: [],
      unverified: [],
      blockers: [],
      predecessors,
      plan: planCheck.plan ?? null,
    };
  }
  const targetUnits = selected ? [selected] : units;
  const unfinished = targetUnits.filter((unit) => unit.status !== 'done').map((unit) => unit.id ?? '?');
  const failedUnits = targetUnits.filter((unit) => unit.status === 'failed').map((unit) => unit.id ?? '?');
  const unverified = targetUnits
    .filter((unit) => {
      if (unit.status !== 'done') return false;
      return args.complete ? !isVerified(unit) : unit.verification?.status !== 'passed';
    })
    .map((unit) => unit.id ?? '?');
  const complete = Boolean(args.complete);
  if (complete && batchEvidence) {
    const publication = batchEvidence.ok && !batchEvidence.unmappedCommits.length && !batchEvidence.externalPending.length
      && batchEvidence.members.every((id) => batchEvidence.localCompleted.includes(id))
      ? await parentBatchPublication(projectDir, read.anchor) : null;
    return {
      ...(publication ? { schemaVersion: SCHEMA_VERSION, command: 'task', subcommand: 'check', taskId, status: 'passed' }
        : taskFailure('check', 'Parent local completion is not remote delivery; require stage validation and publish confirmation', 'VIBE_HARNESS_PARENT_BATCH_NOT_PUBLISHED')),
      complete, deliveryStatus: publication ? 'remote_confirmed' : 'not_published', publication, batchEvidence,
    };
  }
  const blockers = Array.isArray(read.anchor.blockers) ? read.anchor.blockers.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
  const ok = complete
    ? targetUnits.length > 0 && unfinished.length === 0 && unverified.length === 0 && failedUnits.length === 0 && blockers.length === 0
    : unfinished.length === 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'check',
    taskId,
    status: ok ? 'passed' : 'failed',
    ...(ok ? {} : { code: 'VIBE_HARNESS_TASK_NOT_READY', error: `task is not ready${unfinished.length ? `; unfinished units: ${unfinished.join(', ')}` : ''}${unverified.length ? `; unverified units: ${unverified.join(', ')}` : ''}${failedUnits.length ? `; failed units: ${failedUnits.join(', ')}` : ''}` }),
    complete,
    unit: args.unit ?? null,
    unfinished,
    unverified,
    failedUnits,
    blockers,
    predecessors,
    plan: planCheck.plan ?? null,
  };
}
async function taskFreezeTestsReport(projectDir, args, { rebaseline = false } = {}) {
  const subcommand = rebaseline ? 'rebaseline-tests' : 'freeze-tests';
  const taskId = args._[2];
  if (taskId === undefined) return taskFailure(subcommand, `${subcommand} needs a task id`);
  if (!args.unit) return taskFailure(subcommand, `--unit is required for ${subcommand}`);
  if (!args.verification) return taskFailure(subcommand, `--verification is required for ${subcommand}`);
  if (!Array.isArray(args.testPath) || args.testPath.length === 0) return taskFailure(subcommand, `at least one --test-path is required for ${subcommand}`);
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) return taskFailure(subcommand, `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  if (typeof read.anchor.planFile === 'string') {
    const planCheck = await taskPlanCheckReport(projectDir, taskId);
    if (planCheck.status !== 'passed') return { ...planCheck, subcommand };
  }
  let receipt;
  try {
    receipt = parseVerificationReceipt(args.verification, projectDir);
  } catch (error) {
    return taskFailure(subcommand, error.message, error.code);
  }
  let paths;
  try {
    paths = args.testPath.map((item) => projectRelativePath(projectDir, item));
  } catch (error) {
    return taskFailure(subcommand, error.message, error.code);
  }
  let freeze;
  try {
    freeze = freezeEntryFromReceipt(receipt, paths, { taskId });
    if (rebaseline) {
      if (!args.approval) return taskFailure(subcommand, '--approval is required to rebaseline frozen tests', 'VIBE_HARNESS_REBASELINE_APPROVAL_INVALID');
      freeze.approval = approvedRebaseline(args.approval, projectDir);
      freeze.rebaselinedAt = new Date().toISOString();
    }
  } catch (error) {
    return taskFailure(subcommand, error.message, error.code);
  }
  const next = JSON.parse(JSON.stringify(read.anchor));
  const unit = upsertTaskUnit(next.units ??= [], args.unit);
  if (rebaseline && unit.testFreeze?.status !== 'frozen') {
    return taskFailure(subcommand, `unit ${args.unit} has no frozen test assets to rebaseline`, 'VIBE_HARNESS_TESTS_NOT_FROZEN');
  }
  if (!rebaseline && unit.testFreeze?.status === 'frozen') {
    return taskFailure(subcommand, `unit ${args.unit} already has frozen test assets; use rebaseline-tests with protected approval`, 'VIBE_HARNESS_TESTS_ALREADY_FROZEN');
  }
  unit.testFreeze = freeze;
  const now = new Date().toISOString();
  next.updatedAt = now;
  next.sessions = [...(Array.isArray(next.sessions) ? next.sessions : []), { at: now, action: subcommand }];
  if (args.write) writeTaskAnchor(read.filePath, next);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand,
    taskId,
    unit: args.unit,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    write: Boolean(args.write),
    written: Boolean(args.write),
    freeze,
  };
}
async function taskUpdateReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('update', 'task update needs a task id: task update <task-id> [--stage <s>] [--unit-status <unitId>:<status>] [--failure <text>] [--verification <receipt> --unit <unitId>] [--clear-blockers]');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('update', error.message, error.code);
  }
  if (args.verification !== undefined && args.unit === undefined) {
    return taskFailure('update', '--verification requires --unit <unitId>');
  }
  if (args.title !== undefined || args.goal !== undefined || args.riskLevel !== undefined || args.acceptance.length > 0) {
    return taskFailure('update', '--title, --goal, --risk-level and --acceptance are only supported by task init', 'VIBE_HARNESS_TASK_OPTION_UNSUPPORTED');
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) {
    return taskFailure('update', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  }
  const current = read.anchor;
  const recoveryOnly = (args.blocker.length > 0 || args.failure.length > 0 || args.nextAction !== undefined)
    && args.stage === undefined && args.unitStatus.length === 0 && args.decision.length === 0
    && !args.clearBlockers && args.verification === undefined && args.planFile === undefined;
  let recoveryPlan = null;
  let requestedPlan = null;
  if (args.planFile !== undefined) {
    try {
      requestedPlan = await readManagedPlan(projectDir, args.planFile);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    if (requestedPlan.missing.length > 0) {
      return taskFailure('update', `plan is missing required sections: ${requestedPlan.missing.join(', ')}`, 'VIBE_HARNESS_PLAN_INVALID');
    }
    if (current.planFile && current.planFile !== requestedPlan.path) {
      return taskFailure('update', `task ${taskId} is already bound to ${current.planFile}`, 'VIBE_HARNESS_PLAN_ALREADY_BOUND');
    }
  }
  if (typeof current.planFile === 'string') {
    const planCheck = await taskPlanCheckReport(projectDir, taskId);
    if (planCheck.status !== 'passed' && planCheck.code !== 'VIBE_HARNESS_TASK_ANCHOR_MISSING' && !recoveryOnly) {
      return taskFailure('update', planCheck.error ?? 'task plan check failed; update the plan and run task plan-sync before continuing', planCheck.code ?? 'VIBE_HARNESS_PLAN_DRIFT');
    }
    if (recoveryOnly && planCheck.status !== 'passed') recoveryPlan = planCheck;
  }
  const currentSignature = anchorSignature(current);
  // Deep-clone before mutating: the raw anchor stays the baseline for the
  // idempotency probe, so in-place edits must never leak into it.
  const next = JSON.parse(JSON.stringify(current));
  const changes = [];
  if (!Array.isArray(next.units)) next.units = [];
  if (!Array.isArray(next.decisions)) next.decisions = [];
  if (!Array.isArray(next.blockers)) next.blockers = [];
  if (!Array.isArray(next.failures)) next.failures = [];
  if (!Array.isArray(next.sessions)) next.sessions = [];
  if (requestedPlan && !current.planFile) {
    next.planFile = requestedPlan.path;
    next.planDigest = requestedPlan.digest;
    next.planRevision = requestedPlan.revision;
    changes.push('plan-bind');
  }
  if (args.stage !== undefined) {
    if (!TASK_STAGES.includes(args.stage)) {
      return taskFailure('update', `--stage must be one of ${TASK_STAGES.join(', ')}`);
    }
    if (next.stage !== args.stage) {
      next.stage = args.stage;
      changes.push('stage');
    }
  }
  for (const entry of args.unitStatus) {
    const separator = entry.lastIndexOf(':');
    const unitId = separator > 0 ? entry.slice(0, separator) : null;
    const status = separator > 0 ? entry.slice(separator + 1) : null;
    if (!unitId || !TASK_UNIT_STATUSES.includes(status)) {
      return taskFailure('update', `--unit-status ${JSON.stringify(entry)} must be <unitId>:<status> with status from ${TASK_UNIT_STATUSES.join(', ')}`);
    }
    try {
      validateTaskId(unitId);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    const existed = next.units.some((item) => item && item.id === unitId);
    const unit = upsertTaskUnit(next.units, unitId);
    if (!existed || unit.status !== status) {
      unit.status = status;
      changes.push(`unit-status:${unitId}`);
    }
  }
  for (const [flag, field] of [['decision', 'decisions'], ['blocker', 'blockers']]) {
    for (const value of args[flag]) {
      if (value.trim() === '') continue;
      if (!next[field].includes(value)) {
        next[field].push(value);
        changes.push(flag);
      }
    }
  }
  // Blockers are appended, never overwritten, so an external approval that
  // resolves them needs an explicit clear: without it a task could never reach
  // `task check --complete` again. Clearing is reported as its own change.
  if (args.clearBlockers && next.blockers.length > 0) {
    next.blockers = [];
    changes.push('clear-blockers');
  }
  // Failures are deduped by text so re-reporting the same failure (for example
  // after a compaction-driven resume) does not grow the anchor.
  for (const value of args.failure) {
    if (value.trim() === '') continue;
    if (!next.failures.some((item) => item && item.text === value)) {
      next.failures.push({ at: new Date().toISOString(), text: value });
      changes.push('failure');
    }
  }
  if (args.nextAction !== undefined && next.nextAction !== args.nextAction) {
    next.nextAction = args.nextAction;
    changes.push('nextAction');
  }
  if (args.verification !== undefined) {
    try {
      validateTaskId(args.unit);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    let receipt;
    try {
      receipt = parseVerificationReceipt(args.verification, projectDir);
    } catch (error) {
      return taskFailure('update', error.message, error.code);
    }
    const existed = next.units.some((item) => item && item.id === args.unit);
    const unit = upsertTaskUnit(next.units, args.unit);
    const entry = taskVerificationFromReceipt(receipt);
    if (entry.taskId && entry.taskId !== taskId) {
      return taskFailure('update', `verification receipt was produced for task ${entry.taskId}, not ${taskId}`, 'VIBE_HARNESS_VERIFICATION_TASK_MISMATCH');
    }
    if (!existed || stableStringify(unit.verification ?? null) !== stableStringify(entry)) {
      unit.verification = entry;
      changes.push(`verification:${args.unit}`);
    }
    if (next.executionBatch) {
      if (!next.executionBatch.members.includes(args.unit)) return taskFailure('update', 'unit is outside the Parent batch', 'VIBE_HARNESS_PLAN_UNIT_UNDECLARED');
      try {
        unit.localCompletion = await bindLocalCompletion(projectDir, next, unit, receipt,
          configuredChecks(await readProjectConfig(projectDir), projectDir));
        changes.push(`local-completion:${args.unit}`);
      } catch (error) {
        return taskFailure('update', error.message, 'VIBE_HARNESS_LOCAL_COMPLETION_INVALID');
      }
    }
  }
  if (next.executionBatch && next.units.some((unit) => unit.status === 'done' && !unit.localCompletion)) {
    return taskFailure('update', 'batch done units require local completion evidence', 'VIBE_HARNESS_LOCAL_COMPLETION_INVALID');
  }
  if (next.executionBatch && next.units.filter((unit) => unit.status === 'in_progress').length > 1) {
    return taskFailure('update', 'a Parent batch permits one active Writer unit', 'VIBE_HARNESS_PARENT_BATCH_SINGLE_WRITER');
  }
  if (args.stage === 'verify' && current.stage !== 'verify') {
    next.latestCheckpoint = await buildTaskCheckpoint(projectDir, next, 'pre-verify');
    changes.push('checkpoint');
  }
  const changed = anchorSignature(next) !== currentSignature;
  let anchor = next;
  if (changed) {
    const now = new Date().toISOString();
    anchor = { ...next, updatedAt: now, sessions: [...next.sessions, { at: now, action: 'update' }] };
    if (args.write) {
      try {
        writeTaskAnchor(read.filePath, anchor);
      } catch (error) {
        return taskFailure('update', `cannot write ${taskAnchorRelativePath(taskId)}: ${error.code ?? error.message}`);
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'update',
    taskId,
    status: args.write ? 'passed' : 'planned',
    ...(args.write ? {} : { dryRun: true }),
    write: Boolean(args.write),
    written: changed && Boolean(args.write),
    changed,
    changes,
    ...(recoveryPlan ? { planStatus: recoveryPlan.status, planCode: recoveryPlan.code, planError: recoveryPlan.error } : {}),
    path: taskAnchorRelativePath(taskId),
    anchor,
  };
}
// The anchor's riskLevel names the verification tier a completion claim
// needs: quick/light units close on a quick-tier focused receipt, full units
// need standard-tier evidence. Advisory only — the worktree stage verify gate
// is the one place that escalates hard off this field.
function taskRiskLevelAdvisory(riskLevel) {
  if (riskLevel === 'full') {
    return 'riskLevel full: claim unit completion on a standard-tier verify receipt';
  }
  if (riskLevel === 'quick' || riskLevel === 'light') {
    return `riskLevel ${riskLevel}: a quick-tier focused receipt supports the unit completion claim`;
  }
  return null;
}
function taskResumeHint(taskId, anchor, pendingUnits) {
  const parts = [
    `read ${taskAnchorRelativePath(taskId)} and the current diff (git status --porcelain plus git diff) first`,
    'do not re-read rule bodies or the full report',
    `stage: ${typeof anchor.stage === 'string' ? anchor.stage : 'unknown'}`,
  ];
  const advisory = taskRiskLevelAdvisory(typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null);
  if (advisory) parts.push(`verification advisory: ${advisory}`);
  if (pendingUnits.length > 0) parts.push(`pending units: ${pendingUnits.join(', ')}`);
  const failures = Array.isArray(anchor.failures)
    ? anchor.failures.filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
    : [];
  if (failures.length > 0) parts.push(`recent failure: ${failures[failures.length - 1].text}`);
  if (typeof anchor.nextAction === 'string' && anchor.nextAction !== '') parts.push(`next action: ${anchor.nextAction}`);
  return `${parts.join('; ')}.`;
}
async function buildTaskCheckpoint(projectDir, anchor, reason) {
  const current = await gitFingerprint(projectDir);
  return {
    at: new Date().toISOString(), reason, headSha: current.snapshot.head,
    worktree: normalizeSlashes(safeRealpath(projectDir) ?? projectDir), fingerprint: current.fingerprint,
    stage: anchor.stage, activeUnits: anchor.units.filter((unit) => unit.status === 'in_progress').map((unit) => unit.id),
    changes: current.snapshot.changes, blockers: anchor.blockers, nextAction: anchor.nextAction,
    latestVerification: anchor.units.map((unit) => unit.verification).filter(Boolean)
      .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)))[0] ?? null,
  };
}
async function taskRecoveryState(projectDir, anchor) {
  const current = await buildTaskCheckpoint(projectDir, anchor, 'recovery-inspection');
  const previous = anchor.latestCheckpoint;
  const drift = previous ? ['headSha', 'worktree', 'fingerprint', 'activeUnits', 'latestVerification', 'blockers', 'nextAction']
    .filter((key) => stableStringify(previous[key]) !== stableStringify(current[key])) : ['checkpoint-missing'];
  return { status: drift.length ? 'blocked' : 'passed', drift, current,
    guidance: 'Compare current changes and reconcile the existing unit before resuming; do not replan the goal.' };
}
export async function taskCheckpointReport(projectDir, args) {
  const taskId = args._[2];
  if (!args.reason?.trim()) return taskFailure('checkpoint', '--reason is required');
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) return taskFailure('checkpoint', 'task anchor is missing');
  const checkpoint = await buildTaskCheckpoint(projectDir, read.anchor, args.reason.trim());
  if (!checkpoint.headSha || !checkpoint.fingerprint) return { command: 'task', subcommand: 'checkpoint', status: 'blocked', error: 'Workspace identity unavailable' };
  const anchor = { ...read.anchor, latestCheckpoint: checkpoint, updatedAt: checkpoint.at };
  if (args.write) writeTaskAnchor(read.filePath, anchor);
  return { schemaVersion: SCHEMA_VERSION, command: 'task', subcommand: 'checkpoint', taskId,
    status: args.write ? 'passed' : 'planned', written: Boolean(args.write), latestCheckpoint: checkpoint };
}
async function taskEventReport(projectDir, args) {
  const reason = args.reason;
  if (!['pre-compaction', 'resume', 'continue', 'pre-delivery', 'pre-verify'].includes(reason)) return taskFailure('event', 'Unsupported checkpoint event');
  const taskId = args._[2];
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) return taskFailure('event', 'task anchor is missing');
  if (reason === 'resume') {
    const recovery = await taskRecoveryState(projectDir, read.anchor);
    if (recovery.status !== 'passed') return { command: 'task', subcommand: 'event', status: 'blocked', recovery };
  }
  const count = (read.anchor.continuationCount ?? 0) + (reason === 'continue' ? 1 : 0);
  if (args.write && reason === 'continue') writeTaskAnchor(read.filePath, { ...read.anchor, continuationCount: count });
  if (reason === 'continue' && count < 2) return { command: 'task', subcommand: 'event', status: args.write ? 'passed' : 'planned', continuationCount: count, checkpointed: false };
  return { ...await taskCheckpointReport(projectDir, args), subcommand: 'event', continuationCount: count };
}
async function taskStatusReport(projectDir, args) {
  const taskId = args._[2];
  if (taskId === undefined) {
    return taskFailure('status', 'task status needs a task id: task status <task-id>');
  }
  try {
    validateTaskId(taskId);
  } catch (error) {
    return taskFailure('status', error.message, error.code);
  }
  const read = await readTaskAnchor(projectDir, taskId);
  if (!read.exists) {
    return taskFailure('status', `no anchor for task ${taskId}: run "task init ${taskId}" first`);
  }
  const anchor = read.anchor;
  const planCheck = await taskPlanCheckReport(projectDir, taskId);
  const units = Array.isArray(anchor.units) ? anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
  const pendingUnits = units.filter((unit) => unit.status !== 'done').map((unit) => unit.id);
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'status',
    taskId,
    status: 'ready',
    path: taskAnchorRelativePath(taskId),
    title: typeof anchor.title === 'string' ? anchor.title : null,
    stage: typeof anchor.stage === 'string' ? anchor.stage : null,
    riskLevel: typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null,
    verificationAdvisory: taskRiskLevelAdvisory(typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null),
    goal: typeof anchor.goal === 'string' ? anchor.goal : null,
    acceptance: Array.isArray(anchor.acceptance) ? anchor.acceptance : [],
    units,
    pendingUnits,
    decisions: Array.isArray(anchor.decisions) ? anchor.decisions : [],
    blockers: Array.isArray(anchor.blockers) ? anchor.blockers : [],
    failures: Array.isArray(anchor.failures) ? anchor.failures : [],
    nextAction: typeof anchor.nextAction === 'string' ? anchor.nextAction : null,
    sessions: Array.isArray(anchor.sessions) ? anchor.sessions : [],
    plan: planCheck.plan ?? null,
    planStatus: planCheck.status,
    updatedAt: typeof anchor.updatedAt === 'string' ? anchor.updatedAt : null,
    resumeHint: taskResumeHint(taskId, anchor, pendingUnits),
    latestCheckpoint: anchor.latestCheckpoint ?? null,
    recovery: await taskRecoveryState(projectDir, anchor),
  };
}
async function taskListReport(projectDir) {
  let entries = [];
  try {
    entries = await readdir(path.join(projectDir, TASKS_RELATIVE_DIR), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return taskFailure('list', `cannot read ${TASKS_RELATIVE_DIR}: ${error.code ?? error.message}`);
    }
  }
  const tasks = [];
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const taskId = entry.name.slice(0, -'.json'.length);
    if (!TASK_ID_PATTERN.test(taskId) || WINDOWS_RESERVED_NAMES.test(taskId)) {
      tasks.push({ taskId, status: 'invalid', error: 'filename is not a valid task id' });
      continue;
    }
    let read;
    try {
      read = await readTaskAnchor(projectDir, taskId);
    } catch (error) {
      tasks.push({ taskId, status: 'invalid', error: error.message });
      continue;
    }
    if (!read.exists) continue;
    const anchor = read.anchor;
    const units = Array.isArray(anchor.units) ? anchor.units.filter((unit) => unit && typeof unit === 'object') : [];
    tasks.push({
      taskId,
      status: 'ready',
      title: typeof anchor.title === 'string' ? anchor.title : null,
      stage: typeof anchor.stage === 'string' ? anchor.stage : null,
      riskLevel: typeof anchor.riskLevel === 'string' ? anchor.riskLevel : null,
      unitCount: units.length,
      doneUnits: units.filter((unit) => unit.status === 'done').length,
      pendingUnits: units.filter((unit) => unit.status !== 'done').map((unit) => unit.id),
      blockerCount: Array.isArray(anchor.blockers) ? anchor.blockers.length : 0,
      planFile: typeof anchor.planFile === 'string' ? anchor.planFile : null,
      planRevision: typeof anchor.planRevision === 'string' ? anchor.planRevision : null,
      updatedAt: typeof anchor.updatedAt === 'string' ? anchor.updatedAt : null,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'task',
    subcommand: 'list',
    status: 'ready',
    directory: TASKS_RELATIVE_DIR,
    count: tasks.length,
    invalidCount: tasks.filter((item) => item.status === 'invalid').length,
    tasks,
  };
}
export async function taskReport(projectDir, args) {
  const subcommand = args._[1] ?? null;
  try {
    if (subcommand === null) {
      return taskFailure(null, 'task needs a subcommand: task <init|update|status|list|plan-check|plan-sync|check|freeze-tests|rebaseline-tests> [task-id]');
    }
    if (subcommand === 'init') return await taskInitReport(projectDir, args);
    if (subcommand === 'checkpoint') return await taskCheckpointReport(projectDir, args);
    if (subcommand === 'event') return await taskEventReport(projectDir, args);
    if (subcommand === 'update') return await taskUpdateReport(projectDir, args);
    if (subcommand === 'status') return await taskStatusReport(projectDir, args);
    if (subcommand === 'list') return await taskListReport(projectDir);
    if (subcommand === 'plan-check') return await taskPlanCheckReport(projectDir, args._[2]);
    if (subcommand === 'plan-sync') return await taskPlanSyncReport(projectDir, args);
    if (subcommand === 'check') return await taskCheckReport(projectDir, args);
    if (subcommand === 'freeze-tests') return await taskFreezeTestsReport(projectDir, args);
    if (subcommand === 'rebaseline-tests') return await taskFreezeTestsReport(projectDir, args, { rebaseline: true });
    return taskFailure(subcommand, `Unknown task subcommand: ${JSON.stringify(String(subcommand))} (expected init, update, status, list, plan-check, plan-sync, check, freeze-tests or rebaseline-tests)`);
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: 'task',
      subcommand,
      status: 'failed',
      ...(error.code ? { code: error.code } : {}),
      error: boundedOutput(error.message, projectDir),
    };
  }
}
