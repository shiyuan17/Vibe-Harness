import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY = /(api[-_]?key|authorization|credential|cookie|password|secret|session[-_]?id|token(?!s?$))/iu;
const SAFE_TOKEN_KEYS = new Set([
  'cachedTokens', 'completionTokens', 'contextTokens', 'inputTokens', 'outputTokens',
  'promptTokens', 'reasoningTokens', 'tokenUsage', 'totalTokens',
]);
const SECRET_TEXT = /\b(?:bearer\s+|token=|secret=|password=|api[-_]?key=|authorization=)[^\s,;]+/giu;
const WINDOWS_PATH = /[a-zA-Z]:\\(?:[^\\\s"']+\\?)*[^\\\s"']*/gu;
const POSIX_PATH = /(^|[\s"'=(])\/(?!\/)(?:[^/\s"'=]+\/)*[^/\s"'=]*/gu;
const MAX_TEXT_LENGTH = 64 * 1024;

/** @typedef {Record<string, any>} TraceRecord */

/**
 * @typedef {object} AtifTraceOptions
 * @property {string} runId
 * @property {{name?: string, version?: string, modelName?: string, model?: string, extra?: TraceRecord}} [agent]
 * @property {TraceRecord[]} [events]
 * @property {{inputTokens?: number, outputTokens?: number, cachedTokens?: number, costUsd?: number, toolCalls?: number}} [metrics]
 * @property {TraceRecord[]} [subagents]
 * @property {TraceRecord} [extra]
 */

/**
 * @typedef {object} TraceBundleOptions
 * @property {TraceRecord} trace
 * @property {TraceRecord[]} [events]
 * @property {TraceRecord[]} [artifacts]
 */

function redactText(value) {
  const redacted = value
    .replace(SECRET_TEXT, '<redacted>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, (match, prefix) => `${prefix}<path>`);
  return redacted.length <= MAX_TEXT_LENGTH ? redacted : `${redacted.slice(0, MAX_TEXT_LENGTH)}<truncated>`;
}

export function redactTraceValue(value, key = '') {
  if (!SAFE_TOKEN_KEYS.has(key) && SECRET_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactTraceValue(childValue, childKey),
    ]));
  }
  return value;
}

function stableRunId(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/u.test(value)) return value;
  return `run-${createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)}`;
}

function stepFromEvent(event, index) {
  const base = {
    step_id: index + 1,
    timestamp: event.timestamp ?? new Date(0).toISOString(),
    source: event.source ?? (event.type === 'tool-result' ? 'system' : 'agent'),
  };
  // Evidence provenance and the observable outcome travel as projected extra
  // fields. `source` keeps its ATIF meaning (who produced the step), so a
  // downstream reader can still tell a host observation from an Agent claim
  // without reinterpreting the existing role.
  const provenance = {
    evidence_source: typeof event.evidenceSource === 'string' ? event.evidenceSource : null,
    ...(event.callId === undefined ? {} : { call_id: stableRunId(event.callId) }),
    ...(typeof event.status === 'string' ? { status: event.status } : {}),
    ...(Number.isInteger(event.exitCode) ? { exit_code: event.exitCode } : {}),
    ...(typeof event.command === 'string' ? { command: event.command } : {}),
  };
  if (event.type === 'tool-call') {
    return {
      ...base,
      source: 'agent',
      message: event.message ?? null,
      tool_calls: [{
        tool_call_id: stableRunId(event.callId ?? `call-${index + 1}`),
        function_name: event.name ?? 'unknown',
        arguments: event.arguments ?? (event.query === undefined ? {} : { query: event.query }),
        ...(event.extra ? { extra: event.extra } : {}),
      }],
      extra: {
        harness_event_type: event.type,
        tool_name: event.name ?? null,
        ...provenance,
        ...(event.harness ?? {}),
      },
    };
  }
  if (event.type === 'tool-result') {
    return {
      ...base,
      source: 'system',
      message: event.message ?? null,
      observation: {
        results: [{
          source_call_id: stableRunId(event.callId ?? `call-${index}`),
          content: event.content ?? '',
          ...(event.extra ? { extra: event.extra } : {}),
        }],
      },
      extra: {
        harness_event_type: event.type,
        tool_name: event.name ?? null,
        ...provenance,
        ...(event.harness ?? {}),
      },
    };
  }
  return {
    ...base,
    message: event.message ?? event.content ?? '',
    ...(event.modelName ? { model_name: event.modelName } : {}),
    ...(event.metrics ? {
      metrics: {
        ...(Number.isFinite(event.metrics.inputTokens) ? { prompt_tokens: event.metrics.inputTokens } : {}),
        ...(Number.isFinite(event.metrics.outputTokens) ? { completion_tokens: event.metrics.outputTokens } : {}),
        ...(Number.isFinite(event.metrics.cachedTokens) ? { cached_tokens: event.metrics.cachedTokens } : {}),
        ...(Number.isFinite(event.metrics.costUsd) ? { cost_usd: event.metrics.costUsd } : {}),
      },
    } : {}),
    extra: {
      harness_event_type: event.type ?? 'message',
      ...provenance,
      ...(event.harness ?? {}),
    },
  };
}

