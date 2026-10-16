#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { completionReceipt, overrideWarnings, resolveDelivery } from '../lib/delivery.mjs';
import { serviceReport } from '../lib/services.mjs';

import { redactText, summary } from '../lib/cli-output.mjs';
import { PASS_STATUSES, SCHEMA_VERSION, assertSafeCommand, changesReport, envReport, parseArgs, projectContext, readProjectConfig, safeRealpath } from '../lib/cli-runtime.mjs';
import { patchReport, sliceReport } from '../lib/file-edit-command.mjs';
import { readTaskAnchor, taskCheckpointReport, taskReport } from '../lib/task-command.mjs';
import { verifyProject } from '../lib/verification-command.mjs';
import { worktreeReport } from '../lib/worktree-command.mjs';

// The entry file keeps its published surface across the split: host adapters and
// tests import `runCommand`, `main` and these helpers from this path, so the
// moved declarations are re-exported instead of duplicated.
export { assertSafeCommand };
export { landLockTimeoutMs } from '../lib/worktree-command.mjs';

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
    worktree: 'run.mjs worktree <list|check|bootstrap|land|cleanup|recover> --project <path>: bootstrap, land, cleanup and recover stay dry-run until --write; bootstrap does not fetch and starts from the configured base ref, without copying dirty primary code; land serializes writes through a shared Git common-dir lock, merges the attributed worktree in an isolated candidate (--no-ff) and verifies it (quick tier by default, standard when the task anchor declares riskLevel full); the default land fast-forwards a clean primary checkout, while --target-mode remote requires --delivery local-land --base-ref develop and --write --push, verifies origin/develop SHA and pushes the detached candidate without updating the primary checkout (local develop must have no unpushed commits); --write --no-verify is rejected; after confirmed push it cleans up the worktree and branch; cleanup refuses branches not merged into worktree.baseRef; recover reclaims clean attributed candidate residue and bootstrap crash residue but never deletes a branch that moved past the base ref',
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
