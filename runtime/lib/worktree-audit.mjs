// Worktree isolation audit (portable core).
//
// docs/rules/git-rules.md §Worktree and docs/rules/linear-workflow.md require
// one isolation unit per named branch with an explicit write scope, a worktree
// outside the repository, child agents confined to their assigned
// worktree/branch/scope, and no cleanup of a worktree or branch before
// merge-back. This module parses `git worktree list --porcelain -z` and reports
// the isolation facts mechanically.
//
// It never runs `git worktree remove`, `git worktree prune` or a branch
// delete. Cleanup stays a human decision taken after merge-back; the audit only
// reports what it observed, including the `cleanupAllowed` advisory.
//
// This module is the single implementation shared by the source-repository CLI
// (`scripts/worktree.js` via `scripts/lib/worktree-audit.js`) and the installed
// project script (`runtime/commands/run.mjs <worktree|slice|patch>`). It stays
// free of Node APIs beyond `node:path` so the installed copy runs anywhere.
import path from 'node:path';

export const WORKTREE_AUDIT_SCHEMA = 'vibe-harness.worktree-audit/v1';

// Dependency-link problems describe the worktree's own provisioning state, not
// the merge-back facts. A stale link blocks the work in that worktree but must
// not block removal of an already-merged worktree, so these codes are excluded
// from the `cleanupAllowed` gate.
export const WORKTREE_DEPENDENCY_CODES = Object.freeze([
  'WORKTREE_DEPENDENCY_MISSING',
  'WORKTREE_DEPENDENCY_STALE',
]);

// Port segmentation and per-worktree environment facts are provisioning state
// too: a missing regenerated env file or a conflicting block blocks the work in
// that worktree, but it must not stop removal of an already-merged worktree.
export const WORKTREE_PORT_CODES = Object.freeze([
  'WORKTREE_ENV_NOT_IGNORED',
  'WORKTREE_MAIN_DEPENDENCIES_MISSING',
  'WORKTREE_PORT_CONFLICT',
  'WORKTREE_PORT_ENV_DRIFT',
  'WORKTREE_PORT_ENV_MISSING',
  'WORKTREE_PORT_REGISTRY_INVALID',
]);

// Branch types allowed by the `<type>/<ISSUE-ID>-<slug>` convention in
// docs/rules/linear-workflow.md. The list mirrors the commit/PR types the same
// rules use, plus the hotfix/release branches named in docs/rules/git-rules.md.
export const DEFAULT_BRANCH_TYPES = Object.freeze([
  'build',
  'chore',
  'ci',
  'docs',
  'eval',
  'feat',
  'fix',
  'hotfix',
  'perf',
  'refactor',
  'release',
  'style',
  'test',
]);