/** @param {AtifTraceOptions} options */
export function toAtifTrace({ runId, agent = {}, events = [], metrics = {}, subagents = [], extra = {} } = /** @type {AtifTraceOptions} */ ({})) {
  if (!Array.isArray(events) || !Array.isArray(subagents)) throw new TypeError('events and subagents must be arrays');
  const trace = {
    schema_version: 'ATIF-v1.8',
    trajectory_id: stableRunId(runId),
    session_id: stableRunId(runId),
    agent: {
      name: agent.name ?? 'unknown',
      version: agent.version ?? 'unknown',
      model_name: agent.modelName ?? agent.model ?? 'unknown',
      ...(agent.extra ? { extra: agent.extra } : {}),
    },
    steps: events.map(stepFromEvent),
    final_metrics: {
      total_prompt_tokens: Number.isFinite(metrics.inputTokens) ? metrics.inputTokens : 0,
      total_completion_tokens: Number.isFinite(metrics.outputTokens) ? metrics.outputTokens : 0,
      total_cached_tokens: Number.isFinite(metrics.cachedTokens) ? metrics.cachedTokens : 0,
      total_cost_usd: Number.isFinite(metrics.costUsd) ? metrics.costUsd : 0,
      total_steps: events.length,
    },
    ...(subagents.length > 0 ? {
      subagent_trajectories: subagents.map((subagent) => subagent.schema_version === 'ATIF-v1.8'
        ? subagent
        : toAtifTrace(/** @type {AtifTraceOptions} */ (subagent))),
    } : {}),
    extra: {
      harness: {
        tool_calls: Number.isFinite(metrics.toolCalls) ? metrics.toolCalls : null,
        ...extra,
      },
    },
  };
  return redactTraceValue(trace);
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(redactTraceValue(value), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

/**
 * @param {string} directory
 * @param {TraceBundleOptions} options
 */
export async function writeTraceBundle(directory, { trace, events = [], artifacts = [] } = /** @type {TraceBundleOptions} */ ({})) {
  if (!trace || trace.schema_version !== 'ATIF-v1.8') throw new TypeError('trace must use ATIF-v1.8');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    atomicWriteJson(path.join(directory, 'trajectory.json'), trace),
    atomicWriteJson(path.join(directory, 'events.json'), { schemaVersion: 1, events }),
    atomicWriteJson(path.join(directory, 'artifacts.json'), { schemaVersion: 1, artifacts }),
  ]);
  return { artifacts: 'artifacts.json', events: 'events.json', trajectory: 'trajectory.json' };
}

export async function readTraceBundle(directory) {
  const [trace, eventDocument, artifactDocument] = await Promise.all([
    readFile(path.join(directory, 'trajectory.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'events.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'artifacts.json'), 'utf8').then(JSON.parse),
  ]);
  return { trace, events: eventDocument.events, artifacts: artifactDocument.artifacts };
}

const TAXONOMY = new Map([
  ['rule', 'Rule Failure'],
  ['planning', 'Planning Failure'],
  ['reasoning', 'Reasoning Failure'],
  ['tool', 'Tool Failure'],
  ['context', 'Context Failure'],
  ['coordination', 'Coordination Failure'],
  ['workflow', 'Verification Failure'],
  ['verification', 'Verification Failure'],
  ['recovery', 'Recovery Failure'],
  ['infrastructure', 'Infrastructure Failure'],
  ['fixture', 'Fixture Failure'],
  ['verifier', 'Verifier Failure'],
  ['collector', 'Collector Failure'],
]);

