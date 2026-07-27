import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { inspectSubagentReceipts } from '../../runtime/hooks/lib/subagent-receipts.mjs';

const roleTargets = {
  reviewer: '.codex/agents/cognis_reviewer.toml',
  tester: '.codex/agents/cognis_tester.toml',
};

async function roleStatus(targetDir, relativeTarget, plannedTargets) {
  if (plannedTargets?.includes(relativeTarget)) return 'planned';
  try {
    const stat = await lstat(path.join(targetDir, relativeTarget));
    return stat.isFile() && !stat.isSymbolicLink() ? 'installed' : 'invalid';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    return 'invalid';
  }
}

export async function inspectSubagentHealth({ adapter, plannedTargets, profile, targetDir }) {
  const support = adapter.capabilities?.subagents ?? 'unsupported';
  const enabled = profile === 'full';
  const roles = Object.fromEntries(await Promise.all(Object.entries(roleTargets).map(async ([name, target]) => [
    name,
    await roleStatus(targetDir, target, plannedTargets),
  ])));
  const inspected = await inspectSubagentReceipts(targetDir);
  const receipts = {
    status: inspected.status,
    started: inspected.counts.started,
    continuationRequested: inspected.counts.continuationRequested,
    sealed: inspected.counts.sealed,
    invalid: inspected.counts.invalid + inspected.reasons.length,
  };
  if (!enabled) return {
    support,
    status: 'disabled',
    roles,
    receipts,
    reason: 'The selected profile does not install independent subagent roles.',
  };
  if (support === 'unsupported') return {
    support,
    status: 'degraded',
    roles,
    receipts,
    reason: `${adapter.id} does not implement native Cognis subagent roles; record independent manual-equivalent Tester and Reviewer evidence before completing a full task.`,
  };
  if (Object.values(roles).some((status) => status === 'invalid') || inspected.status === 'invalid') return {
    support,
    status: 'invalid',
    roles,
    receipts,
    reason: 'Subagent role files or project-local receipts are malformed or traverse an unsafe path.',
  };
  if (Object.values(roles).every((status) => ['installed', 'planned'].includes(status))) return {
    support,
    status: Object.values(roles).includes('planned') ? 'planned' : 'ready',
    roles,
    receipts,
    reason: 'Independent Tester and Reviewer roles are available; v2 receipts record host-observed runs separately without claiming strong authentication against a workspace writer.',
  };
  return {
    support,
    status: 'missing',
    roles,
    receipts,
    reason: 'The full profile is missing one or more required Codex subagent role files.',
  };
}
