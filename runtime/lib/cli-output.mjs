// Output shaping and redaction for the project-level deterministic CLI.
//
// `redactText`/`boundedOutput` are the single place where a value leaving the CLI is
// stripped of the project path and of credential-looking assignments; `summary` is the
// human-readable projection of a report object, so every command module shapes its
// receipt here instead of formatting strings inline.
//
// Extracted verbatim from `runtime/commands/run.mjs` so that file keeps only
// argument parsing, dispatch and output selection. Behaviour, field names and
// exit codes are unchanged; only the module boundary moved.
import path from 'node:path';

export const MAX_OUTPUT_CHARS = 8 * 1024;
const sensitiveKeyPattern = /(?:api[-_]?key|auth(?:orization|token)?|cookie|credential|password|secret|session|token|username)/iu;
export function normalizePath(value) {
  return String(value).replaceAll('\\', '/');
}
export function redactText(value, targetDir) {
  if (value === undefined || value === null) return '';
  const projectPath = path.resolve(targetDir);
  let result = String(value);
  for (const variant of [projectPath, normalizePath(projectPath)]) {
    result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '<project>');
  }
  return result
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:api[-_]?key|password|secret|token)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/\b([a-z0-9_-]*(?:api[-_]?key|auth(?:orization|token)?|cookie|credential|password|secret|session|token|username)[a-z0-9_-]*=)[^\s/]+/giu, '$1[REDACTED]')
    .trim();
}
export function boundedOutput(value, targetDir) {
  const text = redactText(value, targetDir);
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}
function patchSummary(report) {
  const lines = [`command: ${report.command}`, `status: ${report.status}`];
  if (report.file) lines.push(`file: ${report.file}`);
  if (report.error) lines.push(`error: ${report.error}`);
  for (const op of report.ops ?? []) {
    lines.push(`op[${op.index}] ${op.kind}: ${op.status}${op.startLine ? ` at line ${op.startLine}` : ''}`);
  }
  if (report.written === false && report.status !== 'failed') lines.push('dry run: pass --write to apply');
  return lines.join('\n');
}
function taskSummary(report) {
  const lines = [`command: task ${report.subcommand ?? ''}`.trim(), `status: ${report.status}`];
  if (report.error) {
    lines.push(`error: ${report.error}`);
    return lines.join('\n');
  }
  if (report.path) lines.push(`path: ${report.path}`);
  if (report.taskId) lines.push(`taskId: ${report.taskId}`);
  if (report.subcommand === 'init' || report.subcommand === 'update') {
    const anchor = report.anchor ?? {};
    lines.push(`title: ${anchor.title ?? ''}`);
    lines.push(`stage: ${anchor.stage ?? ''}`);
    lines.push(`riskLevel: ${anchor.riskLevel ?? ''}`);
    if (report.subcommand === 'update') {
      lines.push(`changed: ${report.changed ? 'yes' : 'no'}`);
      if ((report.changes ?? []).length > 0) lines.push(`changes: ${report.changes.join(', ')}`);
    }
    lines.push(`units: ${Array.isArray(anchor.units) ? anchor.units.length : 0}`);
    lines.push(`decisions: ${Array.isArray(anchor.decisions) ? anchor.decisions.length : 0}`);
    lines.push(`blockers: ${Array.isArray(anchor.blockers) ? anchor.blockers.length : 0}`);
    if (anchor.nextAction) lines.push(`nextAction: ${anchor.nextAction}`);
    if (report.written === false && report.status !== 'failed') lines.push('dry run: pass --write to apply');
    return lines.join('\n');
  }
  if (report.subcommand === 'status') {
    lines.push(`stage: ${report.stage ?? ''}`);
    lines.push(`goal: ${report.goal ?? ''}`);
    for (const unit of report.units ?? []) {
      lines.push(`unit ${unit.id}: ${unit.status ?? 'unknown'}${unit.verification ? ' (verified)' : ''}`);
    }
    if ((report.pendingUnits ?? []).length > 0) lines.push(`pendingUnits: ${report.pendingUnits.join(', ')}`);
    if (report.nextAction) lines.push(`nextAction: ${report.nextAction}`);
    if (report.recovery) lines.push(`recovery: ${report.recovery.status}${report.recovery.drift?.length ? ` (${report.recovery.drift.join(', ')})` : ''}`);
    if (report.latestCheckpoint?.latestVerification) {
      const verification = report.latestCheckpoint.latestVerification;
      lines.push(`latestVerification: ${verification.id ?? 'unknown'} ${verification.finishedAt ?? ''}`);
    }
    for (const blocker of report.blockers ?? []) lines.push(`blocker: ${blocker}`);
    if (report.failures?.length) lines.push(`failures: ${report.failures.length} (see --json for details)`);
    lines.push(`resumeHint: ${report.resumeHint}`);
    return lines.join('\n');
  }
  if (report.subcommand === 'list') {
    lines.push(`count: ${report.count}`);
    for (const item of report.tasks ?? []) {
      if (item.status === 'invalid') {
        lines.push(`task ${item.taskId}: invalid (${item.error})`);
        continue;
      }
      lines.push(`task ${item.taskId}: ${item.stage ?? 'unknown'} (${item.unitCount} units, ${item.doneUnits} done, ${item.blockerCount} blockers)`);
    }
    return lines.join('\n');
  }
  return lines.join('\n');
}
export function summary(report) {
  if (report.command === 'slice') return report.error ? `command: slice\nstatus: failed\nerror: ${report.error}` : report.text;
  if (report.command === 'patch') return patchSummary(report);
  if (report.command === 'task') return taskSummary(report);
  if (report.command === 'worktree') {
    const lines = [`command: worktree ${report.subcommand ?? ''}`.trim()];
    if (report.error) lines.push(`error: ${report.error}`);
    // The check subcommand already prints a `status:` line through its audit
    // summary, so only the other subcommands carry the receipt status here.
    if (report.summary) lines.push(report.summary);
    else lines.push(`status: ${report.status}`);
    // land reports one result whose steps carry their own ids and evidence,
    // which the generic result rows below (built for bootstrap/cleanup) do not
    // know how to print.
    if (report.subcommand === 'land') {
      if (report.targetBranch) lines.push(`target: ${report.targetBranch}`);
      if (report.tier) lines.push(`tier: ${report.tier}`);
      for (const blocker of report.blockers ?? []) lines.push(`blocker: ${blocker}`);
      for (const item of report.results ?? []) {
        lines.push(`${item.status}: ${item.id} branch ${item.branch} (${item.path})`);
        for (const step of item.steps ?? []) {
          lines.push(`  ${step.id}: ${step.status}${step.detail ? ` (${step.detail})` : ''}${step.error ? ` - ${step.error}` : ''}`);
          if (step.code) lines.push(`    code: ${step.code}`);
          if (step.tier) lines.push(`    tier: ${step.tier}`);
        }
      }
      return lines.join('\n');
    }
    for (const entry of report.worktrees ?? []) {
      lines.push(`worktree: ${entry.path} ${entry.branch ?? '(detached)'}${entry.integrated === true ? ' [merged]' : entry.integrated === false ? ' [merge-back pending]' : ''}`);
    }
    for (const item of report.results ?? []) {
      lines.push(`${item.status}: ${item.id ?? item.path ?? ''} ${item.error ?? ''} ${(item.blockers ?? []).join('; ')}`.trim());
      if (item.code) lines.push(`  code: ${item.code}`);
      if (item.allocation) {
        const ports = Object.entries(item.allocation.ports ?? {}).map(([name, port]) => `${name}=${port}`).join(' ');
        lines.push(`  ports: ${item.allocation.envFile} block ${item.allocation.block}${ports ? ` (${ports})` : ''}`);
      } else if (item.ports) {
        const ports = Object.entries(item.ports).map(([name, port]) => `${name}=${port}`).join(' ');
        lines.push(`  ports: block${ports ? ` (${ports})` : ''}`);
      }
      for (const step of item.steps ?? []) lines.push(`  ${step.kind}${step.command ? `: ${step.command}` : step.root ? `: ${step.root} (${step.mode})` : ''}`);
      for (const file of item.envFiles ?? []) lines.push(`  env-file ${file.file}: ${file.status}${file.reason ? ` (${file.reason})` : ''}`);
      for (const command of item.setupCommands ?? []) lines.push(`  setup ${command.command}: ${command.status}`);
    }
    return lines.join('\n');
  }
  const lines = [`command: ${report.command}`, `status: ${report.status}`];
  // The help receipt carries the usage contract; without this block it only
  // surfaced under --json, so the summary path answered --help with nothing.
  if (report.command === 'help') {
    lines.push(report.usage);
    if (report.worktree) lines.push(report.worktree);
    if (report.task) lines.push(report.task);
    if (report.reuse) lines.push(report.reuse);
    if (report.verify) lines.push(report.verify);
  }
  if (report.command === 'verify') {
    if (report.tier) lines.push(`tier: ${report.tier}`);
    for (const [name, item] of Object.entries(report.checks ?? {})) lines.push(`${name}: ${item.status}`);
    if (report.nextTier) lines.push(`nextTier: ${report.nextTier}`);
    if (report.reused) lines.push(`reused: ${report.reused.taskId}/${report.reused.unitId}${report.reused.id ? ` receipt ${report.reused.id}` : ''}`);
  }
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}