// --- Diagnostics -------------------------------------------------------------
//
// One report surface for the questions a failed run has to answer: where did it
// first deviate, where did each conclusion come from, which rules were actually
// read, what was read twice, which tools failed, where did the run wait, and
// which completion claims lack verification. Every entry carries the step or
// call it came from, and a missing observation is reported as `unavailable` or
// `unverified` — never as a zero count or a pass.

const FAILED_TOOL_STATUS = /^(?:cancelled|declined|denied|rejected|timed_?out|timeout|aborted|interrupted|error|failed|failure)$/iu;
const PENDING_TOOL_STATUS = /^(?:pending|waiting|queued|in_?progress|running)$/iu;
const WAIT_TOOL_PATTERN = /(?:^|[-_])(?:wait|sleep|poll|delay|timeout)(?:$|[-_])/iu;
const READ_COMMAND_PATTERN = /^\s*(?:[A-Za-z]:)?[^\s]*[\\/]?\s*\b(?:cat|bat|head|tail|less|more|type|get-content|gc|rg|grep|findstr|select-string)\b/iu;
const READ_TOOL_PATTERN = /read|view|open|fetch|get/iu;
const RULE_PATH_PATTERN = /(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.agents[\\/]rules[\\/]|docs[\\/]rules[\\/])/iu;
function stepExtra(step) {
  return step && typeof step.extra === 'object' && step.extra !== null ? step.extra : {};
}

function stepToolCall(step) {
  return Array.isArray(step?.tool_calls) && step.tool_calls.length > 0 ? step.tool_calls[0] : null;
}

function stepTarget(step) {
  const call = stepToolCall(step);
  const extra = stepExtra(step);
  return {
    callId: extra.call_id ?? call?.tool_call_id ?? null,
    stepId: Number.isInteger(step?.step_id) ? step.step_id : null,
    toolName: extra.tool_name ?? call?.function_name ?? null,
    kind: typeof extra.harness_event_type === 'string' ? extra.harness_event_type : 'unknown',
  };
}

function stepCommand(step) {
  const call = stepToolCall(step);
  const args = call?.arguments;
  if (typeof args?.command === 'string') return args.command;
  if (typeof args?.invocation === 'string') return args.invocation;
  const extra = stepExtra(step);
  if (typeof extra.command === 'string') return extra.command;
  return null;
}

function readTarget(step) {
  const command = stepCommand(step);
  if (command && READ_COMMAND_PATTERN.test(command)) return command.trim().split(/\s+/u).at(-1) ?? command.trim();
  const toolName = String(stepToolCall(step)?.function_name ?? '');
  if (READ_TOOL_PATTERN.test(toolName) && command) return command.trim();
  return null;
}

function buildEvidenceSources(steps) {
  const counts = { 'agent-claim': 0, 'tool-call': 0, 'tool-result': 0, unknown: 0 };
  for (const step of steps) {
    const source = stepExtra(step).evidence_source;
    if (source === 'agent-claim' || source === 'tool-call' || source === 'tool-result') counts[source] += 1;
    else counts.unknown += 1;
  }
  return {
    state: 'observed',
    counts,
    note: 'unknown counts steps written before provenance was recorded or by a producer that does not set it',
  };
}

function buildRuleLoads(steps) {
  const items = steps
    .filter((step) => stepExtra(step).harness_event_type === 'rule-read'
      || (stepExtra(step).evidence_source === 'tool-result' && RULE_PATH_PATTERN.test(String(stepCommand(step) ?? ''))))
    .map((step) => stepTarget(step));
  const toolRecords = steps.filter((step) => stepExtra(step).evidence_source === 'tool-result').length;
  if (toolRecords === 0) {
    return { state: 'unavailable', reason: 'no tool results in the trace', items: [] };
  }
  return { state: 'observed', items };
}

