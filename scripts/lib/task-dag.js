// Lightweight Task DAG validation.
//
// docs/rules/ai-collab-rules.md defines the node fields, the trigger semantics,
// the writeScope path grammar and the rule that two write nodes with an
// overlapping Scope or the same resource lock are only allowed to coexist when
// a dependency path orders them. The template table in docs/templates/task.md
// stays a human record: this module validates the same field names in JSON so a
// dispatch can be checked mechanically before any write is handed out.
//
// Invocation surface: the `pnpm task-dag check|hash` CLI (scripts/task-dag.js)
// driven on demand by the task-decomposition skill and the online canary
// scenarios. Nothing in the installed runtime calls it automatically — it is a
// pre-dispatch validator, not a lifecycle step.
import { createHash } from 'node:crypto';
import { batchPredecessorSatisfied } from '../../runtime/lib/parent-batch.mjs';

export const TASK_DAG_SCHEMA = 'vibe-harness.task-dag/v1';
export const DAG_CONCURRENCY_DEFAULTS = Object.freeze({
  maxWriteAgents: 2,
  maxReadAgents: 4,
});

export const NODE_KINDS = Object.freeze(['read', 'write', 'aggregate']);
export const NODE_TRIGGERS = Object.freeze(['all_success', 'all_done']);
export const NODE_RESULTS = Object.freeze(['pending', 'ready', 'running', 'unverified', 'succeeded', 'failed', 'blocked', 'skipped', 'cancelled']);
// `blocked` is deliberately not terminal: an all_done predecessor may not be
// blocked, because that would report a failure as a settled input.
export const TERMINAL_RESULTS = Object.freeze(['succeeded', 'failed', 'skipped', 'cancelled']);
export const SUCCESSFUL_RESULTS = Object.freeze(['succeeded']);
export const DAG_NODE_KEYS = Object.freeze(['id', 'kind', 'output', 'dependsOn', 'trigger', 'writeScope', 'resourceLocks', 'verification', 'result', 'cleanupPending']);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const globCharacters = /[*?[\]{}!]/u;

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function asStringArray(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null).map((item) => String(item));
  return [String(value)];
}

/**
 * Normalize one writeScope entry.
 *
 * Accepts an exact project-relative path or a directory range ending in `/**`,
 * normalizes separators, and rejects absolute paths, UNC paths, empty paths,
 * `..` segments and any other glob. Returns null when the entry is not a valid
 * scope so the caller can report the offending value.
 *
 * @param {unknown} entry
 * @returns {{kind: 'dir'|'file', path: string, raw: string}|null}
 */
export function normalizeScopeEntry(entry) {
  if (typeof entry !== 'string') return null;
  const raw = entry.trim();
  if (raw === '') return null;
  if (raw.startsWith('/') || raw.startsWith('\\\\') || raw.startsWith('//') || /^[A-Za-z]:/u.test(raw)) return null;
  const slashed = raw.replaceAll('\\', '/');
  const range = slashed.endsWith('/**');
  const body = (range ? slashed.slice(0, -3) : slashed).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (body === '' || body.startsWith('/')) return null;
  const segments = body.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (globCharacters.test(body)) return null;
  return { kind: range ? 'dir' : 'file', path: body, raw };
}

function scopeOverlaps(left, right) {
  const leftSegments = left.path.toLowerCase().split('/');
  const rightSegments = right.path.toLowerCase().split('/');
  const shorter = leftSegments.length <= rightSegments.length ? leftSegments : rightSegments;
  const longer = leftSegments.length <= rightSegments.length ? rightSegments : leftSegments;
  // Any path-segment ancestor relationship counts as overlap: an exact path may
  // itself name a directory, and the rules require treating an unprovable
  // isolation claim as a conflict.
  return shorter.every((segment, index) => segment === longer[index]);
}

