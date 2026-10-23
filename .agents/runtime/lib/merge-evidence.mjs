import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gitFingerprint } from './git-fingerprint.mjs';
import { validateCompletion } from './delivery.mjs';
import { attestCompletionProvenance } from './verification-receipt.mjs';

/**
 * Read every SHA the way the repository actually stored it.
 *
 * `refs/replace/*` is local configuration that changes what a SHA resolves to,
 * so evidence read through it can describe a different commit than the target
 * ref holds — a replacement ref could present an unrelated squash as the merge
 * of this branch.
 */
const NO_REPLACE_OBJECTS = ['--no-replace-objects'];

function git(project, args, input = undefined) {
  const result = spawnSync('git', [...NO_REPLACE_OBJECTS, ...args], { cwd: project, input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Git evidence could not be read');
  return result.stdout.trim();
}

/**
 * Raw stdout of one Git command.
 *
 * Command outputs that carry content — a diff's changed lines — must not be
 * trimmed: `+value   ` and `+value` are different patches, and trimming the
 * final line would make the exact-content digest agree with `patch-id`'s
 * whitespace-insensitive identity again.
 */
function gitRaw(project, args, input = undefined) {
  const result = spawnSync('git', [...NO_REPLACE_OBJECTS, ...args], { cwd: project, input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Git evidence could not be read');
  return result.stdout;
}

function patchId(project, before, after) {
  const diff = gitRaw(project, ['diff', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--']);
  const result = git(project, ['patch-id', '--stable'], diff);
  if (!result) throw new Error('Empty patch cannot prove a squash merge');
  return result.split(/\s/u)[0];
}

/**
 * The changed content of a diff, independent of hunk offsets.
 *
 * `git patch-id --stable` deliberately ignores whitespace, so a source patch
 * that adds `a b` and a target patch that adds `ab` share one id. Hashing the
 * exact `+`/`-` lines closes that gap while staying tolerant of a target branch
 * that shifted the hunks: only the changed content has to match, not where it
 * landed.
 *
 * Git's `\ No newline at end of file` marker is part of that content, not
 * decoration: a patch that ends a file without a trailing newline differs from
 * one that adds the same line with a newline, and `patch-id` ignores exactly
 * that difference.
 *
 * A binary change has no `+`/`-` lines at all — its payload is the
 * `GIT binary patch` literal/delta block — so those lines are part of the
 * content too. Without them two different binary edits to one path would share
 * a digest.
 */
function patchContentDigest(project, before, after) {
  const diff = gitRaw(project, ['diff', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--']);
  const content = diff
    .split('\n')
    .filter((line) => /^(?:diff --git |new file mode|deleted file mode|old mode|new mode|rename from|rename to|similarity index|\+\+\+ |--- |\+|-|\\ No newline at end of file$|GIT binary patch$|literal [0-9]+$|delta [0-9]+$|[A-Za-z0-9+/=]{4,}$)/u.test(line))
    .join('\n');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The tree Git produces by merging the source branch onto the target base.
 *
 * The patch identity and the content digest are both location-free: within one
 * file, two identical regions are interchangeable to them, so a squash that
 * changed the other occurrence would still compare equal. Reproducing the merge
 * closes that gap — the squash commit has to carry exactly the tree a merge of
 * `sourceHead` onto `targetBefore` produces. A merge that conflicts cannot
 * reproduce a squash at all and blocks, and so does a Git without
 * `merge-tree --write-tree`: the patch checks it would leave standing are
 * location-free, so treating them as the whole proof would let a squash that
 * changed the wrong occurrence of identical content authorize a cleanup.
 */
function mergeResultTree(project, targetBefore, sourceHead) {
  const result = spawnSync('git', [...NO_REPLACE_OBJECTS, 'merge-tree', '--write-tree', targetBefore, sourceHead], {
    cwd: project, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error('Git evidence could not be read');
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (/unknown option|usage: git/iu.test(detail)) {
      throw new Error('Git is too old to reproduce the merge tree this evidence requires');
    }
    throw new Error('Squash is not reproducible by merging the source branch');
  }
  const [tree] = String(result.stdout ?? '').trim().split('\n');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree ?? '')) throw new Error('Merge result tree unavailable');
  return tree;
}

export async function readMergeEvidence(project, { file, mr }) {
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  if (!/^[1-9][0-9]*$/u.test(mr ?? '')) throw new Error('merge evidence or a GitLab MR iid is required');
  const result = spawnSync('glab', ['mr', 'view', mr, '--output', 'json'], {
    cwd: project, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('GitLab MR read unavailable');
  const data = JSON.parse(result.stdout);
  if (data.state !== 'merged' || !/^[a-f0-9]{40,64}$/u.test(data.squash_commit_sha ?? '')
    || !data.diff_refs?.base_sha || !data.diff_refs?.head_sha) throw new Error('GitLab MR is not a proven squash merge');
  const mergeCommit = data.squash_commit_sha;
  const targetBefore = git(project, ['rev-parse', '--verify', `${mergeCommit}^`]);
  return {
    sourceBase: data.diff_refs.base_sha, sourceHead: data.diff_refs.head_sha,
    targetRef: `origin/${data.target_branch}`, targetBefore, targetAfter: mergeCommit,
    mergeMethod: 'squash', mergeCommit, patchId: patchId(project, targetBefore, mergeCommit),
  };
}

export async function validateMergeEvidence(project, worktree, evidence, { taskId, targetRef, sourceHead, delivery, receipt }) {
  try {
    const required = ['sourceBase', 'sourceHead', 'targetRef', 'targetBefore', 'targetAfter', 'mergeMethod', 'mergeCommit', 'patchId', 'taskId'];
    if (!evidence || required.some((key) => typeof evidence[key] !== 'string' || !evidence[key])) throw new Error('Merge evidence fields are missing');
    for (const key of ['sourceBase', 'sourceHead', 'targetBefore', 'targetAfter', 'mergeCommit']) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(evidence[key])) throw new Error('Merge evidence requires immutable commit SHAs');
      if (git(project, ['rev-parse', '--verify', `${evidence[key]}^{commit}`]) !== evidence[key]) throw new Error('Commit evidence unavailable');
    }
    if (evidence.taskId !== taskId || evidence.sourceHead !== sourceHead || evidence.targetRef !== targetRef
      || evidence.mergeMethod !== 'squash') throw new Error('Merge evidence identity mismatch');
    if (evidence.targetAfter !== evidence.mergeCommit) throw new Error('Recollect evidence at the squash merge boundary; later target commits cannot prove the patch remains present');
    if (git(project, ['rev-parse', '--verify', targetRef]) !== evidence.targetAfter) throw new Error('Target ref drifted');
    git(project, ['merge-base', '--is-ancestor', evidence.sourceBase, sourceHead]);
    if (git(project, ['merge-base', sourceHead, evidence.targetBefore]) !== evidence.sourceBase) throw new Error('sourceBase does not cover the entire source branch');
    git(project, ['merge-base', '--is-ancestor', evidence.mergeCommit, evidence.targetAfter]);
    const parents = git(project, ['show', '-s', '--format=%P', evidence.mergeCommit]).split(' ');
    if (parents.length !== 1 || parents[0] !== evidence.targetBefore) throw new Error('Squash parent does not match targetBefore');
    const sourcePatch = patchId(project, evidence.sourceBase, sourceHead);
    const targetPatch = patchId(project, evidence.targetBefore, evidence.mergeCommit);
    if (sourcePatch !== targetPatch || sourcePatch !== evidence.patchId) throw new Error('Patch identity mismatch');
    if (patchContentDigest(project, evidence.sourceBase, sourceHead)
      !== patchContentDigest(project, evidence.targetBefore, evidence.mergeCommit)) throw new Error('Patch content mismatch');
    const mergedTree = mergeResultTree(project, evidence.targetBefore, evidence.sourceHead);
    if (mergedTree !== git(project, ['rev-parse', '--verify', `${evidence.mergeCommit}^{tree}`])) {
      throw new Error('Squash tree is not the merge of the source branch');
    }
    // The cleanliness gate owns the removal decision, so it cannot be weakened
    // by the repository's own configuration: `submodule.<name>.ignore` (or
    // `.gitmodules`) would hide uncommitted submodule work from this status and
    // let the cleanup delete it.
    if (git(worktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) throw new Error('Dirty worktree');
    const current = await gitFingerprint(worktree);
    if (delivery.requireReceipt) {
      const completion = validateCompletion(receipt, delivery, current,
        { provenance: await attestCompletionProvenance(worktree, receipt) });
      if (completion.status !== 'passed') throw new Error(completion.errors.join('; '));
      if (receipt?.target?.head !== evidence.targetAfter) throw new Error('Receipt target does not match merge evidence');
    }
    // The receipt was validated against the state read above; a concurrent write
    // after that read would leave the refs unchanged while the accepted evidence
    // is already stale, so the worktree state is read once more before the
    // validation is reported as passed.
    const final = await gitFingerprint(worktree);
    if (git(project, ['rev-parse', '--verify', targetRef]) !== evidence.targetAfter
      || git(worktree, ['rev-parse', 'HEAD']) !== sourceHead
      || git(worktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
      || final.fingerprint !== current.fingerprint
      || final.writeFingerprint !== current.writeFingerprint) throw new Error('Refs or worktree changed during evidence validation');
    return { status: 'passed', evidence };
  } catch (error) {
    return { status: 'blocked', code: 'MERGE_EVIDENCE_BLOCKED', reason: error.message };
  }
}