function buildRepeatedReads(steps) {
  const reads = new Map();
  for (const step of steps) {
    const target = readTarget(step);
    if (!target) continue;
    const entry = reads.get(target) ?? { target, stepIds: [] };
    const { stepId } = stepTarget(step);
    if (stepId !== null) entry.stepIds.push(stepId);
    reads.set(target, entry);
  }
  const items = [...reads.values()].filter((entry) => entry.stepIds.length > 1);
  if (steps.length === 0) return { state: 'unavailable', reason: 'trace has no steps', items: [] };
  return { state: 'observed', items };
}

function buildToolFailures(steps) {
  const items = [];
  for (const step of steps) {
    const extra = stepExtra(step);
    if (extra.evidence_source !== 'tool-result') continue;
    const status = typeof extra.status === 'string' ? extra.status : null;
    const exitCode = Number.isInteger(extra.exit_code) ? extra.exit_code : null;
    const failed = (exitCode !== null && exitCode !== 0) || (status !== null && FAILED_TOOL_STATUS.test(status));
    if (!failed) continue;
    items.push({
      ...stepTarget(step),
      status,
      exitCode,
      kind: exitCode !== null && exitCode !== 0 ? 'nonzero-exit-code' : 'failed-status',
    });
  }
  const toolRecords = steps.filter((step) => stepExtra(step).evidence_source === 'tool-result').length;
  if (toolRecords === 0) return { state: 'unavailable', reason: 'no tool results in the trace', items: [] };
  return { state: 'observed', items };
}

function buildWaits(steps) {
  const items = [];
  for (const step of steps) {
    const extra = stepExtra(step);
    const target = stepTarget(step);
    if (extra.evidence_source === 'tool-call' && WAIT_TOOL_PATTERN.test(String(target.toolName ?? ''))) {
      items.push({ ...target, kind: 'wait-tool' });
      continue;
    }
    if (typeof extra.status === 'string' && PENDING_TOOL_STATUS.test(extra.status)) {
      items.push({ ...target, kind: 'pending-status' });
    }
  }
  if (steps.length === 0) return { state: 'unavailable', reason: 'trace has no steps', items: [] };
  return { state: 'observed', items };
}

function buildVerificationGaps(steps, checks) {
  const items = [];
  const verificationSteps = steps.filter((step) => stepExtra(step).harness_event_type === 'verification');
  const changeSteps = steps.filter((step) => stepExtra(step).harness_event_type === 'change');
  const lastChangeId = changeSteps.length > 0 ? changeSteps.at(-1).step_id : null;
  const coveringResults = new Set(steps
    .filter((step) => stepExtra(step).evidence_source === 'tool-result' && stepExtra(step).exit_code === 0)
    .map((step) => stepExtra(step).call_id)
    .filter(Boolean));
  for (const step of verificationSteps) {
    const target = stepTarget(step);
    const extra = stepExtra(step);
    if (extra.evidence_source !== 'tool-result') {
      items.push({ ...target, code: 'claim-without-tool-evidence', evidenceStrength: 'insufficient',
        message: 'a verification claim is recorded without a tool result backing it' });
    }
    if (!Number.isInteger(extra.exit_code) && extra.status === undefined) {
      items.push({ ...target, code: 'exit-code-missing', evidenceStrength: 'unverified',
        message: 'the verification record has no numeric exit code, so success cannot be proven' });
    }
    if (lastChangeId !== null && target.stepId !== null && target.stepId < lastChangeId) {
      items.push({ ...target, code: 'verification-before-last-change', evidenceStrength: 'deterministic',
        message: 'this run happened before the last recorded change, so it cannot support a completion claim' });
    }
    if (target.callId && !coveringResults.has(target.callId) && extra.exit_code !== 0) {
      items.push({ ...target, code: 'no-passing-covering-run', evidenceStrength: 'unverified',
        message: 'no tool result with exit code 0 covers this verification record' });
    }
  }
  for (const check of checks) {
    if (!['failed', 'blocked', 'unverified'].includes(check.status)) continue;
    items.push({
      checkId: check.id,
      code: check.code ?? check.id,
      evidenceStrength: check.evidence ? 'deterministic' : 'insufficient',
      message: `check ${check.id} is ${check.status}`,
      stepId: Number.isInteger(check.evidence?.eventIndex) ? check.evidence.eventIndex + 1 : null,
      callId: null,
      toolName: null,
      kind: 'check',
    });
  }
  if (steps.length === 0 && checks.length === 0) {
    return { state: 'unavailable', reason: 'neither a trace nor checks were supplied', items: [] };
  }
  return { state: items.length === 0 ? 'observed' : 'unverified', items };
}