const slugPattern = /^[a-z0-9][a-z0-9._-]*$/u;
const dependencyCodeSet = new Set([...WORKTREE_DEPENDENCY_CODES, ...WORKTREE_PORT_CODES]);

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Case- and separator-insensitive key for path comparison. */
export function pathKey(value) {
  const resolved = path.resolve(String(value ?? '')).replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Comparison key for a branch short name. */
function branchKey(value) {
  const name = String(value ?? '');
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function isInside(childPath, parentPath) {
  const child = pathKey(childPath);
  const parent = pathKey(parentPath);
  return child !== parent && child.startsWith(`${parent}/`);
}

/**
 * Resolve the worktree root for a project.
 *
 * A configured value is resolved against the project root, so a project can
 * keep worktrees at a project-specific sibling directory. Without one the
 * convention from docs/rules/linear-workflow.md applies: `<repo>-worktrees`
 * next to the repository.
 *
 * @param {string} projectRoot
 * @param {unknown} configuredRoot
 * @returns {string}
 */
export function resolveWorktreeRoot(projectRoot, configuredRoot) {
  const root = path.resolve(String(projectRoot));
  if (isNonEmptyString(configuredRoot)) return path.resolve(root, String(configuredRoot));
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
}

/**
 * Parse `git worktree list --porcelain -z` output.
 *
 * With `-z` git terminates every field with NUL and separates records with an
 * empty field, so a record is a run of `key [value]` fields closed by an empty
 * one. The first record is the main worktree git listed from.
 *
 * @param {unknown} text
 * @returns {Record<string, any>[]}
 */
export function parseWorktreeList(text) {
  if (typeof text !== 'string' || text === '') return [];
  const records = [];
  let fields = [];
  for (const field of text.split('\0')) {
    if (field === '') {
      if (fields.length > 0) {
        records.push(fields);
        fields = [];
      }
      continue;
    }
    fields.push(field);
  }
  if (fields.length > 0) records.push(fields);
  return records.map((record, index) => toWorktree(record, index));
}

function toWorktree(fields, index) {
  const entry = {
    bare: false,
    branch: null,
    branchRef: null,
    detached: false,
    head: null,
    locked: null,
    path: '',
    primary: index === 0,
    prunable: null,
  };
  for (const field of fields) {
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') entry.path = value;
    else if (key === 'HEAD') entry.head = value;
    else if (key === 'branch') {
      entry.branchRef = value;
      entry.branch = value.replace(/^refs\/heads\//u, '');
    } else if (key === 'detached') entry.detached = true;
    else if (key === 'bare') entry.bare = true;
    else if (key === 'locked') entry.locked = value === '' ? true : value;
    else if (key === 'prunable') entry.prunable = value === '' ? true : value;
  }
  return entry;
}

/**
 * True when `branch` follows `<type>/<ISSUE-ID>-<slug>` for the given issue.
 *
 * `options.branchPrefix` replaces the type list with a single literal prefix
 * (for example `codex/`); the issue ID and slug are still required.
 *
 * @param {unknown} branch
 * @param {unknown} issueId
 * @param {{branchPrefix?: string, branchTypes?: readonly string[]}} [options]
 */
export function isTaskBranch(branch, issueId, options = {}) {
  if (!isNonEmptyString(branch) || !isNonEmptyString(issueId)) return false;
  const prefixes = isNonEmptyString(options.branchPrefix)
    ? [options.branchPrefix]
    : (options.branchTypes ?? DEFAULT_BRANCH_TYPES).map((type) => `${type}/`);
  const pattern = new RegExp(`^(?:${prefixes.map(escapeRegExp).join('|')})${escapeRegExp(issueId)}-(.+)$`, 'u');
  const match = pattern.exec(branch);
  return match !== null && slugPattern.test(match[1]);
}

/** Sibling worktree path from docs/rules/linear-workflow.md: `<repo>-worktrees/<ISSUE-ID>`. */
export function defaultWorktreePath(repositoryRoot, issueId) {
  const resolved = path.resolve(String(repositoryRoot));
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-worktrees`, String(issueId));
}

/**
 * Audit a worktree listing against the isolation rules.
 *
 * @param {unknown} value raw `git worktree list --porcelain -z` text, an array
 *   of parsed entries, or `{worktrees, tasks}`
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>} the audit, including error/warning counts and
 *   the `cleanupAllowed` advisory
 */
export function validateWorktrees(value, options = {}) {
  const problems = [];
  const push = (code, message, severity = 'error') => problems.push({ code, message, severity });

  let entries = null;
  let inlineTasks = [];
  if (typeof value === 'string') entries = parseWorktreeList(value);
  else if (Array.isArray(value)) entries = value;
  else if (isObject(value) && Array.isArray(value.worktrees)) {
    entries = value.worktrees;
    inlineTasks = Array.isArray(value.tasks) ? value.tasks : [];
  }
  if (entries === null) {
    push('WORKTREE_LIST_INVALID', 'expected `git worktree list --porcelain -z` text, an array of entries, or {worktrees, tasks}');
    return finishAudit({ entries: [], problems, tasks: [] }, options);
  }
  entries = entries.filter((entry) => isObject(entry)).map((entry, index) => ({ primary: index === 0, ...entry }));

  const repositoryRoot = isNonEmptyString(options.repositoryRoot) ? options.repositoryRoot : null;
  if (repositoryRoot === null) {
    push('WORKTREE_REPOSITORY_UNKNOWN', 'no repository root given; the outside-of-repository check was skipped', 'warning');
  }
  const configuredRoot = isNonEmptyString(options.configuredRoot) ? String(options.configuredRoot) : null;

  // Worktrees must live outside the repository and must not nest inside each
  // other, so a build or dependency scan in one tree cannot reach another.
  const insideReported = new Set();
  for (const entry of entries) {
    if (entry.primary || !isNonEmptyString(entry.path)) continue;
    const key = pathKey(entry.path);
    if (repositoryRoot !== null && (key === pathKey(repositoryRoot) || isInside(entry.path, repositoryRoot))) {
      insideReported.add(key);
      push('WORKTREE_INSIDE_REPOSITORY', `${entry.path} is inside the repository; docs/rules/git-rules.md §Worktree requires an outside-repository worktree`);
    }
    for (const other of entries) {
      if (other === entry || !isNonEmptyString(other.path)) continue;
      if (isInside(entry.path, other.path) && !(other.primary && repositoryRoot !== null)) {
        insideReported.add(key);
        push('WORKTREE_NESTED', `${entry.path} is nested inside worktree ${other.path}; worktrees must not contain one another`);
      }
    }
  }

  if (configuredRoot !== null) {
    for (const entry of entries) {
      if (entry.primary || !isNonEmptyString(entry.path)) continue;
      const key = pathKey(entry.path);
      if (insideReported.has(key)) continue;
      if (key === pathKey(configuredRoot) || isInside(entry.path, configuredRoot)) continue;
      push('WORKTREE_OUTSIDE_CONFIGURED_ROOT', `${entry.path} is outside the configured worktree root ${configuredRoot}; move it or update worktree.root in vibe-harness.config.json`);
    }
  }

  for (const entry of entries) {
    if (entry.primary || entry.bare) continue;
    if (entry.detached || !isNonEmptyString(entry.branch)) {
      push('WORKTREE_DETACHED', `${entry.path} has no named branch; a non-primary worktree must be bound to a branch`);
    }
  }

  // A prunable entry is one whose directory is gone while the Git
  // administrative residue (`.git/worktrees/<id>` plus the branch binding)
  // survives — typically after a hard kill between directory removal and
  // prune. The entry still names a path and a branch, so task materialization
  // and port-registry matching would reason about a directory that no longer
  // exists. It is a full error (not a dependency code): the residue must be
  // resolved with `run.mjs worktree recover` or `git worktree prune` before
  // the audit can pass.
  for (const entry of entries) {
    if (entry.primary || !entry.prunable) continue;
    const reason = typeof entry.prunable === 'string' ? entry.prunable : 'worktree directory missing';
    push(
      'WORKTREE_PRUNABLE_RESIDUE',
      `${entry.path} is prunable (${reason}); the directory is gone but Git metadata and the branch binding remain; run \`run.mjs worktree recover\` or \`git worktree prune\``,
    );
  }

  const byBranch = new Map();
  for (const entry of entries) {
    if (!isNonEmptyString(entry.branch)) continue;
    const key = branchKey(entry.branch);
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key).push(entry);
  }
  for (const [branch, group] of byBranch) {
    if (group.length < 2) continue;
    push('WORKTREE_DUPLICATE_BRANCH', `branch ${branch} is checked out by ${group.length} worktrees: ${group.map((entry) => entry.path).join(', ')}`);
  }

  const tasks = [...(Array.isArray(options.tasks) ? options.tasks : []), ...inlineTasks];
  const normalizedTasks = [];
  const claimedPaths = new Set();
  const mergeBackReported = new Set();
  let unregistered = 0;
  for (const task of tasks) {
    if (!isObject(task) || !isNonEmptyString(task.id)) {
      push('WORKTREE_TASK_INVALID', 'every registered task needs an id');
      continue;
    }
    const id = String(task.id).trim();
    const branch = isNonEmptyString(task.branch) ? String(task.branch).trim() : null;
    const assignedPath = isNonEmptyString(task.path)
      ? String(task.path)
      : defaultWorktreePath(repositoryRoot ?? options.repositoryRoot ?? process.cwd(), id);
    if (branch === null) push('WORKTREE_BRANCH_MISSING', `task ${id} declares no branch; one isolation unit is one named branch`);
    else if (!isTaskBranch(branch, id, options)) {
      push('WORKTREE_BRANCH_INVALID', `task ${id} branch ${branch} must match <type>/${id}-<slug>`);
    }

    const entryByPath = entries.find((entry) => isNonEmptyString(entry.path) && pathKey(entry.path) === pathKey(assignedPath));
    const entryByBranch = branch === null
      ? undefined
      : entries.find((entry) => isNonEmptyString(entry.branch) && branchKey(entry.branch) === branchKey(branch));
    const entry = entryByPath ?? entryByBranch;
    if (entry === undefined) {
      unregistered += 1;
      push('WORKTREE_UNREGISTERED', `task ${id} has no worktree yet; expected ${assignedPath}`, 'warning');
    } else {
      claimedPaths.add(pathKey(entry.path));
      if (branch !== null && entry.branch !== branch) {
        push('WORKTREE_BRANCH_UNBOUND', `task ${id} expects branch ${branch} but ${entry.path} is bound to ${entry.branch ?? 'a detached HEAD'}`);
      }
    }

    const integration = options.integration?.get?.(branch ?? '');
    if (entry !== undefined && integration) {
      if (integration.integrated === false && branch !== null) {
        mergeBackReported.add(branchKey(branch));
        push(
          'WORKTREE_MERGE_BACK_PENDING',
          `task ${id} branch ${branch} is not merged into ${integration.targetRef ?? 'the target ref'}; do not clean up the worktree or delete the branch yet`,
          'warning',
        );
      }
      if (integration.baseDrift === true) {
        push(
          'WORKTREE_BASE_DRIFT',
          `task ${id} merge-base ${String(integration.mergeBaseSha ?? 'unknown').slice(0, 12)} differs from the frozen base SHA ${String(task.baseSha ?? 'unknown').slice(0, 12)}`,
        );
      }
    }

    normalizedTasks.push({
      branch,
      id,
      materialized: entry !== undefined,
      path: assignedPath,
      worktree: entry === undefined ? null : entry.path,
    });
  }

  let unmanaged = 0;
  const enrichedEntries = entries.map((entry) => {
    const claimed = entry.primary || claimedPaths.has(pathKey(entry.path));
    if (!claimed) {
      unmanaged += 1;
      push('WORKTREE_UNMANAGED', `${entry.path} is bound to ${entry.branch ?? 'a detached HEAD'} and no registered task claims it`, 'warning');
    }
    const integration = isNonEmptyString(entry.branch) ? options.integration?.get?.(entry.branch) : null;
    return {
      ...entry,
      claimed,
      integrated: integration?.integrated ?? null,
      mergeBaseSha: integration?.mergeBaseSha ?? null,
      targetRef: integration?.targetRef ?? null,
    };
  });

  // With `integrationAll` the audit reports merge-back per worktree instead of
  // per registered task, so cleanup planning works on a project that has not
  // registered every worktree as a task.
  if (options.integration instanceof Map && options.integrationAll === true) {
    for (const entry of enrichedEntries) {
      if (entry.primary || !isNonEmptyString(entry.branch)) continue;
      if (mergeBackReported.has(branchKey(entry.branch))) continue;
      const integration = options.integration.get(entry.branch);
      if (!integration || integration.integrated !== false) continue;
      mergeBackReported.add(branchKey(entry.branch));
      push(
        'WORKTREE_MERGE_BACK_PENDING',
        `worktree ${entry.path} branch ${entry.branch} is not merged into ${integration.targetRef ?? 'the target ref'}; do not clean up the worktree or delete the branch yet`,
        'warning',
      );
    }
  }

  for (const entry of enrichedEntries) {
    if (options.dirty?.get?.(pathKey(entry.path)) === true) {
      push('WORKTREE_DIRTY', `${entry.path} has uncommitted changes; confirm the worktree is clean before removal`, 'warning');
    }
  }

  // Dependency-link evidence is produced by the caller (which alone can touch
  // the filesystem) and folded in here so severity counting stays in one place.
  const evidence = options.dependencyEvidence;
  if (evidence instanceof Map) {
    for (const entry of enrichedEntries) {
      if (entry.primary || !isNonEmptyString(entry.path)) continue;
      const facts = evidence.get(pathKey(entry.path));
      if (!Array.isArray(facts)) continue;
      for (const fact of facts) {
        if (fact?.status === 'missing') {
          push('WORKTREE_DEPENDENCY_MISSING', `${entry.path}: ${fact.dependencyRoot}/node_modules is not linked from the main checkout; run \`run.mjs worktree bootstrap\` for this worktree`, 'warning');
        } else if (fact?.status === 'stale') {
          push('WORKTREE_DEPENDENCY_STALE', `${entry.path}: ${fact.localPackage ? `${fact.localPackage} resolves to ${fact.resolved ?? 'an unknown path'}` : `${fact.dependencyRoot}/node_modules resolves to ${fact.resolved ?? 'an unknown path'}`}, but this worktree must resolve it inside ${entry.path}`);
        }
      }
    }
  }

  // Port segmentation and per-worktree env facts come from the same kind of
  // caller-owned evidence: the registry plus the filesystem, never a guess.
  for (const problem of Array.isArray(options.portProblems) ? options.portProblems : []) {
    if (!isObject(problem) || !isNonEmptyString(problem.code)) continue;
    push(problem.code, String(problem.message ?? ''), problem.severity === 'warning' ? 'warning' : 'error');
  }

  return finishAudit({ entries: enrichedEntries, problems, tasks: normalizedTasks }, options, { unmanaged, unregistered });
}

