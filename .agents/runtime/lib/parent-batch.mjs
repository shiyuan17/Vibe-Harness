// Parent batches share one writer and one source. Local completion is evidence
// for execution only; it never changes Linear status or the DAG result enum.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { runGit, safeRealpath, stableStringify } from './cli-runtime.mjs';
import { attestCompletionProvenance } from './verification-receipt.mjs';

const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const digest = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const associatesIssue = (subject, id) => subject.split(/[^A-Za-z0-9._-]+/u).includes(id);
const location = (value) => {
  const resolved = (safeRealpath(value) ?? path.resolve(value)).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Validate the optional plan-units extension before binding or syncing it. */
export function parentBatchContract(raw, units) {
  if (raw === undefined) return { batch: null, errors: [] };
  const errors = [];
  const fail = (message) => errors.push(`parent batch: ${message}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { batch: null, errors: ['parent batch must be an object'] };
  if (!idPattern.test(raw.parentId ?? '')) fail('parentId is invalid');
  if (!Array.isArray(raw.members) || raw.members.length === 0 || raw.members.length > 500
    || raw.members.some((id) => typeof id !== 'string' || !idPattern.test(id))
    || new Set(raw.members).size !== raw.members.length) fail('members must be unique required descendant IDs (1..500)');
  const members = Array.isArray(raw.members) ? raw.members : [];
  if (members.includes(raw.parentId)) fail('the aggregate Parent cannot be its own member');
  if (members.length !== units.length || units.some((unit) => !members.includes(unit.id))) fail('members must match the plan execution units exactly');
  if (units.some((unit) => !['write', 'read', 'aggregate'].includes(unit.kind ?? 'write')
    || unit.deliveredCommit !== undefined && !shaPattern.test(unit.deliveredCommit))) fail('member kind or deliveredCommit is invalid');
  if (typeof raw.worktree !== 'string' || !path.isAbsolute(raw.worktree)) fail('worktree must be absolute');
  if (typeof raw.branch !== 'string' || !raw.branch || ['develop', 'main'].includes(raw.branch)
    || /[\s~^:?*[\]\\]/u.test(raw.branch) || raw.branch.includes('..')) fail('branch must name a task branch');
  if (raw.targetRef !== 'refs/heads/develop') fail('targetRef must be refs/heads/develop');
  if (!shaPattern.test(raw.baseSha ?? '')) fail('baseSha must be a full Git SHA');
  const external = raw.externalDependencies ?? [];
  if (!Array.isArray(external) || external.length > 500) fail('externalDependencies must be an array (at most 500)');
  const nodes = new Map(units.map((unit) => [unit.id, { id: unit.id, dependsOn: unit.dependsOn ?? [] }]));
  for (const node of Array.isArray(external) ? external : []) {
    if (!idPattern.test(node?.id ?? '') || nodes.has(node.id) || node.id === raw.parentId
      || !Array.isArray(node.dependsOn) || node.dependsOn.some((id) => typeof id !== 'string')
      || !['pending', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'].includes(node.result)) {
      fail('external dependency snapshot is malformed or duplicated');
      continue;
    }
    nodes.set(node.id, node);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) { fail(`dependency cycle: ${[...trail, id].join(' -> ')}`); return; }
    if (visited.has(id)) return;
    if (!nodes.has(id)) { fail(`unknown predecessor ${id}`); return; }
    visiting.add(id);
    for (const next of nodes.get(id).dependsOn) visit(next, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id, []);
  // Contracting the batch to one delivery boundary can create a cycle in an
  // otherwise acyclic Issue graph: A1 -> outside -> A2 must not deadlock.
  for (const unit of units) {
    const walk = (id, seen = new Set()) => {
      if (members.includes(id)) return id;
      if (seen.has(id) || !nodes.has(id)) return null;
      seen.add(id);
      for (const next of nodes.get(id).dependsOn) {
        const hit = walk(next, seen);
        if (hit) return hit;
      }
      return null;
    };
    for (const predecessor of unit.dependsOn ?? []) {
      if (members.includes(predecessor)) continue;
      const hit = walk(predecessor);
      if (hit) fail(`delivery cycle: ${unit.id} waits for ${predecessor}, which waits for batch member ${hit}`);
    }
  }
  if (errors.length) return { batch: null, errors };
  const batch = {
    parentId: raw.parentId, members: [...members].sort(), worktree: raw.worktree,
    branch: raw.branch, targetRef: raw.targetRef, baseSha: raw.baseSha,
    externalDependencies: [...external].sort((a, b) => a.id.localeCompare(b.id)),
  };
  batch.membershipDigest = digest({ parentId: batch.parentId, members: batch.members,
    dependencies: [...nodes.values()].map(({ id, dependsOn }) => ({ id, dependsOn: [...dependsOn].sort() })).sort((a, b) => a.id.localeCompare(b.id)) });
  return { batch, errors };
}

export function sameParentBatch(left, right) {
  return left && right && stableStringify(left) === stableStringify(right);
}

export async function parentBatchWorkspace(projectDir, batch) {
  if (location(projectDir) !== location(batch.worktree)) return { ok: false, reason: 'batch-worktree-mismatch' };
  const [branch, head, dirty, base] = await Promise.all([
    runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], projectDir),
    runGit(['rev-parse', 'HEAD'], projectDir),
    runGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], projectDir),
    runGit(['merge-base', '--is-ancestor', batch.baseSha, 'HEAD'], projectDir),
  ]);
  if (!branch.ok || branch.stdout.trim() !== batch.branch) return { ok: false, reason: 'batch-branch-mismatch' };
  if (!head.ok || !base.ok) return { ok: false, reason: 'batch-base-not-ancestor' };
  if (!dirty.ok || dirty.stdout !== '') return { ok: false, reason: 'batch-worktree-dirty' };
  return { ok: true, head: head.stdout.trim() };
}

/** Historical evidence stays historical: do not compare it to the current tree. */
export async function localCompletionValid(projectDir, anchor, unit, configured) {
  const batch = anchor.executionBatch;
  const proof = unit?.localCompletion;
  const sameContract = proof?.unitContractDigest && proof.unitContractDigest === anchor.unitContracts?.[unit.id];
  if (!batch || !proof || unit.status !== 'done' || !batch.members.includes(unit.id)
    || proof.parentId !== batch.parentId || proof.membershipDigest !== batch.membershipDigest
    || proof.unitId !== unit.id || proof.planDigest !== anchor.planDigest && !sameContract || !shaPattern.test(proof.commit ?? '')
    || !shaPattern.test(proof.tree ?? '') || configured.error
    || proof.checkDefinitionsDigest !== digest({ commands: configured.commands, definitions: configured.definitions })) return false;
  const receipt = proof.receipt;
  const verification = receipt?.verification;
  if (verification?.task?.id !== anchor.taskId || verification.task.unitId !== unit.id
    || verification.task.planDigest !== anchor.planDigest && !(sameContract && verification.task.unitContractDigest === proof.unitContractDigest)
    || verification.verifiedTree !== proof.tree || verification.snapshotComparison !== 'match'
    || !['passed', 'reused'].includes(receipt.status)) return false;
  const checks = Object.entries(receipt.checks ?? {}).filter(([, check]) => typeof check.command === 'string');
  if (!checks.length || checks.some(([name, check]) => !['passed', 'reused'].includes(check.status)
    || configured.commands[name] !== check.command
    || (configured.definitions[name]?.cwd ?? '.') !== (check.cwd ?? '.'))) return false;
  const [ancestor, tree, provenance] = await Promise.all([
    runGit(['merge-base', '--is-ancestor', proof.commit, 'HEAD'], projectDir),
    runGit(['rev-parse', `${proof.verifiedCommit}^{tree}`], projectDir),
    attestCompletionProvenance(projectDir, receipt),
  ]);
  const verifiedAncestor = shaPattern.test(proof.verifiedCommit ?? '')
    && (await runGit(['merge-base', '--is-ancestor', proof.verifiedCommit, 'HEAD'], projectDir)).ok;
  return ancestor.ok && verifiedAncestor && tree.ok && tree.stdout.trim() === proof.tree && provenance.ok;
}

/** Called after commit with the verify report of the exact staged/clean tree. */
export async function bindLocalCompletion(projectDir, anchor, unit, receipt, configured) {
  const workspace = await parentBatchWorkspace(projectDir, anchor.executionBatch);
  if (!workspace.ok) throw new Error(workspace.reason);
  const tree = await runGit(['rev-parse', 'HEAD^{tree}'], projectDir);
  if (!tree.ok || receipt.verification?.verifiedTree !== tree.stdout.trim()) throw new Error('verified-tree-does-not-match-commit; reverify after Hook changes');
  const prior = unit.localCompletion?.commits ?? [];
  let ownedCommit = workspace.head;
  if ((unit.kind ?? 'write') === 'write') {
    let subject = await runGit(['show', '-s', '--format=%B', ownedCommit], projectDir);
    if (!subject.ok || !associatesIssue(subject.stdout, unit.id)) {
      ownedCommit = unit.localCompletion?.commit ?? unit.deliveredCommit;
      if (!shaPattern.test(ownedCommit ?? '')) throw new Error('commit must be a Conventional Commit associated with the Issue');
      if (unit.deliveredCommit && !prior.length
        && !(await runGit(['merge-base', '--is-ancestor', ownedCommit, anchor.executionBatch.baseSha], projectDir)).ok) {
        throw new Error('already delivered commit must be an ancestor of the frozen base');
      }
      subject = await runGit(['show', '-s', '--format=%B', ownedCommit], projectDir);
    }
    const paths = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', ownedCommit], projectDir);
    if (!subject.ok || !/^[a-z]+(?:\([^)]+\))?!?: .+/u.test(subject.stdout)
      || !associatesIssue(subject.stdout, unit.id)) throw new Error('commit must be a Conventional Commit associated with the Issue');
    const changed = paths.ok ? paths.stdout.split('\0').filter(Boolean) : [];
    const matches = (file) => unit.files.some((scope) => {
      const normalized = scope.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
      const candidate = file.toLowerCase();
      return normalized.endsWith('/**') ? candidate.startsWith(normalized.slice(0, -2)) : candidate === normalized;
    });
    if (!changed.length || changed.some((file) => !matches(file))) throw new Error('commit paths exceed the declared Issue scope');
    if (anchor.units.some((other) => other.id !== unit.id && (other.kind ?? 'write') === 'write'
      && other.localCompletion?.commits?.includes(ownedCommit))) throw new Error('one write commit cannot close multiple Issues');
  }
  for (const commit of prior) {
    if (!(await runGit(['merge-base', '--is-ancestor', commit, 'HEAD'], projectDir)).ok) throw new Error('previous Issue commits must retain their SHA');
  }
  const proof = {
    parentId: anchor.executionBatch.parentId, unitId: unit.id, membershipDigest: anchor.executionBatch.membershipDigest,
    planDigest: anchor.planDigest, unitContractDigest: anchor.unitContracts?.[unit.id] ?? null,
    commit: ownedCommit, verifiedCommit: workspace.head, tree: tree.stdout.trim(),
    commits: [...new Set([...prior, ownedCommit])],
    checkDefinitionsDigest: digest({ commands: configured.commands, definitions: configured.definitions }),
    receipt: { command: receipt.command, status: receipt.status, verification: receipt.verification,
      checks: Object.fromEntries(Object.entries(receipt.checks ?? {}).map(([name, check]) => [name, {
        status: check.status, command: check.command, cwd: check.cwd ?? '.',
      }])) },
  };
  if (!await localCompletionValid(projectDir, anchor, { ...unit, status: 'done', localCompletion: proof }, configured)) {
    const provenance = await attestCompletionProvenance(projectDir, proof.receipt);
    throw new Error(`local completion lacks authenticated verification for this task, plan and check definitions (${provenance.reason})`);
  }
  return proof;
}

// The same predicate serves task dispatch and the optional Task DAG projection.
export function batchPredecessorSatisfied(batchEvidence, consumer, predecessor) {
  return Boolean(batchEvidence?.ok && consumer !== batchEvidence.parentId
    && batchEvidence.members.includes(consumer) && batchEvidence.members.includes(predecessor)
    && batchEvidence.localCompleted.includes(predecessor));
}

/** Discover only bound anchors in this source worktree, never a Linear queue. */
export async function boundParentBatches(projectDir) {
  const directory = path.join(projectDir, '.vibe-harness/tasks');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const batches = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const anchor = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (anchor.executionBatch) batches.push(anchor.executionBatch);
  }
  return batches;
}

/** Read the existing durable publish confirmation; no new delivery database. */
export async function parentBatchPublication(projectDir, anchor) {
  const common = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!common.ok) return null;
  const directory = path.resolve(projectDir, common.stdout.trim());
  for (const name of await readdir(directory)) {
    if (!/^vibe-harness-land-batch-[0-9a-f-]+\.json$/u.test(name)) continue;
    let state;
    try { state = JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    const source = state.sources?.find((item) => item.id === anchor.taskId);
    if (!['integrated', 'integrated_cleanup_pending'].includes(state.integrationStatus)
      || !shaPattern.test(state.remoteConfirmedHead ?? '') || !state.integration?.verificationId
      || source?.executionBatch?.membershipDigest !== anchor.executionBatch.membershipDigest
      || source?.executionBatch?.planDigest !== anchor.planDigest) continue;
    const preserved = await runGit(['merge-base', '--is-ancestor', source.head, state.remoteConfirmedHead], projectDir);
    const current = await runGit(['rev-parse', 'HEAD'], projectDir);
    if (preserved.ok && current.ok && current.stdout.trim() === source.head) {
      return { batchId: state.id, remoteConfirmedHead: state.remoteConfirmedHead, integrationStatus: state.integrationStatus };
    }
  }
  return null;
}