function buildFirstDeviation(steps, checks, findings) {
  const fromCheck = findings.find((finding) => Number.isInteger(finding.firstDeviation?.eventIndex));
  if (fromCheck) {
    return {
      state: 'observed',
      source: 'check',
      checkId: fromCheck.checkId,
      eventIndex: fromCheck.firstDeviation.eventIndex,
      stepId: null,
      callId: null,
      message: `${fromCheck.taxonomy} reported by check ${fromCheck.checkId}`,
    };
  }
  const gaps = buildVerificationGaps(steps, []);
  const firstGap = gaps.items.find((item) => item.stepId !== null);
  if (firstGap) {
    return {
      state: 'observed',
      source: 'trace',
      checkId: firstGap.checkId ?? null,
      eventIndex: null,
      stepId: firstGap.stepId,
      callId: firstGap.callId,
      message: firstGap.message,
    };
  }
  const failure = buildToolFailures(steps).items[0];
  if (failure) {
    return {
      state: 'observed',
      source: 'trace',
      checkId: null,
      eventIndex: null,
      stepId: failure.stepId,
      callId: failure.callId,
      message: `tool ${failure.toolName ?? 'unknown'} failed (${failure.kind})`,
    };
  }
  return {
    state: 'unavailable',
    reason: steps.length === 0 ? 'trace has no steps' : 'no deviation evidence in the trace or checks',
    source: null,
    checkId: null,
    eventIndex: null,
    stepId: null,
    callId: null,
    message: null,
  };
}

function buildDiagnostics(trace, checks, findings) {
  const steps = Array.isArray(trace?.steps) ? trace.steps : null;
  if (steps === null) {
    const unavailable = { state: 'unavailable', reason: 'trace is unavailable', items: [] };
    return {
      state: 'unavailable',
      firstDeviation: {
        state: 'unavailable', reason: 'trace is unavailable', source: null, checkId: null,
        eventIndex: null, stepId: null, callId: null, message: null,
      },
      evidenceSources: { state: 'unavailable', reason: 'trace is unavailable', counts: null },
      ruleLoads: unavailable,
      repeatedReads: unavailable,
      toolFailures: unavailable,
      waits: unavailable,
      verificationGaps: buildVerificationGaps([], checks),
    };
  }
  return {
    state: 'available',
    firstDeviation: buildFirstDeviation(steps, checks, findings),
    evidenceSources: buildEvidenceSources(steps),
    ruleLoads: buildRuleLoads(steps),
    repeatedReads: buildRepeatedReads(steps),
    toolFailures: buildToolFailures(steps),
    waits: buildWaits(steps),
    verificationGaps: buildVerificationGaps(steps, checks),
  };
}

export function analyzeTrace(trace, checks = []) {
  const failedOrBlocked = checks.filter((check) => ['failed', 'blocked', 'unverified'].includes(check.status));
  const findings = failedOrBlocked.map((check) => ({
    checkId: check.id,
    code: check.code ?? check.id,
    taxonomy: check.taxonomy ?? TAXONOMY.get(check.category) ?? 'Unknown Failure',
    stage: check.stage ?? check.category ?? 'unknown',
    firstDeviation: check.evidence?.eventIndex === undefined ? null : { eventIndex: check.evidence.eventIndex },
    evidence: check.evidence ?? null,
    mechanism: check.mechanism ?? null,
    likelyCause: check.likelyCause ?? null,
    evidenceStrength: check.evidence ? 'deterministic' : 'insufficient',
    suggestedValidation: check.suggestedValidation ?? null,
  }));
  // The whole analysis — findings and diagnostics — passes the shared redactor so a
  // report never leaks a session path or secret through a newly added field.
  return redactTraceValue({
    schemaVersion: 2,
    traceState: trace?.schema_version === 'ATIF-v1.8' || Array.isArray(trace?.steps) ? 'available' : 'unavailable',
    findings,
    diagnostics: buildDiagnostics(trace, checks, findings),
  });
}