function finishAudit({ entries, problems, tasks }, options, extra = {}) {
  const errors = problems.filter((problem) => problem.severity === 'error');
  const warnings = problems.filter((problem) => problem.severity === 'warning');
  const dirtyPaths = entries.filter((entry) => options.dirty?.get?.(pathKey(entry.path)) === true).length;
  const pendingMergeBack = problems.filter((problem) => problem.code === 'WORKTREE_MERGE_BACK_PENDING').length;
  const unaccounted = (extra.unmanaged ?? 0) + (extra.unregistered ?? 0);
  const blockingErrors = errors.filter((problem) => !dependencyCodeSet.has(problem.code));
  return {
    baseRef: options.baseRef ?? null,
    // Cleanup is only ever advised when every worktree is accounted for, no
    // worktree is dirty and every registered branch has landed: docs/rules/
    // git-rules.md §Worktree forbids cleanup before merge-back. A stale
    // dependency link describes the worktree's provisioning, not its
    // merge-back state, so it does not block removal on its own.
    cleanupAllowed: blockingErrors.length === 0 && dirtyPaths === 0 && pendingMergeBack === 0 && unaccounted === 0,
    configuredRoot: options.configuredRoot ?? null,
    counts: {
      detached: entries.filter((entry) => !entry.primary && (entry.detached || !isNonEmptyString(entry.branch))).length,
      dirty: dirtyPaths,
      tasks: tasks.length,
      unmanaged: extra.unmanaged ?? 0,
      unregistered: extra.unregistered ?? 0,
      worktrees: entries.length,
    },
    errorCount: errors.length,
    ok: errors.length === 0,
    problems: [...problems].sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message)),
    ports: Array.isArray(options.portSummary) ? options.portSummary : [],
    schema: WORKTREE_AUDIT_SCHEMA,
    schemaVersion: 1,
    tasks,
    warningCount: warnings.length,
    worktrees: entries,
  };
}