/** True when two write nodes share a path or a logical resource lock. */
export function writeConflict(left, right) {
  const sharedLocks = left.resourceLocks.filter((lock) => right.resourceLocks.includes(lock));
  const scopeHits = [];
  for (const leftScope of left.writeScope) {
    for (const rightScope of right.writeScope) {
      if (scopeOverlaps(leftScope, rightScope)) scopeHits.push(`${leftScope.raw} <-> ${rightScope.raw}`);
    }
  }
  return { locks: sharedLocks, scopes: scopeHits };
}

function reachable(edges, from, to) {
  const queue = [from];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of edges.get(current) ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function findCycle(byId) {
  const visiting = new Set();
  const done = new Set();
  const stack = [];
  const visit = (id) => {
    const node = byId.get(id);
    if (node === undefined) return null;
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    for (const next of node.dependsOn) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  for (const id of byId.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function topologicalOrder(byId) {
  const order = [];
  const visited = new Set();
  const visit = (id) => {
    const node = byId.get(id);
    if (node === undefined) return;
    if (visited.has(id)) return;
    visited.add(id);
    for (const next of node.dependsOn) visit(next);
    order.push(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return order;
}

function normalizeNode(raw, index, push) {
  if (!isObject(raw)) {
    push('TASK_DAG_NODE_NOT_OBJECT', `node[${index}] must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!DAG_NODE_KEYS.includes(key)) push('TASK_DAG_FIELD_UNKNOWN', `node[${index}] has unknown field ${key}`, 'warning');
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') {
    push('TASK_DAG_ID_MISSING', `node[${index}] has no id`);
    return null;
  }
  if (!idPattern.test(id)) push('TASK_DAG_ID_INVALID', `${id} must match ${idPattern}`);
  if (!NODE_KINDS.includes(raw.kind)) push('TASK_DAG_KIND_INVALID', `${id} kind must be one of ${NODE_KINDS.join(', ')}`);
  if (!isNonEmptyString(raw.output)) push('TASK_DAG_OUTPUT_MISSING', `${id} must declare an output`);
  if (!NODE_RESULTS.includes(raw.result)) push('TASK_DAG_RESULT_INVALID', `${id} result must be one of ${NODE_RESULTS.join(', ')}`);
  if (raw.cleanupPending !== undefined && typeof raw.cleanupPending !== 'boolean') {
    push('TASK_DAG_CLEANUP_INVALID', `${id} cleanupPending must be boolean`);
  }
  const trigger = raw.trigger ?? 'all_success';
  if (!NODE_TRIGGERS.includes(trigger)) push('TASK_DAG_TRIGGER_INVALID', `${id} trigger must be one of ${NODE_TRIGGERS.join(', ')}`);
  if (trigger === 'all_done' && raw.kind !== 'aggregate') {
    push('TASK_DAG_ALL_DONE_KIND', `${id} uses all_done; only an aggregate (fan-in, cleanup or failure report) node may settle on non-successful predecessors`);
  }
  const dependsOn = asStringArray(raw.dependsOn);
  if (new Set(dependsOn).size !== dependsOn.length) push('TASK_DAG_DEPENDENCY_DUPLICATE', `${id} lists a dependency twice`);
  if (dependsOn.includes(id)) push('TASK_DAG_SELF_DEPENDENCY', `${id} depends on itself`);

  const writeScope = [];
  for (const entry of asStringArray(raw.writeScope)) {
    const normalized = normalizeScopeEntry(entry);
    if (normalized === null) {
      push('TASK_DAG_SCOPE_INVALID', `${id} writeScope ${JSON.stringify(entry)} must be a project-relative path or a directory range ending in /**`);
      continue;
    }
    writeScope.push(normalized);
  }
  if (raw.kind === 'read' && writeScope.length > 0) push('TASK_DAG_READ_SCOPE', `${id} is a read node; writeScope must stay empty`);
  if (raw.kind === 'write' && writeScope.length === 0) push('TASK_DAG_WRITE_SCOPE_REQUIRED', `${id} is a write node; declare at least one writeScope entry`);

  const resourceLocks = asStringArray(raw.resourceLocks).map((lock) => lock.trim()).filter((lock) => lock !== '');
  if (new Set(resourceLocks).size !== resourceLocks.length) push('TASK_DAG_RESOURCE_LOCK_DUPLICATE', `${id} lists a resource lock twice`);
  const verification = asStringArray(raw.verification).map((item) => item.trim()).filter((item) => item !== '');
  if (verification.length === 0) push('TASK_DAG_VERIFICATION_MISSING', `${id} has no verification; every node needs a focused check or an explicit human judgement`, 'warning');

  return {
    dependsOn,
    id,
    kind: raw.kind,
    output: typeof raw.output === 'string' ? raw.output : '',
    resourceLocks,
    result: raw.result,
    cleanupPending: raw.cleanupPending === true,
    trigger,
    verification,
    writeScope,
  };
}

/**
 * Validate a Task DAG.
 *
 * @param {unknown} value `{schema, nodes}` or a bare node array
 * @returns {Record<string, any>} the analysis, including ready/blocked sets
 */
export function validateTaskDag(value, { batchEvidence = null } = {}) {
  const problems = [];
  const push = (code, message, severity = 'error') => problems.push({ code, message, severity });
  const nodes = Array.isArray(value) ? value : isObject(value) ? value.nodes : null;
  if (!Array.isArray(nodes)) {
    push('TASK_DAG_NOT_A_LIST', 'a Task DAG must be an array of nodes or an object with a nodes array');
    return finishDag({ nodes: [], problems });
  }
  if (isObject(value) && value.schema !== undefined && value.schema !== TASK_DAG_SCHEMA) {
    push('TASK_DAG_SCHEMA_UNSUPPORTED', `unsupported schema ${JSON.stringify(value.schema)}; expected ${TASK_DAG_SCHEMA}`);
  }
  const normalized = nodes.map((node, index) => normalizeNode(node, index, push)).filter((node) => node !== null);
  if (isObject(value) && value.executionBatch !== undefined) {
    const pointer = value.executionBatch;
    if (!batchEvidence?.ok || pointer?.parentId !== batchEvidence.parentId || pointer?.worktree !== batchEvidence.worktree) {
      push('TASK_DAG_BATCH_EVIDENCE_INVALID', 'Parent batch requires current evidence from its bound task worktree');
    } else {
      for (const member of batchEvidence.members) {
        const node = normalized.find((item) => item.id === member);
        const expected = batchEvidence.units.find((item) => item.id === member);
        if (!node || node.kind !== expected?.kind
          || JSON.stringify([...node.dependsOn].sort()) !== JSON.stringify([...(batchEvidence.dependencies[member] ?? [])].sort())
          || JSON.stringify(node.writeScope.map((scope) => scope.raw).sort()) !== JSON.stringify([...expected.files].sort())) {
          push('TASK_DAG_BATCH_PROJECTION_DRIFT', `${member} differs from the bound Parent plan`);
        }
      }
    }
  } else batchEvidence = null;
  const byId = new Map();
  for (const node of normalized) {
    if (byId.has(node.id)) push('TASK_DAG_DUPLICATE_ID', `${node.id} is declared twice`);
    else byId.set(node.id, node);
  }
  for (const node of byId.values()) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        push('TASK_DAG_UNKNOWN_PREDECESSOR', `${node.id} depends on ${dependency}, which is not a node in this DAG`);
      }
    }
  }
  const edges = new Map([...byId.keys()].map((id) => [id, []]));
  for (const node of byId.values()) {
    for (const dependency of node.dependsOn) {
      if (byId.has(dependency) && !edges.get(dependency).includes(node.id)) edges.get(dependency).push(node.id);
    }
  }
  const cycle = byId.size > 0 ? findCycle(byId) : null;
  if (cycle) push('TASK_DAG_CYCLE', `dependency cycle: ${cycle.join(' -> ')}`);

  const conflicts = [];
  const writeNodes = [...byId.values()].filter((node) => node.writeScope.length > 0 || node.resourceLocks.length > 0);
  for (let left = 0; left < writeNodes.length; left += 1) {
    for (let right = left + 1; right < writeNodes.length; right += 1) {
      const first = writeNodes[left];
      const second = writeNodes[right];
      const hit = writeConflict(first, second);
      // Runtime exclusivity is a scheduling concern, not a business dependency.
      // Overlapping writes still require explicit ownership/order.
      if (hit.scopes.length === 0) continue;
      const ordered = reachable(edges, first.id, second.id) || reachable(edges, second.id, first.id)
        || batchEvidence?.ok && batchEvidence.members.includes(first.id) && batchEvidence.members.includes(second.id);
      const detail = [
        hit.scopes.length > 0 ? `scope ${hit.scopes.join(', ')}` : null,
        hit.locks.length > 0 ? `resource lock ${hit.locks.join(', ')}` : null,
      ].filter(Boolean).join(' and ');
      if (ordered) {
        problems.push({
          code: 'TASK_DAG_SERIALIZED_CONFLICT',
          message: `${first.id} and ${second.id} share ${detail}; they are serialized by an explicit dependency`,
          severity: 'warning',
        });
      } else {
        conflicts.push({ code: hit.locks.length > 0 ? 'TASK_DAG_RESOURCE_LOCK_CONFLICT' : 'TASK_DAG_SCOPE_CONFLICT', detail, nodes: [first.id, second.id] });
        push(
          hit.locks.length > 0 ? 'TASK_DAG_RESOURCE_LOCK_CONFLICT' : 'TASK_DAG_SCOPE_CONFLICT',
          `${first.id} and ${second.id} share ${detail} without a dependency path; neither node is ready`,
        );
      }
    }
  }

  const dag = {
    byId,
    conflicts,
    edges,
    nodes: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    order: cycle ? null : topologicalOrder(byId),
    problems,
    batchEvidence,
  };
  return finishDag(dag);
}

function finishDag({ byId = new Map(), conflicts = [], nodes, order = null, problems, batchEvidence = null }) {
  const errors = problems.filter((problem) => problem.severity === 'error');
  const schedulingCodes = new Set(['TASK_DAG_SCOPE_CONFLICT', 'TASK_DAG_RESOURCE_LOCK_CONFLICT']);
  const structureValid = errors.every((problem) => schedulingCodes.has(problem.code));
  const readyComputed = structureValid && byId.size > 0;
  const scheduling = readyComputed ? scheduleNodes(byId, conflicts, batchEvidence) : { blocked: [], ready: [] };
  return {
    blocked: scheduling.blocked,
    conflictCount: conflicts.length,
    conflicts,
    counts: {
      aggregate: nodes.filter((node) => node.kind === 'aggregate').length,
      read: nodes.filter((node) => node.kind === 'read').length,
      write: nodes.filter((node) => node.kind === 'write').length,
    },
    errorCount: errors.length,
    nodeCount: nodes.length,
    nodes,
    ok: errors.length === 0,
    structureValid,
    order,
    problems: problems.sort((left, right) => left.code.localeCompare(right.code)),
    ready: scheduling.ready,
    readyComputed,
    schemaVersion: 1,
    structureHash: computeDagStructureHash(nodes, batchEvidence),
    ...(batchEvidence ? { batchEvidence } : {}),
    warningCount: problems.filter((problem) => problem.severity === 'warning').length,
  };
}

/** A node can be dispatched despite unrelated scheduling conflicts, never an invalid graph. */
function predecessorSatisfied(byId, batchEvidence, consumer, predecessor, trigger) {
  const result = byId.get(predecessor).result;
  if (trigger === 'all_done') return TERMINAL_RESULTS.includes(result);
  if (batchEvidence?.ok && batchEvidence.members.includes(consumer)) {
    if (batchEvidence.members.includes(predecessor)) {
      return batchPredecessorSatisfied(batchEvidence, consumer, predecessor);
    }
    const external = batchEvidence.externalDependencies.find((node) => node.id === predecessor);
    if (external) return external.result === 'succeeded' && SUCCESSFUL_RESULTS.includes(result);
  }
  return SUCCESSFUL_RESULTS.includes(result);
}

export function checkTaskDagNode(analysis, id) {
  if (!analysis.structureValid) return { id, ready: false, code: 'TASK_DAG_STRUCTURE_INVALID' };
  if (!analysis.nodes.some((node) => node.id === id)) return { id, ready: false, code: 'TASK_DAG_NODE_UNKNOWN' };
  if (analysis.ready.includes(id)) return { id, ready: true, code: 'TASK_DAG_NODE_READY' };
  return { id, ready: false, ...(analysis.blocked.find((node) => node.id === id)
    ?? { code: 'TASK_DAG_NODE_NOT_PENDING' }) };
}

function inconsistentPredecessor(byId, batchEvidence, id, visited = new Set()) {
  if (visited.has(id)) return null;
  visited.add(id);
  const node = byId.get(id);
  for (const predecessor of node.dependsOn) {
    if (!predecessorSatisfied(byId, batchEvidence, id, predecessor, node.trigger)) return predecessor;
    // An all_done report may consume a failed producer. Successful intermediate
    // nodes still have to satisfy their own triggers; self-reported success
    // cannot conceal an impossible all_success chain.
    if (SUCCESSFUL_RESULTS.includes(byId.get(predecessor).result)
      || batchPredecessorSatisfied(batchEvidence, id, predecessor)) {
      const invalid = inconsistentPredecessor(byId, batchEvidence, predecessor, visited);
      if (invalid) return invalid;
    }
  }
  return null;
}

function scheduleNodes(byId, conflicts, batchEvidence) {
  const ready = [];
  const blocked = [];
  for (const node of byId.values()) {
    if (!['pending', 'ready'].includes(node.result)) continue;
    if (batchEvidence?.ok && batchEvidence.localCompleted.includes(node.id)) continue;
    const waiting = [];
    const failed = [];
    for (const dependency of node.dependsOn) {
      const result = byId.get(dependency).result;
      if (predecessorSatisfied(byId, batchEvidence, node.id, dependency, node.trigger)) continue;
      // `blocked` and `unverified` are non-terminal, so those predecessors are
      // still pending resolution: the node waits instead of failing.
      if (['pending', 'ready', 'running', 'unverified', 'blocked'].includes(result)) waiting.push(`${dependency}=${result}`);
      else failed.push(`${dependency}=${result}`);
    }
    if (failed.length > 0) blocked.push({ code: 'TASK_DAG_PREDECESSOR_FAILED', id: node.id, reason: failed.join(', ') });
    else if (waiting.length > 0) blocked.push({ code: 'TASK_DAG_WAIT', id: node.id, reason: waiting.join(', ') });
    else {
      const inconsistent = inconsistentPredecessor(byId, batchEvidence, node.id);
      if (inconsistent) {
        blocked.push({ code: 'TASK_DAG_PREDECESSOR_NOT_SUCCESSFUL', id: node.id, predecessor: inconsistent });
        continue;
      }
      const occupied = [...byId.values()].filter((other) => other.id !== node.id
        && (other.cleanupPending || ['running', 'unverified'].includes(other.result)
          && !batchPredecessorSatisfied(batchEvidence, node.id, other.id)))
        .filter((other) => {
          const hit = writeConflict(node, other);
          return hit.locks.length > 0 || hit.scopes.length > 0;
        });
      if (occupied.length) blocked.push({ code: 'TASK_DAG_RESOURCE_OCCUPIED', id: node.id,
        reason: `resources retained by ${occupied.map((other) => other.id).sort().join(', ')}` });
      else ready.push(node.id);
    }
  }
  const readySet = new Set(ready);
  for (const conflict of conflicts) {
    const [first, second] = conflict.nodes;
    const pending = conflict.nodes.filter((id) => ['pending', 'ready', 'running', 'unverified', 'blocked'].includes(byId.get(id).result)
      || byId.get(id).cleanupPending);
    if (pending.length < 2) continue;
    for (const id of [first, second]) {
      if (!readySet.has(id)) continue;
      readySet.delete(id);
      blocked.push({ code: conflict.code, id, reason: `conflicts with ${id === first ? second : first}: ${conflict.detail}` });
    }
  }
  if (batchEvidence?.ok) {
    const candidates = [...readySet].filter((id) => batchEvidence.members.includes(id)).sort();
    const active = batchEvidence.units.some((unit) => unit.status === 'in_progress');
    for (const id of candidates.slice(active ? 0 : 1)) {
      readySet.delete(id);
      blocked.push({ code: 'TASK_DAG_BATCH_SINGLE_WRITER', id, reason: 'one Parent batch executes one member at a time' });
    }
  }
  // Reserve only for dispatchable nodes: a scope conflict or batch restriction
  // must not let a blocked node retain an otherwise available runtime resource.
  const reserved = new Set();
  for (const id of [...readySet].sort()) {
    const locks = byId.get(id).resourceLocks;
    if (locks.some((lock) => reserved.has(lock))) {
      readySet.delete(id);
      blocked.push({ code: 'TASK_DAG_RESOURCE_WAIT', id, reason: 'runtime resource reserved by another ready node' });
    } else locks.forEach((lock) => reserved.add(lock));
  }
  return { blocked: blocked.sort((left, right) => left.id.localeCompare(right.id)), ready: [...readySet].sort() };
}

/**
 * Deterministic hash of the DAG structure (ids, kinds, edges, scopes, locks,
 * verification) for the pre-dispatch re-check and checkpoint fields.
 */
export function computeDagStructureHash(nodes, batchEvidence = null) {
  const canonical = [...nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => ({
      dependsOn: [...node.dependsOn].sort(),
      id: node.id,
      kind: node.kind,
      resourceLocks: [...node.resourceLocks].sort(),
      trigger: node.trigger,
      verification: [...node.verification].sort(),
      writeScope: node.writeScope.map((scope) => `${scope.kind}:${scope.path.toLowerCase()}`).sort(),
    }));
  return createHash('sha256').update(JSON.stringify(batchEvidence
    ? { nodes: canonical, batch: { parentId: batchEvidence.parentId, membershipDigest: batchEvidence.membershipDigest } }
    : canonical)).digest('hex');
}

/** Human-readable summary of a Task DAG analysis. */
export function summarizeTaskDag(analysis) {
  const lines = [
    `status: ${analysis.ok ? 'passed' : 'failed'}`,
    `nodes: ${analysis.nodeCount} (read ${analysis.counts.read}, write ${analysis.counts.write}, aggregate ${analysis.counts.aggregate})`,
    `structure hash: ${analysis.structureHash.slice(0, 16)}`,
  ];
  if (analysis.order) lines.push(`order: ${analysis.order.join(' -> ')}`);
  if (analysis.readyComputed) {
    lines.push(`ready: ${analysis.ready.length > 0 ? analysis.ready.join(', ') : '(none)'}`);
    for (const node of analysis.blocked) lines.push(`blocked: ${node.id} ${node.code} ${node.reason}`);
  } else lines.push('ready: not computed (the DAG is invalid)');
  for (const problem of analysis.problems) lines.push(`${problem.severity}: ${problem.code} ${problem.message}`);
  return lines.join('\n');
}
