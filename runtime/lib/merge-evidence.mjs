import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { gitFingerprint } from './git-fingerprint.mjs';
import { validateCompletion } from './delivery.mjs';

function git(project, args, input = undefined) {
  const result = spawnSync('git', args, { cwd: project, input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Git evidence could not be read');
  return result.stdout.trim();
}

function patchId(project, before, after) {
  const diff = git(project, ['diff', '--no-ext-diff', '--no-textconv', '--binary', before, after, '--']);
  const result = git(project, ['patch-id', '--stable'], diff);
  if (!result) throw new Error('Empty patch cannot prove a squash merge');
  return result.split(/\s/u)[0];
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
    if (git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Dirty worktree');
    const current = await gitFingerprint(worktree);
    const completion = validateCompletion(receipt, delivery, current);
    if (completion.status !== 'passed') throw new Error(completion.errors.join('; '));
    if (receipt.target?.head !== evidence.targetAfter) throw new Error('Receipt target does not match merge evidence');
    if (git(project, ['rev-parse', '--verify', targetRef]) !== evidence.targetAfter
      || git(worktree, ['rev-parse', 'HEAD']) !== sourceHead) throw new Error('Refs changed during evidence validation');
    return { status: 'passed', evidence };
  } catch (error) {
    return { status: 'blocked', code: 'MERGE_EVIDENCE_BLOCKED', reason: error.message };
  }
}