/** Human-readable summary of a worktree audit. */
export function summarizeWorktreeAudit(audit) {
  const lines = [
    `status: ${audit.ok ? 'passed' : 'failed'}`,
    `worktrees: ${audit.counts.worktrees} (detached ${audit.counts.detached}, unmanaged ${audit.counts.unmanaged})`,
    `tasks: ${audit.counts.tasks} (unregistered ${audit.counts.unregistered})`,
    `base ref: ${audit.baseRef ?? 'unresolved'}`,
    `cleanup allowed: ${audit.cleanupAllowed ? 'yes' : 'no (merge-back, dirtiness, an unaccounted worktree or an error blocks cleanup)'}`,
  ];
  for (const entry of audit.worktrees) {
    const readiness = entry.integrated === true ? ' [merged]' : entry.integrated === false ? ' [merge-back pending]' : '';
    lines.push(`worktree: ${entry.path} ${entry.branch ?? '(detached)'}${entry.claimed ? '' : ' [unmanaged]'}${readiness}${entry.head ? ` @${String(entry.head).slice(0, 12)}` : ''}`);
  }
  for (const task of audit.tasks) {
    lines.push(`task: ${task.id} branch ${task.branch ?? '(none)'} -> ${task.worktree ?? `(unregistered, expected ${task.path})`}`);
  }
  for (const item of audit.ports ?? []) {
    const ports = Object.entries(item.ports ?? {}).map(([name, port]) => `${name}=${port}`).join(' ');
    lines.push(`ports: ${item.path} block ${item.block}${ports ? ` (${ports})` : ''}`);
  }
  for (const problem of audit.problems) lines.push(`${problem.severity}: ${problem.code} ${problem.message}`);
  return lines.join('\n');
}
